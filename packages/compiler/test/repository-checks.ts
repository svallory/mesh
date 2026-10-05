import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { parseData, type DataDiagnostic } from "@mxlang/data";
import { parse } from "./helpers.ts";

// ADR-0043: only packages declaring tag contracts may mention MX; extensions join in M6.
export const MX_IMPORT_PACKAGES = ["packages/compiler"] as const;

/**
 * The one `@mxlang` mention allowed outside those packages.
 *
 * The docs site highlights `mx` fences with MX's own tree-sitter highlighter,
 * which is the published `@mxlang/tree-sitter-mx` (ADR-0065). It is a build-time
 * grammar for the documentation, not the entity vocabulary, so `@mxlang/core` and
 * `@mxlang/data` stay forbidden everywhere outside `packages/compiler` and only
 * this one package name passes in `apps/docs`. A blanket exemption for the docs
 * app would have let the vocabulary's own packages back in.
 */
export const MX_HIGHLIGHTER_PACKAGE = "@mxlang/tree-sitter-mx";

/**
 * The offset of the first `@mxlang` mention in `source` that is not the
 * highlighter, or -1. `@mxlang/tree-sitter-mx-something` does not pass: the name
 * must end where the package name ends.
 */
function firstForbiddenMxMention(source: string): number {
  for (let at = 0; ;) {
    const found = source.indexOf("@mxlang", at);
    if (found === -1) return -1;
    const end = found + MX_HIGHLIGHTER_PACKAGE.length;
    const next = source[end];
    if (source.startsWith(MX_HIGHLIGHTER_PACKAGE, found) && (next === undefined || !/[\w.-]/.test(next))) {
      at = end;
      continue;
    }
    return found;
  }
}
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
 *
 * The one exception is `MX_HIGHLIGHTER_PACKAGE`, the docs site's grammar (ADR-0065).
 */
export function checkMxImports(root: string): string[] {
  return ["packages", "apps", "examples"].flatMap((group) => walk(root, join(root, group))).sort().flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const first = firstForbiddenMxMention(source);
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

interface DocsBlock {
  /** Page the fence is on. */
  name: string;
  /** 1-based line of the opening fence. */
  line: number;
  /** The fence's lines, with a figure's `// @key:` annotations removed. */
  block: string[];
  /** False when the fence was never closed. */
  closed: boolean;
}

/** Every ```mx and ```mx-figure fence on the Docs pages, in page and file order. */
function docsMxBlocks(dir: string): DocsBlock[] {
  const blocks: DocsBlock[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
    const lines = readFileSync(join(dir, name), "utf8").split(/\r?\n/);
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
      if (language === "mx-figure") block = block.filter((text) => !/^\s*\/\/\s*@/.test(text));
      else if (language !== "mx") continue;
      blocks.push({ name, line, block, closed });
    }
  }
  return blocks;
}

/**
 * The operator's entity file syntax v2 (ruling of 2026-10-05): a declaration is
 * `kind #name`, so every Docs sample is a v2 entity file and today's contracts
 * cannot read one. Two rules keep the check honest while the rename task has not
 * run:
 *
 *  - a v2 block is parsed for real, by `parseData` with no contracts, after one
 *    in-memory normalisation of the spellings MX does not parse yet;
 *  - its parse with the contracts is deferred, counted and printed under one name.
 *
 * The rules of v2 that the normalisation covers are the ones MX has queued
 * (decision 146): `#name` after a space, and the `:label` sugar.
 */
export const DOCS_SYNTAX = "syntax v2";

/** The one named reason a v2 block's contracts parse is deferred under. */
export const DOCS_SYNTAX_PENDING_RENAME = `${DOCS_SYNTAX}, pending the rename task`;

/** A complete v2 entity file: comments and imports may come first, then `entity #Name`. */
export function isV2EntityFile(block: string): boolean {
  for (const line of block.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (text.startsWith("import ")) continue;
    return /^entity\s+#\w+/.test(text);
  }
  return false;
}

/**
 * Rewrites the v2 spellings MX cannot parse yet into today's, in memory only:
 *
 *  - `kind #name` becomes `kind#name`, the form that parses today;
 *  - `kind=Destination #name` becomes `kind#name="Destination"`, because a value
 *    cannot be glued to a name (the same gap, and the same decision);
 *  - `check :label` becomes `check`, dropping the `:label` sugar.
 *
 * Indentation, literals, arrow functions and block bodies are already today's
 * syntax and are left exactly as written, as is every comment.
 */
