import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_TYPES, ATTRIBUTE_TYPES } from "@mesh/model";
import { buildModel, loadConfig, loadProject } from "../src/index.ts";
import { parse } from "./helpers.ts";
import { checkDocsSamples, checkMxImports, mxImports } from "./repository-checks.ts";

const root = new URL("../../../", import.meta.url).pathname;
function temporary(run: (dir: string) => void) {
  const dir = mkdtempSync(join(root, ".m1-check-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("M1 test 1: real blog example loads by path with every registered type and four actions", async () => {
  const loaded = await loadConfig(join(root, "examples/blog"));
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config).not.toBeNull();
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document?.resources).toHaveLength(1);
  const resource = built.document!.resources[0]!;
  expect(new Set(resource.attributes.filter((attribute) => attribute.source === "attribute").map((attribute) => attribute.type)))
    .toEqual(new Set(ATTRIBUTE_TYPES.map((type) => type.name)));
  expect(resource.attributes.filter((attribute) => attribute.source !== "attribute").map((attribute) => attribute.source))
    .toEqual(["uuid-primary-key", "create-timestamp", "update-timestamp"]);
  expect(new Set(resource.actions.map((action) => action.kind))).toEqual(new Set(ACTION_TYPES));
});

test("M1 test 5: real full blog fixture parses by path and fails at relationships in M7", () => {
  const file = "examples/blog/not-yet/post.full.mx";
  const source = readFileSync(join(root, file), "utf8");
  expect(parse(source, join(root, file)).diagnostics).toEqual([]);
  const built = buildModel({ root, files: [{ file, source }] });
  expect(built.document).toBeNull();
  expect(built.diagnostics[0]).toMatchObject({
    message: "Tag `relationships` is not implemented; it will be implemented in M7",
    position: { file, line: 10, column: 2 },
  });
});

test("M1 test 8: only tag-contract packages import MX across the workspace", () => {
  expect(checkMxImports(root)).toEqual([]);
});

test("M1 test 8: planted violations fail in every import form and workspace location", () => {
  const forms = [
    'import x from "@mxlang/data";', 'import "@mxlang";',
    'import type { X } from "@mxlang/core";', 'export * from "@mxlang/data";',
    'export type { X } from "@mxlang/core";', 'const x = import("@mxlang/data");',
    'const x = require("@mxlang/data");', 'type X = import("@mxlang/core").X;',
    'import x = require("@mxlang/core");', 'const x = import(`@mxlang/data`);',
  ];
  temporary((dir) => {
    for (const group of ["packages", "apps", "examples"]) mkdirSync(join(dir, group));
    for (const location of ["packages/model/src", "packages/model/test", "apps/demo/src", "examples/demo/generated"]) {
      mkdirSync(join(dir, location), { recursive: true });
      forms.forEach((form, i) => writeFileSync(join(dir, location, `${i}.ts`), form));
    }
    expect(checkMxImports(dir)).toHaveLength(forms.length * 4);
    expect(checkMxImports(dir)[0]).toContain("ADR-0043");
    for (const location of ["packages/compiler/src", "apps/docs/docs", "apps/demo/dist", "examples/demo/node_modules"]) {
      mkdirSync(join(dir, location), { recursive: true });
      writeFileSync(join(dir, location, "allowed.ts"), forms[0]!);
    }
    expect(checkMxImports(dir)).toHaveLength(forms.length * 4);
  });
});

test("M1 test 8: comments, strings and similarly named modules are not imports", () => {
  expect(mxImports('// import "@mxlang/data";\nconst text = \'require("@mxlang/core")\';\nimport "@mxlanguage/data";\nimport "@mxlang-extra";', "test.ts")).toEqual([]);
  expect(mxImports('const x = import(`@mxlang/${name}`);', "test.ts")).toEqual([]);
  expect(mxImports('const x = import(`@mxlang/data`);', "test.ts")).toEqual([{ specifier: "@mxlang/data", line: 1 }]);
});

test("Docs MX samples: complete resource blocks parse with the contracts", () => {
  const checked = checkDocsSamples(join(root, "apps/docs/docs/docs"));
  console.log(`Docs MX samples: parsed ${checked.parsed}, skipped ${checked.skipped} fragments`);
  expect(checked.errors).toEqual([]);
  expect(checked.parsed).toBeGreaterThan(0);
});

test("Docs MX samples: a planted invalid resource fails with page, fence line and diagnostic", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "bad.md"), '# Bad\n\n```mx "resources/bad.mx"\n\nresource="bad"\n  attributes\n    attribute="x" type="strnig"\n```\n');
    const checked = checkDocsSamples(dir);
    expect(checked.parsed).toBe(1);
    expect(checked.errors).toHaveLength(1);
    expect(checked.errors[0]).toBe('bad.md:3: MX block 4:19: `<attribute>`: attribute `type` must be one of "string", "integer", "float", "boolean", "uuid", "datetime", "atom", got "strnig"');
  });
});

test("Docs MX samples: fragments are skipped, other languages ignored, longer fences supported", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "good.md"), '```mx\nattribute="x" type="string"\n```\n```ts\nresource="bad"\n```\n~~~~mx title\n\nresource="ok"\n  attributes\n~~~~\n');
    expect(checkDocsSamples(dir)).toEqual({ parsed: 1, skipped: 1, errors: [] });
    writeFileSync(join(dir, "good.md"), '```mx\nattributes\n```\n');
    expect(checkDocsSamples(dir).errors).toEqual(["Docs sample check parsed no complete resource blocks"]);
  });
});
