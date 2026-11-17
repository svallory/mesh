import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROUPS_FILE,
  ROOT_STEPS,
  STEPS,
  checkGroups,
  parseVerifyArgs,
  planAll,
  planGroup,
  readWorkspace,
  type Manifest,
  type Step,
  type VerifyGroups,
} from "./plan.ts";

const root = join(import.meta.dir, "../..");

// A fixture workspace: one package with every step but conformance, one with conformance, one with no `test`,
// and one with no scripts at all.
const dirs = ["apps/site", "examples/demo", "packages/core", "packages/empty"];
const manifests = new Map<string, Manifest>([
  ["apps/site", { name: "site", scripts: { build: "x", validate: "x", typecheck: "x" } }],
  ["examples/demo", { name: "demo", scripts: { conformance: "x", test: "x", dev: "x" } }],
  ["packages/core", { name: "@x/core", scripts: { test: "x", typecheck: "x", build: "x", validate: "x" } }],
  ["packages/empty", { name: "@x/empty" }],
]);
const groups = (shape: VerifyGroups["groups"]): VerifyGroups => ({ groups: shape });
const valid = groups({
  core: { packages: ["packages/core", "packages/empty"] },
  rest: { root: true, packages: ["apps/site", "examples/demo"] },
});
const labels = (steps: Step[]) => steps.map((step) => step.label);
const key = (step: Step) => `${step.cwd}\0${step.label}\0${step.argv.join(" ")}`;

describe("planAll", () => {
  test("root steps first, then each package in order with the steps it defines, in STEPS order", () => {
    const steps = planAll(dirs, manifests);
    expect(labels(steps)).toEqual([
      "mesh (.): typecheck scripts",
      "mesh (.): test scripts",
      "site (apps/site): typecheck",
      "site (apps/site): build",
      "site (apps/site): validate",
      "demo (examples/demo): test",
      "demo (examples/demo): conformance",
      "@x/core (packages/core): test",
      "@x/core (packages/core): typecheck",
      "@x/core (packages/core): build",
      "@x/core (packages/core): validate",
    ]);
    expect(steps[0]).toEqual({ label: "mesh (.): typecheck scripts", cwd: ".", argv: ["bunx", "tsc", "--noEmit"] });
    expect(steps[1]).toEqual({ label: "mesh (.): test scripts", cwd: ".", argv: ["bun", "test", "scripts/"] });
    expect(steps.at(-1)).toEqual({ label: "@x/core (packages/core): validate", cwd: "packages/core", argv: ["bun", "run", "validate"] });
  });

  test("an empty script is not a step", () => {
    const steps = planAll(["p"], new Map([["p", { name: "p", scripts: { test: "" } }]]));
    expect(labels(steps)).toEqual(labels([...ROOT_STEPS]));
  });

  test("the real repository: root steps, then every package's defined STEPS in sorted order", async () => {
    const workspace = await readWorkspace(root);
    expect(workspace.dirs).toEqual([...workspace.dirs].sort());
    const expected: string[] = ROOT_STEPS.map((step) => step.label);
    for (const dir of workspace.dirs) {
      const pkg = workspace.manifests.get(dir)!;
      for (const step of STEPS) if (pkg.scripts?.[step]) expected.push(`${pkg.name} (${dir}): ${step}`);
    }
    expect(labels(planAll(workspace.dirs, workspace.manifests))).toEqual(expected);
  });
});

