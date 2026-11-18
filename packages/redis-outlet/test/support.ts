// What the outlet's tests share: the test Redis server, the project built by the real `mesh build` (fixtures/project:
// an Invoice whose `open` publishes InvoiceDrafted and whose `pay` publishes InvoicePaid, and a surface `billing` that
// publishes InvoicePaid only), and a fresh SQLite database bound with localBus per test.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RedisClient } from "bun";
import type { Binding, DataLayer, EventBus, TableHandle } from "@meshfw/runtime";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { localBus, type LocalBusOptions } from "@meshfw/bus-local";

/**
 * How the tests find a server: `MESH_TEST_REDIS_URL`. Not set, the server tests are skipped with one line on stderr;
 * not set while `CI` is, this module throws, so CI never passes by skipping.
 */
export const redisUrl = process.env.MESH_TEST_REDIS_URL?.trim() || undefined;
if (redisUrl === undefined) {
  if (process.env.CI) throw new Error("redis-outlet: MESH_TEST_REDIS_URL is not set while CI is: the outlet tests must run against a server in CI");
  const announced = globalThis as { meshRedisSkipAnnounced?: boolean };
  if (!announced.meshRedisSkipAnnounced) {
    announced.meshRedisSkipAnnounced = true;
    console.error("redis-outlet: the Redis tests are skipped because MESH_TEST_REDIS_URL is not set. Start a server with docker run -d -p 6379:6379 redis:7-alpine and set MESH_TEST_REDIS_URL=redis://localhost:6379");
  }
}

/** `describe` when a server is configured, `describe.skip` otherwise. */
export const describeServer = redisUrl === undefined ? describe.skip : describe;

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "redis-outlet-project", private: true, type: "module",
  imports: {
    "#mesh": "./.mesh/index.ts",
    "#mesh/domain": "./.mesh/domain/index.ts",
    "#mesh/domain/*": "./.mesh/domain/*/index.ts",
    "#mesh/surfaces/*": "./.mesh/surfaces/*/index.ts",
  },
};

export interface Project {
  readonly root: string;
  readonly bind: (layer: DataLayer, options: { events: { bus: EventBus; keep?: "until-delivered" | "all" } }) => Binding;
  readonly tables: Record<string, TableHandle>;
  readonly Invoice: { open(input: object, context?: object): Promise<{ id: string }>; pay(input: object, context?: object): Promise<unknown> };
  readonly publishes: readonly string[];
}

/** Build the fixture project once per test file, into a scratch folder beside the tests (`.scratch-*`, gitignored). */
export function builtProject(): () => Project {
  let project: Project | undefined;
  let root: string | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(import.meta.dir, ".scratch-"));
    await cp(join(import.meta.dir, "fixtures/project"), root, { recursive: true });
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
    const index = await import(join(root, ".mesh/index.ts"));
    const { Invoice } = await import(join(root, ".mesh/domain/billing/index.ts"));
    const { surface } = await import(join(root, ".mesh/surfaces/billing/index.ts"));
    project = { root, bind: index.bind, tables: index.tables, Invoice, publishes: surface.publishes };
  }, 30_000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  return () => project!;
}

/** A fresh database with the project's tables, bound with localBus (and `bus` options), plus two publishing calls. */
export async function freshBinding(project: Project, bus: LocalBusOptions = {}, file = ":memory:") {
  const layer = sqlite({ file });
  await createSchema(layer, project.tables);
  const binding = project.bind(layer, { events: { bus: localBus(bus) } });
  return {
    layer,
    binding,
    /** One `Invoice.open`: an InvoiceDrafted, which no surface publishes. */
    draft: () => binding.run(() => project.Invoice.open({})),
    /** One `Invoice.open` then `Invoice.pay`: an InvoiceDrafted, then an InvoicePaid. */
    paid: async () => {
      const invoice = await binding.run(() => project.Invoice.open({}));
      await binding.run(() => project.Invoice.pay({ id: invoice.id }));
      return invoice.id;
    },
  };
}

/** A stream key no other test (or earlier run) uses. */
export function streamKey(what: string): string {
  return `mesh-test:${what}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

/** A client of the test server, for reading streams and writing foreign entries. */
export async function redis(): Promise<RedisClient> {
  const client = new RedisClient(redisUrl!, { autoReconnect: false, enableOfflineQueue: false });
  await client.connect();
  return client;
}

/** The entries of `stream`, each as its id and its fields as an object. */
export async function entries(client: RedisClient, stream: string): Promise<{ id: string; fields: Record<string, string> }[]> {
  const raw = (await client.send("XRANGE", [stream, "-", "+"])) as [string, string[]][];
  return raw.map(([id, flat]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
    return { id, fields };
  });
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

/** How many connections the outlet of `stream` holds on the server: those named `outlet:redis:<stream>` (`CLIENT LIST`). */
export async function outletConnections(client: RedisClient, stream: string): Promise<number> {
  const list = String(await client.send("CLIENT", ["LIST"]));
  return list.split("\n").filter((line) => line.includes(` name=outlet:redis:${stream} `)).length;
}
