import { describe, expect, test } from "bun:test";
import { sql, type SQL, type Table } from "drizzle-orm";
import { SQLiteSyncDialect, alias, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { FrameworkError, type Condition, type Hop, type TableHandle } from "@meshfw/runtime";
import { conditionSql, orderSql, selectOptions, type ConditionSqlOptions } from "../src/index.ts";
import { orderingDialect, testDialect } from "./dialect.ts";

const render = new SQLiteSyncDialect();
const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey().notNull(), customerId: text("customerId"), parentId: text("parentId"),
  total: integer("total"), note: text("db_note"), dueOn: integer("dueOn", { mode: "timestamp_ms" }),
});
const customers = sqliteTable("customers", { id: text("id").primaryKey().notNull(), ownerId: text("ownerId"), name: text("db_name") });
const tags = sqliteTable("tags", { id: text("id").primaryKey().notNull(), label: text("label") });
const invoiceTags = sqliteTable("invoice_tags", { id: text("id").primaryKey().notNull(), invoiceId: text("invoiceId"), tagId: text("tagId") });
const options: ConditionSqlOptions = { dialect: testDialect, resolve: (handle) => handle as Table };
const q = (node: Condition, root: Table = invoices, opts: ConditionSqlOptions = options) => render.sqlToQuery(conditionSql(root, node, opts));

const col = (name: string, depth = 0, cls: "string" | "integer" | "date" | "boolean" = "string"): Condition => ({ kind: "column", depth, name, class: cls });
const val = (value: string | number | boolean | Date | null, cls: "string" | "integer" | "float" | "boolean" | "date" = "string"): Condition => ({ kind: "value", value, class: cls });
const call = (fn: Extract<Condition, { kind: "call" }>["fn"], ...args: Condition[]): Condition => ({ kind: "call", fn, args });
const toCustomer: Hop = { table: customers as TableHandle, column: "id", outer: "customerId", key: "id" };
const toParent: Hop = { table: invoices as TableHandle, column: "id", outer: "parentId", key: "id" };
const toChildren: Hop = { table: invoices as TableHandle, column: "parentId", outer: "id", key: "id" };
const toTags: Hop = { table: tags as TableHandle, column: "id", outer: "id", key: "id", through: { table: invoiceTags as TableHandle, entry: "invoiceId", exit: "tagId" } };

