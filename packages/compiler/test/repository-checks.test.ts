import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { ACTION_TYPES, ATTRIBUTE_TYPES } from "@meshfw/model";
import { buildModel, loadConfig, loadProject } from "../src/index.ts";
import { parse } from "./helpers.ts";
import { checkDocsSamples, checkDrizzleImports, checkGeneratedImports, checkMxImports, checkRuntime } from "./repository-checks.ts";

const root = new URL("../../../", import.meta.url).pathname;
function temporary(run: (dir: string) => void) {
  const dir = mkdtempSync(join(root, ".m1-check-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("real v4 blog loads by path with every registered type", async () => {
  const loaded = await loadConfig(join(root, "examples/blog"));
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config).not.toBeNull();
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  const entity = built.document!.entities.find((e) => e.name === "Post")!;
  expect(entity).toBeDefined();
  expect(new Set(entity.attributes.map((attribute) => attribute.type))).toEqual(new Set(ATTRIBUTE_TYPES.map((type) => type.name)));
  expect(new Set([...entity.actions.map((action) => action.kind), ...entity.auto])).toEqual(new Set(ACTION_TYPES));
});

test("full blog post, members included, parses and builds", () => {
  const files = ["post", "user", "comment"].map((name) => {
    const file = `examples/blog/src/domain/blog/${name}.mesh.mx`;
    return { file, source: readFileSync(join(root, file), "utf8") };
  });
  const [post] = files;
  expect(parse(post!.source, join(root, post!.file)).diagnostics).toEqual([]);
  const built = buildModel({ root, files });
  expect(built.diagnostics).toEqual([]);
  expect(built.document?.entities[0]?.name).toBe("Post");
  const entity = built.document!.entities[0]!;
  expect(entity.onLoad?.name).toBe("published");
  expect(entity.actions.find((action) => action.kind === "read")?.sort).toEqual([
    expect.objectContaining({ direction: "desc", member: expect.objectContaining({ name: "insertedAt" }) }),
  ]);
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

// ADR-0065: the docs site highlights `mx` fences with MX's own highlighter, so
// the one package name it may mention outside `packages/compiler` is the grammar
// package. The vocabulary's own packages stay forbidden there, and so does a name
// that merely starts with the highlighter's.
test("M1 test 8: the docs app may mention only the highlighter, not the vocabulary", () => {
  workspace((dir, put) => {
    put("apps/docs/plugins/mx-highlight.js", 'import { renderMx } from "@mxlang/tree-sitter-mx/docmd";');
    put("apps/docs/package.json", '  "devDependencies": { "@mxlang/tree-sitter-mx": "0.1.0-alpha.1" }');
    put("apps/docs/test/mx-highlight.test.js", '// see ADR-0065 and @mxlang/tree-sitter-mx');
    expect(checkMxImports(dir)).toEqual([]);
    for (const path of ["packages/model/src/core.ts", "apps/demo/data.ts", "examples/blog/core.mjs"])
      put(path, 'import "@mxlang/core";');
    expect(checkMxImports(dir)).toHaveLength(3);
  });
});

test("M1 test 8: a name that only starts with the highlighter is still forbidden", () => {
  workspace((dir, put) => {
    put("apps/docs/plugins/data.js", 'import { data } from "@mxlang/tree-sitter-mx-data";');
    put("apps/docs/plugins/shorthand.js", 'import x from "@mxlang/tree-sitter-mx.js";');
    put("apps/docs/plugins/other.js", 'import { data } from "@mxlang/data";');
    expect(checkMxImports(dir)).toHaveLength(3);
  });
});

test("M1 test 8: the highlighter alongside the vocabulary in one file is one finding", () => {
  workspace((dir, put) => {
    put("apps/docs/plugins/both.js", [
      'import { renderMx } from "@mxlang/tree-sitter-mx/docmd";',
      '// and the vocabulary, which is never allowed here:',
      'import { parseData } from "@mxlang/data";',
      '',
    ].join("\n"));
    expect(checkMxImports(dir)).toEqual([
      'apps/docs/plugins/both.js:3: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention',
    ]);
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

const SCHEMA_HEADER = "// Do not edit this file by hand.\n// It is generated by `mesh build` from the entity files; change them and rebuild.\n";

test("M2 test 4: Drizzle is imported only by data adapters and the emitted schema", () => {
  expect(checkDrizzleImports(root)).toEqual([]);
});

test.each(["drizzle-orm", "drizzle-kit"])("M2 test 4: planted Drizzle mentions outside the allow-list fail for %s", (name) => {
  workspace((dir, put) => {
    const paths = ["packages/compiler/src/bad.ts", "packages/runtime/src/bad.ts", "packages/cli/src/bad.ts", "packages/model/test/bad.js",
      "apps/demo/src/build/bad.mts", "examples/demo/.mesh/post.types.ts", "scripts/bad.ts", "packages/data/src/bad.ts",
      "packages/compiler/test/fixtures/fake-adapter/build.ts", "examples/demo/src/schema.ts", "tsconfig.json"];
    for (const path of paths) put(path, `\n// ${name}`);
    const errors = checkDrizzleImports(dir);
    expect(errors).toHaveLength(paths.length);
    for (const path of paths) expect(errors).toContain(`${path}:2: Drizzle is allowed only in data adapters and the emitted schema (ADR-0014); remove ${name} from this file`);
  });
});

test("M2 test 4: the allow-list is data adapters, emitted schemas, manifests, lockfiles and the rule itself", () => {
  workspace((dir, put) => {
    for (const path of ["packages/data-sqlite/src/index.ts", "packages/data-drizzle/test/x.test.ts", "packages/data-postgres/src/build.ts",
      "examples/demo/package.json", "bun.lock", "apps/docs/docs/docs/page.md", "apps/docs/docmd.config.json",
      "packages/compiler/test/repository-checks.ts", "packages/compiler/test/repository-checks.test.ts", "examples/demo/node_modules/db/index.ts"]) put(path, '"drizzle-orm"');
    put("examples/blog/.mesh/schema.ts", `${SCHEMA_HEADER}import "drizzle-orm/sqlite-core";`);
    put("apps/other/.mesh/schema.ts", `${SCHEMA_HEADER}import "drizzle-orm/sqlite-core";`);
    expect(checkDrizzleImports(dir)).toEqual([]);
  });
});

test("M2 test 4: a schema.ts is exempt only at .mesh/schema.ts with the generated header", () => {
  workspace((dir, put) => {
    const paths = ["examples/blog/src/schema.ts", "examples/blog/.mesh/blog/schema.ts", "examples/blog/mesh/schema.ts", "examples/blog/.mesh/schema.js"];
    for (const path of paths) put(path, `${SCHEMA_HEADER}import "drizzle-orm";`);
    put("examples/demo/.mesh/schema.ts", 'import "drizzle-orm";');
    const errors = checkDrizzleImports(dir);
    expect(errors).toEqual([...paths.map((path) => `${path}:3:`), "examples/demo/.mesh/schema.ts:1:"].sort()
      .map((prefix) => `${prefix} Drizzle is allowed only in data adapters and the emitted schema (ADR-0014); remove drizzle-orm from this file`));
  });
});

test("M2 test 4: no generated file imports the model, the compiler, Drizzle (outside schema.ts) or model.json", () => {
  expect(checkGeneratedImports(root)).toEqual([]);
});

test.each(["@meshfw/model", "@meshfw/compiler", "model.json", "drizzle-orm", "drizzle-kit"])(
  "M2 test 4: a planted %s in a generated file fails, comments included", (name) => {
    workspace((dir, put) => {
      const paths = ["examples/blog/.mesh/index.ts", "examples/blog/.mesh/blog/post.actions.ts", "apps/demo/.mesh/x/y.validators.js"];
      for (const path of paths) put(path, `// Do not edit\n// ${name}`);
      expect(checkGeneratedImports(dir)).toEqual(paths.sort().map((path) =>
        `${path}:2: Generated code must not import ${name} (roadmap M2, acceptance 4); it imports only @meshfw/runtime, zod, its sibling files, the adapter's schema.ts and (index.ts only) ../mesh.config`));
    });
  },
);

test("M2 test 4: the emitted schema may import Drizzle but not the build half; model.json is not scanned; elsewhere is not generated", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/schema.ts", 'import { sqliteTable } from "drizzle-orm/sqlite-core";\nimport "@meshfw/compiler";');
    put("examples/blog/.mesh/model.json", '{"note": "drizzle-orm @meshfw/model"}');
    put("examples/blog/src/main.ts", 'import "@meshfw/model";');
    put("examples/blog/node_modules/x/.mesh/index.ts", 'import "@meshfw/model";');
    expect(checkGeneratedImports(dir)).toEqual([
      "examples/blog/.mesh/schema.ts:2: Generated code must not import @meshfw/compiler (roadmap M2, acceptance 4); it imports only @meshfw/runtime, zod, its sibling files, the adapter's schema.ts and (index.ts only) ../mesh.config",
    ]);
  });
});

test("M2 test 4: finding no generated files is an error, never a vacuous pass", () => {
  workspace((dir, put) => {
    put("examples/blog/src/main.ts", "export {};");
    expect(checkGeneratedImports(dir)).toEqual(["examples: No generated .mesh/ files scanned"]);
  });
});

test("M2 test 4: runtime imports no model, compiler or Drizzle", () => {
  expect(checkRuntime(root, "imports")).toEqual([]);
});

test("M2 test 7: runtime uses web-standard APIs only", () => {
  expect(checkRuntime(root, "web")).toEqual([]);
});

test.each(["@meshfw/model", "@meshfw/compiler", "drizzle-orm", "drizzle-kit"])(
  "M2 test 4: planted source mention of %s fails", (name) => {
    workspace((dir, put) => {
      put("packages/runtime/package.json", "{}");
      put("packages/runtime/src/nested/file.unusual", `\n// ${name}`);
      expect(checkRuntime(dir, "imports")).toEqual([
        `packages/runtime/src/nested/file.unusual:2: Runtime must not mention ${name}; move build-time or database-specific code out of runtime`,
      ]);
    });
  },
);

test.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"])(
  "M2 test 4: planted forbidden dependencies fail in %s", (field) => {
    workspace((dir, put) => {
      put("packages/runtime/src/index.ts", "export {};");
      const names = ["@meshfw/model", "@meshfw/compiler", "drizzle-orm", "drizzle-kit"];
      put("packages/runtime/package.json", JSON.stringify({ [field]: field.startsWith("bundle") ? names : Object.fromEntries(names.map((name) => [name, "*"])) }));
      expect(checkRuntime(dir, "imports")).toHaveLength(4);
      expect(checkRuntime(dir, "imports").every((error) => error.startsWith("packages/runtime/package.json:1:"))).toBe(true);
    });
  },
);

for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  test.each(["@meshfw/model", "@meshfw/compiler", "drizzle-orm", "drizzle-kit"])(
    `M2 test 4: planted npm alias for %s fails in ${field}`, (name) => {
      workspace((dir, put) => {
        put("packages/runtime/src/alias.ts", 'import { x } from "db/subpath";');
        put("packages/runtime/package.json", `{\n"${field}": {"db": "npm:${name}@0.45.3"}\n}`);
        expect(checkRuntime(dir, "imports")).toEqual([
          `packages/runtime/package.json:2: Runtime manifest must not mention ${name} anywhere, including keys and values`,
        ]);
      });
    },
  );
}

test.each(["@meshfw/model", "@meshfw/compiler", "drizzle-orm", "drizzle-kit"])(
  "M2 test 4: whole manifest text rejects %s outside dependency fields", (name) => {
    workspace((dir, put) => {
      put("packages/runtime/src/index.ts", "export {};");
      put("packages/runtime/package.json", JSON.stringify({ description: `Uses ${name}` }));
      expect(checkRuntime(dir, "imports")).toEqual([
        `packages/runtime/package.json:1: Runtime manifest must not mention ${name} anywhere, including keys and values`,
      ]);
    });
  },
);

const nonWebForms = ["bun", "node"].flatMap((host) => ["'", '"', "`"].flatMap((quote) => [
  `import { x } from ${quote}${host}:test${quote};`,
  `export { x } from ${quote}${host}:test${quote};`,
  `import( ${quote}${host}:test${quote});`,
  `require( ${quote}${host}:test${quote});`,
  `import ${quote}${host}:test${quote};`,
]));
test.each([...nonWebForms, "Bun.file('x')", "Bun [ 'file' ]('x')", "Bun\n.write('x', '')"])(
  "M2 test 7: planted non-web API fails: %s", (source) => {
    workspace((dir, put) => {
      put("packages/runtime/src/nested/bad.ts", `\n${source}`);
      const errors = checkRuntime(dir, "web");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toStartWith("packages/runtime/src/nested/bad.ts:2:");
    });
  },
);

const hostBypasses = ["bun", "node"].flatMap((host) => [
  [`import fs from /* explanation */ "${host}:fs";`, `${host}:`, 2],
  [`const sqlite = await import(/* explanation */ "${host}:sqlite");`, `${host}:`, 2],
  [`import /* note */ "${host}:sqlite";`, `${host}:`, 2],
  [`export * from /* note */ '${host}:fs';`, `${host}:`, 2],
  [`require /* note */ ('${host}:fs');`, `${host}:`, 2],
  [`import(// explanation\n"${host}:fs");`, `${host}:`, 3],
  [`// ${host}: is forbidden even in a comment`, `${host}:`, 2],
  [`const text = "${host}: is forbidden even in a string";`, `${host}:`, 2],
] as const);
const globalBypasses = ["Bun?.file('x')", "const { file } = globalThis.Bun;", 'globalThis["Bun"]', "// Bun", 'const text = "Bun";']
  .map((source) => [source, "Bun", 2] as const);
test.each([...hostBypasses, ...globalBypasses])(
  "M2 test 7: plain text rejects reviewer bypass: %s", (source, forbidden, line) => {
    workspace((dir, put) => {
      put("packages/runtime/src/review-probe.ts", `\n${source}`);
      expect(checkRuntime(dir, "web")).toEqual([
        `packages/runtime/src/review-probe.ts:${line}: Runtime must use web-standard APIs; forbidden text ${forbidden} (including comments and strings)`,
      ]);
    });
  },
);

test.each(["imports", "web"] as const)("M2 runtime %s scan fails closed with no source files", (rule) => {
  workspace((dir, put) => {
    put("packages/runtime/package.json", "{}");
    expect(checkRuntime(dir, rule)).toContain("packages/runtime/src: No runtime source files scanned");
    mkdirSync(join(dir, "packages/runtime/src"));
    expect(checkRuntime(dir, rule)).toContain("packages/runtime/src: No runtime source files scanned");
  });
});

test("M2 runtime scans every regular file under src regardless of extension or directory name", () => {
  workspace((dir, put) => {
    put("packages/runtime/package.json", "{}");
    for (const path of ["build/bad.ts", "node_modules/bad.js", "bun.lock", "nested/text", "site/bad.json"]) {
      put(`packages/runtime/src/${path}`, '// @meshfw/model\nimport "bun:test";');
    }
    expect(checkRuntime(dir, "imports")).toHaveLength(5);
    expect(checkRuntime(dir, "web")).toHaveLength(5);
  });
});

test("M2 runtime checks exclude tests and accept ordinary web-standard code", () => {
  workspace((dir, put) => {
    put("packages/runtime/package.json", "{}");
    put("packages/runtime/test/allowed.test.ts", 'import { test } from "bun:test"; // @meshfw/model');
    put("packages/runtime/src/index.ts", 'export const parsed = JSON.parse("{}"); const notBun = {}; const Bunny = "bun";');
    expect(checkRuntime(dir, "web")).toEqual([]);
    expect(checkRuntime(dir, "imports")).toEqual([]);
  });
});

test("Docs MX samples: complete entity blocks parse with the contracts", () => {
  const checked = checkDocsSamples(join(root, "apps/docs/docs/docs"));
  expect(checked).not.toHaveProperty("deferred");
  expect(checked.errors).toEqual([]);
  expect(checked.parsed).toBeGreaterThan(0);
});

test("Docs MX samples: a planted invalid entity fails with page, fence line and diagnostic", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "bad.md"), '# Bad\n\n```mx "todo/bad.mesh.mx"\nentity :Bad\n  attributes\n    strnig :x\n```\n');
    const checked = checkDocsSamples(dir);
    expect(checked.parsed).toBe(1);
    expect(checked.errors.length).toBeGreaterThan(0);
    expect(checked.errors.join("\n")).toContain('bad.md:3: MX block 3:5:');
    expect(checked.errors.join("\n")).toContain('strnig');
  });
});

