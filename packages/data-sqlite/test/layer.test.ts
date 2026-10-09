import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { FrameworkError, type DataOperations } from "@meshfw/runtime";
import { dataLayerConformance } from "@meshfw/runtime/testing";
import { createSchema, sqlite } from "../src/index.ts";
import { sqliteState } from "../src/layer.ts";
import { MISSING_DRIZZLE_KIT, planSchemaPush } from "../src/push-schema.ts";

const table = sqliteTable("records", {
  id: text("id").primaryKey().notNull(), title: text("title").notNull(), count: integer("count").notNull(),
  score: real("score").notNull(), active: integer("active", { mode: "boolean" }).notNull(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(), status: text("status", { enum: ["draft", "live"] }).notNull(),
  optional: text("optional"),
});
const sampleRow = { id: "00000000-0000-4000-8000-000000000001", title: "First", count: 17, score: 1.25, active: false,
  at: new Date("2026-01-01T00:00:00.123Z"), status: "draft", optional: null };
const secondRow = { ...sampleRow, id: "00000000-0000-4000-8000-000000000002", title: "Second", active: true, optional: "present" };

for (const kind of ["memory", "file"] as const) {
  describe(`${kind} database conformance`, () => {
    const checks = dataLayerConformance(async () => {
      const dir = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-sqlite-")) : undefined;
      const layer = sqlite({ file: dir ? join(dir, "test.db") : ":memory:" });
      try { await createSchema(layer, { table }); }
      catch (error) { await layer.close(); if (dir) rmSync(dir, { recursive: true, force: true }); throw error; }
      return {
        layer: { transaction: layer.transaction, close: async () => { await layer.close(); if (dir) rmSync(dir, { recursive: true, force: true }); } },
        table, sampleRow, secondRow, key: { id: sampleRow.id }, secondKey: { id: secondRow.id },
        changes: { title: "Changed", active: true, at: new Date("2026-02-01T00:00:00.456Z") },
      };
    });
    for (const [name, check] of Object.entries(checks)) test(name, check);
  });
}

async function withLayer(run: (layer: ReturnType<typeof sqlite>) => Promise<void>) {
  const layer = sqlite({ file: ":memory:" });
  try { await createSchema(layer, { table }); await run(layer); }
  finally { await layer.close(); }
}

test("sqlite validates configuration and exposes frozen build metadata without opening a connection", async () => {
  // SAFETY: invalid inputs deliberately exercise the JavaScript boundary.
  for (const options of [undefined, {}, { file: "" }, { file: 1 }]) expect(() => sqlite(options as never)).toThrow(FrameworkError);
  const dir = mkdtempSync(join(tmpdir(), "mesh-lazy-"));
  try {
    const options = { file: join(dir, "lazy.db") };
    const layer = sqlite(options);
    options.file = ":memory:";
    expect(layer.kind).toBe("data-adapter");
    expect(layer.name).toBe("sqlite");
    expect(layer.build).toBe("@meshfw/data-sqlite/build");
    expect(Object.isFrozen(layer)).toBe(true);
    expect(layer.options.file).toBe(join(dir, "lazy.db"));
    expect(Object.isFrozen(layer.options)).toBe(true);
    expect(existsSync(layer.options.file)).toBe(false);
    await createSchema(layer, { table });
    expect(existsSync(layer.options.file)).toBe(true);
    await layer.close();
    await layer.close();
    expect(() => layer.transaction(async () => {})).toThrow(FrameworkError);
    await expect(createSchema(layer, { table })).rejects.toThrow(FrameworkError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("closing before first use never opens a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-unopened-"));
  try {
    const file = join(dir, "no.db");
    const layer = sqlite({ file });
    await layer.close();
    expect(existsSync(file)).toBe(false);
    expect(() => layer.transaction(async () => {})).toThrow("closed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createSchema push API creates tables on the same connection and is idempotent", async () => {
  await withLayer(async (layer) => {
    await layer.transaction(async (tx) => expect(await tx.insert(table, sampleRow)).toEqual(sampleRow));
    await createSchema(layer, { table });
    await layer.transaction(async (tx) => expect(await tx.selectByKey(table, { id: sampleRow.id })).toEqual(sampleRow));
  });
});

test("createSchema refuses data-losing statements and preserves existing rows", async () => {
  await withLayer(async (layer) => {
    await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
    await expect(createSchema(layer, {})).rejects.toThrow("DROP TABLE");
    await layer.transaction(async (tx) => expect(await tx.selectAll(table)).toEqual([sampleRow]));
  });
});

test("createSchema rejects a foreign layer and invalid table handles", async () => {
  await expect(createSchema({ transaction: async () => { throw new Error("must not run"); }, close: async () => {} }, {})).rejects.toThrow("made by sqlite()");
  await withLayer(async (layer) => {
    const postgres = pgTable("wrong", { id: pgText("id") });
    for (const invalid of [{}, postgres]) {
      await expect(createSchema(layer, { invalid })).rejects.toThrow("Drizzle SQLite table");
      await expect(layer.transaction((tx) => tx.selectAll(invalid))).rejects.toThrow("Drizzle SQLite table");
    }
  });
});

test("missing development tooling reports the exact installation instruction and cause", async () => {
  await withLayer(async (layer) => {
    const cause = new Error("module not found");
    await sqliteState(layer).exclusive(async (db) => {
      try { await planSchemaPush(db, { table }, async () => { throw cause; }); throw new Error("did not reject"); }
      catch (error) {
        expect(error).toBeInstanceOf(FrameworkError);
        expect(MISSING_DRIZZLE_KIT).toBe("createSchema needs drizzle-kit, a development dependency. Run: bun add -d drizzle-kit@0.31.11. Production databases are prepared with migrations, not with createSchema.");
        expect((error as Error).message).toBe(MISSING_DRIZZLE_KIT);
        expect((error as Error).cause).toBe(cause);
      }
    });
  });
});

test("synchronous throw rolls back and preserves the error object", async () => {
  await withLayer(async (layer) => {
    const cause = new Error("sync callback");
    await expect(layer.transaction(() => { throw cause; })).rejects.toBe(cause);
    await layer.transaction(async (tx) => expect(await tx.selectAll(table)).toEqual([]));
  });
});

test("operations are revoked after success and failure", async () => {
  await withLayer(async (layer) => {
    for (const fail of [false, true]) {
      let held: DataOperations | undefined;
      const cause = new Error("rollback");
      const pending = layer.transaction(async (tx) => { held = tx; if (fail) throw cause; });
      if (fail) await expect(pending).rejects.toBe(cause); else await pending;
      if (!held) throw new Error("callback not run");
      for (const call of [() => held!.insert(table, sampleRow), () => held!.selectAll(table), () => held!.selectByKey(table, { id: sampleRow.id }),
        () => held!.updateByKey(table, { id: sampleRow.id }, {}), () => held!.deleteByKey(table, { id: sampleRow.id })]) {
        await expect(call()).rejects.toThrow("no longer active");
      }
    }
  });
});

test("constraint errors are FrameworkError with the original driver error as cause", async () => {
  await withLayer(async (layer) => {
    await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
    try { await layer.transaction((tx) => tx.insert(table, sampleRow)); throw new Error("did not reject"); }
    catch (error) { expect(error).toBeInstanceOf(FrameworkError); expect((error as Error).cause).toBeInstanceOf(Error); }
    await layer.transaction(async (tx) => expect(await tx.selectAll(table)).toEqual([sampleRow]));
  });
});

test("COMMIT failure rolls back the write and rethrows unchanged", async () => {
  await withLayer(async (layer) => {
    const db = await sqliteState(layer).exclusive(async (db) => db);
    const original = db.run.bind(db);
    const cause = new Error("commit failure");
    const statements: string[] = [];
    const spy = spyOn(db, "run").mockImplementation((statement) => {
      const text = new SQLiteSyncDialect().sqlToQuery(typeof statement === "string" ? sql.raw(statement) : statement.getSQL()).sql;
      statements.push(text);
      if (text === "COMMIT") throw cause;
      return original(statement);
    });
    try { await expect(layer.transaction((tx) => tx.insert(table, sampleRow))).rejects.toBe(cause); }
    finally { spy.mockRestore(); }
    expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
    await layer.transaction(async (tx) => expect(await tx.selectAll(table)).toEqual([]));
  });
});

test.each(["memory", "file"])("ROLLBACK failure fails closed for queued and later work (%s)", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-fatal-"));
  const file = kind === "memory" ? ":memory:" : join(dir, "fatal.db");
  const layer = sqlite({ file });
  try {
    await createSchema(layer, { table });
    const db = await sqliteState(layer).exclusive(async (db) => db);
    const original = db.run.bind(db);
    const transaction = new Error("callback failure");
    const rollback = new Error("rollback failure");
    const statements: string[] = [];
    let rejectRollback = true;
    const spy = spyOn(db, "run").mockImplementation((statement) => {
      const text = new SQLiteSyncDialect().sqlToQuery(typeof statement === "string" ? sql.raw(statement) : statement.getSQL()).sql;
      statements.push(text);
      if (text === "ROLLBACK" && rejectRollback) { rejectRollback = false; throw rollback; }
      return original(statement);
    });
    try {
      const first = layer.transaction(async (tx) => { await tx.insert(table, sampleRow); throw transaction; });
      let callbacks = 0;
      const successors = [layer.transaction(async () => { callbacks++; }), layer.transaction(async () => { callbacks++; })];
      const results = await Promise.allSettled([first, ...successors]);
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected") throw new Error("expected rejection");
        expect(result.reason).toBeInstanceOf(FrameworkError);
        expect(result.reason.cause.transaction).toBe(transaction);
        expect(result.reason.cause.rollback).toBe(rollback);
        expect(result.reason.message).toBe(index === 0 ? "Transaction failed and ROLLBACK failed" :
          "this data layer is unusable: a rollback failed, so its connection may still be inside a transaction. Close it and create a new one.");
      }
      await expect(layer.transaction(async () => { callbacks++; })).rejects.toThrow("this data layer is unusable");
      await expect(createSchema(layer, { table })).rejects.toThrow("this data layer is unusable");
      expect(callbacks).toBe(0);
      expect(statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    } finally { spy.mockRestore(); }
    // No out-of-band rollback: closing is the only permitted cleanup/recovery.
    await layer.close();
    await layer.close();
    expect(() => layer.transaction(async () => {})).toThrow("SQLite data layer is closed");
  } finally { await layer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("closing a fatally failed layer releases the write lock for a new layer on the same file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-unlock-"));
  const file = join(dir, "unlocked.db");
  const layer = sqlite({ file });
  try {
    await createSchema(layer, { table });
    const db = await sqliteState(layer).exclusive(async (db) => db);
    const original = db.run.bind(db);
    let sent = false;
    const spy = spyOn(db, "run").mockImplementation((statement) => {
      const text = new SQLiteSyncDialect().sqlToQuery(typeof statement === "string" ? sql.raw(statement) : statement.getSQL()).sql;
      if (text === "ROLLBACK" && !sent) { sent = true; throw new Error("swallowed rollback"); }
      return original(statement);
    });
    try {
      await expect(layer.transaction(async (tx) => { await tx.insert(table, sampleRow); throw new Error("callback failure"); }))
        .rejects.toThrow("Transaction failed and ROLLBACK failed");
    }
    finally { spy.mockRestore(); db.run = original; }
    // The transaction never rolled back, so the write lock is still held.
    const blocked = sqlite({ file });
    await expect(blocked.transaction(async () => {})).rejects.toThrow("another connection holds the write lock");
    await blocked.close();
    // close() drops the native handle and the Drizzle references that keep its
    // prepared statements alive; the deferred close then completes. One explicit
    // full collection makes that finalisation deterministic instead of waiting
    // for an arbitrary garbage-collection cycle.
    await layer.close();
    Bun.gc(true);
    const probe = new Database(file);
    try { probe.run("BEGIN IMMEDIATE"); probe.run("ROLLBACK"); }
    finally { probe.close(); }
    const next = sqlite({ file });
    try { await next.transaction(async (tx) => expect(await tx.selectAll(table)).toEqual([])); }
    finally { await next.close(); }
  } finally { await layer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("close reports running and queued counts without closing a busy layer", async () => {
  await withLayer(async (layer) => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const begin = new Promise<void>((resolve) => { started = resolve; });
    const first = layer.transaction(async () => { started(); await gate; });
    await begin;
    const second = layer.transaction(async () => 2);
    try { await expect(layer.close()).rejects.toThrow("1 running and 1 queued"); }
    finally { release(); await first; expect(await second).toBe(2); }
  });
});

test("a queued but not started transaction prevents close", async () => {
  const layer = sqlite({ file: ":memory:" });
  const pending = layer.transaction(async () => 1);
  const closed = layer.close();
  await expect(closed).rejects.toThrow("0 running and 1 queued");
  expect(await pending).toBe(1);
  await layer.close();
});

async function frameworkFailure(promise: Promise<unknown>): Promise<FrameworkError> {
  try { await promise; } catch (error) {
    if (!(error instanceof FrameworkError)) throw error;
    return error;
  }
  throw new Error("expected FrameworkError");
}

test("lazy-open failure names the operation and file, retains cause, and permits later recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-open-failure-"));
  const parent = join(dir, "missing");
  const file = join(parent, "data.db");
  const layer = sqlite({ file });
  try {
    let calls = 0;
    const failed = await Promise.all([
      frameworkFailure(layer.transaction(async () => { calls++; })),
      frameworkFailure(layer.transaction(async () => { calls++; })),
    ]);
    for (const error of failed) {
      expect(error.message).toContain(`Cannot open a connection for SQLite file ${JSON.stringify(file)}`);
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.cause).toMatchObject({ code: "SQLITE_CANTOPEN" });
    }
    expect(calls).toBe(0);
    mkdirSync(parent);
    await createSchema(layer, { table });
    await layer.transaction(async (tx) => expect(await tx.insert(table, sampleRow)).toEqual(sampleRow));
  } finally { await layer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("BEGIN busy failure explains the per-layer lock boundary and the queue recovers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-busy-"));
  const file = join(dir, "shared.db");
  const first = sqlite({ file });
  const second = sqlite({ file });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let pending: Promise<void> | undefined;
  try {
    await createSchema(first, { table });
    pending = first.transaction(async (tx) => { await tx.insert(table, sampleRow); started(); await gate; });
    await entered;
    let calls = 0;
    const failures = await Promise.all([
      frameworkFailure(second.transaction(async () => { calls++; })),
      frameworkFailure(second.transaction(async () => { calls++; })),
    ]);
    for (const error of failures) {
      expect(error.message).toBe(`Cannot run BEGIN IMMEDIATE for SQLite file ${JSON.stringify(file)}. The queue serialises one layer only; another connection holds the write lock. The caller decides whether to retry.`);
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.cause).toMatchObject({ cause: { code: "SQLITE_BUSY" } });
    }
    expect(calls).toBe(0);
    release();
    await pending;
    await second.transaction(async (tx) => expect(await tx.selectAll(table)).toEqual([sampleRow]));
  } finally { release(); await pending; await first.close(); await second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("createSchema rejects unsafe direct table and column names before opening a connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-unsafe-name-"));
  const file = join(dir, "untouched.db");
  const layer = sqlite({ file });
  try {
    const names = ["injected` (id text, hacked text); --", ...Array.from({ length: 32 }, (_, i) => `bad${String.fromCharCode(i)}name`), "bad\x7fname"];
    for (const name of names) {
      for (const kind of ["table", "column"] as const) {
        const unsafe = kind === "table" ? sqliteTable(name, { id: text("id") }) : sqliteTable("unsafe", { field: text(name) });
        const error = await frameworkFailure(createSchema(layer, { safe: table, unsafe }));
        expect(error.message).toBe(`"${name}" cannot be used as a SQLite ${kind} name: it contains a character that the schema tools cannot quote safely (backtick or control character)`);
        expect(existsSync(file)).toBe(false);
      }
    }
    await sqliteState(layer).exclusive(async (db) => expect(db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)).toEqual([]));
  } finally { await layer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("nested calls throw immediately rather than queuing behind themselves", async () => {
  await withLayer(async (layer) => {
    await layer.transaction(async () => {
      await Promise.resolve();
      expect(() => layer.transaction(async () => {})).toThrow("nested transactions are not supported");
    });
  });
});
