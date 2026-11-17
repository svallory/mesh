// A surface's `publishes` at run time (`notes/architecture/surfaces-design.md`, PR 3, section 7 "Run time"; ruling D41),
// in a project built by the real `mesh` command on data-sqlite with localBus (fixture: `fixtures/surfaces`, a Task whose
// `complete` publishes `TaskCompleted`, from a file of its own, and whose `archive` and `touch` publish `TaskArchived`
// and `TaskTouched`, declared inline in its `events` section; the admin surface lists the first two). `subscribe` from
// `#mesh`, given the manifest's `publishes` as `names`, receives exactly the listed events; the unlisted one is still
// published and delivered to the project's handlers (R22).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DataLayer } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "bus-local-surfaces", private: true, type: "module",
  imports: {
    "#mesh": "./.mesh/index.ts",
    "#mesh/domain": "./.mesh/domain/index.ts",
    "#mesh/domain/*": "./.mesh/domain/*/index.ts",
    "#mesh/surfaces/*": "./.mesh/surfaces/*/index.ts",
  },
};

type Run = (input: object, context?: object) => Promise<Record<string, unknown>>;
let root: string;
let app: {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(query: { name: string; names: readonly string[] }, callback: (event: { name: string; payload: unknown }) => unknown): Promise<{ close(): Promise<void>; done: Promise<unknown> }>;
  tables: Record<string, object>;
};
let surface: { publishes: readonly string[]; expose: { tasks: { actions: Record<"open" | "complete" | "touch" | "archive", { run: Run }> } } };
let events: { seen: string[] };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-bus-local-surfaces-"));
  await cp(join(import.meta.dir, "fixtures/surfaces"), root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite", "bus-local"]) await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  const built = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), "build"], { cwd: root });
  expect({ code: built.exitCode, stderr: built.stderr.toString() }).toEqual({ code: 0, stderr: "0 errors, 0 warnings\n" });
  app = await import(join(root, ".mesh/index.ts"));
  ({ surface } = await import(join(root, ".mesh/surfaces/admin/index.ts")));
  events = await import(join(root, "events.ts"));
  const config: { default: { data: DataLayer } } = await import(join(root, "mesh.config.ts"));
  const data: { createSchema(layer: DataLayer, tables: object): Promise<void> } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
  await data.createSchema(config.default.data, app.tables);
}, 30_000);
afterAll(async () => {
  await app?.disconnect();
  if (root) await rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    await sleep(5);
  }
}

test("the manifest lists the publishes section's FQNs, in written order, an inline event by its own FQN", () => {
  expect(surface.publishes).toEqual(["work.TaskCompleted", "work.TaskArchived"]);
  expect(Object.isFrozen(surface.publishes)).toBe(true);
});

test("subscribe with names: surface.publishes receives the listed events only; the unlisted one is still delivered", async () => {
  await app.connect();
  const received: { name: string; payload: unknown }[] = [];
  const subscription = await app.subscribe({ name: "admin-feed", names: surface.publishes }, (event) => {
    received.push({ name: event.name, payload: event.payload });
  });
  const { actions } = surface.expose.tasks;
  const task = await actions.open.run({});
  expect(Object.keys(task).sort()).toEqual(["id", "state"]);
  await actions.touch.run({ id: task.id });
  await actions.complete.run({ id: task.id });
  await actions.archive.run({ id: task.id });
  await until(() => received.length >= 2 && events.seen.length >= 3, "the subscription and the handler saw the events");
  // A moment more, so an unlisted event that leaked through would have arrived.
  await sleep(100);
  expect(received).toEqual([
    { name: "work.TaskCompleted", payload: { taskId: task.id } },
    { name: "work.TaskArchived", payload: { taskId: task.id } },
  ]);
  // R22: `publishes` raises nothing and hides nothing: the project's own handler gets every event, listed or not.
  expect(events.seen).toEqual(["work.TaskTouched", "work.TaskCompleted", "work.TaskArchived"]);
  await subscription.close();
  expect(await subscription.done).toBeNull();
}, 15_000);
