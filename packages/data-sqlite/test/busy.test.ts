import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseBusyError } from "@meshfw/runtime";
import { createSchema, sqlite } from "../src/index.ts";
import { sqliteState, sqliteWith } from "../src/layer.ts";

// The wait for a lock is 5 s by default; `sqliteWith` shortens it here so no test waits that long. The default itself
// is pinned by the first test below.
const table = sqliteTable("records", { id: text("id").primaryKey().notNull(), n: integer("n").notNull() });
const other = sqliteTable("others", { id: text("id").primaryKey().notNull() });

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mesh-wait-")); file = join(dir, "app.db"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mode = (path: string) => {
  const probe = new Database(path);
  try { return (probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode; }
  finally { probe.close(); }
};
/** Another connection (the stand-in for another process) that holds the write lock until `release()`. */
function holder(path: string) {
  const connection = new Database(path);
  connection.run("BEGIN IMMEDIATE");
  let open = true;
  return { release() { if (open) { open = false; connection.run("COMMIT"); connection.close(); } } };
}

describe("waiting for a lock", () => {
  test("a transaction that waits does not freeze the process: a timer keeps firing, then the transaction commits", async () => {
    const layer = sqliteWith({ file }, { waitMs: 3000 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      const waiting = layer.transaction(async (tx) => tx.insert(table, { id: "a", n: 1 }));
      await sleep(400);
      const during = ticks;
      lock.release();
      await waiting;
      clearInterval(timer);
      // A synchronous busy_timeout wait would have stopped the timer for the whole 400 ms.
      expect(during).toBeGreaterThanOrEqual(15);
      await layer.transaction(async (tx) => expect((await tx.select(table)).map((row) => row.id)).toEqual(["a"]));
    } finally { await layer.close(); }
  });

  test("two layers on one file in one process do not deadlock, and the later write reads the earlier one", async () => {
    const first = sqlite({ file });
    const second = sqlite({ file });
    try {
      await createSchema(first, { table });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const one = first.transaction(async (tx) => { await tx.insert(table, { id: "one", n: 1 }); entered(); await sleep(150); });
      await inside;
      const two = second.transaction(async (tx) => {
        const seen = (await tx.select(table)).map((row) => row.id);
        await tx.insert(table, { id: "two", n: seen.length });
        return seen;
      });
      const [, seen] = await Promise.all([one, two]);
      expect(seen).toEqual(["one"]);
    } finally { await first.close(); await second.close(); }
  });

  test("a lock held past the wait fails with MESH_DATABASE_BUSY, and the layer works once the lock is gone", async () => {
    const layer = sqliteWith({ file }, { waitMs: 300 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const started = performance.now();
      const error = await layer.transaction(async () => {}).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DatabaseBusyError);
      const busy = error as DatabaseBusyError;
      expect(busy.code).toBe("MESH_DATABASE_BUSY");
      expect(busy.file).toBe(file);
      expect(busy.waitedMs).toBeGreaterThanOrEqual(300);
      expect(busy.waitedMs).toBeLessThan(1500);
      expect(performance.now() - started).toBeLessThan(1500);
      lock.release();
      await layer.transaction(async (tx) => { await tx.insert(table, { id: "late", n: 1 }); });
    } finally { await layer.close(); }
  });

  test("the default wait is 5 s", async () => {
    const layer = sqlite({ file });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const started = performance.now();
      const error = await layer.transaction(async () => {}).catch((cause: unknown) => cause);
      lock.release();
      expect(error).toBeInstanceOf(DatabaseBusyError);
      expect((error as DatabaseBusyError).waitedMs).toBeGreaterThanOrEqual(5000);
      expect(performance.now() - started).toBeLessThan(8000);
    } finally { await layer.close(); }
  }, 15_000);

  test("a caller can pass a longer wait for one transaction (the internal option)", async () => {
    const layer = sqliteWith({ file }, { waitMs: 50 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const waiting = sqliteState(layer).transaction(async (tx) => { await tx.insert(table, { id: "x", n: 1 }); }, { waitMs: 2000 });
      await sleep(300); // past the layer's own 50 ms
      lock.release();
      await waiting;
    } finally { await layer.close(); }
  });

  test("queued transactions on a blocked layer run in the order they were made", async () => {
    const layer = sqliteWith({ file }, { waitMs: 3000 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const order: number[] = [];
      const all = [0, 1, 2, 3].map((n) => layer.transaction(async (tx) => { order.push(n); await tx.insert(table, { id: `r${n}`, n }); }));
      await sleep(100);
      lock.release();
      await Promise.all(all);
      expect(order).toEqual([0, 1, 2, 3]);
    } finally { await layer.close(); }
  });

  test("two processes writing one file at once both commit every row", async () => {
    const layer = sqlite({ file });
    try {
      await createSchema(layer, { table });
      const worker = Bun.spawn([process.execPath, join(import.meta.dir, "busy-worker.ts"), file, "child", "40"], { stdout: "inherit", stderr: "inherit", env: { ...process.env } });
      for (let i = 0; i < 40; i++) {
        await layer.transaction(async (tx) => {
          await tx.insert(table, { id: `parent-${i}`, n: i });
          await sleep(5);
        });
      }
      expect(await worker.exited).toBe(0);
      const rows = await layer.transaction(async (tx) => tx.select(table));
      expect(rows).toHaveLength(80);
      expect(new Set(rows.map((row) => row.id)).size).toBe(80);
    } finally { await layer.close(); }
  }, 60_000);
});

describe("WAL", () => {
  test("a new file database opens in WAL mode, and a memory database does not", async () => {
    const layer = sqlite({ file });
    const memory = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, { table });
      expect(mode(file)).toBe("wal");
      await createSchema(memory, { table });
      await memory.transaction(async (tx) => { await tx.insert(table, { id: "m", n: 1 }); });
      const state = await sqliteState(memory).exclusive(async (db) => db.all(sql.raw("PRAGMA journal_mode")) as { journal_mode: string }[]);
      expect(state).toEqual([{ journal_mode: "memory" }]);
    } finally { await layer.close(); await memory.close(); }
  });

  test("an existing rollback-journal file is switched to WAL, and its rows survive", async () => {
    const old = new Database(file);
    old.run("CREATE TABLE records (id text PRIMARY KEY NOT NULL, n integer NOT NULL)");
    old.run("INSERT INTO records VALUES ('old', 1)");
    old.close();
    expect(mode(file)).toBe("delete");
    const layer = sqlite({ file });
    try {
      await layer.transaction(async (tx) => expect((await tx.select(table)).map((row) => row.id)).toEqual(["old"]));
      expect(mode(file)).toBe("wal");
    } finally { await layer.close(); }
  });

  test("a file already in WAL opens again, and so does the daemon's own pragma on it", async () => {
    const layer = sqlite({ file });
    try {
      await createSchema(layer, { table });
      await layer.close();
      const probe = new Database(file);
      try { expect(probe.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" }); } finally { probe.close(); }
      await layer.transaction(async (tx) => { await tx.insert(table, { id: "again", n: 1 }); });
    } finally { await layer.close(); }
  });

  test("the first open of a rollback-journal file while another connection writes waits, then switches to WAL once that write commits", async () => {
    const old = new Database(file);
    old.run("CREATE TABLE records (id text PRIMARY KEY NOT NULL, n integer NOT NULL)");
    old.close();
    const lock = holder(file);
    const layer = sqliteWith({ file }, { waitMs: 3000 });
    try {
      const waiting = layer.transaction(async (tx) => { await tx.insert(table, { id: "w", n: 1 }); });
      await sleep(250);
      lock.release();
      await waiting;
      expect(mode(file)).toBe("wal");
      await layer.transaction(async (tx) => expect((await tx.select(table)).map((row) => row.id)).toEqual(["w"]));
    } finally { lock.release(); await layer.close(); }
  });

  test("the switch fails with MESH_DATABASE_BUSY when that write lasts past the wait, and a later open works", async () => {
    const old = new Database(file);
    old.run("CREATE TABLE records (id text PRIMARY KEY NOT NULL, n integer NOT NULL)");
    old.close();
    const lock = holder(file);
    const layer = sqliteWith({ file }, { waitMs: 300 });
    try {
      const error = await layer.transaction(async () => {}).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DatabaseBusyError);
      expect((error as DatabaseBusyError).file).toBe(file);
      expect((error as DatabaseBusyError).waitedMs).toBeGreaterThanOrEqual(300);
      lock.release();
      await layer.transaction(async (tx) => { await tx.insert(table, { id: "ok", n: 1 }); });
      expect(mode(file)).toBe("wal");
    } finally { lock.release(); await layer.close(); }
  });
});

describe("a busy statement that is not retried", () => {
  test("schema preparation that meets a lock fails at once with MESH_DATABASE_BUSY, never the raw error", async () => {
    const layer = sqliteWith({ file }, { waitMs: 3000 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const started = performance.now();
      const error = await createSchema(layer, { table, other }).catch((cause: unknown) => cause);
      lock.release();
      expect(error).toBeInstanceOf(DatabaseBusyError);
      expect((error as DatabaseBusyError).waitedMs).toBe(0);
      expect((error as DatabaseBusyError).code).toBe("MESH_DATABASE_BUSY");
      expect(performance.now() - started).toBeLessThan(1500);
      await createSchema(layer, { table, other });
    } finally { await layer.close(); }
  });
});
