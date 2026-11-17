// The reader rule on Postgres (spec, Events and commands, "The outbox": "on Postgres it needs a reader-side rule"): a
// read returns rows only at or below its settled position, below which every transaction that took a position has
// ended, so a row that commits later is never below one a read returned. Only appenders of this outbox in this
// database hold the position back (D30, O3): not another write transaction, not an appender of another database.
import { afterAll, expect, test } from "bun:test";
import type { ReservedSQL, SQL } from "bun";
import { outboxRow } from "@meshfw/runtime/testing";
import type { PostgresLayer } from "../src/layer.ts";
import { outboxChannel, outboxLockKey } from "../src/outbox.ts";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
afterAll(remove);

/** A promise and the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/** An append in `layer` that stays open until `release` is called; resolves `appended` once its row has a position. */
function openAppend(layer: PostgresLayer, n: number, outcome: "commit" | "rollback" = "commit") {
  const appended = gate();
  const held = gate();
  const done = layer.transaction(async (tx) => {
    await tx.appendEvent!(outboxRow(n));
    appended.open();
    await held.wait;
    if (outcome === "rollback") throw new Error("roll back");
  }).catch((error: unknown) => { if (!(error instanceof Error && error.message === "roll back")) throw error; });
  return { appended: appended.wait, release: async () => { held.open(); await done; } };
}

/** A raw transaction on `admin` that stays open until the returned function ends it. */
async function openRaw(admin: SQL, ...statements: string[]): Promise<() => Promise<void>> {
  const connection: ReservedSQL = await admin.reserve();
  await connection.unsafe("BEGIN");
  for (const statement of statements) await connection.unsafe(statement);
  return async () => { try { await connection.unsafe("ROLLBACK"); } finally { connection.release(); } };
}

const positions = (page: { rows: readonly { position: number }[] }) => page.rows.map((row) => row.position);
const schemaOf = (layer: PostgresLayer) => layer.database!.split("#")[1]!;

