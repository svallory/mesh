// Unit tests for the selection logic of `bun run test:affected` (scripts/affected/select.ts):
// changed files + package graph + slow manifest -> packages and files. Fixtures only:
// no git, no filesystem, no spawned tests.
import { describe, expect, test } from "bun:test";
import {
  isDocChange,
  isTestFile,
  packageDirOf,
  parseNameStatus,
  selectAffected,
  type FileChange,
  type Workspace,
} from "./select.ts";

// A miniature of the real workspace graph:
//   model, runtime <- compiler <- {bus-local, data-sqlite, cli(meshfw)} <- {blog, hyper}
//   create-meshfw depends on nothing; docs (apps/docs) depends on no workspace package.
function graph(): Workspace[] {
  return [
    { dir: "packages/model", name: "@meshfw/model", dependsOn: [] },
    { dir: "packages/runtime", name: "@meshfw/runtime", dependsOn: [] },
    { dir: "packages/compiler", name: "@meshfw/compiler", dependsOn: ["@meshfw/model", "@meshfw/runtime"] },
    { dir: "packages/cli", name: "meshfw", dependsOn: ["@meshfw/compiler", "@meshfw/model", "@meshfw/runtime"] },
    { dir: "packages/create-meshfw", name: "create-meshfw", dependsOn: [] },
    { dir: "packages/bus-local", name: "@meshfw/bus-local", dependsOn: ["@meshfw/compiler", "@meshfw/data-sqlite"] },
    { dir: "packages/data-sqlite", name: "@meshfw/data-sqlite", dependsOn: ["@meshfw/data-drizzle", "@meshfw/compiler", "@meshfw/model", "@meshfw/runtime"] },
    { dir: "packages/data-drizzle", name: "@meshfw/data-drizzle", dependsOn: ["@meshfw/runtime"] },
    { dir: "packages/jsonrpc", name: "@meshfw/jsonrpc", dependsOn: ["@meshfw/runtime"] },
    { dir: "apps/docs", name: "mesh-docs", dependsOn: [] },
    { dir: "examples/blog", name: "blog-example", dependsOn: ["@meshfw/data-sqlite", "@meshfw/runtime", "meshfw"] },
    { dir: "examples/hyper", name: "hyper-example", dependsOn: ["@meshfw/bus-local", "@meshfw/data-sqlite", "@meshfw/jsonrpc", "@meshfw/runtime", "meshfw", "@meshfw/compiler"] },
  ];
}

const SLOW = [
  "packages/cli/test/cli.test.ts",
  "examples/hyper/test/daemon.test.ts",
  "packages/compiler/test/expressions.test.ts",
  "examples/blog/test/blog.test.ts",
  "packages/cli/test/example-guard.test.ts",
  "packages/cli/test/events.test.ts",
];

const OPTS = { slow: false, all: false };

function dirs(selection: ReturnType<typeof selectAffected>): string[] {
  return selection.runs.map((r) => r.dir);
}

