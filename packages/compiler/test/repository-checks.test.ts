import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { ACTION_TYPES, ATTRIBUTE_TYPES } from "@meshfw/model";
import { buildModel, loadConfig, loadProject } from "../src/index.ts";
import { parse } from "./helpers.ts";
import { checkDocsSamples, checkDocsSyntaxV4, checkDrizzleImports, checkGeneratedImports, checkMxImports, checkRuntime, checkScratchPrefixes, oldSpellingInV4 } from "./repository-checks.ts";

const root = new URL("../../../", import.meta.url).pathname;
function temporary(run: (dir: string) => void) {
  const dir = mkdtempSync(join(root, ".scratch-check-"));
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
    const paths = ["examples/blog/src/schema.ts", "examples/blog/.mesh/blog/schema.ts", "examples/blog/.mesh/domain/schema.ts", "examples/blog/.mesh/domain/schema/schema.ts", "examples/blog/mesh/schema.ts", "examples/blog/.mesh/schema.js"];
    for (const path of paths) put(path, `${SCHEMA_HEADER}import "drizzle-orm";`);
    put("examples/demo/.mesh/schema.ts", 'import "drizzle-orm";');
    const errors = checkDrizzleImports(dir);
    expect(errors).toEqual([...paths.map((path) => `${path}:3:`), "examples/demo/.mesh/schema.ts:1:"].sort()
      .map((prefix) => `${prefix} Drizzle is allowed only in data adapters and the emitted schema (ADR-0014); remove drizzle-orm from this file`));
  });
});

test("M2 test 4: no generated file imports the model, the compiler, Drizzle (outside schema.ts), model.json or mesh.config (outside binding.ts)", () => {
  expect(checkGeneratedImports(root)).toEqual([]);
});

test.each(["@meshfw/model", "@meshfw/compiler", "model.json", "drizzle-orm", "drizzle-kit"])(
  "M2 test 4: a planted %s in a generated file fails, comments included", (name) => {
    workspace((dir, put) => {
      const paths = ["examples/blog/.mesh/index.ts", "examples/blog/.mesh/binding.ts", "examples/blog/.mesh/domain/blog/index.ts", "examples/blog/.mesh/domain/blog/post.actions.ts", "apps/demo/.mesh/domain/x/y.validators.js"];
      for (const path of paths) put(path, `// Do not edit\n// ${name}`);
      expect(checkGeneratedImports(dir)).toEqual(paths.sort().map((path) =>
        `${path}:2: Generated code must not import ${name} (roadmap M2, acceptance 4); it imports only @meshfw/runtime, zod, the other files of its .mesh/ tree, the adapter's schema.ts and (binding.ts only) the project's mesh.config and node:async_hooks`));
    });
  },
);

const CONFIG_TAIL = "outside .mesh/binding.ts (roadmap M2, acceptance 4); it imports only @meshfw/runtime, zod, the other files of its .mesh/ tree, the adapter's schema.ts and (binding.ts only) the project's mesh.config and node:async_hooks";

test.each([
  ["a static import", 'import config from "../mesh.config";', "../mesh.config"],
  ["a side-effect import with the extension", "import '../../../mesh.config.ts';", "../../../mesh.config.ts"],
  ["a dynamic import", "const { default: config } = await import(\"../mesh.config\");", "../mesh.config"],
  ["a dynamic import in a template literal", "await import(`../../mesh.config.js`);", "../../mesh.config.js"],
  ["a re-export", 'export { default } from "/abs/project/mesh.config";', "/abs/project/mesh.config"],
  ["a require", 'const config = require("../mesh.config.cjs");', "../mesh.config.cjs"],
  ["a commented-out import", '// import "../mesh.config";', "../mesh.config"],
])("M2 test 4: %s of mesh.config in a generated file other than .mesh/binding.ts fails", (_, text, specifier) => {
  workspace((dir, put) => {
    // `.mesh/domain/x/binding.ts` is a module's file, not the binding, so it is not exempt.
    const paths = ["examples/blog/.mesh/index.ts", "examples/blog/.mesh/load.ts", "examples/blog/.mesh/domain/blog/index.ts",
      "examples/blog/.mesh/domain/blog/post.actions.ts", "examples/blog/.mesh/domain/x/binding.ts", "apps/demo/.mesh/domain/binding.ts"];
    for (const path of paths) put(path, `// Do not edit\n${text}`);
    expect(checkGeneratedImports(dir)).toEqual(paths.sort().map((path) => `${path}:2: Generated code must not import ${specifier} ${CONFIG_TAIL}`));
  });
});

