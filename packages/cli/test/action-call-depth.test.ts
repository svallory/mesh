// A bound on nested action calls, end to end. The fixture (`fixtures/action-call-depth/domain/tree`) is a `Node`
// with a `parentId`, whose actions call actions through a helper (`probe.ts`) from a step, a write policy that reads the
// record, a pre-check, a `set` function, a `validate` check and an application `transaction`. A row whose parents form a
// loop makes each of them recurse without end. The project is built by the real `mesh` command on the SQLite adapter,
// type-checked by tsc under the strictest flags, and run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FrameworkError, NotFoundError } from "@meshfw/runtime";

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
  add: Call; reparent: Call; climb: Call; gate: Call; spawn: Call; spawnTwice: Call; descend: Call; probed: Call; seamed: Call; plainStep: Call; named: Call; looped: Call; wrap: Call; twice: Call;
  start: Call; afterFailure: Call; fail: Call; count: Call;
  read(input: object, context: object): Promise<NodeRow[]>;
}
interface Binding {
  run<T>(fn: () => Promise<T>): Promise<T>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
interface Probe {
  hooks: { call: ((kind: string, id: string | undefined) => Promise<unknown>) | undefined };
  counts: { twice: number; ping: number; catching: number; level: number };
}

const anyone = {};

/** Run `body` on a fresh SQLite database with the helpers wired to the entity's actions; `target` is the row a hook acts on. */
type Seams = Record<string, (...args: never[]) => unknown>;

async function withApp(body: (api: { Node: NodeEntity; bound: Binding; probe: Probe; target: { id: string }; rows(): Promise<NodeRow[]> }) => Promise<void>, seams?: (api: { Node: NodeEntity; target: { id: string } }) => Seams): Promise<void> {
  const app = await import(join(root, ".mesh/index.ts"));
  const { tree } = await import(join(root, ".mesh/domain/index.ts")) as { tree: { Node: NodeEntity } };
  const probe = await import(join(root, "domain/tree/probe.ts")) as Probe;
  const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
  const layer = sqlite({ file: ":memory:" });
  await createSchema(layer, app.tables);
  const { Mesh } = await import(Bun.resolveSync("meshfw", root)) as { Mesh: { can(action: unknown, input: unknown, context: object): Promise<boolean> } };
  const { Node } = tree;
  const target = { id: "" };
  const bound = app.bind(layer, seams ? { seams: seams({ Node, target }) } : {}) as Binding;
  probe.hooks.call = (kind, id) => {
    const at = id ?? target.id;
    switch (kind) {
      case "climb": return Node.climb({ id: at }, anyone);
      case "gate": return Node.gate({ id: at }, anyone);
      case "spawn": return Node.spawn({ name: "spawned", parentId: null }, anyone);
      case "spawnTwice": return Node.spawnTwice({ name: "spawned", parentId: null }, anyone);
      case "descend": return Node.descend({ name: "descended", parentId: null }, anyone);
      case "ask": return Mesh.can(Node.probed, { id: at }, anyone);
      case "read": return Node.read({}, anyone);
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
  probe.counts.catching = 0;
  probe.counts.level = 0;
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

describe("a bound on nested action calls", () => {
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

  const routes: readonly (readonly [string, "climb" | "gate" | "named" | "looped" | "wrap"])[] = [
    ["a step", "climb"],
    ["a write policy's helper, in a check that reads the record", "gate"],
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
        expect(error.message).toContain(capMessage(`tree.Node#${action}`, `tree.Node#${action}`));
        expect(error.cause).toBeUndefined();
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
      expect(error.cause).toBeUndefined();
      expect(error.message).toContain("probably form a cycle");
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    });
  }, 20_000);

  test("a helper that catches and calls twice per level: the root rejects with the cap's error, and the calls are bounded", async () => {
    await withApp(async ({ Node, probe, rows }) => {
      const row = await loop(Node);
      const error = await bounded(() => Node.twice({ id: row.id }, anyone));
      // Every level updates this one row, so the root's own stale-row check fails after the helper caught the cap: that is a real
      // failure of the root, which keeps it. The row-per-level case below is the one that rejects with the cap's error.
      expect(error.message).toContain("decided on a stale row");
      // The helper ran once per level of the first descent; every call after the cap hit threw at entry and ran nothing.
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

  test("a call made after a caught failure in the same transaction does not run", async () => {
    await withApp(async ({ Node, probe }) => {
      const row = await Node.add({ name: "after", parentId: null }, anyone);
      const error = await rejection(Node.afterFailure({ id: row.id }, anyone), FrameworkError);
      expect(error).toBeInstanceOf(FrameworkError);
      expect(probe.counts.ping).toBe(0);
    });
  });

  const seeded = (rows: NodeRow[]) => rows.filter((candidate) => candidate.name !== "seed");

  test("each level creates its own row and a catching helper swallows the cap's error: the root rejects with it and nothing is written", async () => {
    await withApp(async ({ Node, probe, rows }) => {
      const error = await bounded(() => Node.spawn({ name: "root", parentId: null }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#spawn", "tree.Node#spawn"));
      expect(error.cause).toBeUndefined();
      expect(probe.counts.catching).toBe(CAP);
      expect(await rows()).toEqual([]);
    });
  }, 20_000);

  test("the twice case with a row per level: bounded, the root rejects with the cap's error, nothing is written", async () => {
    await withApp(async ({ Node, probe, rows }) => {
      const error = await bounded(() => Node.spawnTwice({ name: "root", parentId: null }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#spawnTwice", "tree.Node#spawnTwice"));
      expect(error.cause).toBeUndefined();
      expect(probe.counts.catching).toBe(CAP);
      expect(await rows()).toEqual([]);
    });
  }, 20_000);

  test("a chain that reaches Mesh.can, whose policy's helper catches the cap's error: the root rejects with it and nothing is written", async () => {
    await withApp(async ({ Node, target, rows }) => {
      target.id = (await Node.add({ name: "seed", parentId: null }, anyone)).id;
      const error = await bounded(() => Node.descend({ name: "root", parentId: null }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#read", "tree.Node#descend"));
      expect(error.cause).toBeUndefined();
      expect(seeded(await rows())).toEqual([]);
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    });
  }, 20_000);

  test("a beforeTransaction seam, which runs with no transaction open, that calls an action in a cycle: capped, plain cap error, nothing written", async () => {
    let seen = 0;
    await withApp(async ({ Node, target, rows }) => {
      const row = await Node.add({ name: "seed", parentId: null }, anyone);
      target.id = row.id;
      seen = 0;
      const error = await bounded(() => Node.seamed({ id: row.id }, anyone));
      expect(error.message).toContain(capMessage("tree.Node#seamed", "tree.Node#seamed"));
      expect(error.cause).toBeUndefined();
      expect(seen).toBe(CAP);
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    }, ({ Node, target }) => ({
      beforeTransaction: async (event: { action: string }) => {
        if (event.action !== "seamed") return;
        seen++;
        await Node.seamed({ id: target.id }, anyone);
      },
    }));
  }, 20_000);

  test("an afterCommit seam that calls an action in a cycle is bounded, the call resolves, and the seam's error is logged", async () => {
    let seen = 0;
    const logged: unknown[][] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      await withApp(async ({ Node, target, rows }) => {
        const row = await Node.add({ name: "seed", parentId: null }, anyone);
        target.id = row.id;
        seen = 0;
        await Node.seamed({ id: row.id }, anyone);
        expect(seen).toBe(CAP);
        expect(logged.length).toBeGreaterThan(0);
        expect(String(logged[0]?.[0])).toContain("The afterCommit seam threw");
        expect(String((logged[0]?.[1] as Error).message)).toContain(capMessage("tree.Node#seamed", "tree.Node#seamed"));
        expect((await rows()).filter((candidate) => candidate.touched)).toHaveLength(1);
      }, ({ Node, target }) => ({
        afterCommit: async (event: { changes: readonly { action: string }[] }) => {
          if (event.changes[0]?.action !== "seamed") return;
          seen++;
          await Node.seamed({ id: target.id }, anyone);
        },
      }));
    } finally {
      console.error = log;
    }
  }, 30_000);

  test("calls started after the one before has finished are not nested: a chain of batches a timer starts runs past 1,000", async () => {
    const BATCHES = 1_500;
    let seen = 0;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const failures: unknown[] = [];
    await withApp(async ({ Node, target, rows }) => {
      const row = await Node.add({ name: "seed", parentId: null }, anyone);
      target.id = row.id;
      seen = 0;
      await Node.seamed({ id: row.id }, anyone);
      await done;
      expect(failures).toEqual([]);
      expect(seen).toBe(BATCHES);
      expect((await rows()).filter((candidate) => candidate.touched)).toHaveLength(1);
    }, ({ Node, target }) => ({
      afterCommit: (event: { changes: readonly { action: string }[] }) => {
        if (event.changes[0]?.action !== "seamed") return;
        if (++seen >= BATCHES) return finish();
        setTimeout(() => { Node.seamed({ id: target.id }, anyone).catch((error: unknown) => { failures.push(error); finish(); }); }, 0);
      },
    }));
  }, 60_000);

  test("a root that fails for its own reason keeps its error, though a beforeTransaction seam caught the cap's: a missing row is a NotFoundError", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    let seen = 0;
    await withApp(async ({ Node, rows }) => {
      await rejection(Node.plainStep({ id: missing }, anyone), NotFoundError);
      expect(seen).toBe(CAP);
      expect(await rows()).toEqual([]);
    }, ({ Node }) => ({
      beforeTransaction: async (event: { action: string }) => {
        if (event.action !== "plainStep") return;
        seen++;
        try { await Node.plainStep({ id: missing }, anyone); } catch { /* the cap's error, or this call's own */ }
      },
    }));
  }, 20_000);

  test("the same when the seam calls an action whose own transaction hits the cap and catches it", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await withApp(async ({ Node, target, rows }) => {
      target.id = (await loop(Node)).id;
      await rejection(Node.plainStep({ id: missing }, anyone), NotFoundError);
      expect((await rows()).filter((candidate) => candidate.touched)).toEqual([]);
    }, ({ Node, target }) => ({
      beforeTransaction: async (event: { action: string; input: { id?: string } }) => {
        if (event.action !== "plainStep" || event.input.id !== missing) return;
        try { await Node.climb({ id: target.id }, anyone); } catch { /* the cap's error */ }
      },
    }));
  }, 20_000);

  test("a batch started with queueMicrotask while its parent still runs is nested: the chain fails at batch 1,001", async () => {
    let seen = 0;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const failures: unknown[] = [];
    await withApp(async ({ Node, target }) => {
      const row = await Node.add({ name: "seed", parentId: null }, anyone);
      target.id = row.id;
      seen = 0;
      await Node.seamed({ id: row.id }, anyone);
      await done;
      expect(seen).toBe(CAP);
      expect(failures).toHaveLength(1);
      expect((failures[0] as Error).message).toContain(capMessage("tree.Node#seamed", "tree.Node#seamed"));
    }, ({ Node, target }) => ({
      afterCommit: (event: { changes: readonly { action: string }[] }) => {
        if (event.changes[0]?.action !== "seamed") return;
        seen++;
        queueMicrotask(() => { Node.seamed({ id: target.id }, anyone).catch((error: unknown) => { failures.push(error); finish(); }); });
      },
    }));
  }, 30_000);
});