describe("classification helpers", () => {
  test("test files follow bun's default names", () => {
    expect(isTestFile("packages/model/test/thing.test.ts")).toBe(true);
    expect(isTestFile("apps/docs/test/site.test.js")).toBe(true);
    expect(isTestFile("packages/model/test/thing_test.ts")).toBe(true);
    expect(isTestFile("packages/model/test/thing.spec.tsx")).toBe(true);
    expect(isTestFile("packages/model/test/thing_spec.mts")).toBe(true);
    expect(isTestFile("packages/cli/test/fixtures/events-golden/x.ts.golden")).toBe(false);
    expect(isTestFile("packages/model/src/index.ts")).toBe(false);
    expect(isTestFile("packages/model/test/client.ts")).toBe(false);
  });

  test("doc changes are notes/ and markdown outside apps/docs", () => {
    expect(isDocChange("notes/spec/README.md")).toBe(true);
    expect(isDocChange("CLAUDE.md")).toBe(true);
    expect(isDocChange("packages/cli/README.md")).toBe(true);
    expect(isDocChange("apps/docs/docs/docs/entities.md")).toBe(false);
    expect(isDocChange("packages/compiler/src/index.ts")).toBe(false);
  });

  test("packageDirOf maps paths into their workspace package", () => {
    expect(packageDirOf("packages/compiler/src/front-end/dialect.ts")).toBe("packages/compiler");
    expect(packageDirOf("examples/blog/test/blog.test.ts")).toBe("examples/blog");
    expect(packageDirOf("apps/docs/test/docs-samples.test.ts")).toBe("apps/docs");
    expect(packageDirOf("package.json")).toBe(null);
    expect(packageDirOf("packages")).toBe(null);
    expect(packageDirOf("notes/x.md")).toBe(null);
  });

  test("parseNameStatus reads git's name-status output, renames pre-split", () => {
    const text = "M\tpackages/model/src/index.ts\nA\tscripts/new.ts\nD\tgone.ts\n\n";
    expect(parseNameStatus(text)).toEqual([
      { path: "packages/model/src/index.ts", kind: "modify" },
      { path: "scripts/new.ts", kind: "add" },
      { path: "gone.ts", kind: "delete" },
    ] satisfies FileChange[]);
  });
});

