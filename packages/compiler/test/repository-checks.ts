import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { parse } from "./helpers.ts";

// ADR-0043: only packages declaring tag contracts may mention MX; extensions join in M6.
export const MX_IMPORT_PACKAGES = ["packages/compiler"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const lockFiles = new Set(["bun.lock", "bun.lockb", "bun.lock.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function walk(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    // Only host separators delimit segments; a POSIX backslash is a filename character.
    const path = relative(root, file).split(sep).join("/");
    if (path.split("/").includes("node_modules") || within(path, "apps/docs/site") || within(path, "apps/docs/docs") ||
      MX_IMPORT_PACKAGES.some((pkg) => within(path, pkg))) return [];
    // Never follow symlinks into dependencies or outside the checkout.
    if (entry.isDirectory()) return walk(root, file);
    return entry.isFile() && sourceExtensions.has(extname(file)) && !lockFiles.has(entry.name) ? [file] : [];
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

export function checkDocsSamples(dir: string) {
  let parsed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const name of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const file = join(dir, name);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
      if (!opening) continue;
      const fence = opening[1]!;
      const line = i + 1;
      const block: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (closing && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length) { closed = true; break; }
        block.push(lines[i]!);
      }
      if (!opening[2]!.trimStart().startsWith("mx")) continue;
      if (!closed) errors.push(`${name}:${line}: unclosed MX fence`);
      if (!block.find((text) => text.trim() !== "")?.trimStart().startsWith("resource")) { skipped++; continue; }
      parsed++;
      for (const diagnostic of parse(`${block.join("\n")}\n`, file).diagnostics) {
        errors.push(`${name}:${line}: MX block ${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`);
      }
    }
  }
  if (parsed === 0) errors.push("Docs sample check parsed no complete resource blocks");
  return { parsed, skipped, errors };
}