describe("conditionSql", () => {
  test("columns, values and every call, each parenthesised, values bound through the dialect", () => {
    expect(q(call("eq", col("customerId"), val("c1")))).toMatchObject({ sql: '("invoices"."customerId" = ?)', params: ["c1"] });
    for (const [fn, op] of [["ne", "<>"], ["lt", "<"], ["lte", "<="], ["gt", ">"], ["gte", ">="], ["add", "+"], ["sub", "-"], ["mul", "*"]] as const) {
      expect(q(call(fn, col("total", 0, "integer"), val(2, "integer"))).sql).toBe(`("invoices"."total" ${op} ?)`);
    }
    expect(q(call("isNull", col("note"))).sql).toBe('("invoices"."db_note" is null)');
    expect(q(call("isNotNull", col("note"))).sql).toBe('("invoices"."db_note" is not null)');
    expect(q(call("and", val(true, "boolean"), val(false, "boolean"), val(null, "boolean")))).toMatchObject({ sql: "(? and ? and ?)", params: [1, 0, null] });
    expect(q(call("or", val(true, "boolean"), col("note"))).sql).toBe('(? or "invoices"."db_note")');
    expect(q(call("not", val(true, "boolean"))).sql).toBe("(not ?)");
    expect(q(call("isTrue", val(true, "boolean"))).sql).toBe("((?) is true)");
    expect(q(call("isFalse", val(true, "boolean"))).sql).toBe("((?) is false)");
    expect(q(call("neg", col("total"))).sql).toBe('(- "invoices"."total")');
    expect(q(call("idiv", col("total"), val(2, "integer"))).sql).toBe('("invoices"."total" / nullif(?, 0))');
    expect(q(call("div", col("total"), val(2, "integer"))).sql).toBe('(cast("invoices"."total" as real) / nullif(?, 0))');
    expect(q(call("length", col("note"))).sql).toBe('length("invoices"."db_note")');
    expect(q(call("coalesce", val(1, "integer"), val(2, "integer"))).sql).toBe("coalesce(?, ?)");
    expect(q(call("cond", col("note"), val(1, "integer"), val(2, "integer"))).sql).toBe('(case when ("invoices"."db_note") is true then ? else ? end)');
    const at = new Date(1234);
    expect(q(call("lt", col("dueOn", 0, "date"), val(at, "date"))).params).toEqual([1234]);
  });

  test("a value that looks like SQL is a parameter, never text", () => {
    const hostile = "x') OR 1=1 --";
    expect(q(call("eq", col("customerId"), val(hostile)))).toMatchObject({ sql: '("invoices"."customerId" = ?)', params: [hostile] });
  });

  test("one, some, every, count and first are correlated subqueries over an alias per depth", () => {
    expect(q({ kind: "one", hop: toCustomer, value: col("name", 1) }).sql).toBe(
      '(select "t1"."db_name" from "customers" as "t1" where "t1"."id" = "invoices"."customerId" order by "t1"."id" limit 1)');
    expect(q({ kind: "some", hop: toChildren, where: call("gt", col("total", 1), val(2, "integer")) }).sql).toBe(
      '(exists (select 1 from "invoices" as "t1" where "t1"."parentId" = "invoices"."id" and (("t1"."total" > ?)) is true))');
    expect(q({ kind: "every", hop: toChildren, where: call("gt", col("total", 1), val(2, "integer")) }).sql).toBe(
      '(not exists (select 1 from "invoices" as "t1" where "t1"."parentId" = "invoices"."id" and (("t1"."total" > ?)) is not true))');
    expect(q({ kind: "count", hop: toChildren }).sql).toBe('(select count(*) from "invoices" as "t1" where "t1"."parentId" = "invoices"."id")');
    expect(q({ kind: "count", hop: toChildren, where: col("note", 1) }).sql).toBe(
      '(select count(*) from "invoices" as "t1" where "t1"."parentId" = "invoices"."id" and ("t1"."db_note") is true)');
    expect(q({ kind: "first", hop: toChildren, where: col("note", 1), value: col("total", 1) }).sql).toBe(
      '(select "t1"."total" from "invoices" as "t1" where "t1"."parentId" = "invoices"."id" and ("t1"."db_note") is true order by "t1"."id" limit 1)');
  });

  test("a through hop reads the link's non-null exits", () => {
    expect(q({ kind: "count", hop: toTags }).sql).toBe(
      '(select count(*) from "tags" as "t1" where "t1"."id" in (select "l1"."tagId" from "invoice_tags" as "l1" where "l1"."invoiceId" = "invoices"."id" and "l1"."tagId" is not null))');
  });

  test("two steps nest, and a depth-0 column inside a depth-1 body reads the outer row", () => {
    const grand: Condition = { kind: "one", hop: toParent, value: { kind: "one", hop: toParent, value: col("note", 2) } };
    expect(q(grand).sql).toBe('(select (select "t2"."db_note" from "invoices" as "t2" where "t2"."id" = "t1"."parentId" order by "t2"."id" limit 1) from "invoices" as "t1" where "t1"."id" = "invoices"."parentId" order by "t1"."id" limit 1)');
    expect(q({ kind: "some", hop: toChildren, where: call("gt", col("total", 1), col("total", 0)) }).sql).toContain('("t1"."total" > "invoices"."total")');
  });

  test("an aliased root and another alias prefix", () => {
    const h1 = alias(invoices, "h1");
    expect(q({ kind: "count", hop: toTags }, h1, { ...options, aliasPrefix: "c" }).sql).toBe(
      '(select count(*) from "tags" as "c1" where "c1"."id" in (select "cl1"."tagId" from "invoice_tags" as "cl1" where "cl1"."invoiceId" = "h1"."id" and "cl1"."tagId" is not null))');
    expect(() => q(col("id"), invoices, { ...options, aliasPrefix: "a b" })).toThrow(FrameworkError);
  });

  test("a malformed condition is refused, never printed", () => {
    expect(() => q({ kind: "fragment" } as never)).toThrow(FrameworkError);
    expect(() => q(call("like" as never, col("note"), val("x")))).toThrow(FrameworkError);
    expect(() => q(call("eq", col("note")))).toThrow(FrameworkError);
    expect(() => q(call("and", col("note")))).toThrow(FrameworkError);
    expect(() => q(col("note", 1))).toThrow(FrameworkError);
    expect(() => q(col("nope"))).toThrow(FrameworkError);
    expect(() => q({ kind: "one", hop: { ...toCustomer, outer: "nope" }, value: col("name", 1) })).toThrow(FrameworkError);
    expect(() => q({ kind: "count", hop: { ...toTags, through: "x" as never } })).toThrow("A hop's through must be an object { table, entry, exit }");
  });
});