describeServer("the reader rule", () => {
  const database = testDatabase(tables);
  const other = testDatabase(tables);

  test("an open appender withholds a later commit; once it commits, both rows come in order", async () => {
    const writer = await database.freshLayer();
    const beside = database.sibling(writer);
    const reader = database.sibling(writer);
    const first = openAppend(writer, 1);
    await first.appended;
    await beside.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
    const during = await reader.readOutbox(0, 10);
    // A naive `position > 0` read would return [2], and a reader would move past 1 for good.
    expect(positions(during)).toEqual([]);
    expect(during).toMatchObject({ settled: 0, highest: 2 });
    await first.release();
    const after = await reader.readOutbox(0, 10);
    expect(positions(after)).toEqual([1, 2]);
    expect(after).toMatchObject({ settled: 2, highest: 2 });
  }, 60_000);

  test("settled advances while appenders overlap: a sample waits only for the appenders running when it was taken", async () => {
    const writer = await database.freshLayer();
    const reader = database.sibling(writer);
    const a = openAppend(writer, 1);
    await a.appended;
    // The sample v = 1 waits for {A}.
    expect(await reader.readOutbox(0, 10)).toMatchObject({ rows: [], settled: 0, highest: 1 });
    await a.release();
    const b = openAppend(database.sibling(writer), 2);
    await b.appended;
    try {
      // A ended; B, which took position 2 after the sample, runs. A rule that waits for no appender at all to run
      // would stall here under steady load.
      const during = await reader.readOutbox(0, 10);
      expect(positions(during)).toEqual([1]);
      expect(during).toMatchObject({ settled: 1, highest: 2 });
    } finally { await b.release(); }
    const after = await reader.readOutbox(0, 10);
    expect(positions(after)).toEqual([1, 2]);
    expect(after.settled).toBe(2);
  }, 60_000);

  test("more reads than the samples kept, while one appender is held, only delay settled", async () => {
    const writer = await database.freshLayer();
    const reader = database.sibling(writer);
    const held = openAppend(writer, 1);
    await held.appended;
    for (let i = 0; i < 70; i++) expect((await reader.readOutbox(0, 10)).settled).toBe(0);
    await held.release();
    await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
    // Samples were dropped while the appender held; the next reads still reach every committed row.
    let page = await reader.readOutbox(0, 10);
    if (page.settled < 2) page = await reader.readOutbox(0, 10);
    expect(positions(page)).toEqual([1, 2]);
    expect(page.settled).toBe(2);
  }, 60_000);

  test("the appender's own layer, read outside its transaction, is held back too", async () => {
    const writer = await database.freshLayer();
    await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
    expect((await writer.readOutbox(0, 10)).settled).toBe(1);
    const open = openAppend(writer, 2);
    await open.appended;
    // The floor the earlier read reached stays; the new sample waits for the open append.
    const page = await writer.readOutbox(0, 10);
    expect(positions(page)).toEqual([1]);
    expect(page).toMatchObject({ settled: 1, highest: 2 });
    await open.release();
    expect(positions(await writer.readOutbox(0, 10))).toEqual([1, 2]);
  }, 60_000);

  test("a rolled-back appender leaves a gap that settled passes once it ends", async () => {
    const writer = await database.freshLayer();
    const reader = database.sibling(writer);
    const open = openAppend(writer, 1, "rollback");
    await open.appended;
    await database.sibling(writer).transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
    expect(await reader.readOutbox(0, 10)).toMatchObject({ rows: [], settled: 0, highest: 2 });
    await open.release();
    const page = await reader.readOutbox(0, 10);
    expect(positions(page)).toEqual([2]);
    expect(page).toMatchObject({ settled: 2, highest: 2 });
  }, 60_000);

  test("highest counts a running append; settled does not", async () => {
    const writer = await database.freshLayer();
    const reader = database.sibling(writer);
    const open = openAppend(writer, 1);
    await open.appended;
    expect(await reader.readOutbox(0, 10)).toMatchObject({ rows: [], deletedThrough: 0, settled: 0, highest: 1 });
    await open.release();
  }, 60_000);

  test("an open write transaction that appended nothing does not hold settled back", async () => {
    const writer = await database.freshLayer();
    await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
    const end = await openRaw(database.admin, `INSERT INTO "${schemaOf(writer)}".invoices (id) VALUES ('00000000-0000-4000-8000-000000000001')`, "SELECT pg_current_xact_id()");
    try {
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
      const page = await writer.readOutbox(0, 10);
      expect(positions(page)).toEqual([1, 2]);
      expect(page.settled).toBe(2);
    } finally { await end(); }
  }, 60_000);

  test("neither an open writer nor an open appender holding the same advisory key in another database holds settled back", async () => {
    const writer = await database.freshLayer();
    // The same advisory key (the writer's channel) held by a transaction with an xid in another database of the same
    // server, beside an open write there: pg_locks lists the whole cluster, and the rule looks at this database only.
    const [k1, k2] = outboxLockKey(outboxChannel(schemaOf(writer)));
    await other.freshLayer();
    const endWriter = await openRaw(other.admin, `INSERT INTO "c1".invoices (id) VALUES ('00000000-0000-4000-8000-000000000001')`);
    const endAppender = await openRaw(other.admin, `SELECT pg_advisory_xact_lock_shared(${k1}, ${k2})`, "SELECT pg_current_xact_id()");
    try {
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
      const page = await writer.readOutbox(0, 10);
      expect(positions(page)).toEqual([1]);
      expect(page.settled).toBe(1);
    } finally { await endWriter(); await endAppender(); }
  }, 60_000);

  test("the same advisory key held in this database does hold settled back", async () => {
    const writer = await database.freshLayer();
    const [k1, k2] = outboxLockKey(outboxChannel(schemaOf(writer)));
    const end = await openRaw(database.admin, `SELECT pg_advisory_xact_lock_shared(${k1}, ${k2})`, "SELECT pg_current_xact_id()");
    try {
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
      expect(await writer.readOutbox(0, 10)).toMatchObject({ rows: [], settled: 0, highest: 1 });
    } finally { await end(); }
    expect((await writer.readOutbox(0, 10)).settled).toBe(1);
  }, 60_000);

  test("a fresh layer object starts with settled at least deletedThrough, even while an append is open", async () => {
    const writer = await database.freshLayer();
    await writer.transaction(async (tx) => { for (const n of [1, 2, 3]) await tx.appendEvent!(outboxRow(n)); });
    await writer.transaction(async (tx) => tx.deleteOutboxThrough!(2));
    const open = openAppend(writer, 4);
    await open.appended;
    try {
      const page = await database.sibling(writer).readOutbox(0, 10);
      expect(page.deletedThrough).toBe(2);
      expect(page.settled).toBeGreaterThanOrEqual(2);
      expect(page.settled).toBeLessThan(4);
      expect(page.rows.every((row) => row.position <= page.settled)).toBe(true);
    } finally { await open.release(); }
  }, 60_000);

  test("after the sequence is set back below the floor (a restore), settled stays at or below highest", async () => {
    const writer = await database.freshLayer();
    await writer.transaction(async (tx) => { for (const n of [1, 2, 3]) await tx.appendEvent!(outboxRow(n)); });
    expect((await writer.readOutbox(0, 10)).settled).toBe(3);
    await database.admin.unsafe(`SELECT setval(pg_get_serial_sequence('"${schemaOf(writer)}".mesh_outbox', 'position'), 1)`);
    const page = await writer.readOutbox(0, 10);
    expect(page.highest).toBe(1);
    expect(page.settled).toBeLessThanOrEqual(page.highest);
  }, 60_000);
});
