// Unit tests for the selection logic of `bun run test:affected` (scripts/affected/select.ts):
// changed files + package graph + slow manifest -> packages and files. Fixtures only:
// no git, no filesystem, no spawned tests.
import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceGraph,
  commandFor,
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
  "examples/hyper/test/daemon.test.ts",
  "packages/compiler/test/expressions.test.ts",
  "examples/blog/test/blog.test.ts",
  "packages/data-sqlite/test/busy.test.ts",
  "packages/data-sqlite/test/bus-conformance.test.ts",
  "packages/cli/test/example-guard.test.ts",
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
      "packages/cli/test/example-guard.test.ts",
      "packages/data-sqlite/test/busy.test.ts",
      "packages/data-sqlite/test/bus-conformance.test.ts",
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
    expect(cli.skipSlow).toEqual(["test/example-guard.test.ts"]);
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

  test("a deleted test file runs the package's full script, not the deleted path", () => {
    const selection = selectAffected(
      [{ path: "packages/jsonrpc/test/framing.test.ts", kind: "delete" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.runs).toEqual([
      {
        dir: "packages/jsonrpc",
        name: "@meshfw/jsonrpc",
        reason: "deleted test files: test/framing.test.ts",
        files: null,
        skipSlow: [],
      },
    ]);
  });

  test("a rename within a package runs the new file; a cross-package rename runs the old package's full script", () => {
    const within = selectAffected(
      [
        { path: "packages/jsonrpc/test/old.test.ts", kind: "delete" },
        { path: "packages/jsonrpc/test/new.test.ts", kind: "add" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    expect(within.runs[0]!.files).toEqual(["test/new.test.ts"]);
    const across = selectAffected(
      [
        { path: "packages/jsonrpc/test/old.test.ts", kind: "delete" },
        { path: "packages/runtime/test/new.test.ts", kind: "add" },
      ],
      graph(),
      SLOW,
      OPTS,
    );
    expect(across.runs.map((r) => [r.dir, r.files, r.reason])).toEqual([
      ["packages/runtime", ["test/new.test.ts"], "changed test files only: test/new.test.ts"],
      ["packages/jsonrpc", null, "deleted test files: test/old.test.ts"],
    ]);
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

describe("unknown package-shaped paths", () => {
  test("a path under a directory no manifest covers runs everything, never doc-only", () => {
    const selection = selectAffected(
      [{ path: "packages/unregistered/src/index.ts", kind: "add" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.mode).toBe("all");
    expect(selection.note).toBe("changed file in a directory no workspace package covers: packages/unregistered/src/index.ts");
    expect(selection.runs).toHaveLength(graph().length);
    expect(selection.rootTests).toBe(true);
  });

  test("a deleted package directory runs everything", () => {
    const selection = selectAffected(
      [{ path: "packages/gone/src/index.ts", kind: "delete" }],
      graph(),
      SLOW,
      OPTS,
    );
    expect(selection.mode).toBe("all");
  });
});

describe("buildWorkspaceGraph", () => {
  const manifests = (order: "consumer-first" | "producer-first") => {
    const consumer = {
      dir: "packages/consumer",
      name: "consumer",
      deps: { producer: "0.0.0", runtime: "workspace:*", zod: "4.6.5" },
    };
    const producer = {
      dir: "packages/producer",
      name: "producer",
      deps: { runtime: "1.2.3" },
    };
    const runtime = { dir: "packages/runtime", name: "runtime", deps: {} };
    return order === "consumer-first" ? [consumer, producer, runtime] : [runtime, producer, consumer];
  };

  test("resolves workspace deps by name whatever the spec and the manifest order", () => {
    for (const order of ["consumer-first", "producer-first"] as const) {
      const graph0 = buildWorkspaceGraph(manifests(order));
      expect(graph0.find((w) => w.name === "consumer")!.dependsOn).toEqual(["producer", "runtime"]);
      expect(graph0.find((w) => w.name === "producer")!.dependsOn).toEqual(["runtime"]);
      expect(graph0.find((w) => w.name === "runtime")!.dependsOn).toEqual([]);
    }
  });

  test("an ordinary version naming a workspace package reaches the transitive dependents", () => {
    for (const order of ["consumer-first", "producer-first"] as const) {
      const selection = selectAffected(
        [{ path: "packages/producer/src/index.ts", kind: "modify" }],
        buildWorkspaceGraph(manifests(order)),
        [],
        OPTS,
      );
      expect([...dirs(selection)].sort()).toEqual(["packages/consumer", "packages/producer"]);
    }
  });

  test("a self-dependency is dropped", () => {
    const graph0 = buildWorkspaceGraph([
      { dir: "packages/a", name: "a", deps: { a: "workspace:*", b: "workspace:*" } },
      { dir: "packages/b", name: "b", deps: {} },
    ]);
    expect(graph0[0]!.dependsOn).toEqual(["b"]);
  });
});

describe("rootTests and commandFor", () => {
  test("a package change does not run the root script tests; a root change and --all do", () => {
    const pkg = selectAffected([{ path: "packages/model/src/index.ts", kind: "modify" }], graph(), SLOW, OPTS);
    expect(pkg.rootTests).toBe(false);
    const root = selectAffected([{ path: "scripts/verify.ts", kind: "modify" }], graph(), SLOW, OPTS);
    expect(root.mode).toBe("all");
    expect(root.rootTests).toBe(true);
    const allSel = selectAffected([], graph(), SLOW, { slow: false, all: true });
    expect(allSel.rootTests).toBe(true);
    const none = selectAffected([], graph(), SLOW, OPTS);
    expect(none.rootTests).toBe(false);
  });

  test("file-only runs append the files to a script that ends in a bare bun test, keeping prerequisites", () => {
    const run = { dir: "examples/blog", name: "blog-example", reason: "r", files: ["test/blog.test.ts"], skipSlow: [] };
    expect(commandFor(run, "mesh build --check && bun test")).toEqual(["run", "test", "--", "test/blog.test.ts"]);
    expect(commandFor(run, "bun test")).toEqual(["run", "test", "--", "test/blog.test.ts"]);
  });

  test("file-only runs fall back to the full script when narrowing is unsafe", () => {
    const run = { dir: "apps/docs", name: "mesh-docs", reason: "r", files: ["test/one.test.js"], skipSlow: [] };
    // A directory filter (`bun test test/`) plus a file name would broaden, not narrow.
    expect(commandFor(run, "bun test test/")).toEqual(["run", "test"]);
    expect(commandFor(run, undefined)).toEqual(["run", "test"]);
    expect(commandFor(run, "mesh build && bun test ./test")).toEqual(["run", "test"]);
  });

  test("slow skips append ignore patterns and --pass-with-no-tests to the full script", () => {
    const run = { dir: "packages/cli", name: "meshfw", reason: "r", files: null, skipSlow: ["test/example-guard.test.ts"] };
    expect(commandFor(run, "bun test")).toEqual([
      "run",
      "test",
      "--",
      "--pass-with-no-tests",
      "--path-ignore-patterns",
      "test/example-guard.test.ts",
    ]);
  });
});

describe("slow skips in conservative fallbacks (review round 2, F7)", () => {
  test("a deletion-only run skips the package's unchanged slow files", () => {
    const slow = [...SLOW, "packages/jsonrpc/test/slow.test.ts"];
    const selection = selectAffected(
      [{ path: "packages/jsonrpc/test/framing.test.ts", kind: "delete" }],
      graph(),
      slow,
      OPTS,
    );
    expect(selection.runs[0]!.files).toBe(null);
    expect(selection.runs[0]!.skipSlow).toEqual(["test/slow.test.ts"]);
    expect(selection.skippedSlow).toEqual(["packages/jsonrpc/test/slow.test.ts"]);
  });

  test("a live file-only run carries the skips for the full-script fallback", () => {
    const slow = [...SLOW, "packages/jsonrpc/test/slow.test.ts"];
    const selection = selectAffected(
      [{ path: "packages/jsonrpc/test/server.test.ts", kind: "modify" }],
      graph(),
      slow,
      OPTS,
    );
    expect(selection.runs[0]!.files).toEqual(["test/server.test.ts"]);
    expect(selection.runs[0]!.skipSlow).toEqual(["test/slow.test.ts"]);
  });
});