test("M2 test 4: .mesh/binding.ts may import mesh.config; a name that only contains mesh.config, or a mention outside an import, passes", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/binding.ts", '// mesh.config.ts configures the layer\nconst { default: config } = await import("../mesh.config");\nimport "../mesh.config.ts";');
    put("apps/demo/.mesh/binding.ts", 'export { default } from "../../mesh.config";');
    put("examples/blog/.mesh/index.ts", '// The data layer is the one mesh.config.ts configures.\nimport "./mesh.configuration";\nimport "./my-mesh.config.d";\nconst note = "see mesh.config";');
    expect(checkGeneratedImports(dir)).toEqual([]);
  });
});

const HOST_TAIL = "(roadmap M2, acceptance 4); it imports only @meshfw/runtime, zod, the other files of its .mesh/ tree, the adapter's schema.ts and (binding.ts only) the project's mesh.config and node:async_hooks";

test("M2 test 4: .mesh/binding.ts may import node:async_hooks, the project's async frame, and no other host module", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/binding.ts", '/// <reference types="bun" />\nimport { AsyncLocalStorage as $AsyncLocalStorage } from "node:async_hooks";\nimport { readFileSync } from "node:fs";\nconst db = await import("bun:sqlite");');
    expect(checkGeneratedImports(dir)).toEqual([
      `examples/blog/.mesh/binding.ts:3: Generated code must not import node:fs ${HOST_TAIL}`,
      `examples/blog/.mesh/binding.ts:4: Generated code must not import bun:sqlite ${HOST_TAIL}`,
    ]);
  });
});

test("M2 test 4: .mesh/binding.ts may import node:async_hooks only by that name: a bare built-in or bun is refused there too", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/binding.ts", 'import { AsyncLocalStorage } from "node:async_hooks";\nimport { AsyncLocalStorage as A } from "async_hooks";\nimport { file } from "bun";');
    expect(checkGeneratedImports(dir)).toEqual([
      `examples/blog/.mesh/binding.ts:2: Generated code must not import async_hooks ${HOST_TAIL}`,
      `examples/blog/.mesh/binding.ts:3: Generated code must not import bun ${HOST_TAIL}`,
    ]);
  });
});

test("M2 test 4: a package whose name only looks like a built-in passes", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/domain/blog/post.actions.ts", 'import { z } from "zod";\nimport "@meshfw/runtime";\nimport "./fs";\nimport "bunyan";');
    expect(checkGeneratedImports(dir)).toEqual([]);
  });
});

test.each([
  ["a static import", 'import { AsyncLocalStorage } from "node:async_hooks";'],
  ["a dynamic import", 'const hooks = await import("node:async_hooks");'],
  ["a re-export", "export { AsyncLocalStorage } from 'node:async_hooks';"],
  ["a commented-out import", '// import "node:async_hooks";'],
])("M2 test 4: %s of node:async_hooks in a generated file other than .mesh/binding.ts fails", (_, text) => {
  workspace((dir, put) => {
    const paths = ["examples/blog/.mesh/index.ts", "examples/blog/.mesh/domain/blog/index.ts", "examples/blog/.mesh/domain/blog/post.actions.ts",
      "examples/blog/.mesh/domain/x/binding.ts", "examples/blog/.mesh/schema.ts"];
    for (const path of paths) put(path, `// Do not edit\n${text}`);
    expect(checkGeneratedImports(dir)).toEqual(paths.sort().map((path) => `${path}:2: Generated code must not import node:async_hooks outside .mesh/binding.ts ${HOST_TAIL}`));
  });
});

test.each(["node:fs", "bun:sqlite", "node:path", "bun", "fs", "path", "async_hooks", "worker_threads"])("M2 test 4: a planted host module %s in a generated file fails", (specifier) => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/domain/blog/post.actions.ts", `// Do not edit\nimport x from "${specifier}";`);
    expect(checkGeneratedImports(dir)).toEqual([`examples/blog/.mesh/domain/blog/post.actions.ts:2: Generated code must not import ${specifier} ${HOST_TAIL}`]);
  });
});

