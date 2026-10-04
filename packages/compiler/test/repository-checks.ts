import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseScript } from "@babel/parser";
import { parse } from "./helpers.ts";

// ADR-0043: only packages declaring tag contracts may import MX; extensions join in M6.
export const MX_IMPORT_PACKAGES = ["packages/compiler"] as const;
const ignored = new Set(["node_modules", "dist", "build", "site", "coverage", ".git"]);
const sourceExtension = /\.[cm]?[jt]sx?$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = join(dir, entry.name);
    // Never follow symlinks into dependencies or outside the checkout.
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  }).sort();
}

/** Parse JavaScript/TypeScript, rather than matching import-looking comments or strings. */
export function mxImports(source: string, file: string): { specifier: string; line: number }[] {
  const tree = parseScript(source, { sourceFilename: file, sourceType: "unambiguous",
    plugins: ["typescript", "jsx"], createImportExpressions: true });
  const found: { specifier: string; line: number }[] = [];
  // A small structural visitor avoids another traversal dependency.
  interface Node { type?: string; value?: unknown; name?: string; loc?: { start: { line: number } }; [key: string]: unknown }
  function record(value: unknown) {
    const node = value as Node | undefined;
    if (!node) return;
    const specifier = node.type === "StringLiteral" ? node.value :
      node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0 ?
        (((node.quasis as Node[])[0]?.value as { cooked?: string })?.cooked) : undefined;
    if (typeof specifier !== "string") return;
    if (specifier !== "@mxlang" && !specifier.startsWith("@mxlang/")) return;
    found.push({ specifier, line: node.loc!.start.line });
  }
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Node;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type ?? "")) record(node.source);
    else if (node.type === "CallExpression" && (node.callee as Node)?.type === "Identifier" && (node.callee as Node).name === "require") record((node.arguments as unknown[])[0]);
    else if (node.type === "TSImportType") record(node.argument);
    else if (node.type === "TSExternalModuleReference") record(node.expression);
    for (const [key, child] of Object.entries(node)) {
      if (!["loc", "tokens", "comments"].includes(key)) visit(child);
    }
  }
  visit(tree);
  return found;
}

export function checkMxImports(root: string): string[] {
  const files: string[] = [];
  for (const group of ["packages", "apps", "examples"]) {
    for (const pkg of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!pkg.isDirectory() || ignored.has(pkg.name)) continue;
      const base = join(root, group, pkg.name);
      if (group === "packages") {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && ["src", "test"].includes(entry.name)) files.push(...walk(join(base, entry.name)));
        }
      } else files.push(...walk(base));
    }
  }
  return files.filter((file) => sourceExtension.test(file)).flatMap((file) => {
    const path = relative(root, file).split("\\").join("/");
    if (path.startsWith("apps/docs/docs/")) return [];
    if (MX_IMPORT_PACKAGES.some((pkg) => path.startsWith(`${pkg}/`))) return [];
    return mxImports(readFileSync(file, "utf8"), file).map(({ specifier, line }) =>
      `${path}:${line}: MX import "${specifier}" is forbidden here (ADR-0043); keep MX in a tag-contract package`);
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
