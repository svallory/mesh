import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MESH_EXTENSIONS } from "../src/front-end/extensions.ts";

// A plain import scan: no dependency, no TypeScript resolver.
const src = resolve(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
/** Every module specifier a file imports, re-exports or dynamically imports. */
export function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) found.add(match[1]!);
  return [...found];
}
/** The imports of `layer` that resolve inside any of `forbidden` (relative) or start with a forbidden package prefix. */
function violations(layer: string, forbiddenDirs: string[], forbiddenPackages: string[]): string[] {
  const found: string[] = [];
  for (const file of files(join(src, layer))) {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const target = specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined;
      const bad = target
        ? forbiddenDirs.some((dir) => target === join(src, dir) || target.startsWith(join(src, dir) + "/"))
        : forbiddenPackages.some((prefix) => specifier === prefix || specifier.startsWith(prefix + "/"));
      if (bad) found.push(`${relative(src, file)} imports ${specifier}`);
    }
  }
  return found;
}

test("the scan sees real imports (planted sources)", () => {
  expect(specifiers('import a from "../typescript/x.ts";\nexport { b } from "./y.ts";\nconst c = await import("@mxlang/core");')).toEqual([
    "../typescript/x.ts", "./y.ts", "@mxlang/core",
  ]);
});

test("the front end never imports the TypeScript back end", () => {
  expect(files(join(src, "front-end")).length).toBeGreaterThan(5);
  expect(violations("front-end", ["typescript"], ["@jig-lang", "prettier"])).toEqual([]);
});

test("the TypeScript back end reads the model only: it never imports the front end or MX", () => {
  expect(files(join(src, "typescript")).length).toBeGreaterThan(10);
  expect(violations("typescript", ["front-end"], ["@mxlang"])).toEqual([]);
});

test("the model folder imports neither half", () => {
  expect(violations("model", ["front-end", "typescript"], ["@mxlang", "@jig-lang", "prettier"])).toEqual([]);
});

test("only the extensions list spells an entity file extension", () => {
  const offenders = files(src)
    .filter((file) => !file.endsWith("front-end/extensions.ts"))
    .filter((file) => MESH_EXTENSIONS.some((extension) => readFileSync(file, "utf8").includes(extension)))
    .map((file) => relative(src, file));
  expect(offenders).toEqual([]);
});
