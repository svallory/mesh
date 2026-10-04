import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { ACTION_TYPES, ATTRIBUTE_TYPES } from "@mesh/model";
import { buildModel, loadConfig, loadProject } from "../src/index.ts";
import { parse } from "./helpers.ts";
import { checkDocsSamples, checkMxImports } from "./repository-checks.ts";

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

function workspace(run: (dir: string, put: (path: string, text: string) => void) => void) {
  temporary((dir) => {
    for (const group of ["packages", "apps", "examples"]) mkdirSync(join(dir, group));
    run(dir, (path, text) => {
      const file = join(dir, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    });
  });
}

test.each([
  ['TS const wrapper', 'const a = import("@mxlang/data" as const);'],
  ['TS assertion wrapper', 'const a = import("@mxlang/data" as string);'],
  ['interpolated template', 'const b = import(`@mxlang/${"data"}`);'],
  ['variable template suffix', 'const b = import(`@mxlang/${name}`);'],
  ['optional require', 'const c = require?.("@mxlang/core");'],
])("M1 test 8: text rule rejects reviewer bypass %s", (_name, source) => {
  workspace((dir, put) => {
    put("apps/docs/review-bypass.ts", source!);
    expect(checkMxImports(dir)).toHaveLength(1);
    expect(checkMxImports(dir)[0]).toStartWith("apps/docs/review-bypass.ts:1:");
  });
});

test("M1 test 8: real source directories named like output and all selected extensions are scanned", () => {
  workspace((dir, put) => {
    const locations = ["apps/docs/src/build", "packages/model/src/build", "packages/model/test/site",
      "apps/demo/src/dist", "examples/demo/src/coverage", "packages/build", "apps/site", "examples/dist"];
    const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json"];
    for (const location of locations) for (const extension of extensions) put(`${location}/bad.${extension}`, '"@mxlang/data"');
    // Group-root files and package files outside src/test are included too.
    put("packages/root.ts", '"@mxlang"');
    put("packages/model/scripts/check.ts", '"@mxlang"');
    expect(checkMxImports(dir)).toHaveLength(locations.length * extensions.length + 2);
  });
});

test("M1 test 8: only exact dependency, docs output/content and lock paths are excluded", () => {
  workspace((dir, put) => {
    for (const path of ["packages/model/node_modules/bad.ts", "apps/docs/site/bad.ts", "apps/docs/docs/bad.json",
      "examples/blog/bun.lock", "apps/demo/package-lock.json", "apps/demo/bun.lock.json", "examples/blog/yarn.lock"])
      put(path, '"@mxlang/data"');
    expect(checkMxImports(dir)).toEqual([]);
    for (const path of ["apps/docs/site.ts", "apps/docs/docs.ts", "apps/demo/site/bad.ts",
      "apps/docs/site-other/bad.ts", "packages/model/src/node_modules.ts"])
      put(path, '"@mxlang/data"');
    expect(checkMxImports(dir)).toHaveLength(5);
  });
});

test.skipIf(sep !== "/")("M1 test 8: POSIX literal backslashes do not create excluded path segments", () => {
  workspace((dir, put) => {
    put("apps/docs/site\\review-import.ts", 'import "@mxlang/data";');
    put("apps/docs/site/review-import.ts", 'import "@mxlang/data";');
    expect(checkMxImports(dir)).toEqual([
      'apps/docs/site\\review-import.ts:1: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention',
    ]);
  });
});

test("M1 test 8: MX-free angle-bracket assertions and JSX never invoke a parser", () => {
  workspace((dir, put) => {
    put("packages/model/src/reviewer-valid.ts", "export const count = <number>1;");
    put("apps/demo/view.tsx", "export const view = <main />;");
    put("examples/blog/view.jsx", "export const view = <main />;");
    expect(checkMxImports(dir)).toEqual([]);
  });
});

test("M1 test 8: comments and strings intentionally fail at the first mention's line", () => {
  workspace((dir, put) => {
    put("apps/demo/comment.ts", '\n// @mxlang is intentionally forbidden even in a comment\nimport "@mxlang/data";');
    put("examples/blog/string.js", 'const text = "@mxlang-extra";');
    expect(checkMxImports(dir)).toEqual([
      'apps/demo/comment.ts:2: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention',
      'examples/blog/string.js:1: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention',
    ]);
  });
});

test("M1 test 8: compiler files are allowed to mention MX", () => {
  workspace((dir, put) => {
    put("packages/compiler/src/allowed.ts", 'import "@mxlang/data";');
    put("packages/compiler/package.json", '{"dependencies":{"@mxlang/data":"link:@mxlang/data"}}');
    put("packages/compiler-other/package.json", '{"dependencies":{"@mxlang/data":"*"}}');
    expect(checkMxImports(dir)).toHaveLength(1);
    expect(checkMxImports(dir)[0]).toStartWith("packages/compiler-other/package.json:1:");
  });
});

test.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])(
  "M1 test 8: package.json outside compiler rejects an MX dependency in %s", (field) => {
    workspace((dir, put) => {
      put("packages/model/package.json", JSON.stringify({ [field]: { "@mxlang/data": "*" } }));
      put("examples/blog/package.json", JSON.stringify({ [field]: { "@mxlang": "*" } }));
      expect(checkMxImports(dir)).toHaveLength(2);
    });
  },
);

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
