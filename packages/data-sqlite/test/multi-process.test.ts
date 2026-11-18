// Delivery from several processes on data-sqlite, the data layer's side: the multi-process delivery operations
// (`multiProcessConformance` from `@meshfw/runtime/testing`) on a memory and a file database built for a bus that
// declares multi-process, and their refusal on a schema built without it; and what a multi-mode start does when other
// processes' transactions get in its way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DECLARATION, DatabaseBusyError, bindDomain, type DataLayer, type DataOperations, type Declaration, type MultiProcessOperations, type TableHandle } from "@meshfw/runtime";
import { multiProcessConformance, setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import { MULTI_CAPABILITIES } from "./multi-capabilities.ts";
import { createSchema, sqlite } from "../src/index.ts";
import { buildSchemas } from "./multi-schema.ts";

class Paid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration = { kind: "event", fqn: "start.Paid", is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
}

let single: Record<string, TableHandle>;
let multi: Record<string, TableHandle>;
let remove: () => Promise<void>;
beforeAll(async () => { ({ single, multi, remove } = await buildSchemas()); });
afterAll(async () => { await remove(); });

test("the multi schema holds the process table after core's other tables, and the single one does not", () => {
  expect(Object.keys(multi)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures", "mesh_delivery_process"]);
  expect(Object.keys(single)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures"]);
});

for (const kind of ["memory", "file"] as const) {
  describe(`multi-process data-layer conformance, ${kind} database`, () => {
    const dirs: string[] = [];
    afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    const layerWith = (tables: () => Record<string, TableHandle>) => async () => {
      const scratch = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-multi-")) : undefined;
      if (scratch) dirs.push(scratch);
      const layer = sqlite({ file: scratch ? join(scratch, "app.db") : ":memory:" });
      await createSchema(layer, tables());
      return layer;
    };
    const checks = multiProcessConformance(layerWith(() => multi), { singleLayer: layerWith(() => single), renewsOutsideTheQueue: kind === "file" });
    test(kind === "file" ? "a file database renews outside its queue" : "a memory database has no renewal outside its queue", async () => {
      const layer = await layerWith(() => multi)();
      try { expect(typeof layer.renewProcess).toBe(kind === "file" ? "function" : "undefined"); } finally { await layer.close(); }
    });
    if (kind === "file") test("checks of the renewal outside the queue run", () => {
      expect(Object.keys(checks).filter((name) => name.startsWith("[renewal outside the queue]")).length).toBe(3);
    });
    for (const [name, check] of Object.entries(checks)) test(name, check, 30_000);
  });
}

describe("renewProcess on a file database, beside another connection's write lock", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const RUN = "00000000-0000-4000-8000-00000000000a";
  const row = { runId: RUN, pid: 1, startedAt: null, keep: "until-delivered" as const, handlers: {}, declared: [] };
  const opened = async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-renew-"));
    dirs.push(dir);
    const file = join(dir, "app.db");
    const layer = sqlite({ file });
    await createSchema(layer, multi);
    await layer.transaction((tx) => (tx as DataOperations & MultiProcessOperations).writeProcess(row));
    return { layer, other: sqlite({ file }) };
  };
  /** Holds the write lock from `other` until the returned release is called. */
  const hold = async (other: DataLayer) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const done = other.transaction(async (tx) => { await (tx as DataOperations & MultiProcessOperations).writeProcess({ ...row, pid: 2 }); holding(); await released; });
    await held;
    return async () => { release(); await done; };
  };

  test("it waits for the lock until its deadline, then fails with MESH_DATABASE_BUSY", async () => {
    const { layer, other } = await opened();
    const release = await hold(other);
    const started = Date.now();
    const error = await layer.renewProcess!(RUN, 60_000, { deadline: started + 200 }).then(() => undefined, (failure: unknown) => failure);
    const took = Date.now() - started;
    await release();
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1500);
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 1000 })).toBe(true);
    await other.close();
    await layer.close();
  });

  test("it renews once the lock is released within its deadline, beside the layer's queued transactions", async () => {
    const { layer, other } = await opened();
    const release = await hold(other);
    // Queued on this layer: BEGIN IMMEDIATE waits for the same lock, for up to 5 s each.
    const queued = [layer.transaction(async () => {}), layer.transaction(async () => {})];
    const renewal = layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 3000 });
    setTimeout(() => { void release(); }, 100);
    expect(await renewal).toBe(true);
    await Promise.all(queued);
    await other.close();
    await layer.close();
  });

  test("close() waits for a running renewal, and the next renewal opens its connection again", async () => {
    const { layer, other } = await opened();
    const release = await hold(other);
    const renewal = layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 3000 });
    const closing = layer.close();
    setTimeout(() => { void release(); }, 100);
    expect(await renewal).toBe(true);
    await closing;
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 1000 })).toBe(true);
    await other.close();
    await layer.close();
  });
});

describe("a multi-mode start against other processes' transactions", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); setDeliveryTiming(null); });
  /** A file layer over the multi schema whose transactions go through `around` first. */
  const wrapped = async (around: (call: number) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-multi-start-"));
    dirs.push(dir);
    const layer = sqlite({ file: join(dir, "app.db") });
    await createSchema(layer, multi);
    let calls = 0;
    const view: DataLayer = { ...layer, transaction: async (run, options) => { await around(++calls); return (layer as DataLayer).transaction(run, options); } };
    return { layer, view };
  };
  const renewedAt = async (layer: DataLayer) =>
    (await layer.transaction((tx) => (tx as DataOperations & MultiProcessOperations).readProcesses()))[0]?.renewedAt.getTime();
  const start = (view: DataLayer) => bindDomain({ Paid }, view, {
    events: { bus: testBus({ capabilities: MULTI_CAPABILITIES }), load: async () => ({ handlers: { process: { a: { events: [Paid], run: async () => {} } }, listen: { b: { events: [Paid], run: async () => {} } } } }) },
  }, new AsyncLocalStorage()).startDelivery();

  test("a registration that fails with a serialization failure or a deadlock is made again; a lock wait is not", async () => {
    setDeliveryTiming({ renewMs: 1000, lapseMs: 5000 });
    const busy = (reason: "serialization" | "deadlock" | "lock-timeout") => new DatabaseBusyError("app.db", 0, { reason, sqlstate: "40001" });
    const { layer, view } = await wrapped(async (call) => { if (call === 1) throw busy("serialization"); if (call === 2) throw busy("deadlock"); });
    const delivery = await start(view);
    try { expect(await renewedAt(layer)).toBeNumber(); } finally { await delivery.stop(); await layer.close(); }
    const timedOut = await wrapped(async (call) => { if (call === 1) throw busy("lock-timeout"); });
    const error = await start(timedOut.view).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect((error as DatabaseBusyError).reason).toBe("lock-timeout");
    await timedOut.layer.close();
  });

  test("the renewals start once the lease takes are done, also when the takes take longer than the renewal interval", async () => {
    setDeliveryTiming({ renewMs: 20, lapseMs: 5000 });
    // every transaction takes 40 ms more, as on a server across a network: the takes outlast the first renewal interval
    const { layer, view } = await wrapped(() => new Promise((resolve) => { setTimeout(resolve, 40); }));
    const delivery = await start(view);
    try {
      const first = await renewedAt(layer);
      await new Promise((resolve) => { setTimeout(resolve, 400); });
      expect(await renewedAt(layer)).toBeGreaterThan(first!);
    } finally { await delivery.stop(); await layer.close(); }
  });
});
