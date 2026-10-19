import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseBusyError, FrameworkError } from "@meshfw/runtime";
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

/**
 * Runs `scenario` under fake timers, advancing the fake clock 50 ms at a time (flushing microtasks between steps)
 * until it settles, so the layer's busy retry loop — a `setTimeout` sleep checked against a `performance.now()`
 * deadline — runs through its whole wait in faked milliseconds instead of real ones: `advanceTimersByTime` advances
 * `performance.now` with it, which is what the deadline math and `waitedMs` read. The scenario may schedule its own
 * timers (a lock released at a faked instant); they fire as the clock is advanced the same way.
 */
async function withoutRealTime<T>(scenario: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  let settled = false;
  try {
    const result = scenario();
    void result.then(() => { settled = true; }, () => { settled = true; });
    for (let advanced = 0; !settled && advanced < 120_000; advanced += 50) {
      jest.advanceTimersByTime(50);
      for (let i = 0; i < 50 && !settled; i++) await Promise.resolve();
    }
    return await result;
  } finally {
    jest.useRealTimers();
  }
}

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
      let enough!: () => void;
      const ticked = new Promise<void>((resolve) => { enough = resolve; });
      const timer = setInterval(() => { if (++ticks >= 15) enough(); }, 10);
      let deadline!: ReturnType<typeof setTimeout>;
      const observed = new Promise<void>((resolve) => { deadline = setTimeout(resolve, 400); });
      const waiting = layer.transaction(async (tx) => tx.insert(table, { id: "a", n: 1 }));
      let during: number;
      try {
        // Finish early when responsive, but sample after at most the original 400 ms observation window.
        await Promise.race([ticked, observed]);
        during = ticks;
      } finally {
        clearInterval(timer);
        clearTimeout(deadline);
        lock.release();
        await waiting;
      }
      // A synchronous busy_timeout wait would have stopped the timer before it reached 15 ticks.
      expect(during).toBeGreaterThanOrEqual(15);
      await layer.transaction(async (tx) => expect((await tx.select(table)).map((row) => row.id)).toEqual(["a"]));
    } finally { await layer.close(); }
  });

  test("two layers on one file in one process do not deadlock, and the later write reads the earlier one", async () => {
    const first = sqlite({ file });
    const second = sqlite({ file });
    try {
      await createSchema(first, { table });
      const seen = await withoutRealTime(async () => {
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
        return seen;
      });
      expect(seen).toEqual(["one"]);
    } finally { await first.close(); await second.close(); }
  });

  test("a lock held past the wait fails with MESH_DATABASE_BUSY, and the layer works once the lock is gone", async () => {
    const layer = sqliteWith({ file }, { waitMs: 300 });
    let lock: ReturnType<typeof holder> | undefined;
    try {
      await createSchema(layer, { table });
      lock = holder(file);
      const error = await withoutRealTime(async () => {
        const started = performance.now();
        const error = await layer.transaction(async () => {}).catch((cause: unknown) => cause);
        expect(performance.now() - started).toBeLessThan(1500);
        return error;
      });
      expect(error).toBeInstanceOf(DatabaseBusyError);
      const busy = error as DatabaseBusyError;
      expect(busy.code).toBe("MESH_DATABASE_BUSY");
      expect(busy.file).toBe(file);
      expect(busy.waitedMs).toBeGreaterThanOrEqual(300);
      expect(busy.waitedMs).toBeLessThan(1500);
      lock.release();
      await layer.transaction(async (tx) => { await tx.insert(table, { id: "late", n: 1 }); });
    } finally { lock?.release(); await layer.close(); }
  });

  test("the default wait is 5 s", async () => {
    const layer = sqlite({ file });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const error = await withoutRealTime(async () => {
        const started = performance.now();
        const error = await layer.transaction(async () => {}).catch((cause: unknown) => cause);
        expect(performance.now() - started).toBeLessThan(8000);
        return error;
      });
      lock.release();
      expect(error).toBeInstanceOf(DatabaseBusyError);
      expect((error as DatabaseBusyError).waitedMs).toBeGreaterThanOrEqual(5000);
    } finally { await layer.close(); }
  }, 15_000);

  test("a caller can pass a longer wait for one transaction (the internal option)", async () => {
    const layer = sqliteWith({ file }, { waitMs: 50 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      // The lock goes 250 ms in, past the layer's own 50 ms, on the faked clock.
      await withoutRealTime(async () => {
        setTimeout(() => lock.release(), 250);
        return sqliteState(layer).transaction(async (tx) => { await tx.insert(table, { id: "x", n: 1 }); }, { waitMs: 2000 });
      });
    } finally { await layer.close(); }
  });

  test("queued transactions on a blocked layer run in the order they were made", async () => {
    const layer = sqliteWith({ file }, { waitMs: 3000 });
    try {
      await createSchema(layer, { table });
      const lock = holder(file);
      const order: number[] = [];
      const all = [0, 1, 2, 3].map((n) => layer.transaction(async (tx) => { order.push(n); await tx.insert(table, { id: `r${n}`, n }); }));
      await withoutRealTime(async () => {
        // The lock goes 100 ms in, on the faked clock.
        setTimeout(() => lock.release(), 100);
        await Promise.all(all);
      });
      expect(order).toEqual([0, 1, 2, 3]);
    } finally { await layer.close(); }
  });

  test("two processes writing one file at once both commit every row, and one waits for the other's lock", async () => {
    const layer = sqlite({ file });
    const count = 60;
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "busy-worker.ts"), file, "child", String(count)], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env } });
    try {
      await createSchema(layer, { table });
      // The child has opened its layer before either side writes, so the two write loops overlap.
      const reader = worker.stdout.getReader();
      let seen = "";
      const until = async (word: string) => {
        while (!seen.includes(word)) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`the worker ended before ${word}: ${seen}`);
          seen += new TextDecoder().decode(value);
        }
      };
      await until("READY");
      worker.stdin.write("GO\n");
      await worker.stdin.flush();
      // The child's first transaction holds the write lock for 300 ms and says so from inside it.
      await until("LOCKED");
      let longest = 0;
      for (let i = 0; i < count; i++) {
        const began = performance.now();
        await layer.transaction(async (tx) => {
          await tx.insert(table, { id: `parent-${i}`, n: i });
          await sleep(5);
        });
        longest = Math.max(longest, performance.now() - began);
      }
      expect(await worker.exited).toBe(0);
      const rows = await layer.transaction(async (tx) => tx.select(table));
      expect(rows).toHaveLength(count * 2);
      expect(new Set(rows.map((row) => row.id)).size).toBe(count * 2);
      // The parent's first write met the child's 300 ms lock and waited it out (SQLite does not queue fairly, so the later
      // commits need not alternate).
      expect(longest).toBeGreaterThan(150);
    } finally { worker.kill(); await layer.close(); }
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
      // The lock goes 250 ms in, on the faked clock, and the open succeeds once it has.
      await withoutRealTime(async () => {
        setTimeout(() => lock.release(), 250);
        return layer.transaction(async (tx) => { await tx.insert(table, { id: "w", n: 1 }); });
      });
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
      const error = await withoutRealTime(() => layer.transaction(async () => {}).catch((cause: unknown) => cause));
      // Still in the rollback journal: the failure came from the switch, never from BEGIN.
      expect(mode(file)).toBe("delete");
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
    let lock: ReturnType<typeof holder> | undefined;
    try {
      await createSchema(layer, { table });
      lock = holder(file);
      const started = performance.now();
      const error = await createSchema(layer, { table, other }).catch((cause: unknown) => cause);
      lock.release();
      expect(error).toBeInstanceOf(DatabaseBusyError);
      expect((error as DatabaseBusyError).waitedMs).toBe(0);
      expect((error as DatabaseBusyError).code).toBe("MESH_DATABASE_BUSY");
      expect(performance.now() - started).toBeLessThan(1500);
      await createSchema(layer, { table, other });
    } finally { lock?.release(); await layer.close(); }
  });
});

