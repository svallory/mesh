import { expect, test } from "bun:test";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { DatabaseBusyError, FrameworkError } from "@meshfw/runtime";
import { postgres } from "../src/index.ts";
import { databaseUrl, describeServer, serverUrl, testDatabase } from "./support.ts";

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