describe("range comparisons follow the dialect's collation", () => {
  const pg: ConditionSqlOptions = { ...options, dialect: orderingDialect };
  test("a string comparison collates its left side, whichever side names the class; equality and numbers do not", () => {
    expect(q(call("lt", col("note"), val("m")), invoices, pg).sql).toBe('("invoices"."db_note" collate "C" < ?)');
    expect(q(call("gte", val("m"), col("note")), invoices, pg).sql).toBe('(? collate "C" >= "invoices"."db_note")');
    expect(q(call("eq", col("note"), val("m")), invoices, pg).sql).toBe('("invoices"."db_note" = ?)');
    expect(q(call("gt", col("total", 0, "integer"), val(3, "integer")), invoices, pg).sql).toBe('("invoices"."total" > ?)');
  });
  test("SQLite's dialect has no collation, so its SQL is unchanged", () => {
    expect(q(call("lt", col("note"), val("m"))).sql).toBe('("invoices"."db_note" < ?)');
  });
});

describe("orderSql and selectOptions", () => {
  const sqlOf = (parts: readonly SQL[]) => render.sqlToQuery(sql.join([...parts], sql`, `)).sql;
  test("each key with its direction, and the dialect's nulls and collation when it has them", () => {
    expect(sqlOf(orderSql(invoices, [{ by: col("total"), desc: true }, { by: col("note"), desc: false }], options))).toBe('"invoices"."total" desc, "invoices"."db_note" asc');
    const pg = { ...options, dialect: { ...testDialect, nulls: (desc: boolean) => desc ? sql`nulls last` : sql`nulls first`, collate: (key: SQL, kind: string) => kind === "string" ? sql`${key} collate "C"` : key } };
    expect(sqlOf(orderSql(invoices, [{ by: col("note"), desc: false }, { by: col("total", 0, "integer"), desc: true }], pg))).toBe('"invoices"."db_note" collate "C" asc nulls first, "invoices"."total" desc nulls last');
  });

  test("where is ANDed onto the filter; order comes before the primary key, which is not repeated", () => {
    const select = selectOptions(invoices, { filter: { total: { gt: 1 } }, where: call("eq", col("customerId"), val("c1")), order: [{ by: col("total"), desc: true }] }, options);
    expect(render.sqlToQuery(select.where!)).toMatchObject({ sql: '("invoices"."total" > ? and ("invoices"."customerId" = ?))', params: [1, "c1"] });
    expect(sqlOf(select.orderBy)).toBe('"invoices"."total" desc, "invoices"."id" asc');
    expect(sqlOf(selectOptions(invoices, { order: [{ by: col("id"), desc: true }] }, options).orderBy)).toBe('"invoices"."id" desc');
    expect(render.sqlToQuery(selectOptions(invoices, { where: col("note") }, options).where!).sql).toBe('"invoices"."db_note"');
  });

  test("sort and order together, or a condition with no dialect, are refused", () => {
    expect(() => selectOptions(invoices, { sort: ["total"], order: [{ by: col("total"), desc: false }] }, options)).toThrow(FrameworkError);
    expect(() => selectOptions(invoices, { where: col("note") })).toThrow(FrameworkError);
    expect(() => selectOptions(invoices, { order: [] })).toThrow(FrameworkError);
    expect(() => selectOptions(invoices, { order: [{ by: col("total") } as never] }, options)).toThrow(FrameworkError);
  });
});