export function normaliseV2(source: string): string {
  return source.split("\n").map((line) => {
    if (line.trim() === "" || line.trimStart().startsWith("//")) return line;
    const indent = line.slice(0, line.length - line.trimStart().length);
    const rest = line.trimStart();
    const valued = /^([a-z][a-z0-9-]*)=([A-Za-z][\w]*)\s+#(\w+)(.*)$/.exec(rest);
    if (valued) return `${indent}${valued[1]}#${valued[3]}="${valued[2]}"${valued[4]}`;
    const named = /^([a-z][a-z0-9-]*)\s+#(\w+)(.*)$/.exec(rest);
    if (named) return `${indent}${named[1]}#${named[2]}${named[3]}`;
    return `${indent}${rest.replace(/(^|\s):[a-z][a-z0-9-]*/g, "$1")}`;
  }).join("\n");
}

/** Parses a v2 block with no contracts; a parser crash is a finding, not an exception. */
export function parseV2(source: string, file: string): DataDiagnostic[] {
  try {
    return parseData(normaliseV2(source), file).diagnostics;
  } catch (cause) {
    return [{ severity: "error", message: `MX could not parse the block at all: ${(cause as Error).message.split("\n")[0]}`, line: 1, column: 0, offset: 0 }];
  }
}

/**
 * The stricter companion: every MX fence on the Docs pages must be a complete v2
 * entity file, so a page cannot drift back to another syntax, and every one of them
 * must parse. A block whose root is not `entity #Name` fails here.
 */
export function checkDocsSyntaxV2(dir: string) {
  let checked = 0;
  const errors: string[] = [];
  for (const { name, line, block, closed } of docsMxBlocks(dir)) {
    const where = `${name}:${line}`;
    if (!closed) { errors.push(`${where}: unclosed MX fence`); continue; }
    if (!isV2EntityFile(block.join("\n"))) {
      errors.push(`${where}: MX fence is not a complete ${DOCS_SYNTAX} entity file: its root must be \`entity #Name\``);
      continue;
    }
    checked++;
    for (const diagnostic of parseV2(`${block.join("\n")}\n`, where)) {
      errors.push(`${where}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
    }
  }
  console.log(`Docs ${DOCS_SYNTAX} entity files: ${checked} checked with parseData, no contracts, ${errors.length} findings`);
  if (checked === 0) errors.push(`Docs ${DOCS_SYNTAX} check found no entity file on any Docs page`);
  return { checked, errors };
}

export function checkDocsSamples(dir: string) {
  let parsed = 0;
  let skipped = 0;
  let v2 = 0;
  const deferred: { at: string; reason: string }[] = [];
  const errors: string[] = [];
  for (const { name, line, block, closed } of docsMxBlocks(dir)) {
    const where = `${name}:${line}`;
    if (!closed) errors.push(`${where}: unclosed MX fence`);
    // A v2 entity file is parsed here for real, without the contracts, and its
    // contracts parse is deferred under one name rather than counted as a finding.
    if (isV2EntityFile(block.join("\n"))) {
      v2++;
      parsed++;
      deferred.push({ at: where, reason: DOCS_SYNTAX_PENDING_RENAME });
      for (const diagnostic of parseV2(`${block.join("\n")}\n`, where)) {
        errors.push(`${where}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
      }
      continue;
    }
    const root = block.find((text) => text.trim() !== "")?.trimStart() ?? "";
    // An entity file may open with its imports, so an `import` line heads a complete block too.
    if (!/^(resource\b|import\s)/.test(root) && !root.startsWith(DOCS_ROOT_TAG_PENDING_RENAME)) { skipped++; continue; }
    const diagnostics = parse(withCurrentRootTag(`${block.join("\n")}\n`), join(dir, name)).diagnostics;
    const renaming = diagnostics.filter((diagnostic) => RENAME_AFFECTED.test(diagnostic.message));
    if (renaming.length > 0 && renaming.length === diagnostics.length) {
      deferred.push({ at: where, reason: renaming[0]!.message });
      continue;
    }
    parsed++;
    for (const diagnostic of diagnostics) {
      errors.push(`${where}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
    }
  }
  const byReason = new Map<string, number>();
  for (const { reason } of deferred) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  console.log(`Docs MX samples: parsed ${parsed} (${v2} of them ${DOCS_SYNTAX} entity files, parsed without contracts), deferred ${deferred.length}, skipped ${skipped} fragments`);
  for (const [reason, count] of byReason) console.log(`  deferred (${count}): ${reason}`);
  if (parsed === 0 && deferred.length === 0) errors.push("Docs sample check parsed no complete entity blocks");
  return { parsed, skipped, deferred, errors };
}