test("M2 test 4: the emitted schema may import Drizzle but not the build half; model.json is not scanned; elsewhere is not generated", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/schema.ts", 'import { sqliteTable } from "drizzle-orm/sqlite-core";\nimport "@meshfw/compiler";');
    put("examples/blog/.mesh/model.json", '{"note": "drizzle-orm @meshfw/model"}');
    put("examples/blog/src/main.ts", 'import "@meshfw/model";');
    put("examples/blog/node_modules/x/.mesh/index.ts", 'import "@meshfw/model";');
    expect(checkGeneratedImports(dir)).toEqual([
      "examples/blog/.mesh/schema.ts:2: Generated code must not import @meshfw/compiler (roadmap M2, acceptance 4); it imports only @meshfw/runtime, zod, the other files of its .mesh/ tree, the adapter's schema.ts and (binding.ts only) the project's mesh.config and node:async_hooks",
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

test.each([
  ['/// <reference types="bun" />', 'types="bun'],
  ["/// <reference types='node' />", "types='node"],
  ['///<reference types = "@types/bun"/>', 'types = "@types/bun'],
  ['/// <reference types="bun-types" />', 'types="bun'],
])("M2 test 7: a reference to the host's types fails: %s", (source, forbidden) => {
  workspace((dir, put) => {
    put("packages/runtime/src/entity.ts", `// Binding in scope.\n${source}\nexport {};`);
    expect(checkRuntime(dir, "web")).toEqual([
      `packages/runtime/src/entity.ts:2: Runtime must use web-standard APIs; forbidden text ${forbidden} (including comments and strings)`,
    ]);
  });
});

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

test("Docs MX samples: a concept file is a complete fence, parsed as authored", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "concept.md"), '```mx "concepts/Money.mesh.mx"\nconcept :Money\n  integer :amount min=0\n```\n');
    expect(checkDocsSamples(dir)).toMatchObject({ parsed: 1, skipped: 0, errors: [] });
    writeFileSync(join(dir, "concept.md"), '```mx "concepts/Money.mesh.mx"\nconcept :Money\n  belongs-to :x entity=X\n```\n');
    expect(checkDocsSamples(dir).errors.join("\n")).toContain("`belongs-to` must be inside `relationships`");
  });
});

test("Docs MX samples: the architecture file is a complete fence, parsed as authored", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "architecture.md"), '```mx "src/domain/architecture.mesh.mx"\nimport { MeshRecommended } from "meshfw/architecture"\n\narchitecture :project\n  use preset=MeshRecommended\n  disable :service-touches-one-entity\n```\n');
    expect(checkDocsSamples(dir)).toMatchObject({ parsed: 1, skipped: 0, errors: [] });
    expect(checkDocsSyntaxV4(dir)).toMatchObject({ checked: 1, errors: [] });
    writeFileSync(join(dir, "architecture.md"), '```mx "src/domain/architecture.mesh.mx"\narchitecture :project\n  use\n```\n');
    expect(checkDocsSamples(dir).errors.join("\n")).toContain("`use` names what it includes");
  });
});

test("Docs MX samples: a mixin file is a complete fence, and its `&name`s, like those of an entity that uses one, are members of another fence", () => {
  temporary((dir) => {
    writeFileSync(join(dir, "mixin.md"), '```mx "src/domain/shared/audited.mesh.mx"\nmixin :Audited\n  checks\n    check :ok that=() => &amount > 0 code="a" message="a"\n```\n');
    expect(checkDocsSamples(dir)).toMatchObject({ parsed: 1, skipped: 0, errors: [] });
    expect(checkDocsSyntaxV4(dir)).toMatchObject({ checked: 1, errors: [] });
    const invoice = (use: string) => `\`\`\`mx "src/domain/billing/invoice.mesh.mx"\nimport { Audited } from "../shared/audited.mesh.mx"\n\nentity :Invoice\n${use}  attributes\n    uuid :id primary-key\n  actions\n    read :recent\n      sort\n        desc &createdBy\n\`\`\`\n`;
    writeFileSync(join(dir, "mixin.md"), invoice("  use mixin=Audited\n"));
    expect(checkDocsSyntaxV4(dir)).toMatchObject({ checked: 1, errors: [] });
    writeFileSync(join(dir, "mixin.md"), invoice(""));
    expect(checkDocsSyntaxV4(dir).errors.join("\n")).toContain("&createdBy is not a declared member of this entity");
  });
});

