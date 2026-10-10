import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { FrameworkError, type Row } from "@meshfw/runtime";
import { drizzleOperations, filterCondition, selectOptions, type DrizzleCommands } from "../src/index.ts";

const dialect = new SQLiteSyncDialect();
const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey().notNull(),
  parentId: text("parentId"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
  rank: integer("rank"),
});
const lines = sqliteTable("lines", { orderId: text("orderId").notNull(), no: integer("no").notNull(), note: text("note") });
const compositeKey = sqliteTable("pairs", { a: text("a").notNull(), b: text("b").notNull() });
const sqlOf = (condition: SQL | undefined) => {
  if (condition === undefined) return undefined;
  const { sql, params } = dialect.sqlToQuery(condition);
  return { sql, params };
};

describe("filterCondition", () => {
  test("every operator becomes a parameterised comparison", () => {
    const q = (filter: object) => sqlOf(filterCondition(tasks, filter as never));
    expect(q({ rank: { eq: 1 } })).toEqual({ sql: '"tasks"."rank" = ?', params: [1] });
    expect(q({ rank: { ne: 1 } })).toEqual({ sql: '"tasks"."rank" <> ?', params: [1] });
    expect(q({ rank: { lt: 1 } })?.sql).toBe('"tasks"."rank" < ?');
    expect(q({ rank: { lte: 1 } })?.sql).toBe('"tasks"."rank" <= ?');
    expect(q({ rank: { gt: 1 } })?.sql).toBe('"tasks"."rank" > ?');
    expect(q({ rank: { gte: 1 } })?.sql).toBe('"tasks"."rank" >= ?');
    expect(q({ rank: { in: [1, 2] } })).toEqual({ sql: '"tasks"."rank" in (?, ?)', params: [1, 2] });
    expect(q({ rank: { nil: true } })?.sql).toBe('"tasks"."rank" is null');
    expect(q({ rank: { nil: false } })?.sql).toBe('"tasks"."rank" is not null');
    expect(q({ rank: { eq: null } })?.sql).toBe('"tasks"."rank" is null');
    expect(q({ rank: { ne: null } })?.sql).toBe('"tasks"."rank" is not null');
  });

  test("values go through the column's own encoding, never into the SQL text", () => {
    const at = new Date("2026-01-02T03:04:05.678Z");
    expect(sqlOf(filterCondition(tasks, { createdAt: { gte: at } }))).toEqual({ sql: '"tasks"."createdAt" >= ?', params: [at.getTime()] });
    expect(sqlOf(filterCondition(tasks, { done: { eq: true } }))?.params).toEqual([1]);
    const hostile = "x' OR 1=1 --";
    expect(sqlOf(filterCondition(tasks, { id: { eq: hostile } }))).toEqual({ sql: '"tasks"."id" = ?', params: [hostile] });
  });

  test("no filter, an empty filter and an empty and are no condition", () => {
    expect(filterCondition(tasks, undefined)).toBeUndefined();
    expect(filterCondition(tasks, {})).toBeUndefined();
    expect(filterCondition(tasks, { and: [] })).toBeUndefined();
    expect(filterCondition(tasks, { and: [{}, { and: [] }] })?.getSQL).toBeDefined();
  });

  test("an empty or and an empty in match nothing", () => {
    expect(sqlOf(filterCondition(tasks, { or: [] }))?.sql).toBe("1 = 0");
    expect(sqlOf(filterCondition(tasks, { rank: { in: [] } }))?.sql).toBe("1 = 0");
  });

  test("several operators and several keys are all required; and/or nest", () => {
    expect(sqlOf(filterCondition(tasks, { rank: { gt: 1, lt: 5 } }))).toEqual({ sql: '("tasks"."rank" > ? and "tasks"."rank" < ?)', params: [1, 5] });
    expect(sqlOf(filterCondition(tasks, { parentId: { eq: "p" }, rank: { nil: true } }))?.sql).toBe('("tasks"."parentId" = ? and "tasks"."rank" is null)');
    expect(sqlOf(filterCondition(tasks, { or: [{ rank: { eq: 1 } }, { and: [{ done: { eq: true } }, { rank: { eq: 2 } }] }] }))?.sql)
      .toBe('("tasks"."rank" = ? or ("tasks"."done" = ? and "tasks"."rank" = ?))');
  });

  test.each([
    [{ nope: { eq: 1 } }, 'Unknown column "nope"'],
    [{ toString: { eq: 1 } }, 'Unknown column "toString"'],
    [{ rank: { like: 1 } }, 'Unknown filter operator "like"'],
    [{ rank: 1 }, "not a bare value"],
    [{ rank: "x" }, "not a bare value"],
    [{ rank: [] }, "not a bare value"],
    [{ rank: new Date() }, "not a bare value"],
    [{ rank: null }, "not a bare value"],
    [{ rank: {} }, "has no operator"],
    [{ rank: { eq: undefined } }, "must be a string, finite number"],
    [{ rank: { eq: Number.NaN } }, "finite number"],
    [{ rank: { eq: Number.POSITIVE_INFINITY } }, "finite number"],
    [{ rank: { eq: new Date("invalid") } }, "valid Date"],
    [{ rank: { eq: {} } }, "finite number"],
    [{ rank: { lt: null } }, "cannot compare with null"],
    [{ rank: { gte: null } }, "cannot compare with null"],
    [{ rank: { in: 1 } }, "must be a list"],
    [{ rank: { in: [null] } }, "must not contain null"],
    [{ rank: { in: [undefined] } }, "finite number"],
    [{ rank: { nil: 1 } }, "true or false"],
    [{ and: {} }, "must be a list"],
    [{ or: "x" }, "must be a list"],
    [{ and: [1] }, "must be an object"],
    [{ or: [[]] }, "must be an object"],
    [[], "must be an object"],
    ["rank > 1", "must be an object"],
    [null, "must be an object"],
  ])("rejects %j", (filter, message) => {
    expect(() => filterCondition(tasks, filter as never)).toThrow(FrameworkError);
    expect(() => filterCondition(tasks, filter as never)).toThrow(message);
  });

  test("refuses nesting deeper than 64 levels", () => {
    let filter: object = { rank: { eq: 1 } };
    for (let depth = 0; depth < 70; depth++) filter = { and: [filter] };
    expect(() => filterCondition(tasks, filter as never)).toThrow("64 levels");
  });

  test("a prototype key never reaches a column", () => {
    expect(() => filterCondition(tasks, JSON.parse('{"__proto__":{"eq":1}}'))).toThrow('Unknown column "__proto__"');
    expect(() => filterCondition(tasks, JSON.parse('{"constructor":{"eq":1}}'))).toThrow('Unknown column "constructor"');
  });
});