describe("planGroup", () => {
  const all = planAll(dirs, manifests);

  test("a group without root gets only its packages' steps, order kept", () => {
    expect(labels(planGroup(all, valid, "core"))).toEqual([
      "@x/core (packages/core): test",
      "@x/core (packages/core): typecheck",
      "@x/core (packages/core): build",
      "@x/core (packages/core): validate",
    ]);
  });

  test("the root group gets the root steps first, then its packages", () => {
    expect(labels(planGroup(all, valid, "rest"))).toEqual([
      "mesh (.): typecheck scripts",
      "mesh (.): test scripts",
      "site (apps/site): typecheck",
      "site (apps/site): build",
      "site (apps/site): validate",
      "demo (examples/demo): test",
      "demo (examples/demo): conformance",
    ]);
  });

  test("an unknown name throws, inherited object keys included", () => {
    expect(() => planGroup(all, valid, "ghost")).toThrow("unknown group ghost");
    expect(() => planGroup(all, valid, "toString")).toThrow("unknown group toString");
  });

  test("the real groups file: the union of every group is exactly planAll, as a multiset", async () => {
    const workspace = await readWorkspace(root);
    const real: VerifyGroups = await Bun.file(join(root, GROUPS_FILE)).json();
    const everything = planAll(workspace.dirs, workspace.manifests);
    const union = Object.keys(real.groups).flatMap((name) => planGroup(everything, real, name));
    expect(union.map(key).sort()).toEqual(everything.map(key).sort());
    expect(union.length).toBe(everything.length);
  });
});

describe("checkGroups", () => {
  test("a valid file has no problems", () => {
    expect(checkGroups(dirs, valid)).toEqual([]);
  });

  test("a package in no group", () => {
    const file = groups({ core: { packages: ["packages/core"] }, rest: { root: true, packages: ["apps/site", "examples/demo"] } });
    expect(checkGroups(dirs, file)).toEqual([
      "verify: packages/empty is in no group in scripts/verify-groups.json; add it to one",
    ]);
  });

  test("a package in two groups, and in three", () => {
    const two = groups({ ...valid.groups, extra: { packages: ["packages/core"] } });
    expect(checkGroups(dirs, two)).toEqual([
      "verify: packages/core is in groups core and extra in scripts/verify-groups.json; keep it in one",
    ]);
    const three = groups({ ...two.groups, more: { packages: ["packages/core"] } });
    expect(checkGroups(dirs, three)).toEqual([
      "verify: packages/core is in groups core, extra and more in scripts/verify-groups.json; keep it in one",
    ]);
  });

  test("a package listed twice in one group is not a second group", () => {
    const file = groups({ ...valid.groups, core: { packages: ["packages/core", "packages/core", "packages/empty"] } });
    expect(checkGroups(dirs, file)).toEqual([]);
  });

  test("a group naming a directory that is not a workspace package", () => {
    const file = groups({ ...valid.groups, core: { packages: ["packages/core", "packages/empty", "packages/ghost"] } });
    expect(checkGroups(dirs, file)).toEqual([
      "verify: group core lists packages/ghost, which is not a workspace package",
    ]);
  });

  test("zero root groups, and two", () => {
    const none = groups({ core: valid.groups.core!, rest: { packages: ["apps/site", "examples/demo"] } });
    expect(checkGroups(dirs, none)).toEqual(['verify: exactly one group must have "root": true; found 0']);
    const two = groups({ core: { ...valid.groups.core!, root: true }, rest: valid.groups.rest! });
    expect(checkGroups(dirs, two)).toEqual(['verify: exactly one group must have "root": true; found 2']);
  });

  test("the real groups file against the real workspace has no problems", async () => {
    const workspace = await readWorkspace(root);
    const real: VerifyGroups = await Bun.file(join(root, GROUPS_FILE)).json();
    expect(checkGroups(workspace.dirs, real)).toEqual([]);
  });
});

describe("parseVerifyArgs", () => {
  test("no arguments runs everything", () => {
    expect(parseVerifyArgs([])).toEqual({ group: undefined });
  });

  test("--group takes the next argument", () => {
    expect(parseVerifyArgs(["--group", "cli"])).toEqual({ group: "cli" });
  });

  test("--group without a name", () => {
    expect(parseVerifyArgs(["--group"])).toEqual({ error: "verify: --group requires a group name" });
    expect(parseVerifyArgs(["--group", ""])).toEqual({ error: "verify: --group requires a group name" });
    expect(parseVerifyArgs(["--group", "--group"])).toEqual({ error: "verify: --group requires a group name" });
  });

  test("an unknown argument", () => {
    expect(parseVerifyArgs(["--slow"])).toEqual({ error: "verify: unknown argument: --slow" });
    expect(parseVerifyArgs(["cli"])).toEqual({ error: "verify: unknown argument: cli" });
  });
});

