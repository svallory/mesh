// Delivery from several processes on data-postgres, the data layer's side: the multi-process delivery operations
// (`multiProcessConformance` from `@meshfw/runtime/testing`) on a schema built for a bus that declares multi-process,
// their refusal on a schema built without it, and the row locks they take against a second connection.
import { afterAll, expect, test } from "bun:test";
import type { DataOperations, MultiProcessOperations } from "@meshfw/runtime";
import type { PostgresLayer } from "../src/layer.ts";
import { multiProcessConformance } from "@meshfw/runtime/testing";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const single = await eventTables();
const multi = await eventTables({ multiProcess: true });
afterAll(async () => { await single.remove(); await multi.remove(); });

test("the multi schema holds the process table after core's other tables, and the single one does not", () => {
  expect(Object.keys(multi.tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures", "mesh_delivery_process"]);
  expect(Object.keys(single.tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures"]);
});

describeServer("multi-process data-layer conformance, Postgres", () => {
  const multiDatabase = testDatabase(multi.tables);
  const singleDatabase = testDatabase(single.tables);
  const checks = multiProcessConformance(() => multiDatabase.freshLayer(), {
    singleLayer: () => singleDatabase.freshLayer(),
    sibling: async (layer) => multiDatabase.sibling(layer as PostgresLayer),
    renewsOutsideTheQueue: true,
  });
  test("the checks of the renewal outside the queue run, the held-row one included", () => {
    expect(Object.keys(checks).filter((name) => name.startsWith("[renewal outside the queue]")).length).toBe(4);
  });
  test("the row-lock checks run", () => {
    expect(Object.keys(checks).filter((name) => name.startsWith("[two connections]")).length).toBeGreaterThan(0);
  });
  for (const [name, check] of Object.entries(checks)) test(name, check, 60_000);
});

describeServer("renewProcess on Postgres, outside the layer's queue", () => {
  const database = testDatabase(multi.tables);
  const RUN = "00000000-0000-4000-8000-00000000000a";
  const ops = (tx: DataOperations) => tx as DataOperations & MultiProcessOperations;

  // mesh-vaxr: a round's transaction waiting on a stalled peer's lock holds the layer's queue (one transaction at a
  // time), for up to `lock_timeout` per lock. The renewal runs on its own connection, so it renews meanwhile.
  test("it renews while a transaction of the same layer waits on another connection's lock", async () => {
    const layer = await database.freshLayer({ waitMs: 5000 });
    const peer = database.sibling(layer);
    await layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const stalled = peer.transaction(async (tx) => { await ops(tx).lockDeliveryState(); locked(); await released; });
    await holding;
    // This layer's queue is now held by a transaction waiting for the stalled peer's lock on mesh_outbox_state.
    const waiting = layer.transaction((tx) => ops(tx).lockDeliveryState());
    const queued = layer.transaction(async () => "after");
    await Bun.sleep(100);
    const started = Date.now();
    const renewed = await layer.renewProcess!(RUN, 60_000, { deadline: started + 2000 });
    const took = Date.now() - started;
    release();
    await stalled;
    // At SERIALIZABLE the waiter may fail once the peer changed the row it waited for; it never blocks the renewal.
    const waited = await waiting.then(() => undefined, (failure: unknown) => failure);
    expect(waited === undefined || (waited as { retryable?: boolean }).retryable === true).toBe(true);
    expect(await queued).toBe("after");
    expect(renewed).toBe(true);
    expect(took).toBeLessThan(1000);
    await peer.close();
  }, 30_000);

  test("its lock wait ends at the deadline with reason lock-timeout, and the connection renews again afterwards", async () => {
    const layer = await database.freshLayer();
    const peer = database.sibling(layer);
    await layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = peer.transaction(async (tx) => { await ops(tx).deleteProcess(RUN); locked(); await released; }).catch(() => undefined);
    await holding;
    const error = await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 200 }).then(() => undefined, (failure: unknown) => failure);
    release();
    await holder;
    expect((error as { reason?: string }).reason).toBe("lock-timeout");
    // The peer's callback resolved, so its delete committed: the row is gone and the renewal says so.
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 1000 })).toBe(false);
    await peer.close();
  }, 30_000);
});
