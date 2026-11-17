// ADR-0076 style guard: Mesh owns its syntax (decision "2026-10-10 14:30 — Mesh owns all of its syntax"), and core
// drops its `syntax/*` modules. No file in `packages/` or `examples/` may import them, by any spelling of the
// specifier. A plain scan, like `architecture.test.ts`: no dependency, no resolver.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isScratchPath } from "./scan-skip.ts";

const root = resolve(import.meta.dir, "../../..");
/** The forbidden package path, built by concatenation so that this file does not spell it either. */
const FORBIDDEN = ["@mxlang", "core", "syntax"].join("/");
/** The forbidden package path as the built output spells it. */
const FORBIDDEN_DIST = ["@mxlang", "core", "dist", "syntax"].join("/");
const SOURCE = /\.(?:[cm]?[jt]sx?|mx)$/;
const SKIP = new Set(["node_modules", "dist", ".git"]);

/** The source files under `dir`, skipping a test's `.scratch-*` temp dir by its path relative to `scanRoot`. */
function files(scanRoot: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (SKIP.has(entry.name) || isScratchPath(relative(scanRoot, path).split(sep).join("/"))) return [];
    return entry.isDirectory() ? files(scanRoot, path) : SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files in `packages/` and `examples/` under `scanRoot` that import core's syntax modules, relative to it. */
function offenders(scanRoot: string): string[] {
  return [...files(scanRoot, join(scanRoot, "packages")), ...files(scanRoot, join(scanRoot, "examples"))]
    .filter((file) => specifiers(readFileSync(file, "utf8")).some(forbidden))
    .map((file) => relative(scanRoot, file).split(sep).join("/"));
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
  const scanned = [...files(root, join(root, "packages")), ...files(root, join(root, "examples"))];
  expect(scanned.length).toBeGreaterThan(50);
  expect(offenders(root)).toEqual([]);
});

test("the scan skips a test's .scratch-* temp dir, by its path below the scan's root, and nothing else", () => {
  // Under the checkout, named as a test temp dir: the skip must not apply to the root the scan was given.
  const fixture = mkdtempSync(join(root, ".scratch-syntax-scan-"));
  try {
    const put = (path: string) => {
      mkdirSync(join(fixture, path, ".."), { recursive: true });
      writeFileSync(join(fixture, path), `import a from "${FORBIDDEN}/mesh";\n`);
    };
    put("packages/x/.scratch-race/y.ts");
    put("examples/x/test/.scratch-guard-abc123/src/y.ts");
    expect(offenders(fixture)).toEqual([]);
    put("packages/x/race/y.ts");
    put("packages/x/src/scratchpad/y.ts");
    expect(offenders(fixture).sort()).toEqual(["packages/x/race/y.ts", "packages/x/src/scratchpad/y.ts"]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