describe("one deadline for a call", () => {
  test("the WAL switch and BEGIN IMMEDIATE share the wait: the total stays within it", async () => {
    const old = new Database(file);
    old.run("CREATE TABLE records (id text PRIMARY KEY NOT NULL, n integer NOT NULL)");
    old.close();
    const first = holder(file);
    let second: ReturnType<typeof holder> | undefined;
    // After 250 ms the first holder commits and its connection moves the file to WAL and takes the lock again, in one
    // tick: the layer's switch then succeeds (the file is WAL already) and its BEGIN meets a lock that does not go.
    // Scheduled inside the faked clock, so it fires as the clock is advanced.
    let handover: ReturnType<typeof setTimeout> | undefined;
    const layer = sqliteWith({ file }, { waitMs: 500 });
    try {
      const error = await withoutRealTime(async () => {
        handover = setTimeout(() => {
          first.release();
          const next = new Database(file);
          next.query("PRAGMA journal_mode=WAL").get();
          next.run("BEGIN IMMEDIATE");
          second = { release() { next.run("COMMIT"); next.close(); } };
        }, 250);
        return layer.transaction(async () => {}).catch((cause: unknown) => cause);
      });
      expect(error).toBeInstanceOf(DatabaseBusyError);
      const waited = (error as DatabaseBusyError).waitedMs;
      expect(waited).toBeGreaterThanOrEqual(500);
      // Two clocks would have waited about 250 + 500 ms.
      expect(waited).toBeLessThan(650);
    } finally { if (handover !== undefined) clearTimeout(handover); first.release(); second?.release(); await layer.close(); }
  });
});

describe("busy errors inside a transaction", () => {
  test("a COMMIT that meets a lock is reported as MESH_DATABASE_BUSY, and the transaction rolls back", async () => {
    const layer = sqlite({ file });
    try {
      await createSchema(layer, { table });
      const db = await sqliteState(layer).exclusive(async (db) => db);
      const original = db.run.bind(db);
      const spy = spyOn(db, "run").mockImplementation((statement) => {
        const text = new SQLiteSyncDialect().sqlToQuery(typeof statement === "string" ? sql.raw(statement) : statement.getSQL()).sql;
        if (text === "COMMIT") throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return original(statement);
      });
      let error: unknown;
      try { error = await layer.transaction(async (tx) => { await tx.insert(table, { id: "c", n: 1 }); }).catch((cause: unknown) => cause); }
      finally { spy.mockRestore(); db.run = original; }
      expect(error).toBeInstanceOf(DatabaseBusyError);
      expect((error as DatabaseBusyError).waitedMs).toBe(0);
      expect((error as DatabaseBusyError).cause).toMatchObject({ code: "SQLITE_BUSY" });
      await layer.transaction(async (tx) => expect(await tx.select(table)).toEqual([]));
    } finally { await layer.close(); }
  });

  test("a Mesh error whose cause is a busy error passes through unchanged; a raw busy error from a callback is reported", async () => {
    const layer = sqlite({ file });
    try {
      await createSchema(layer, { table });
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const mine = new FrameworkError("my own message", { cause: busy });
      expect(await layer.transaction(async () => { throw mine; }).catch((cause: unknown) => cause)).toBe(mine);
      const raw = await layer.transaction(async () => { throw busy; }).catch((cause: unknown) => cause);
      expect(raw).toBeInstanceOf(DatabaseBusyError);
      expect((raw as DatabaseBusyError).cause).toBe(busy);
    } finally { await layer.close(); }
  });
});
