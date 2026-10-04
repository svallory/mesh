import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const srcDir = new URL("../src/", import.meta.url).pathname;

const FORBIDDEN = [/^@mxlang(\/|$)/, /^@mesh\/compiler(\/|$)/, /^drizzle(-orm|-kit)?(\/|$)/, /^@mesh\/(?!model(\/|$))/];

/** Module specifiers from import/export-from/dynamic import/require. */
export function specifiers(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

describe("specifiers", () => {
  test("finds every import form", () => {
    const src = [
      'import a from "@mxlang/data";',
      'import type { B } from "@mesh/compiler";',
      'import "drizzle-orm";',
      'export * from "./x.ts";',
      'export { y } from "@mxlang/core";',
      'const z = await import("drizzle-orm/pg-core");',
      'const w = require("@mxlang/data");',
    ].join("\n");
    expect(specifiers(src)).toEqual([
      "@mxlang/data",
      "@mesh/compiler",
      "drizzle-orm",
      "./x.ts",
      "@mxlang/core",
      "drizzle-orm/pg-core",
      "@mxlang/data",
    ]);
  });
});

describe("packages/model/src imports", () => {
  const files = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"));

  test("there are sources to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("none import MX, @mesh/compiler, other @mesh packages or Drizzle", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const s of specifiers(readFileSync(srcDir + f, "utf8"))) {
        if (FORBIDDEN.some((re) => re.test(s))) offenders.push(`src/${f}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