test("Docs MX samples: a surface file is a complete fence, parsed as authored", () => {
  temporary((dir) => {
    const surface = (line: string) => `\`\`\`mx "src/surfaces/public/public.mesh.mx"\nimport { Todo } from "../../domain/todo/todo.mesh.mx"\n\nsurface :public\n  expose :todos entity=Todo ${line}\n    action :read\n\`\`\`\n`;
    writeFileSync(join(dir, "surfaces.md"), surface('label="Todos" fields=[:id, :title]'));
    expect(checkDocsSamples(dir)).toMatchObject({ parsed: 1, skipped: 0, errors: [] });
    expect(checkDocsSyntaxV4(dir)).toMatchObject({ checked: 1, errors: [] });
    writeFileSync(join(dir, "surfaces.md"), surface('fields="title"'));
    expect(checkDocsSamples(dir).errors.join("\n")).toContain("fields must be a list of atoms");
  });
  // Only an `expose` line is exempt: elsewhere `fields=[:a]` is still the old spelling of a member reference.
  expect(oldSpellingInV4("import { Todo } from \"./todo.mesh.mx\"\nsurface :public\n  expose :todos entity=Todo fields=[:id, :title]\n")).toBeNull();
  expect(oldSpellingInV4("entity :Todo\n  identities\n    identity :ab fields=[:a]\n")).toContain("a member reference is `&name`, not an atom");
  expect(oldSpellingInV4("  expose-like :x fields=[:a]\n")).toContain("a member reference is `&name`, not an atom");
});

