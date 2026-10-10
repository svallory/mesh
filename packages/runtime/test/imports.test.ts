import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ADR-0013, ADR-0014: nothing Drizzle-specific shows through the runtime contract. A plain
// scan of the package's own sources and manifest: no architecture-test dependency.
const root = join(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

/** Every module specifier a source file names: static, type-only and dynamic imports, re-exports and require. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']/g]) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

// The package name is spelled in parts: the repository's own import rule (M2 test 4) flags the literal.
const orm = ["drizzle", "orm"].join("-");
const kit = ["drizzle", "kit"].join("-");
const FORBIDDEN = new RegExp(`^(${orm}|${kit}|@meshfw/(data-|compiler|model|cli)|bun:|node:sqlite|better-sqlite3|pg$|postgres$|mysql)`);

test("the scan flags what the runtime must not import and allows what it may", () => {
  for (const name of [orm, `${orm}/sqlite-core`, kit, "@meshfw/data-drizzle", "@meshfw/data-sqlite/build", "@meshfw/compiler", "@meshfw/model", "bun:sqlite", "pg", "postgres", "mysql2"]) {
    expect(FORBIDDEN.test(name)).toBe(true);
  }
  for (const name of ["./data-layer.ts", "node:async_hooks", "@meshfw/runtime", "pgp-utils"]) expect(FORBIDDEN.test(name)).toBe(false);
});

test("the scan itself sees every kind of import", () => {
  const sample = `import a from "one"; import type { B } from "two"; export * from "three"; import "four"; const c = await import("five"); const d = require("six");`;
  expect(specifiers(sample).sort()).toEqual(["five", "four", "one", "six", "three", "two"]);
});

test("no runtime source imports Drizzle, a driver, bun:* or a Mesh package that depends on them", () => {
  const sources = files(join(root, "src"));
  expect(sources.length).toBeGreaterThan(5);
  const forbidden = FORBIDDEN;
  const offenders = sources.flatMap((file) =>
    specifiers(readFileSync(file, "utf8")).filter((name) => forbidden.test(name)).map((name) => `${file.slice(root.length)}: ${name}`));
  expect(offenders).toEqual([]);
});

test("no runtime source mentions a Drizzle type or the Bun global outside comments", () => {
  const offenders: string[] = [];
  for (const file of files(join(root, "src"))) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (/\bdrizzle\b/i.test(code) || /\bBun\./.test(code)) offenders.push(file.slice(root.length));
  }
  expect(offenders).toEqual([]);
});

test("the package declares no Drizzle dependency", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    expect(Object.keys(manifest[field] ?? {}).filter((name) => /drizzle/i.test(name))).toEqual([]);
  }
});
