// ADR-0076 style guard: Mesh owns its syntax (decision "2026-10-10 14:30 — Mesh owns all of its syntax"), and core
// drops its `syntax/*` modules. No file in `packages/` or `examples/` may import them, by any spelling of the
// specifier. A plain scan, like `architecture.test.ts`: no dependency, no resolver.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
/** The forbidden package path, built by concatenation so that this file does not spell it either. */
const FORBIDDEN = ["@mxlang", "core", "syntax"].join("/");
/** The forbidden package path as the built output spells it. */
const FORBIDDEN_DIST = ["@mxlang", "core", "dist", "syntax"].join("/");
const SOURCE = /\.(?:[cm]?[jt]sx?|mx)$/;
const SKIP = new Set(["node_modules", "dist", ".git"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    SKIP.has(entry.name) ? [] : entry.isDirectory() ? files(join(dir, entry.name)) : SOURCE.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

/** Every module specifier a source imports, re-exports, requires or dynamically imports. */
export function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*)["'`]([^"'`]+)["'`]/g)) found.add(match[1]!);
  return [...found];
}

const forbidden = (specifier: string): boolean =>
  [FORBIDDEN, FORBIDDEN_DIST].some((path) => specifier === path || specifier.startsWith(`${path}/`));

test("the scan sees every spelling (planted sources)", () => {
  const planted = [
    `import a from "${FORBIDDEN}/mesh";`,
    `export { b } from '${FORBIDDEN}/member';`,
    `const c = await import("${FORBIDDEN}/atoms-sugars");`,
    `const d = require("${FORBIDDEN}");`,
    `import "${FORBIDDEN}/mesh";`,
    "const e = await import(`" + FORBIDDEN + "/templated`);",
    `const f = require.resolve("${FORBIDDEN}/resolved");`,
    `import g from "${FORBIDDEN_DIST}/mesh.js";`,
    `import ok from "@mxlang/core";`,
  ].join("\n");
  expect(specifiers(planted).filter(forbidden)).toEqual([
    `${FORBIDDEN}/mesh`,
    `${FORBIDDEN}/member`,
    `${FORBIDDEN}/atoms-sugars`,
    FORBIDDEN,
    `${FORBIDDEN}/templated`,
    `${FORBIDDEN}/resolved`,
    `${FORBIDDEN_DIST}/mesh.js`,
  ]);
});

test("no file in packages/ or examples/ imports core's syntax modules", () => {
  const scanned = [...files(join(root, "packages")), ...files(join(root, "examples"))];
  expect(scanned.length).toBeGreaterThan(50);
  const offenders = scanned
    .filter((file) => specifiers(readFileSync(file, "utf8")).some(forbidden))
    .map((file) => relative(root, file));
  expect(offenders).toEqual([]);
});
