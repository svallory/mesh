// A bound on nested action calls (TXN-21), end to end. The fixture (`fixtures/action-call-depth/domain/tree`) is a `Node`
// with a `parentId`, whose actions call actions through a helper (`probe.ts`) from a step, a write policy that reads the
// record, a pre-check, a `set` function, a `validate` check and an application `transaction`. A row whose parents form a
// loop makes each of them recurse without end. The project is built by the real `mesh` command on the SQLite adapter,
// type-checked by tsc under the strictest flags, and run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FrameworkError } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/action-call-depth/domain");
const projects: string[] = [];
const CAP = 1_000;

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "action-call-depth", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "action-call-depth-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite"]) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  await symlink(await realpath(join(repo, "node_modules/@types/bun")), join(root, "node_modules/@types/bun"));
  return root;
}

function mesh(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

async function rejection<E>(call: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(type);
  return error as E;
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface NodeRow { id: string; name: string; touched: boolean; parentId: string | null }
type Call = (input: Record<string, unknown>, context: object) => Promise<NodeRow>;
interface NodeEntity {
  add: Call; reparent: Call; climb: Call; gate: Call; pre: Call; named: Call; looped: Call; wrap: Call; twice: Call;
  start: Call; afterFailure: Call; fail: Call; count: Call;
  read(input: object, context: object): Promise<NodeRow[]>;
}
interface Binding {
  run<T>(fn: () => Promise<T>): Promise<T>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
interface Probe {
  hooks: { call: ((kind: string, id: string | undefined) => Promise<unknown>) | undefined };
  counts: { twice: number; ping: number };
}

const anyone = {};

/** Run `body` on a fresh SQLite database with the helpers wired to the entity's actions; `target` is the row a hook acts on. */
async function withApp(body: (api: { Node: NodeEntity; bound: Binding; probe: Probe; target: { id: string }; rows(): Promise<NodeRow[]> }) => Promise<void>): Promise<void> {
  const app = await import(join(root, ".mesh/index.ts"));
  const { tree } = await import(join(root, ".mesh/domain/index.ts")) as { tree: { Node: NodeEntity } };
  const probe = await import(join(root, "domain/tree/probe.ts")) as Probe;
  const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
  const layer = sqlite({ file: ":memory:" });
  await createSchema(layer, app.tables);
  const bound = app.bind(layer) as Binding;
  const { Node } = tree;
  const target = { id: "" };
  probe.hooks.call = (kind, id) => {
    const at = id ?? target.id;
    switch (kind) {
      case "climb": return Node.climb({ id: at }, anyone);
      case "gate": return Node.gate({ id: at }, anyone);
      case "pre": return Node.pre({ id: at }, anyone);
      case "named": return Node.named({ id: at, name: "x" }, anyone);
      case "looped": return Node.looped({ id: at }, anyone);
      case "wrap": return bound.transaction(() => Node.wrap({ id: at }, anyone));
      case "twice": return Node.twice({ id: at }, anyone);
      case "fail": return Node.fail({ id: at }, anyone);
      case "count": return Node.count({ id: at }, anyone);
      default: throw new Error(`unknown kind ${kind}`);
    }
  };
  probe.counts.twice = 0;
  probe.counts.ping = 0;
  try {
    await bound.run(() => body({ Node, bound, probe, target, rows: () => Node.read({}, anyone) }));
  } finally {
    probe.hooks.call = undefined;
    await layer.close();
  }
}

/** A row whose parent is itself. */
async function loop(Node: NodeEntity, name = "loop"): Promise<NodeRow> {
  const row = await Node.add({ name, parentId: null }, anyone);
  return Node.reparent({ id: row.id, parentId: row.id }, anyone);
}

/** `length` rows, each the parent of the next; the last row (the leaf) is returned. */
async function chain(Node: NodeEntity, length: number): Promise<NodeRow> {
  let last = await Node.add({ name: "n0", parentId: null }, anyone);
  for (let level = 1; level < length; level++) last = await Node.add({ name: `n${level}`, parentId: last.id }, anyone);
  return last;
}

/** Run `call` with a timer beside it; it must reject within a second, and the timer must have fired. */
async function bounded(call: () => Promise<unknown>): Promise<FrameworkError> {
  let ticked = false;
  const timer = new Promise<void>((done) => setTimeout(() => { ticked = true; done(); }, 20));
  const began = performance.now();
  const error = await rejection(call(), FrameworkError);
  const took = performance.now() - began;
  await timer;
  expect(ticked).toBe(true);
  expect(took).toBeLessThan(1_000);
  return error;
}

const capMessage = (called: string, root: string) =>
  `${called} was called more than ${CAP} nested calls deep, in a chain that began with ${root}: the calls probably form a cycle`;

describe("a bound on nested action calls (TXN-21)", () => {
  test("tsc type-checks the generated tree and the helper under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "domain/tree/probe.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  const routes: readonly (readonly [string, "climb" | "gate" | "pre" | "named" | "looped" | "wrap"])[] = [
    ["a step", "climb"],
    ["a write policy's helper, in a check that reads the record", "gate"],
    ["a pre-check helper, before the action's transaction opens", "pre"],
    ["a set function", "named"],
    ["a validate check", "looped"],
    ["an application transaction whose call nests", "wrap"],
  ];
  for (const [route, action] of routes) {
    test(`${route}: a cycle fails with the cap's error within a second, writes nothing, and leaves the event loop free`, async () => {
      await withApp(async ({ Node, target, rows }) => {
        const row = await loop(Node);
        target.id = row.id;
        const error = await bounded(() => Node[action]({ id: row.id, ...(action === "named" ? { name: "x" } : {}) }, anyone));
        // A function of an entity file may wrap what it throws; the cap's message is the error's own or its cause's.
        const text = [error.message, error.cause instanceof Error ? error.cause.message : ""].join("\n");
        expect(text).toContain(capMessage(`tree.Node#${action}`, `tree.Node#${action}`));
        expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
        // The loop is the same row, left as it was.
        expect((await rows()).map((candidate) => candidate.name)).toEqual(["loop"]);
      });
    }, 20_000);
  }

  test("the error is a FrameworkError that names the action called and the action at the root of the chain", async () => {
    await withApp(async ({ Node, rows }) => {
      const row = await loop(Node);
      const error = await bounded(() => Node.start({ id: row.id }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#climb", "tree.Node#start"));
      expect(error.message).toContain("probably form a cycle");
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    });
  }, 20_000);

  test("a helper that catches and calls twice per level: the root rejects with the cap's error, and the calls are bounded", async () => {
    await withApp(async ({ Node, probe, rows }) => {
      const row = await loop(Node);
      const error = await bounded(() => Node.twice({ id: row.id }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#twice", "tree.Node#twice"));
      // The helper ran once per level of the first descent; every call after the cap hit threw at entry, uncaught by nothing and run by nothing.
      expect(probe.counts.twice).toBe(CAP);
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    });
  }, 20_000);

  test("the boundary: a chain 1,000 deep commits, and one 1,001 deep throws", async () => {
    await withApp(async ({ Node, rows }) => {
      const leaf = await chain(Node, CAP);
      await Node.climb({ id: leaf.id }, anyone);
      expect((await rows()).filter((candidate) => candidate.touched)).toHaveLength(CAP);
    });
    await withApp(async ({ Node, rows }) => {
      const leaf = await chain(Node, CAP + 1);
      const error = await bounded(() => Node.climb({ id: leaf.id }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#climb", "tree.Node#climb"));
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    });
  }, 60_000);

  test("a legitimate recursion 200 deep commits its writes", async () => {
    await withApp(async ({ Node, rows }) => {
      const leaf = await chain(Node, 200);
      await Node.climb({ id: leaf.id }, anyone);
      expect((await rows()).filter((candidate) => candidate.touched)).toHaveLength(200);
    });
  }, 30_000);

  test("calls that are not nested count from 1 each time", async () => {
    await withApp(async ({ Node, rows }) => {
      const leaf = await chain(Node, 600);
      for (let call = 0; call < 4; call++) await Node.climb({ id: leaf.id }, anyone);
      expect((await rows()).filter((candidate) => candidate.touched)).toHaveLength(600);
    });
  }, 30_000);

  test("concurrent roots share neither a count nor an error: only the cyclic one fails", async () => {
    await withApp(async ({ Node, rows }) => {
      const cyclic = await loop(Node, "cyclic");
      const leaf = await chain(Node, 300);
      const [bad, good] = await Promise.allSettled([Node.climb({ id: cyclic.id }, anyone), Node.climb({ id: leaf.id }, anyone)]);
      expect(bad.status).toBe("rejected");
      expect((bad as PromiseRejectedResult).reason).toBeInstanceOf(FrameworkError);
      expect(good.status).toBe("fulfilled");
      const touched = (await rows()).filter((candidate) => candidate.touched);
      expect(touched).toHaveLength(300);
      expect(touched.map((candidate) => candidate.id)).not.toContain(cyclic.id);
      // And the cap was not left behind: the next cyclic call fails on its own count, and a legitimate one still runs.
      await rejection(Node.climb({ id: cyclic.id }, anyone), FrameworkError);
      await Node.climb({ id: leaf.id }, anyone);
    });
  }, 30_000);

  test("TXN-01: a call made after a caught failure in the same transaction does not run", async () => {
    await withApp(async ({ Node, probe }) => {
      const row = await Node.add({ name: "after", parentId: null }, anyone);
      const error = await rejection(Node.afterFailure({ id: row.id }, anyone), FrameworkError);
      expect(error).toBeInstanceOf(FrameworkError);
      expect(probe.counts.ping).toBe(0);
    });
  });
});