test("Docs MX samples: a fence uses a concept another fence of the Docs declares, and not one no fence declares", () => {
  temporary((dir) => {
    const money = '```mx "concepts/Money.mesh.mx"\nconcept :Money\n  integer :amount min=0\n```\n';
    const invoice = (head: string) => `\`\`\`mx "billing/invoice.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n    ${head} :total\n  actions auto=[:read]\n    create :open\n      input\n        &total\n\`\`\`\n`;
    writeFileSync(join(dir, "concept.md"), money);
    writeFileSync(join(dir, "entity.md"), invoice("Money"));
    expect(checkDocsSamples(dir)).toMatchObject({ parsed: 2, errors: [] });
    expect(checkDocsSyntaxV4(dir)).toMatchObject({ checked: 2, errors: [] });
    writeFileSync(join(dir, "entity.md"), invoice("Mony"));
    expect(checkDocsSamples(dir).errors.join("\n")).toContain("`Mony` is not a known tag");
    expect(checkDocsSyntaxV4(dir).errors.join("\n")).toContain("`Mony` is not a known tag");
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

// Test temp dirs inside the checkout are named `.scratch-*`, and every repository walker skips them (scan-skip.ts):
// while tests run side by side, a scan that lists a file a test then deletes throws ENOENT, and a planted or
// generated file reads as a violation. The fixtures below sit outside `packages/compiler`, so the mx rule's package
// exemption cannot make a case vacuous; each is paired with the same file outside a scratch dir, which still fails.
test("scratch dirs: the mx rule skips a .scratch-* dir and still reports the same file outside one", () => {
  workspace((dir, put) => {
    put("apps/x/.scratch-race/y.ts", 'import "@mxlang/core";');
    put("examples/x/test/.scratch-copy-abc123/src/y.ts", 'import "@mxlang/core";');
    put("packages/cli/.scratch-build-abc123/dialect.js", '// @mxlang');
    expect(checkMxImports(dir)).toEqual([]);
    put("apps/x/race/y.ts", 'import "@mxlang/core";');
    expect(checkMxImports(dir)).toEqual([
      "apps/x/race/y.ts:1: Mention of @mxlang is forbidden here (ADR-0043), including comments and strings; move the code into packages/compiler or remove the mention",
    ]);
  });
});

test("scratch dirs: the Drizzle rule skips a .scratch-* dir, at the root too, and still reports the same file outside one", () => {
  workspace((dir, put) => {
    put("examples/x/.scratch-race/y.ts", 'import "drizzle-orm";');
    put(".scratch-check-abc123/packages/model/src/bad.ts", 'import "drizzle-orm";');
    put("packages/compiler/.scratch-mesh-emit-abc123/generated/x.ts", "// drizzle-kit");
    expect(checkDrizzleImports(dir)).toEqual([]);
    put("examples/x/race/y.ts", 'import "drizzle-orm";');
    expect(checkDrizzleImports(dir)).toEqual([
      "examples/x/race/y.ts:1: Drizzle is allowed only in data adapters and the emitted schema (ADR-0014); remove drizzle-orm from this file",
    ]);
  });
});

test("scratch dirs: the generated-imports rule skips a .mesh/ tree inside a .scratch-* copy", () => {
  workspace((dir, put) => {
    put("examples/blog/.mesh/index.ts", "// Do not edit\nexport {};");
    put("examples/blog/test/.scratch-guard-abc123/.mesh/index.ts", '// Do not edit\nimport "@meshfw/model";');
    expect(checkGeneratedImports(dir)).toEqual([]);
    put("examples/blog/test/guard-abc123/.mesh/index.ts", '// Do not edit\nimport "@meshfw/model";');
    expect(checkGeneratedImports(dir)).toHaveLength(1);
  });
});

test("scratch dirs: only a segment that starts with .scratch- is skipped, and only below the scan's own root", () => {
  // `temporary()` itself lives at `<checkout>/.scratch-check-XXXXXX`: every planted case in this file reports from
  // inside it, so the skip is decided on the path relative to the root the scan was given, never on the absolute path.
  workspace((dir, put) => {
    expect(dir.split(sep).at(-1)).toStartWith(".scratch-check-");
    for (const path of ["apps/x/src/scratchpad/y.ts", "apps/x/scratch-race/y.ts", "apps/x/.scratchy/y.ts", "apps/x/my.scratch-race/y.ts", "apps/x/.scratch/y.ts"])
      put(path, 'import "@mxlang/core";');
    expect(checkMxImports(dir).map((error) => error.split(":")[0])).toEqual([
      "apps/x/.scratch/y.ts", "apps/x/.scratchy/y.ts", "apps/x/my.scratch-race/y.ts", "apps/x/scratch-race/y.ts", "apps/x/src/scratchpad/y.ts",
    ]);
  });
});

test("scratch dirs: every temp dir a test makes inside the checkout is named .scratch-*", () => {
  expect(checkScratchPrefixes(root)).toEqual([]);
});

const SCRATCH_TAIL = "Test temp dirs inside the checkout must be named .scratch-*, which repository scans skip; start the mkdtemp prefix with .scratch- or create the dir under tmpdir()";

test("scratch dirs: the prefix guard reads every mkdtemp call in the test directories", () => {
  workspace((dir, put) => {
    put("packages/x/test/bad.test.ts", [
      'const a = await mkdtemp(join(import.meta.dir, ".emitted-"));',
      'const b = await mkdtemp(resolve(import.meta.dir, "../mesh-filter-plain-"));',
      "const c = mkdtempSync(",
      '  join(root, ".m1-check-"),',
      ");",
      'const d = mkdtempSync(join(app, "scratch-samples-"));',
      'const e = mkdtempSync(join(app, ".scratchy-"));',
      'const f = mkdtempSync(join(repo, "work-"));',
    ].join("\n"));
    put("examples/x/test/good.test.ts", [
      'import { mkdtemp, mkdtempSync } from "node:fs/promises";',
      'const a = await mkdtemp(join(import.meta.dir, ".scratch-emitted-"));',
      'const b = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-filter-plain-"));',
      "const c = await mkdtemp(resolve(import.meta.dir, `../.scratch-mesh-${prefix}-`));",
      'const d = await mkdtemp(join(tmpdir(), "mesh-cli-"));',
      'const base = join(homedir(), "tmp", "mx-alpha-16");',
      'const e = mkdtempSync(join(base, "registration-"));',
    ].join("\n"));
    put("apps/x/test/helper.ts", [
      "async function generate(prefix: string, sources: object): Promise<string> {",
      "  const dir = await mkdtemp(join(import.meta.dir, prefix));",
      "  return dir;",
      "}",
      'await generate(".scratch-reads-load-", {});',
      'await generate(".reads-load-plain-", {});',
    ].join("\n"));
    put("packages/x/test/orphan.ts", "export const make = (name: string) => mkdtemp(join(import.meta.dir, name));");
    // Member calls, aliased imports and other source extensions are read too.
    put("packages/x/test/member.test.ts", [
      'import { mkdtemp as makeTemp } from "node:fs/promises";',
      'const a = await fs.mkdtemp(join(import.meta.dir, "../mesh-a-"));',
      'const b = fsp.mkdtempSync(join(root, ".bad-ns-"));',
      'const c = await makeTemp(join(import.meta.dir, ".bad-alias-"));',
      'const d = await fs.mkdtemp(join(tmpdir(), "x-"));',
      'const e = await fs.mkdtemp(join(import.meta.dir, ".scratch-ns-"));',
    ].join("\n"));
    put("packages/x/test/b.test.js", 'mkdtempSync(join(root, ".bad-js-"));');
    put("packages/x/test/c.test.tsx", 'mkdtempSync(join(root, ".bad-tsx-"));');
    // Only the first argument names the dir, and a .scratch- segment anywhere in it is enough.
    put("apps/x/test/args.test.ts", [
      'const a = await mkdtemp(join(import.meta.dir, "../.scratch-ok-"), { encoding: "utf8" });',
      'const b = await mkdtemp(join(import.meta.dir, ".scratch-x/", "mesh-d-"));',
      'const c = await mkdtemp(join(import.meta.dir, "bad-opts-"), { encoding: ".scratch-" });',
    ].join("\n"));
    // A parameter is resolved through the function that encloses the call, not the last one that declares the name.
    put("apps/x/test/enclosing.test.ts", [
      "function first(prefix: string) { return prefix; }",
      "const make = (prefix: string) => mkdtemp(join(import.meta.dir, prefix));",
      'first(".scratch-ok-");',
      'make(".bad-");',
      "async function outer(prefix: string) { return prefix; }",
      "async function inner(name: string) {",
      "  return await mkdtemp(join(import.meta.dir, name));",
      "}",
      'outer(".scratch-fine-");',
      'inner(".scratch-fine-");',
    ].join("\n"));
    put("apps/x/test/unenclosed.test.ts", [
      "function first(prefix: string) { return prefix; }",
      "const dir = mkdtemp(join(import.meta.dir, prefix));",
      'first(".scratch-ok-");',
    ].join("\n"));
    // A const base counts as outside the checkout only when every declaration of that name in the file is.
    put("examples/x/test/shadow.test.ts", [
      'const root = join(tmpdir(), "x");',
      "function g() {",
      "  const root = import.meta.dir;",
      '  return mkdtemp(join(root, "mesh-c-"));',
      "}",
      'function one() { const base = join(homedir(), "x"); return base; }',
      'function two() { const base = join(repo, "y"); return mkdtempSync(join(base, "bad-base-")); }',
    ].join("\n"));
    // Outside the test directories, and inside a scratch copy, nothing is read.
    put("packages/x/src/tool.ts", 'mkdtemp(join(import.meta.dir, ".work-"));');
    put("examples/x/test/.scratch-guard-abc/test/copy.test.ts", 'mkdtemp(join(import.meta.dir, ".work-"));');
    expect(checkScratchPrefixes(dir)).toEqual([
      `apps/x/test/args.test.ts:3: ${SCRATCH_TAIL}`,
      `apps/x/test/enclosing.test.ts:4: ${SCRATCH_TAIL}`,
      `apps/x/test/helper.ts:6: ${SCRATCH_TAIL}`,
      `apps/x/test/unenclosed.test.ts:2: ${SCRATCH_TAIL}`,
      `examples/x/test/shadow.test.ts:4: ${SCRATCH_TAIL}`,
      `examples/x/test/shadow.test.ts:7: ${SCRATCH_TAIL}`,
      `packages/x/test/b.test.js:1: ${SCRATCH_TAIL}`,
      `packages/x/test/bad.test.ts:1: ${SCRATCH_TAIL}`,
      `packages/x/test/bad.test.ts:2: ${SCRATCH_TAIL}`,
      `packages/x/test/bad.test.ts:3: ${SCRATCH_TAIL}`,
      `packages/x/test/bad.test.ts:6: ${SCRATCH_TAIL}`,
      `packages/x/test/bad.test.ts:7: ${SCRATCH_TAIL}`,
      `packages/x/test/bad.test.ts:8: ${SCRATCH_TAIL}`,
      `packages/x/test/c.test.tsx:1: ${SCRATCH_TAIL}`,
      `packages/x/test/member.test.ts:2: ${SCRATCH_TAIL}`,
      `packages/x/test/member.test.ts:3: ${SCRATCH_TAIL}`,
      `packages/x/test/member.test.ts:4: ${SCRATCH_TAIL}`,
      `packages/x/test/orphan.ts:1: ${SCRATCH_TAIL}`,
    ]);
  });
});
