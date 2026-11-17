import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { localBus } from "@meshfw/bus-local";
import {
  DECLARATION, DatabaseBusyError, FrameworkError, bindDomain, publishEvent,
  type DataLayer, type DataOperations, type Declaration, type DeliveryOperations, type EventRecord, type EventsModule, type HandlerStoppedError,
} from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import { postgres } from "../src/index.ts";
import type { PostgresLayer } from "../src/layer.ts";
import { eventTables } from "./event-tables.ts";
import { databaseUrl, describeServer, serverUrl, testDatabase } from "./support.ts";

const events = await eventTables();
afterAll(events.remove);

const counters = pgTable("counters", { seq: bigint("seq", { mode: "number" }).primaryKey().notNull(), label: text("label").notNull() });
const notes = pgTable("notes", { id: text("id").primaryKey().notNull(), body: text("body").notNull() });

/** A promise and the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

describeServer("transient errors on Postgres are DatabaseBusyError with a reason", () => {
  const database = testDatabase({ counters, notes });

  test("two layers fill one integer key at once: one commits, the other gets a retryable serialization failure", async () => {
    const a = await database.freshLayer();
    const b = database.sibling(a);
    const held = gate();
    const inserted = gate();
    const first = settle(a.transaction(async (tx) => { const row = await tx.insert(counters, { label: "a" }); inserted.open(); await held.wait; return row; }));
    await inserted.wait;
    // b reads the same highest key, then its insert waits on a's uncommitted row and fails once a commits.
    const second = settle(b.transaction((tx) => tx.insert(counters, { label: "b" })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.open();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ value: { seq: 1, label: "a" } });
    expect("error" in two && two.error).toBeInstanceOf(DatabaseBusyError);
    expect((two as { error: DatabaseBusyError }).error).toMatchObject({ code: "MESH_DATABASE_BUSY", reason: "serialization", sqlstate: "40001", retryable: true });
    // The caller may repeat the call, and the repeat succeeds.
    expect(await b.transaction((tx) => tx.insert(counters, { label: "b" }))).toMatchObject({ seq: 2 });
  }, 30_000);

  test("a serialization failure inside a select reaches the caller unchanged, even when the callback catches it", async () => {
    const a = await database.freshLayer();
    const b = database.sibling(a);
    await a.transaction((tx) => tx.insert(notes, { id: "n1", body: "first" }));
    const read = gate();
    const written = gate();
    let caught: unknown;
    const outcome = settle(a.transaction(async (tx) => {
      await tx.select(notes); // takes the snapshot
      read.open();
      await written.wait;
      try { await tx.selectByKeyForUpdate(notes, { id: "n1" }); } catch (cause) { caught = cause; }
      return "went on";
    }));
    await read.wait;
    await b.transaction((tx) => tx.updateByKey(notes, { id: "n1" }, { body: "changed by b" }));
    written.open();
    const result = await outcome;
    // R23: the select's failure is the DatabaseBusyError itself, never data-drizzle's "Database operation failed".
    expect(caught).toBeInstanceOf(DatabaseBusyError);
    expect(caught).toMatchObject({ reason: "serialization", sqlstate: "40001" });
    // R27: the transaction is aborted, so the outer call rejects with that same error, though the callback went on.
    expect("error" in result && result.error).toBe(caught);
  }, 30_000);

  test("a write skew fails at COMMIT with a retryable serialization failure", async () => {
    const a = await database.freshLayer();
    const b = database.sibling(a);
    const bothRead = { a: gate(), b: gate() };
    const bothInserted = { a: gate(), b: gate() };
    const inserted = { x: false, y: false };
    const run = (layer: typeof a, id: "x" | "y", read: [{ open: () => void }, { wait: Promise<void> }], wrote: [{ open: () => void }, { wait: Promise<void> }]) => settle(layer.transaction(async (tx) => {
      const count = (await tx.select(notes)).length;
      read[0].open();
      await read[1].wait;
      await tx.insert(notes, { id, body: `saw ${count}` });
      inserted[id] = true;
      // Neither commits before both inserts ran, so the conflict can only show at COMMIT.
      wrote[0].open();
      await wrote[1].wait;
    }));
    const [one, two] = await Promise.all([
      run(a, "x", [bothRead.a, bothRead.b], [bothInserted.a, bothInserted.b]),
      run(b, "y", [bothRead.b, bothRead.a], [bothInserted.b, bothInserted.a]),
    ]);
    // Both inserts resolved, so the DatabaseBusyError came from COMMIT, through the commit stage's report.
    expect(inserted).toEqual({ x: true, y: true });
    const failures = [one, two].filter((outcome) => "error" in outcome).map((outcome) => (outcome as { error: unknown }).error);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(DatabaseBusyError);
    expect(failures[0]).toMatchObject({ reason: "serialization", sqlstate: "40001", retryable: true });
  }, 30_000);

  test("waitMs bounds a lock wait: a row held FOR UPDATE gives lock-timeout after it", async () => {
    const a = await database.freshLayer();
    const b = database.sibling(a);
    await a.transaction((tx) => tx.insert(notes, { id: "n1", body: "first" }));
    const locked = gate();
    const release = gate();
    const holder = a.transaction(async (tx) => { await tx.selectByKeyForUpdate(notes, { id: "n1" }); locked.open(); await release.wait; });
    await locked.wait;
    const started = performance.now();
    const error = await b.transaction((tx) => tx.selectByKeyForUpdate(notes, { id: "n1" }), { waitMs: 200 }).catch((cause: unknown) => cause);
    const waited = performance.now() - started;
    release.open();
    await holder;
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(error).toMatchObject({ reason: "lock-timeout", sqlstate: "55P03", waitedMs: 200, retryable: true });
    expect(waited).toBeGreaterThanOrEqual(190);
    expect(waited).toBeLessThan(5000);
  }, 30_000);

  test("a terminated connection is a lost connection; the layer's next transaction runs on a new one", async () => {
    const layer = await database.freshLayer();
    const error = await layer.transaction(async (tx) => {
      await tx.insert(notes, { id: "lost", body: "never committed" });
      await database.admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx.select(notes);
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(error).toMatchObject({ reason: "connection", retryable: true });
    expect(await layer.transaction((tx) => tx.select(notes))).toEqual([]);
    await layer.transaction((tx) => tx.insert(notes, { id: "after", body: "fine" }));
    expect((await layer.transaction((tx) => tx.select(notes))).map((row) => row.id)).toEqual(["after"]);
  }, 30_000);

  test("a callback that catches a refused statement and goes on rejects with R27's FrameworkError, and nothing it wrote commits", async () => {
    const layer = await database.freshLayer();
    await layer.transaction((tx) => tx.insert(notes, { id: "n1", body: "first" }));
    let caught: unknown;
    const error = await layer.transaction(async (tx) => {
      await tx.insert(notes, { id: "n2", body: "second" });
      try { await tx.insert(notes, { id: "n1", body: "duplicate" }); } catch (cause) { caught = cause; }
      // Later statements of the aborted transaction fail too (25P02); the first failure is the one reported.
      await tx.insert(notes, { id: "n3", body: "third" }).catch(() => undefined);
      return "resolved";
    }).catch((cause: unknown) => cause);
    expect(caught).toBeInstanceOf(FrameworkError);
    expect((caught as Error).message).toBe("Database operation failed");
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("A statement of this transaction failed, so Postgres aborted the transaction even though its callback caught the error");
    // The cause is the first failure as the statement raised it: Drizzle's wrapper around the server's 23505.
    expect((((error as Error).cause as Error).cause as { errno?: string }).errno).toBe("23505");
    expect((await layer.transaction((tx) => tx.select(notes))).map((row) => row.id)).toEqual(["n1"]);
  }, 30_000);

  test("a validation error that never reached the database leaves the transaction usable", async () => {
    const layer = await database.freshLayer();
    const result = await layer.transaction(async (tx) => {
      await tx.insert(notes, { id: "n1", body: "first" });
      await tx.select(notes, { sort: ["nope"] }).catch(() => undefined);
      return (await tx.select(notes)).length;
    });
    expect(result).toBe(1);
  }, 30_000);
});

describeServer("connecting", () => {
  test("a server that does not answer is a retryable connection error: could not connect", async () => {
    const layer = postgres({ url: "postgres://postgres:secret-password@127.0.0.1:1/none" });
    const error = await layer.transaction(async () => 1).catch((cause: unknown) => cause);
    await layer.close();
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(error).toMatchObject({ reason: "connection", retryable: true });
    expect((error as Error).message).toStartWith("Could not connect to the database postgres://127.0.0.1:1/none: ");
    expect((error as Error).message).not.toContain("secret-password");
  }, 30_000);

  test("a wrong password and an unknown database are FrameworkErrors that never print the password", async () => {
    const good = new URL(serverUrl!);
    const wrong = new URL(serverUrl!);
    wrong.password = "certainly-not-the-password";
    for (const [url, sqlstate] of [[wrong.toString(), "28P01"], [databaseUrl("nosuchdb_x"), "3D000"]] as const) {
      const layer = postgres({ url });
      const error = await layer.transaction(async () => 1).catch((cause: unknown) => cause);
      await layer.close();
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith(`Cannot connect to the database postgres://${good.hostname}:`);
      expect((error as Error).message).toEndWith(`(SQLSTATE ${sqlstate})`);
      expect((error as Error).message).not.toContain("certainly-not-the-password");
      if (good.password) expect((error as Error).message).not.toContain(good.password);
    }
  }, 30_000);

  test("close() rejects while a transaction runs, and the layer opens again afterwards", async () => {
    const layer = postgres({ url: serverUrl! });
    const held = gate();
    const running = layer.transaction(async () => { await held.wait; return 1; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(layer.close()).rejects.toThrow("Cannot close Postgres data layer: 1 running and 0 queued");
    held.open();
    expect(await running).toBe(1);
    await layer.close();
    expect(await layer.transaction(async () => 2)).toBe(2);
    await layer.close();
    await layer.close();
  }, 30_000);
});

class Paid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration = { kind: "event", fqn: "busy.Paid", is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
  readonly n: number;
  constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
}
const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;
const nOf = (event: EventRecord<object>) => (event.payload as { n: number }).n;

/** Publish one `Paid` per `n` in one transaction of `binding` over `layer`. */
function publish(binding: { transaction<T>(run: () => Promise<T>): Promise<T> }, layer: DataLayer, ...ns: number[]) {
  return binding.transaction(() => layer.transaction(async (tx) => {
    for (const n of ns) await publishEvent(tx, undefined, { entity: "busy.Thing", action: "make", key: { id: `k${n}` }, at: "busy" }, new Paid({ n }), {}, () => new Date());
  }));
}

