import { expect, test } from "bun:test";
import { FrameworkError } from "@meshfw/runtime";
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzleOperations, keyCondition, type DrizzleCommands } from "../src/index.ts";

const table = sqliteTable("rows", { id: integer("id"), tenant: text("tenant"), title: text("title") });
const row = { id: 1, tenant: "a", title: "one" };
function fixture() {
  let updates = 0;
  const commands: DrizzleCommands<typeof table> = {
    table: () => table,
    insert: (_table, values) => values,
    select: () => [row],
    aggregate: () => null,
    update: (_table, _condition, values) => { updates++; return [{ ...row, ...values }]; },
    delete: () => [row],
  };
  return { operations: drizzleOperations(commands, () => {}), updates: () => updates, commands };
}

test("composite keys use every column and parameterise values", () => {
  const query = new SQLiteSyncDialect().sqlToQuery(keyCondition(table, { id: 1, tenant: "a' OR 1=1" }));
  expect(query.sql).toBe('(\"rows\".\"id\" = ? and \"rows\".\"tenant\" = ?)');
  expect(query.params).toEqual([1, "a' OR 1=1"]);
});

test("empty and unknown keys fail without silently dropping fields", async () => {
  const { operations } = fixture();
  for (const key of [{}, { absent: 1 }, { toString: 1 }]) {
    await expect(operations.selectByKey(table, key)).rejects.toBeInstanceOf(FrameworkError);
    await expect(operations.updateByKey(table, key, {})).rejects.toBeInstanceOf(FrameworkError);
    await expect(operations.deleteByKey(table, key)).rejects.toBeInstanceOf(FrameworkError);
  }
});

test("unknown insert and update columns fail, including prototype names", async () => {
  const { operations } = fixture();
  for (const changes of [{ unknown: 1 }, { toString: 1 }, JSON.parse('{"__proto__":1}')]) {
    await expect(operations.insert(table, changes)).rejects.toBeInstanceOf(FrameworkError);
    await expect(operations.updateByKey(table, { id: 1 }, changes)).rejects.toBeInstanceOf(FrameworkError);
  }
});

test("empty changes reads the current row and never writes", async () => {
  const { operations, updates } = fixture();
  expect(await operations.updateByKey(table, { id: 1 }, {})).toEqual(row);
  expect(updates()).toBe(0);
});

test("driver error becomes FrameworkError with the same cause", async () => {
  const { commands } = fixture();
  const cause = new Error("driver constraint");
  commands.insert = () => { throw cause; };
  const operations = drizzleOperations(commands, () => {});
  try { await operations.insert(table, row); throw new Error("did not fail"); }
  catch (error) { expect(error).toBeInstanceOf(FrameworkError); expect((error as Error).cause).toBe(cause); }
});

test("revoked operations reject every method before touching a driver", async () => {
  const { commands } = fixture();
  let accesses = 0;
  commands.table = () => { accesses++; return table; };
  const cause = new FrameworkError("expired");
  const tx = drizzleOperations(commands, () => { throw cause; });
  for (const call of [() => tx.insert(table, row), () => tx.select(table), () => tx.selectByKey(table, { id: 1 }),
    () => tx.updateByKey(table, { id: 1 }, {}), () => tx.deleteByKey(table, { id: 1 })]) {
    await expect(call()).rejects.toBe(cause);
  }
  expect(accesses).toBe(0);
});

// The same operations over a real driver: Drizzle on an in-memory bun:sqlite database.
import { Database } from "bun:sqlite";
import { count, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { drizzleTable } from "../src/index.ts";

const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  tenant: text("tenant").notNull(),
  title: text("title").notNull().unique(),
});
function sqliteOperations() {
  const database = new Database(":memory:");
  database.run('CREATE TABLE posts (id integer PRIMARY KEY, tenant text NOT NULL, title text NOT NULL UNIQUE)');
  const db = drizzle(database);
  const commands: DrizzleCommands<SQLiteTable> = {
    table: (handle) => drizzleTable(handle, SQLiteTable, "SQLite"),
    insert: (target, values) => db.insert(target).values(values).returning().get()!,
    select: (target, options) => {
      let query = db.select().from(target).$dynamic();
      if (options?.where) query = query.where(options.where);
      if (options?.orderBy?.length) query = query.orderBy(...options.orderBy);
      if (options?.limit !== undefined || options?.offset !== undefined) query = query.limit(options.limit ?? Number.MAX_SAFE_INTEGER);
      if (options?.offset !== undefined) query = query.offset(options.offset);
      return query.all();
    },
    aggregate: (target, kind, column, where) => {
      const query = db.select({ value: kind === "max" ? max(column) : count(column) }).from(target).$dynamic();
      return (where ? query.where(where) : query).get()?.value ?? null;
    },
    update: (target, condition, changes) => db.update(target).set(changes).where(condition).returning().all(),
    delete: (target, condition) => db.delete(target).where(condition).returning().all(),
  };
  return { operations: drizzleOperations(commands, () => {}), database };
}

test("bun:sqlite: insert returns the stored row and every read finds it by key", async () => {
  const { operations, database } = sqliteOperations();
  try {
    expect(await operations.insert(posts, { id: 1, tenant: "a", title: "one" })).toEqual({ id: 1, tenant: "a", title: "one" });
    await operations.insert(posts, { id: 2, tenant: "a", title: "two" });
    expect(await operations.selectByKey(posts, { id: 2 })).toEqual({ id: 2, tenant: "a", title: "two" });
    expect(await operations.selectByKey(posts, { id: 2, tenant: "b" })).toBeUndefined();
    expect((await operations.select(posts)).map((row) => row.id).sort()).toEqual([1, 2]);
    expect(await operations.updateByKey(posts, { id: 1 }, { title: "uno" })).toEqual({ id: 1, tenant: "a", title: "uno" });
    expect(await operations.updateByKey(posts, { id: 1 }, {})).toEqual({ id: 1, tenant: "a", title: "uno" });
    expect(await operations.updateByKey(posts, { id: 9 }, { title: "x" })).toBeUndefined();
    expect(await operations.deleteByKey(posts, { id: 1 })).toBe(true);
    expect(await operations.deleteByKey(posts, { id: 1 })).toBe(false);
    expect(await operations.select(posts)).toEqual([{ id: 2, tenant: "a", title: "two" }]);
  } finally { database.close(); }
});

test("bun:sqlite: a constraint violation is a FrameworkError whose cause is the driver error", async () => {
  const { operations, database } = sqliteOperations();
  try {
    await operations.insert(posts, { id: 1, tenant: "a", title: "same" });
    for (const write of [
      () => operations.insert(posts, { id: 1, tenant: "a", title: "other" }),
      () => operations.insert(posts, { id: 2, tenant: "a", title: "same" }),
      () => operations.insert(posts, { id: 3, tenant: null, title: "null tenant" }),
    ]) {
      const error = await write().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe("Database operation failed");
      expect(((error as Error).cause as Error).message).toContain("constraint failed");
    }
  } finally { database.close(); }
});

test("bun:sqlite: a handle that is not a Drizzle SQLite table is refused before any statement", async () => {
  const { operations, database } = sqliteOperations();
  try {
    const foreign = pgTable("posts", { id: pgText("id") });
    for (const handle of [{}, foreign, { _: posts }]) {
      const error = await operations.select(handle).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe("Expected a Drizzle SQLite table from the emitted schema");
    }
  } finally { database.close(); }
});