describe("selectAffected", () => {
  test("a compiler change selects the compiler and every transitive dependent", () => {
    const selection = selectAffected(
      [{ path: "packages/compiler/src/front-end/dialect.ts", kind: "modify" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.mode).toBe("packages");
    expect(dirs(selection)).toEqual([
      "packages/compiler",
      "packages/cli",
      "packages/bus-local",
      "packages/data-sqlite",
      "examples/blog",
      "examples/hyper",
    ]);
    const compiler = selection.runs[0]!;
    expect(compiler.reason).toBe("changed packages/compiler/src/front-end/dialect.ts");
    // expressions.test.ts is slow and did not change: skipped.
    expect(compiler.skipSlow).toEqual(["test/expressions.test.ts"]);
    expect(selection.skippedSlow).toEqual([
      "packages/compiler/test/expressions.test.ts",
      "packages/cli/test/cli.test.ts",
      "packages/cli/test/example-guard.test.ts",
      "packages/cli/test/events.test.ts",
      "examples/blog/test/blog.test.ts",
      "examples/hyper/test/daemon.test.ts",
    ]);
  });

  test("a leaf package change selects only that package", () => {
    const selection = selectAffected(
      [{ path: "packages/create-meshfw/src/bin.ts", kind: "modify" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(dirs(selection)).toEqual(["packages/create-meshfw"]);
  });

  test("a model change reaches its dependents but not runtime, jsonrpc or the docs", () => {
    // runtime does not depend on model, so a model change cannot break it.
    const selection = selectAffected(
      [{ path: "packages/model/src/index.ts", kind: "modify" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(dirs(selection)).toEqual([
      "packages/model",
      "packages/compiler",
      "packages/cli",
      "packages/bus-local",
      "packages/data-sqlite",
      "examples/blog",
      "examples/hyper",
    ]);
  });

  test("a changed test file in an otherwise-untouched package runs only that file", () => {
    const selection = selectAffected(
      [{ path: "packages/jsonrpc/test/server.test.ts", kind: "modify" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.runs).toEqual([
      {
        dir: "packages/jsonrpc",
        name: "@meshfw/jsonrpc",
        reason: "changed test files only: test/server.test.ts",
        files: ["test/server.test.ts"],
        skipSlow: [],
      },
    ]);
  });

  test("a package with a test-file change and a source change runs its full script", () => {
    const selection = selectAffected(
      [
        { path: "packages/jsonrpc/test/server.test.ts", kind: "modify" },
        { path: "packages/jsonrpc/src/server.ts", kind: "modify" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    expect(dirs(selection)).toEqual(["packages/jsonrpc", "examples/hyper"]);
    expect(selection.runs[0]!.files).toBe(null);
  });

  test("a root config change runs everything", () => {
    for (const path of ["package.json", "bun.lock", "tsconfig.base.json", "scripts/verify.ts", ".github/workflows/verify.yml"]) {
      const selection = selectAffected([{ path, kind: "modify" }], graph(), SLOW, OPTS);
      expect(selection.mode).toBe("all");
      expect(selection.runs).toHaveLength(graph().length);
      const sorted = [...selection.skippedSlow].sort();
      expect(sorted).toEqual([...SLOW].sort());
    }
  });

  test("an unknown root-level file runs everything too", () => {
    const selection = selectAffected([{ path: "bunfig.toml", kind: "modify" }], graph(), SLOW, OPTS);
    expect(selection.mode).toBe("all");
    expect(selection.note).toBe("changed file outside every package: bunfig.toml");
  });

  test("a notes-only or markdown-only change runs nothing", () => {
    const selection = selectAffected(
      [
        { path: "notes/spec/actions.md", kind: "modify" },
        { path: "README.md", kind: "modify" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.mode).toBe("none");
    expect(selection.note).toContain("documentation-only");
  });

  test("docs-site markdown is a package change, not a doc-only change", () => {
    const selection = selectAffected(
      [{ path: "apps/docs/docs/docs/entities.md", kind: "modify" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(dirs(selection)).toEqual(["apps/docs"]);
  });

  test("a changed slow file runs; the others are still skipped", () => {
    const selection = selectAffected(
      [
        { path: "packages/compiler/src/index.ts", kind: "modify" },
        { path: "packages/compiler/test/expressions.test.ts", kind: "modify" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    const compiler = selection.runs.find((r) => r.dir === "packages/compiler")!;
    expect(compiler.skipSlow).toEqual([]);
    const cli = selection.runs.find((r) => r.dir === "packages/cli")!;
    expect(cli.skipSlow).toEqual(["test/cli.test.ts", "test/example-guard.test.ts", "test/events.test.ts"]);
  });

  test("--slow skips nothing", () => {
    const selection = selectAffected(
      [{ path: "packages/compiler/src/index.ts", kind: "modify" }],
      graph(),
      SLOW,
      { slow: true, all: false },
    );
    expect(selection.skippedSlow).toEqual([]);
  });

  test("--all selects every package with reason run everything, slow files skipped", () => {
    const selection = selectAffected([], graph(), SLOW, { slow: false, all: true });
    expect(selection.runs).toHaveLength(graph().length);
      expect(selection.runs.every((r) => r.reason === "run everything" && r.files === null)).toBe(true);
      const sorted = [...selection.skippedSlow].sort();
      expect(sorted).toEqual([...SLOW].sort());
  });

  test("a deleted file selects its former package", () => {
    const selection = selectAffected(
      [{ path: "packages/jsonrpc/test/framing.test.ts", kind: "delete" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.runs[0]!.files).toEqual(["test/framing.test.ts"]);
  });

  test("a renamed file (split into delete + add) selects the new package and runs the new test file", () => {
    const selection = selectAffected(
      [
        { path: "packages/jsonrpc/test/old.test.ts", kind: "delete" },
        { path: "packages/jsonrpc/test/new.test.ts", kind: "add" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.runs[0]!.files).toEqual(["test/old.test.ts", "test/new.test.ts"]);
  });

  test("no changes against the base selects nothing", () => {
    const selection = selectAffected([], graph(), SLOW, OPTS);
    expect(selection.mode).toBe("none");
    expect(selection.note).toBe("no changes against the base");
  });

  test("a doc change plus a package change still selects the package", () => {
    const selection = selectAffected(
      [
        { path: "notes/x.md", kind: "modify" },
        { path: "packages/model/src/index.ts", kind: "modify" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    expect(dirs(selection)).toContain("packages/model");
    expect(dirs(selection)).not.toContain("apps/docs");
  });
});