describe("selectOptions", () => {
  const orderOf = (query: object | undefined, table = tasks) => selectOptions(table, query as never).orderBy.map((sql) => dialect.sqlToQuery(sql).sql);

  test("sort names become order terms with the primary key last", () => {
    expect(orderOf(undefined)).toEqual(['"tasks"."id" asc']);
    expect(orderOf({ sort: ["createdAt", "-rank"] })).toEqual(['"tasks"."createdAt" asc', '"tasks"."rank" desc', '"tasks"."id" asc']);
  });

  test("a primary key already in the sort is not added twice, and keeps its direction", () => {
    expect(orderOf({ sort: ["-id"] })).toEqual(['"tasks"."id" desc']);
    expect(orderOf({ sort: ["rank", "id"] })).toEqual(['"tasks"."rank" asc', '"tasks"."id" asc']);
  });

  test("a table without a primary key sorts only by what was asked", () => {
    expect(orderOf(undefined, compositeKey as never)).toEqual([]);
    expect(orderOf({ sort: ["b"] }, compositeKey as never)).toEqual(['"pairs"."b" asc']);
    expect(orderOf({ sort: ["no"] }, lines as never)).toEqual(['"lines"."no" asc']);
  });

  test("limit and offset pass through; zero is a valid value", () => {
    expect(selectOptions(tasks, { limit: 0, offset: 0 })).toMatchObject({ limit: 0, offset: 0 });
    expect(selectOptions(tasks, { limit: 5 })).toMatchObject({ limit: 5, offset: undefined });
    expect(selectOptions(tasks, {}).where).toBeUndefined();
  });

  test.each([
    [{ sort: ["nope"] }, 'Unknown column "nope"'],
    [{ sort: ["-nope"] }, 'Unknown column "nope"'],
    [{ sort: ["-"] }, "needs a name"],
    [{ sort: [""] }, "needs a name"],
    [{ sort: "id" }, "list of attribute names"],
    [{ sort: [1] }, "list of attribute names"],
    [{ limit: -1 }, "non-negative integer"],
    [{ limit: 1.5 }, "non-negative integer"],
    [{ limit: Number.NaN }, "non-negative integer"],
    [{ limit: Infinity }, "non-negative integer"],
    [{ limit: "5" }, "non-negative integer"],
    [{ limit: null }, "non-negative integer"],
    [{ offset: -1 }, "non-negative integer"],
    [{ offset: 2 ** 60 }, "non-negative integer"],
    ["id", "must be an object"],
    [null, "must be an object"],
  ])("rejects %j", (query, message) => {
    expect(() => selectOptions(tasks, query as never)).toThrow(FrameworkError);
    expect(() => selectOptions(tasks, query as never)).toThrow(message);
  });
});

