import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { parse } from "./helpers.ts";

// ADR-0043: only packages declaring tag contracts may mention MX; extensions join in M6.
export const MX_IMPORT_PACKAGES = ["packages/compiler"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const lockFiles = new Set(["bun.lock", "bun.lockb", "bun.lock.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function walk(root: string, dir: string, allFiles = false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    // Only host separators delimit segments; a POSIX backslash is a filename character.
    const path = relative(root, file).split(sep).join("/");
    if (!allFiles && (path.split("/").includes("node_modules") || within(path, "apps/docs/site") || within(path, "apps/docs/docs") ||
      MX_IMPORT_PACKAGES.some((pkg) => within(path, pkg)))) return [];
    // Never follow symlinks into dependencies or outside the checkout.
    if (entry.isDirectory()) return walk(root, file, allFiles);
    return entry.isFile() && (allFiles || (sourceExtensions.has(extname(file)) && !lockFiles.has(entry.name))) ? [file] : [];
  });
}

/** Deliberately text-only: comments, strings, wrappers and dependency fields all count.
 * Specifiers assembled at run time from pieces cannot be caught by this substring rule;
 * the package.json dependency rule plus code review are the backstop.
 */
export function checkMxImports(root: string): string[] {
  return ["packages", "apps", "examples"].flatMap((group) => walk(root, join(root, group))).sort().flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const first = source.indexOf("@mxlang");
    if (first === -1) return [];
    const path = relative(root, file).split(sep).join("/");
    const line = source.slice(0, first).split(/\r\n|\r|\n/).length;
    return [`${path}:${line}: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention`];
  });
}

const runtimeForbidden = ["@mesh/model", "@mesh/compiler", "drizzle-orm", "drizzle-kit"];

/** M2's text rules reuse M1's directory walker, scanning every runtime source file. */
export function checkRuntime(root: string, rule: "imports" | "web"): string[] {
  const dir = join(root, "packages/runtime/src");
  const files = existsSync(dir) ? walk(root, dir, true).sort() : [];
  const errors: string[] = [];
  if (files.length === 0) errors.push("packages/runtime/src: No runtime source files scanned");
  const report = (file: string, source: string, index: number, reason: string) => {
    const path = relative(root, file).split(sep).join("/");
    errors.push(`${path}:${source.slice(0, index).split(/\r\n|\r|\n/).length}: ${reason}`);
  };
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (rule === "imports") {
      for (const name of runtimeForbidden) {
        const index = source.indexOf(name);
        if (index !== -1) report(file, source, index, `Runtime must not mention ${name}; move build-time or database-specific code out of runtime`);
      }
    } else {
      // Plain text on purpose, like M1: even comments and strings fail.
      // No parsing or token adjacency assumptions: inter-token comments cannot hide a mention.
      for (const match of source.matchAll(/bun:|node:|\bBun\b/g)) {
        report(file, source, match.index, `Runtime must use web-standard APIs; forbidden text ${match[0]} (including comments and strings)`);
      }
    }
  }
  if (rule === "imports") {
    const file = join(root, "packages/runtime/package.json");
    if (!existsSync(file)) errors.push("packages/runtime/package.json: Missing runtime manifest");
    else {
      const source = readFileSync(file, "utf8");
      // Scan the whole manifest text, including values such as npm: dependency aliases.
      for (const name of runtimeForbidden) {
        const index = source.indexOf(name);
        if (index !== -1) report(file, source, index, `Runtime manifest must not mention ${name} anywhere, including keys and values`);
      }
    }
  }
  return errors;
}

/**
 * The Docs pages write the entity root tag as `entity` (the operator's ruling of
 * 2026-10-04). The tag contracts still know `resource`, so before parsing, the
 * check rewrites the root tag in memory: every Docs sample is still parsed by
 * today's contracts, and the check keeps its teeth.
 *
 * What the rename task will change is anything the vocabulary itself touches.
 * A block that fails only for one of those reasons is deferred, counted per
 * reason and printed; any other failure is a finding in the page.
 */
export const DOCS_ROOT_TAG_PENDING_RENAME = "entity";

/** Diagnostic text that names something the entity/module rename or the import rule will change. */
const RENAME_AFFECTED = /\b(entity|module|domain|import)\b/i;

function withCurrentRootTag(block: string) {
  return block.replace(new RegExp(`^(\\s*)${DOCS_ROOT_TAG_PENDING_RENAME}(\\s*=)`, "m"), "$1resource$2");
}

export function checkDocsSamples(dir: string) {
  let parsed = 0;
  let skipped = 0;
  const deferred: { at: string; reason: string }[] = [];
  const errors: string[] = [];
  for (const name of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const file = join(dir, name);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
      if (!opening) continue;
      const fence = opening[1]!;
      const line = i + 1;
      let block: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (closing && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length) { closed = true; break; }
        block.push(lines[i]!);
      }
      const language = opening[2]!.trim().split(/\s+/)[0];
      // The figure is one entity file too, once its `// @key:` annotations are removed.
      if (language === "mx-figure") block = block.filter((line) => !/^\s*\/\/\s*@/.test(line));
      else if (language !== "mx") continue;
      if (!closed) errors.push(`${name}:${line}: unclosed MX fence`);
      const root = block.find((text) => text.trim() !== "")?.trimStart() ?? "";
      // An entity file may open with its imports, so an `import` line heads a complete block too.
      if (!/^(resource\b|import\s)/.test(root) && !root.startsWith(DOCS_ROOT_TAG_PENDING_RENAME)) { skipped++; continue; }
      const diagnostics = parse(withCurrentRootTag(`${block.join("\n")}\n`), file).diagnostics;
      const renaming = diagnostics.filter((diagnostic) => RENAME_AFFECTED.test(diagnostic.message));
      if (renaming.length > 0 && renaming.length === diagnostics.length) {
        deferred.push({ at: `${name}:${line}`, reason: renaming[0]!.message });
        continue;
      }
      parsed++;
      for (const diagnostic of diagnostics) {
        errors.push(`${name}:${line}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
      }
    }
  }
  const byReason = new Map<string, number>();
  for (const { reason } of deferred) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  console.log(`Docs MX samples: parsed ${parsed}, deferred ${deferred.length}, skipped ${skipped} fragments`);
  for (const [reason, count] of byReason) console.log(`  deferred (${count}) pending the entity rename: ${reason}`);
  if (parsed === 0 && deferred.length === 0) errors.push("Docs sample check parsed no complete entity blocks");
  return { parsed, skipped, deferred, errors };
}