describe("the workflow", () => {
  const workflow = Bun.file(join(root, ".github/workflows/verify.yml")).text();

  /** The lines of one top-level job under `jobs:`, from its `  name:` header to the next job. */
  async function job(id: string): Promise<string> {
    const lines = (await workflow).split("\n");
    const start = lines.indexOf(`  ${id}:`);
    if (start < 0) throw new Error(`no job ${id}`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
    return rest.slice(0, end < 0 ? undefined : end).join("\n");
  }

  test("the matrix lists exactly the groups file's names, in its order", async () => {
    const real: VerifyGroups = await Bun.file(join(root, GROUPS_FILE)).json();
    const matrix = (await job("group")).match(/^ {8}group: \[(.*)\]$/m);
    expect(matrix).not.toBeNull();
    expect(matrix![1]!.split(",").map((name) => name.trim())).toEqual(Object.keys(real.groups));
  });

  test("each group job runs verify for its group and does not stop the others", async () => {
    const text = await job("group");
    expect(text).toContain("run: bun run verify -- --group ${{ matrix.group }}");
    expect(text).toMatch(/^ {6}fail-fast: false/m);
  });

  test("the aggregate job is named verify, waits for every group and fails unless all passed", async () => {
    const text = await job("verify");
    expect(text).toMatch(/^ {4}name: verify$/m);
    expect(text).toMatch(/^ {4}needs: group$/m);
    expect(text).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
    expect(text).toContain('run: test "${{ needs.group.result }}" = "success"');
  });
});

describe("verify.ts", () => {
  // Every spawn is killed after 10 s: if argument handling broke, the real verify.ts would start a full run whose
  // own `bun test scripts/` step spawns verify.ts again. A kill fails the test instead.
  async function run(at: string, args: string[]) {
    const proc = Bun.spawn(["bun", join(at, "scripts/verify.ts"), ...args], {
      cwd: at,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(proc.signalCode).toBeNull();
    return { code, stdout, stderr };
  }

  async function verify(args: string[]) {
    const { code, stderr } = await run(root, args);
    return { code, stderr };
  }

  /** A throwaway repository: verify.ts and plan.ts copied in, packages/a and packages/b, and `groupsFile` (raw
   *  text) as its groups file. verify.ts finds its root from its own path, so the copy checks the fixture. */
  async function fixture(groupsFile: string): Promise<string> {
    const at = await mkdtemp(join(tmpdir(), "verify-fixture-"));
    await Bun.write(join(at, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
    for (const name of ["a", "b"]) {
      await Bun.write(join(at, `packages/${name}/package.json`), JSON.stringify({ name, scripts: { test: "true" } }));
    }
    await Bun.write(join(at, "scripts/verify.ts"), Bun.file(join(root, "scripts/verify.ts")));
    await Bun.write(join(at, "scripts/verify/plan.ts"), Bun.file(join(root, "scripts/verify/plan.ts")));
    await Bun.write(join(at, GROUPS_FILE), groupsFile);
    return at;
  }

  test("--group refuses to run any step when a package is in no group", async () => {
    const at = await fixture(JSON.stringify({ groups: { all: { root: true, packages: ["packages/a"] } } }));
    try {
      const { code, stdout, stderr } = await run(at, ["--group", "all"]);
      expect(code).toBe(1);
      expect(stderr).toBe("verify: packages/b is in no group in scripts/verify-groups.json; add it to one\n");
      expect(stdout).not.toContain("===");
    } finally {
      await rm(at, { recursive: true, force: true });
    }
  });

  test("an unknown group exits 2 and lists the groups", async () => {
    expect(await verify(["--group", "ghost"])).toEqual({
      code: 2,
      stderr: "verify: unknown group ghost; groups: compiler, cli, data, hyper, rest\n",
    });
  });

  test("--group without a name and an unknown argument exit 2", async () => {
    expect(await verify(["--group"])).toEqual({ code: 2, stderr: "verify: --group requires a group name\n" });
    expect(await verify(["--fast"])).toEqual({ code: 2, stderr: "verify: unknown argument: --fast\n" });
  });
});