/** `layer` with every transaction's rejection recorded in `errors`, with whether the transaction renewed the claim. */
function recording(layer: PostgresLayer, errors: { renewal: boolean; error: unknown }[]): DataLayer {
  return {
    database: layer.database,
    transaction: (run, options) => {
      let renewal = false;
      const watched = (tx: DataOperations) => new Proxy(tx, { get: (target, key) => { if (key === "renewClaim") renewal = true; return Reflect.get(target, key); } });
      return layer.transaction((tx) => run(watched(tx)), options).catch((error: unknown) => { errors.push({ renewal, error }); throw error; });
    },
    readOutbox: (after, limit) => layer.readOutbox(after, limit),
    refuseIfFailed: () => layer.refuseIfFailed(),
    close: () => layer.close(),
  };
}

const schemaOf = (layer: PostgresLayer) => layer.database!.split("#")[1]!;

describeServer("transient errors in delivery on Postgres", () => {
  const database = testDatabase(events.tables);

  test("a handler transaction that meets 40001 ends the round without counting a try, and the next round handles the event once", async () => {
    const layer = await database.freshLayer();
    const runs: number[] = [];
    const inside = { open: () => {}, wait: Promise.resolve() };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    inside.wait = new Promise<void>((resolve) => { inside.open = resolve; });
    const module: EventsModule = { handlers: { process: { h: {
      events: [Paid],
      async run(event: EventRecord<object>) {
        runs.push(nOf(event));
        if (runs.length === 1) { inside.open(); await held; }
      },
    } } } };
    // Two retries a round: a counted try would run the body again in the same round.
    const binding = bindDomain({ Paid }, layer, { events: { bus: testBus({ retryDelays: [0, 0], pollMs: 20 }), load: async () => module } }, new AsyncLocalStorage());
    await binding.deliver();
    await publish(binding, layer, 1);
    const round = binding.deliver().then(() => undefined, (error: unknown) => error);
    await inside.wait;
    // A concurrent update of the handler's progress row commits after the handler transaction's snapshot, so the
    // handler's own progress write is a serialization failure.
    await database.admin.unsafe(`UPDATE "${schemaOf(layer)}".mesh_handler_progress SET position = position WHERE name = 'h'`);
    release();
    const error = await round;
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(error).toMatchObject({ reason: "serialization", sqlstate: "40001", retryable: true });
    expect(runs).toEqual([1]);
    await binding.deliver();
    expect(runs).toEqual([1, 1]);
    await binding.deliver();
    expect(runs).toEqual([1, 1]);
    const [progress] = await layer.transaction((tx) => ops(tx).readHandlerProgress());
    expect(progress).toMatchObject({ name: "h", position: 1 });
  }, 60_000);

  test("a terminated read connection is a retryable connection error and the next read reconnects; under localBus such a round ends and the handler is not stopped", async () => {
    const killer = new SQL(database.url, { max: 1 });
    // A read connection is one whose last statement was the read of the rows (its LEFT JOIN LATERAL); only the
    // outbox read sends it, so the transaction connections are left alone.
    const killReaders = async () => (await killer.unsafe(
      `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND query LIKE '%LEFT JOIN LATERAL%'`)).length;
    try {
      const layer = await database.freshLayer();
      expect((await layer.readOutbox(0, 10)).rows).toEqual([]);
      expect(await killReaders()).toBeGreaterThan(0);
      const lost = await layer.readOutbox(0, 10).then(() => undefined, (error: unknown) => error);
      expect(lost).toBeInstanceOf(DatabaseBusyError);
      expect(lost).toMatchObject({ reason: "connection", retryable: true });
      expect((await layer.readOutbox(0, 10)).rows).toEqual([]);

      const delivering = await database.freshLayer();
      const seen: number[] = [];
      const stopped: HandlerStoppedError[] = [];
      const module: EventsModule = { handlers: { process: { h: { events: [Paid], run(event: EventRecord<object>) { seen.push(nOf(event)); } } } } };
      const binding = bindDomain({ Paid }, delivering, { events: { bus: localBus({ pollInterval: 50, onStopped: (error) => { stopped.push(error); } }), load: async () => module } }, new AsyncLocalStorage());
      const errors = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
      const delivery = await binding.startDelivery();
      let killed = 0;
      try {
        await publish(binding, delivering, 1);
        for (let i = 0; i < 3; i++) { killed += await killReaders(); await Bun.sleep(120); }
        await publish(binding, delivering, 2);
        const end = Date.now() + 10_000;
        while (seen.length < 2 && Date.now() < end) await Bun.sleep(50);
      } finally {
        await delivery.stop();
        console.error = errors;
      }
      // The loop did kill the delivery's read connection at least once while it delivered.
      expect(killed).toBeGreaterThan(0);
      expect(seen).toEqual([1, 2]);
      expect(stopped).toEqual([]);
      expect(logged.filter((line) => line.includes("MESH_HANDLER_STOPPED"))).toEqual([]);
    } finally { await killer.close(); }
  }, 60_000);

  test("a claim renewal that meets 40001 is retried and keeps the claim", async () => {
    const layer = await database.freshLayer();
    const errors: { renewal: boolean; error: unknown }[] = [];
    const seen: number[] = [];
    const module: EventsModule = { handlers: { process: { h: { events: [Paid], run(event: EventRecord<object>) { seen.push(nOf(event)); } } } } };
    setDeliveryTiming({ renewMs: 100, lapseMs: 5000 });
    const recorded = recording(layer, errors);
    const binding = bindDomain({ Paid }, recorded, { events: { bus: testBus({ pollMs: 50 }), load: async () => module } }, new AsyncLocalStorage());
    const quiet = console.error;
    console.error = () => {}; // a round's deletion pass may meet the same 40001, which testBus reports
    const delivery = await binding.startDelivery();
    const holder = await database.admin.reserve();
    try {
      // Another connection updates the state row and holds it past a renewal; the renewal waits on the row, and fails
      // with 40001 once the update commits, since the row changed after the renewal's snapshot.
      await holder.unsafe("BEGIN");
      await holder.unsafe(`UPDATE "${schemaOf(layer)}".mesh_outbox_state SET host = host WHERE id = 1`);
      await Bun.sleep(300);
      await holder.unsafe("COMMIT");
      await Bun.sleep(400);
      expect(errors.some(({ renewal, error }) => renewal && error instanceof DatabaseBusyError && error.reason === "serialization")).toBe(true);
      // The claim is still this process's: delivery goes on.
      await publish(binding, recorded, 1);
      const end = Date.now() + 5000;
      while (seen.length < 1 && Date.now() < end) await Bun.sleep(20);
      expect(seen).toEqual([1]);
    } finally {
      holder.release();
      await delivery.stop();
      console.error = quiet;
      setDeliveryTiming(null);
    }
  }, 60_000);
});
