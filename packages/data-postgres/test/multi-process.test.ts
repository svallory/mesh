// Delivery from several processes on data-postgres, the data layer's side: the multi-process delivery operations
// (`multiProcessConformance` from `@meshfw/runtime/testing`) on a schema built for a bus that declares multi-process,
// their refusal on a schema built without it, and the row locks they take against a second connection.
import { afterAll, expect, test } from "bun:test";
import { DatabaseBusyError, type DataOperations, type MultiProcessOperations } from "@meshfw/runtime";
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
    const started = Date.now();
    const error = await layer.renewProcess!(RUN, 60_000, { deadline: started + 200 }).then(() => undefined, (failure: unknown) => failure);
    const took = Date.now() - started;
    release();
    await holder;
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect((error as DatabaseBusyError).reason).toBe("lock-timeout");
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(1000);
    // The peer's callback resolved, so its delete committed: the row is gone and the renewal says so.
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 1000 })).toBe(false);
    await peer.close();
  }, 30_000);

  const schemaOf = (layer: PostgresLayer) => layer.database!.split("#")[1]!;
  const writeRow = (layer: PostgresLayer) => layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
  /** The server pids of this database's sessions whose last statement was a renewal's UPDATE. */
  const renewalPids = async (): Promise<Set<number>> =>
    new Set(((await database.admin.unsafe(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'UPDATE mesh_delivery_process%'`)) as { pid: number }[]).map((row) => row.pid));

  test("close() waits for a running renewal and releases its connection, and a renewal after close() renews on the new pool", async () => {
    const layer = await database.freshLayer();
    await writeRow(layer);
    // Another session holds the row's lock without changing it, so the renewal waits for it and then renews.
    const session = await database.admin.reserve();
    await session.unsafe("BEGIN");
    await session.unsafe(`SELECT 1 FROM "${schemaOf(layer)}".mesh_delivery_process WHERE run_id = $1 FOR UPDATE`, [RUN]);
    const renewal = layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 5000 });
    await Bun.sleep(100);
    let closed = false;
    const closing = layer.close().then(() => { closed = true; });
    await Bun.sleep(200);
    expect(closed).toBe(false);
    await session.unsafe("COMMIT");
    session.release();
    expect(await renewal).toBe(true);
    await closing;
    expect(closed).toBe(true);
    // close() closed the pool and its renewal connection: the next renewal runs on a new session.
    const before = await renewalPids();
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 2000 })).toBe(true);
    const after = [...await renewalPids()].filter((pid) => !before.has(pid));
    expect(after.length).toBe(1);
    await layer.close();
  }, 30_000);

  test("a renewal whose connection was lost fails as a lost connection, and the next one reconnects", async () => {
    const layer = await database.freshLayer();
    await writeRow(layer);
    const before = await renewalPids();
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 2000 })).toBe(true);
    const mine = [...await renewalPids()].filter((pid) => !before.has(pid));
    expect(mine.length).toBe(1);
    await database.admin.unsafe(`SELECT pg_terminate_backend($1)`, [mine[0]]);
    await Bun.sleep(100);
    const error = await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 2000 }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect((error as DatabaseBusyError).reason).toBe("connection");
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 2000 })).toBe(true);
    const now = [...await renewalPids()].filter((pid) => !before.has(pid) && pid !== mine[0]);
    expect(now.length).toBe(1);
    await layer.close();
  }, 30_000);

  // A connection that stops answering: lock_timeout bounds lock waits only, and here the statement runs (a trigger that
  // sleeps), so only the layer's own bound past the deadline ends it. close() and the next renewal do not wait on it.
  test("a renewal that never answers is given up soon after its deadline, close() does not wait on it, and the next renewal reconnects", async () => {
    const layer = await database.freshLayer();
    await writeRow(layer);
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 2000 })).toBe(true);
    const schema = schemaOf(layer);
    await database.admin.unsafe(`CREATE FUNCTION "${schema}".hang() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$`);
    await database.admin.unsafe(`CREATE TRIGGER hang BEFORE UPDATE ON "${schema}".mesh_delivery_process FOR EACH ROW EXECUTE FUNCTION "${schema}".hang()`);
    const started = Date.now();
    const renewal = layer.renewProcess!(RUN, 60_000, { deadline: started + 200 }).then(() => undefined, (failure: unknown) => failure);
    await Bun.sleep(50);
    await layer.close();
    const closedAfter = Date.now() - started;
    const error = await renewal;
    const took = Date.now() - started;
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect((error as DatabaseBusyError).reason).toBe("connection");
    expect(took).toBeGreaterThanOrEqual(400);
    expect(took).toBeLessThan(1500);
    expect(closedAfter).toBeLessThan(1500);
    // Waits for the sleeping UPDATE to end (its row lock), then the trigger is gone.
    await database.admin.unsafe(`DROP TRIGGER hang ON "${schema}".mesh_delivery_process`);
    expect(await layer.renewProcess!(RUN, 60_000, { deadline: Date.now() + 5000 })).toBe(true);
    await layer.close();
  }, 30_000);
});
