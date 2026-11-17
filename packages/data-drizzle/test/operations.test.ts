import { expect, test } from "bun:test";
import { DatabaseBusyError, FrameworkError, NotFoundError, defineCapabilities, type CapabilityManifest } from "@meshfw/runtime";
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzleOperations, keyCondition, type DrizzleCommands } from "../src/index.ts";

const table = sqliteTable("rows", { id: integer("id"), tenant: text("tenant"), title: text("title") });
const row = { id: 1, tenant: "a", title: "one" };
function fixture() {
  let updates = 0;
  const commands: DrizzleCommands<typeof table> = {
    dialect: testDialect,
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

test("a Mesh error a command throws reaches the caller unchanged, a DatabaseBusyError above all, from every operation", async () => {
  const busy = new DatabaseBusyError("postgres://db:5432/app", 0, { reason: "serialization", sqlstate: "40001" });
  const other = new NotFoundError("a.B", { id: 1 });
  for (const thrown of [busy, other]) {
    const { commands } = fixture();
    const fail = () => { throw thrown; };
    commands.insert = fail; commands.select = fail; commands.update = fail; commands.delete = fail; commands.aggregate = fail;
    const operations = drizzleOperations(commands, () => {});
    for (const call of [() => operations.insert(table, row), () => operations.select(table), () => operations.selectByKey(table, { id: 1 }),
      () => operations.updateByKey(table, { id: 1 }, { title: "x" }), () => operations.deleteByKey(table, { id: 1 }), () => operations.max(table, "id")]) {
      await expect(call()).rejects.toBe(thrown);
    }
  }
  // A rejected promise is let through the same way as a synchronous throw.
  const { commands } = fixture();
  commands.select = () => Promise.reject(busy) as never;
  await expect(drizzleOperations(commands, () => {}).select(table)).rejects.toBe(busy);
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
import { orderingDialect, testDialect } from "./dialect.ts";

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
    dialect: testDialect,
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

// a column may be named like a member of `Object.prototype`. Drizzle reads `row[column]` for every column of the
// table, where a column the row leaves out would read as the method every object inherits.
const named = sqliteTable("named", {
  constructor: text("constructor").primaryKey().notNull(),
  toString: text("toString"),
  valueOf: integer("valueOf"),
});
function namedOperations() {
  const database = new Database(":memory:");
  database.run('CREATE TABLE named ("constructor" text PRIMARY KEY NOT NULL, "toString" text, "valueOf" integer)');
  const db = drizzle(database);
  const commands: DrizzleCommands<SQLiteTable> = {
    dialect: testDialect,
    table: (handle) => drizzleTable(handle, SQLiteTable, "SQLite"),
    insert: (target, values) => db.insert(target).values(values).returning().get()!,
    select: (target) => db.select().from(target).all(),
    aggregate: () => null,
    update: (target, condition, changes) => db.update(target).set(changes).where(condition).returning().all(),
    delete: (target, condition) => db.delete(target).where(condition).returning().all(),
  };
  return { operations: drizzleOperations(commands, () => {}), database };
}

test("bun:sqlite: an insert that leaves out a column named like an Object.prototype member stores no value in it", async () => {
  const { operations, database } = namedOperations();
  try {
    expect(await operations.insert(named, { constructor: "k", valueOf: 2 })).toEqual({ constructor: "k", toString: null, valueOf: 2 });
    expect(await operations.insert(named, { constructor: "j", toString: "t" })).toEqual({ constructor: "j", toString: "t", valueOf: null });
    expect(await operations.selectByKey(named, { constructor: "k" })).toEqual({ constructor: "k", toString: null, valueOf: 2 });
  } finally { database.close(); }
});

test("bun:sqlite: a row that leaves out a key named like an Object.prototype member gets a generated key", async () => {
  const { operations, database } = namedOperations();
  try {
    const stored = await operations.insert(named, { toString: "t" });
    expect(typeof stored.constructor).toBe("string");
    expect(stored.constructor as unknown as string).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stored).toEqual({ constructor: stored.constructor, toString: "t", valueOf: null });
  } finally { database.close(); }
});

test("bun:sqlite: an update that leaves out a column named like an Object.prototype member keeps its value", async () => {
  const { operations, database } = namedOperations();
  try {
    await operations.insert(named, { constructor: "k", toString: "t", valueOf: 2 });
    expect(await operations.updateByKey(named, { constructor: "k" }, { valueOf: 3 })).toEqual({ constructor: "k", toString: "t", valueOf: 3 });
    expect(await operations.updateByKey(named, { constructor: "k" }, { toString: "u" })).toEqual({ constructor: "k", toString: "u", valueOf: 3 });
  } finally { database.close(); }
});

test("rollup prints one grouped statement and decodes what the driver gives", async () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const { commands } = fixture();
  const operations = drizzleOperations({
    ...commands,
    rows: (statement) => {
      const { sql, params } = new SQLiteSyncDialect().sqlToQuery(statement);
      statements.push({ sql, params });
      return [{ anchor: "a", value: "3" }, { anchor: "b", value: null }];
    },
  }, () => {}, defineCapabilities("test", ["aggregates"]));
  expect(await operations.rollup({ fn: "sum", table, anchor: "tenant", anchors: ["a", "b", "c"], value: "id" })).toEqual([{ anchor: "a", value: 3 }, { anchor: "b", value: null }]);
  expect(statements).toEqual([{
    sql: 'select "rows"."tenant" as "anchor", sum("rows"."id") as "value" from "rows" where "rows"."tenant" in (?, ?, ?) group by "rows"."tenant"',
    params: ["a", "b", "c"],
  }]);
  // A count over rows whose values are all null is 0, never null.
  expect(await operations.rollup({ fn: "count", table, anchor: "tenant", anchors: ["a", "b"], value: "id" })).toEqual([{ anchor: "a", value: 3 }, { anchor: "b", value: 0 }]);
  // No anchor, no statement.
  expect(await operations.rollup({ fn: "max", table, anchor: "tenant", anchors: [], value: "id" })).toEqual([]);
  expect(statements).toHaveLength(2);
});

test("rollup is refused without the aggregates capability, without a rows command, and for an unknown column or too many anchors", async () => {
  const { commands } = fixture();
  const query = { fn: "count", table, anchor: "tenant", anchors: ["a"], value: "id" } as const;
  const rows = () => [];
  await expect(drizzleOperations({ ...commands, rows }, () => {}).rollup(query)).rejects.toThrow("rollup needs the aggregates capability");
  await expect(drizzleOperations({ ...commands, rows }, () => {}, defineCapabilities("test", ["joins"])).rollup(query)).rejects.toThrow('the test data layer does not declare it');
  await expect(drizzleOperations(commands, () => {}, defineCapabilities("test", ["aggregates"])).rollup(query)).rejects.toThrow("rollup is not available: the test dialect has no rows command");
  const operations = drizzleOperations({ ...commands, rows }, () => {}, defineCapabilities("test", ["aggregates"]));
  for (const name of ["nope", "toString"]) {
    await expect(operations.rollup({ ...query, anchor: name })).rejects.toThrow(`Unknown column "${name}"`);
    await expect(operations.rollup({ ...query, value: name })).rejects.toThrow(`Unknown column "${name}"`);
  }
  await expect(operations.rollup({ ...query, anchors: Array.from({ length: 501 }, (_, index) => `t${index}`) })).rejects.toThrow("A rollup takes at most 500 anchors, and this one has 501");
  await expect(operations.rollup({ ...query, fn: "median" as never })).rejects.toThrow('Unknown rollup function "median"');
});

// A joined route: the owner table is h0, each hop's table h1, h2, ... joined by the condition printer's hop link, and the
// distinct derived table keeps each last row once per anchor.
const students = sqliteTable("students", { id: text("id") });
const courses = sqliteTable("courses", { id: text("id"), credits: integer("credits"), code: text("code") });
const enrollments = sqliteTable("enrollments", { id: text("id"), studentId: text("studentId"), courseId: text("courseId") });
const school = { students, courses, enrollments, rows: table } as const;
function joined(capabilities: CapabilityManifest = defineCapabilities("test", ["aggregates", "joins"]), dialect = testDialect) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const { commands } = fixture();
  const operations = drizzleOperations({
    ...commands,
    dialect,
    table: (handle) => handle as typeof table,
    rows: (statement) => {
      const { sql, params } = new SQLiteSyncDialect().sqlToQuery(statement);
      statements.push({ sql, params });
      return [{ anchor: "s1", value: "7" }];
    },
  }, () => {}, capabilities);
  return { operations, statements };
}
const courseHop = { hop: { table: school.courses, column: "id", outer: "id", key: "id", through: { table: school.enrollments, entry: "studentId", exit: "courseId" } } };

test("rollup with hops prints the hops as joins inside a distinct derived table, a through hop by its link", async () => {
  const { operations, statements } = joined();
  expect(await operations.rollup({ fn: "sum", table: students, anchor: "id", anchors: ["s1", "s2"], value: "credits", hops: [courseHop], key: "id" })).toEqual([{ anchor: "s1", value: 7 }]);
  expect(statements).toEqual([{
    sql: 'select "anchor", sum("v") as "value" from (select distinct "h0"."id" as "anchor", "h1"."id" as "k", "h1"."credits" as "v" from "students" as "h0"'
      + ' inner join "courses" as "h1" on "h1"."id" in (select "hl1"."courseId" from "enrollments" as "hl1" where "hl1"."studentId" = "h0"."id" and "hl1"."courseId" is not null)'
      + ' where "h0"."id" in (?, ?)) as "reached" group by "anchor"',
    params: ["s1", "s2"],
  }]);
  // Two plain hops: each from the alias of the one before it.
  await operations.rollup({ fn: "count", table: students, anchor: "id", anchors: ["s1"], value: "id", key: "id", hops: [
    { hop: { table: enrollments, column: "studentId", outer: "id", key: "id" } },
    { hop: { table: courses, column: "id", outer: "courseId", key: "id" } },
  ] });
  expect(statements[1]!.sql).toBe('select "anchor", count("v") as "value" from (select distinct "h0"."id" as "anchor", "h2"."id" as "k", "h2"."id" as "v" from "students" as "h0"'
    + ' inner join "enrollments" as "h1" on "h1"."studentId" = "h0"."id" inner join "courses" as "h2" on "h2"."id" = "h1"."courseId"'
    + ' where "h0"."id" in (?)) as "reached" group by "anchor"');
});

test("rollup with hops takes the min and max of a text value through the dialect's collate", async () => {
  const { operations, statements } = joined(undefined, orderingDialect);
  await operations.rollup({ fn: "min", table: students, anchor: "id", anchors: ["s1"], value: "code", hops: [courseHop], key: "id" });
  expect(statements[0]!.sql.startsWith('select "anchor", min("v" collate "C") as "value" from (select distinct')).toBe(true);
});

test("rollup with hops is refused without joins, and for an empty list of hops, a missing key or an unknown column", async () => {
  const query = { fn: "count", table: students, anchor: "id", anchors: ["s1"], value: "id", hops: [courseHop], key: "id" } as const;
  await expect(joined(defineCapabilities("test", ["aggregates"])).operations.rollup(query)).rejects.toThrow("A rollup with hops crosses relationships, which runs as a join, and the test data layer does not declare the joins capability");
  const { operations, statements } = joined();
  await expect(operations.rollup({ ...query, hops: [] })).rejects.toThrow("A rollup's hops must be a non-empty list");
  await expect(operations.rollup({ ...query, key: undefined })).rejects.toThrow("A rollup with hops needs key");
  await expect(operations.rollup({ ...query, hops: [{}] as never })).rejects.toThrow("Each of a rollup's hops must be { hop: { table, column, outer, key } }");
  await expect(operations.rollup({ ...query, hops: Array.from({ length: 65 }, () => courseHop) })).rejects.toThrow("A rollup crosses at most 64 relationships, and this one crosses 65");
  await expect(operations.rollup({ ...query, hops: [{ hop: { ...courseHop.hop, through: "x" as never } }] })).rejects.toThrow("A hop's through must be an object { table, entry, exit }");
  for (const name of ["nope", "toString"]) {
    await expect(operations.rollup({ ...query, key: name })).rejects.toThrow(`Unknown column "${name}"`);
    await expect(operations.rollup({ ...query, value: name })).rejects.toThrow(`Unknown column "${name}"`);
    await expect(operations.rollup({ ...query, anchor: name })).rejects.toThrow(`Unknown column "${name}"`);
    await expect(operations.rollup({ ...query, hops: [{ hop: { ...courseHop.hop, through: { ...courseHop.hop.through, exit: name } } }] })).rejects.toThrow(`Unknown column "${name}"`);
    await expect(operations.rollup({ ...query, hops: [{ hop: { ...courseHop.hop, outer: name } }] })).rejects.toThrow(`Unknown column "${name}"`);
  }
  // An unknown column is refused before an empty list of anchors returns.
  await expect(operations.rollup({ ...query, anchors: [], key: "nope" })).rejects.toThrow('Unknown column "nope"');
  expect(await operations.rollup({ ...query, anchors: [] })).toEqual([]);
  expect(statements).toEqual([]);
});

// A read policy folded into a caller's load narrows a rollup's rows: the start's where beside the anchors, each hop's in
// its join, a link's inside the link subquery, every one against the alias of its own table.
test("rollup prints each where against its own table, and needs conditions for one", async () => {
  const is = (name: string, value: string) => ({ kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name, class: "string" }, { kind: "value", value, class: "string" }] }) as const;
  const { operations, statements } = joined(defineCapabilities("test", ["aggregates", "joins", "conditions"]));
  await operations.rollup({ fn: "sum", table: students, anchor: "id", anchors: ["s1"], value: "credits", key: "id", where: is("id", "s1"),
    hops: [{ ...courseHop, where: is("code", "c"), linkWhere: is("id", "e") }] });
  expect(statements[0]).toEqual({
    sql: 'select "anchor", sum("v") as "value" from (select distinct "h0"."id" as "anchor", "h1"."id" as "k", "h1"."credits" as "v" from "students" as "h0"'
      + ' inner join "courses" as "h1" on "h1"."id" in (select "hl1"."courseId" from "enrollments" as "hl1" where "hl1"."studentId" = "h0"."id" and "hl1"."courseId" is not null and (("hl1"."id" = ?)))'
      + ' and (("h1"."code" = ?)) where "h0"."id" in (?) and (("h0"."id" = ?))) as "reached" group by "anchor"',
    params: ["e", "c", "s1", "s1"],
  });
  const one = { fn: "count", table: students, anchor: "id", anchors: ["s1"], value: "id" } as const;
  await operations.rollup({ ...one, where: is("id", "s1") });
  expect(statements[1]!.sql).toBe('select "students"."id" as "anchor", count("students"."id") as "value" from "students" where "students"."id" in (?) and (("students"."id" = ?)) group by "students"."id"');
  const plain = joined(defineCapabilities("test", ["aggregates", "joins"])).operations;
  const refused = "A rollup with a where runs a condition as SQL, and the test data layer does not declare the conditions capability";
  await expect(plain.rollup({ ...one, where: is("id", "s1") })).rejects.toThrow(refused);
  await expect(plain.rollup({ ...one, key: "id", hops: [{ ...courseHop, where: is("code", "c") }] })).rejects.toThrow(refused);
  await expect(plain.rollup({ ...one, key: "id", hops: [{ ...courseHop, linkWhere: is("id", "e") }] })).rejects.toThrow(refused);
});