test("Docs MX samples: fragments are skipped, other languages ignored, longer fences supported", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "good.md"), '```mx\nstring :x\n```\n```ts\nrecord="bad"\n```\n~~~~mx title\n\nentity :Ok\n  attributes\n~~~~\n');
    expect(checkDocsSamples(dir)).toMatchObject({ parsed: 1, skipped: 1, errors: [] });
    writeFileSync(join(dir, "good.md"), '```mx\nattributes\n```\n');
    expect(checkDocsSamples(dir).errors).toEqual(["Docs sample check parsed no complete entity blocks"]);
  });
});

test.each(['resource="Todo"', 'resource :Todo'])("Docs MX samples: obsolete root %s fails v4 rather than being skipped", (source) => {
  temporary((dir) => {
    writeFileSync(join(dir, "old.md"), `\`\`\`mx\n${source}\n\`\`\`\n`);
    const checked = checkDocsSamples(dir);
    expect(checked.parsed).toBe(1);
    expect(checked.skipped).toBe(0);
    expect(checked.errors).toContain("old.md:1: MX fence is not written in syntax v4: use entity :Name, not resource");
  });
});

test("Docs MX samples: removed vocabulary is an error, never deferred", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "old.md"), '```mx\nentity :Todo module="todo"\n```\n');
    const checked = checkDocsSamples(dir);
    expect(checked.parsed).toBe(1);
    expect(checked.errors.join("\n")).toContain("module");
  });
});