describe("generated keys", () => {
  function recorder(highest: unknown) {
    const inserted: Row[] = [];
    const commands: DrizzleCommands<typeof tasks> = {
      table: () => tasks,
      insert: (_table, row) => { inserted.push(row); return row; },
      select: () => [],
      aggregate: () => highest,
      update: () => [],
      delete: () => [],
    };
    return { inserted, operations: drizzleOperations(commands as never, () => {}) };
  }
  const base = { createdAt: new Date(0), done: false };

  test("a text key left out, undefined or null becomes a UUIDv7; a given key is kept", async () => {
    const { operations, inserted } = recorder(null);
    await operations.insert(tasks, base);
    await operations.insert(tasks, { ...base, id: undefined });
    await operations.insert(tasks, { ...base, id: null });
    await operations.insert(tasks, { ...base, id: "mine" });
    expect(inserted.slice(0, 3).map((row) => row.id)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(inserted[0]!.id as string < (inserted[1]!.id as string)).toBe(true);
    expect(inserted[3]!.id).toBe("mine");
  });

  test("an integer key is the highest stored plus one, starting at 1", async () => {
    const counters = sqliteTable("counters", { seq: integer("seq").primaryKey().notNull(), label: text("label") });
    for (const [highest, expected] of [[null, 1], [undefined, 1], [0, 1], [41, 42]] as const) {
      const inserted: Row[] = [];
      const operations = drizzleOperations({
        table: () => counters, insert: (_t: unknown, row: Row) => { inserted.push(row); return row; }, select: () => [], aggregate: () => highest, update: () => [], delete: () => [],
      } as never, () => {});
      await operations.insert(counters, { label: "x" });
      expect(inserted[0]!.seq).toBe(expected);
    }
  });

  test("a composite key is never filled", async () => {
    const inserted: Row[] = [];
    const operations = drizzleOperations({
      table: () => compositeKey, insert: (_t: unknown, row: Row) => { inserted.push(row); return row; }, select: () => [], aggregate: () => null, update: () => [], delete: () => [],
    } as never, () => {});
    await operations.insert(compositeKey, { a: "1", b: "2" });
    expect(inserted).toEqual([{ a: "1", b: "2" }]);
  });

  test("a table without a primary key is never filled", async () => {
    const inserted: Row[] = [];
    const operations = drizzleOperations({
      table: () => lines, insert: (_t: unknown, row: Row) => { inserted.push(row); return row; }, select: () => [], aggregate: () => null, update: () => [], delete: () => [],
    } as never, () => {});
    await operations.insert(lines, { orderId: "o", no: 1 });
    expect(inserted).toEqual([{ orderId: "o", no: 1 }]);
  });
});

describe("read for update and serialised inserts", () => {
  test("selectByKeyForUpdate uses the dialect's selectForUpdate when it has one, else a plain select", async () => {
    const calls: string[] = [];
    const base = { table: () => tasks, insert: (_t: unknown, r: Row) => r, aggregate: () => null, update: () => [], delete: () => [] };
    const plain = drizzleOperations({ ...base, select: () => { calls.push("select"); return []; } } as never, () => {});
    await plain.selectByKeyForUpdate(tasks, { id: "a" });
    const locking = drizzleOperations({ ...base, select: () => { calls.push("plain"); return []; }, selectForUpdate: () => { calls.push("for update"); return []; } } as never, () => {});
    await locking.selectByKeyForUpdate(tasks, { id: "a" });
    await locking.selectByKey(tasks, { id: "a" });
    expect(calls).toEqual(["select", "for update", "plain"]);
  });

  test("parallel inserts into one table never overlap, and a failed one does not block the next", async () => {
    const counters = sqliteTable("counters2", { seq: integer("seq").primaryKey().notNull(), label: text("label") });
    let stored = 0;
    let running = 0;
    let overlap = false;
    const operations = drizzleOperations({
      table: () => counters, select: () => [], update: () => [], delete: () => [],
      aggregate: async () => { running++; if (running > 1) overlap = true; await new Promise((resolve) => setTimeout(resolve, 2)); return stored; },
      insert: async (_t: unknown, row: Row) => { if (row.label === "bad") { running--; throw new Error("boom"); } stored = row.seq as number; running--; return row; },
    } as never, () => {});
    const results = await Promise.allSettled(["a", "bad", "b", "c"].map((label) => operations.insert(counters, { label })));
    expect(overlap).toBe(false);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(results.flatMap((result) => result.status === "fulfilled" ? [result.value.seq] : [])).toEqual([1, 2, 3]);
  });
});
