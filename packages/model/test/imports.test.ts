import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { checkSource, stripComments } from "./scan.ts";

// `model` imports nothing outside itself. The brief for M1 says "no dependency on MX, on
// @meshfw/compiler or on any other package"; that is a rule for this milestone, not a design
// rule: ADR-0033 lets build-time packages import `runtime`'s contract types, and M4 may
// move the expression tree type. Change this allow-list then, on purpose.
const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const FILE = join(srcDir, "x.ts");
const check = (src: string) => checkSource(src, FILE, srcDir);

describe("checkSource finds every way to import", () => {
  test.each([
    ["static", 'import a from "@external/data";'],
    ["type-only", 'import type { B } from "@meshfw/compiler";'],
    ["side-effect", 'import "drizzle-orm";'],
    ["re-export all", 'export * from "@external/core";'],
    ["re-export named", 'export { y } from "@external/core";'],
    ["re-export type", 'export type { Y } from "@external/core";'],
    ["dynamic", 'const z = await import("drizzle-orm/pg-core");'],
    ["require", 'const w = require("@external/data");'],
    ["import = require", 'import w = require("@external/data");'],
    ["string binding name", 'import { "x-y" as c } from "@external/core";'],
    ["quote inside a comment", 'import { a /* it\'s */ } from "drizzle-orm";'],
    ["multi-line", 'import {\n  a,\n  b,\n} from\n  "@external/core";'],
    ["node built-in", 'import { readFileSync } from "node:fs";'],
    ["bun built-in", 'import { test } from "bun:test";'],
    ["relative escape", 'import b from "../../compiler/src/contracts.ts";'],
    ["relative escape, dynamic", 'await import("../../compiler/src/contracts.ts");'],
    ["template literal", "await import(`@external/data`);"],
    ["computed dynamic", "await import(name);"],
    ["computed require", "require(name + 'x');"],
  ])("%s", (_label, src) => {
    expect(check(src).length).toBeGreaterThan(0);
  });

  test("names the offending specifier", () => {
    expect(check('import a from "@external/data";')).toEqual([
      `${FILE}: "@external/data" is not a relative import`,
    ]);
    expect(check('import b from "../../compiler/src/contracts.ts";')).toEqual([
      `${FILE}: "../../compiler/src/contracts.ts" resolves outside packages/model/src`,
    ]);
  });
});

describe("checkSource allows what model may do", () => {
  test.each([
    ["sibling", 'import type { A } from "./model.ts";'],
    ["sibling re-export", 'export * from "./position.ts";'],
    ["subdirectory", 'import { a } from "./sub/a.ts";'],
    ["parent inside src", 'import { a } from "../model.ts";'],
    ["an import word in a comment", '// import x from "@external/data"\nconst a = 1;'],
    ["an import word in a block comment", '/* import x from "@external/data" */ const a = 1;'],
    ["no imports", "export const a = 1;"],
  ])("%s", (_label, src) => {
    const file = _label === "parent inside src" ? join(srcDir, "sub", "b.ts") : FILE;
    expect(checkSource(src, file, srcDir)).toEqual([]);
  });

  test("a sibling directory with the same prefix is outside src", () => {
    expect(
      checkSource('import a from "../src-other/a.ts";', FILE, srcDir),
    ).toHaveLength(1);
  });
});

describe("stripComments", () => {
  test("keeps string contents that look like comments", () => {
    expect(stripComments('const u = "http://x"; // gone')).toBe('const u = "http://x"; ');
  });
});

describe("packages/model/src", () => {
  const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

  test("there are sources to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("every file, whatever its extension, imports only inside src", () => {
    const problems = files.flatMap((f) => checkSource(readFileSync(f, "utf8"), f, srcDir));
    expect(problems).toEqual([]);
  });
});
