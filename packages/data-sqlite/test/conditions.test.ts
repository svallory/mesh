import { describe, expect, test } from "bun:test";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { FrameworkError, bindCondition, type Condition, type DataLayer, type DataOperations } from "@meshfw/runtime";
import { dataLayerConditionConformance, expressionTablesThroughLayer, type ConditionFixture } from "@meshfw/runtime/testing";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const parent = sqliteTable("cond_parent", {
  id: text("id").primaryKey().notNull(), s: text("s"), n: integer("n"), f: real("f"),
  b: integer("b", { mode: "boolean" }), d: integer("d", { mode: "timestamp_ms" }), parentId: text("parentId"), label: text("db_label"),
});
const child = sqliteTable("cond_child", { id: text("id").primaryKey().notNull(), parentId: text("parentId"), qty: integer("qty"), pos: integer("pos") });
const link = sqliteTable("cond_link", { id: text("id").primaryKey().notNull(), parentId: text("parentId"), childId: text("childId") });
const slot = (p: string) => ({
  [`${p}_s`]: text(`${p}_s`), [`${p}_i`]: integer(`${p}_i`), [`${p}_f`]: real(`${p}_f`),
  [`${p}_b`]: integer(`${p}_b`, { mode: "boolean" }), [`${p}_d`]: integer(`${p}_d`, { mode: "timestamp_ms" }),
});
const values = sqliteTable("cond_values", { id: integer("id").primaryKey().notNull(), ...slot("a"), ...slot("b"), ...slot("c") });
const tables = { parent, child, link, values };

async function make(): Promise<ConditionFixture> {
  const layer = sqlite({ file: ":memory:" });
  try { await createSchema(layer, tables); }
  catch (error) { await layer.close(); throw error; }
  return { layer, parent, child, link, values };
}

describe("condition conformance, SQLite", () => {
  for (const [name, check] of Object.entries(dataLayerConditionConformance(make, capabilities))) test(name, check);
});

describe("the expression tables through SQLite", () => {
  for (const [name, check] of Object.entries(expressionTablesThroughLayer(make, capabilities))) test(name, check);
});

describe("the capability manifest", () => {
  test("declares conditions and joins, so both suites run every check", () => {
    expect(capabilities.capabilities).toContain("conditions");
    expect(capabilities.capabilities).toContain("joins");
    expect(Object.keys(dataLayerConditionConformance(make, capabilities)).some((name) => name.includes("through hop"))).toBe(true);
    expect(Object.keys(expressionTablesThroughLayer(make, capabilities)).some((name) => name.startsWith("every:"))).toBe(true);
  });
});

describe("SQLite-specific cases", () => {
  test("SQLite would match a text column against a number, so the binder refuses the number before SQL sees it", async () => {
    const fixture = await make();
    try {
      await fixture.layer.transaction((tx) => tx.insert(parent, { id: "x", s: "1" }));
      const loose: Condition = { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "s", class: "string" }, { kind: "value", value: 1, class: "integer" }] };
      // What the binder prevents: type affinity makes '1' = 1 true, where in memory "1" === 1 is false.
      expect(await fixture.layer.transaction((tx) => tx.select(parent, { where: loose }))).toHaveLength(1);
      expect(() => bindCondition(() => parent, {
        what: "the filter of read :open of t.Parent", entity: "t.Parent",
        tree: { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "s", class: "string" }, { kind: "param", index: 0, class: "string" }] },
        params: () => [1],
      }, {})).toThrow(FrameworkError);
    } finally { await fixture.layer.close(); }
  });
});

describe("the suites catch adapters that break the contract", () => {
  // Each wrapper breaks one promise; the named check must fail.
  const broken = (change: (tx: DataOperations) => Partial<DataOperations>) => async (): Promise<ConditionFixture> => {
    const fixture = await make();
    const layer: DataLayer = {
      refuseIfFailed: fixture.layer.refuseIfFailed, close: fixture.layer.close,
      transaction: (run) => fixture.layer.transaction((tx) => run({ ...tx, ...change(tx) })),
    };
    return { ...fixture, layer };
  };
  const fails = async (make: () => Promise<ConditionFixture>, name: string, suite = dataLayerConditionConformance) => {
    const check = suite(make, capabilities)[name];
    expect(check).toBeDefined();
    await expect(check!()).rejects.toThrow("Data-layer condition conformance");
  };

  test("a layer that drops where", () =>
    fails(broken((tx) => ({ select: (table, query) => tx.select(table, query && { ...query, where: undefined }) })), "where keeps only the rows a condition makes true; unknown leaves a row out"));
  test("a layer that drops order", () =>
    fails(broken((tx) => ({ select: (table, query) => tx.select(table, query && { ...query, order: undefined }) })), "order sorts nulls as the smallest value, and ties come back in key order"));
  test("a layer whose aggregates drop where", () =>
    fails(broken((tx) => ({ count: (table, attribute, filter) => tx.count(table, attribute, filter), max: (table, attribute, filter) => tx.max(table, attribute, filter) })), "max and count honour where"));
  test("a layer that reads an unknown condition as true", () =>
    fails(broken((tx) => ({ select: (table, query) => tx.select(table, query?.where ? { ...query, where: { kind: "call", fn: "not", args: [{ kind: "call", fn: "isFalse", args: [query.where] }] } } : query) })),
      "where keeps only the rows a condition makes true; unknown leaves a row out"));
  test("a layer that runs every as not-some-false, so an unknown element passes", () =>
    fails(broken((tx) => ({
      select: (table, query) => tx.select(table, query?.where?.kind === "every"
        ? { ...query, where: { kind: "call", fn: "not", args: [{ kind: "some", hop: query.where.hop, where: { kind: "call", fn: "isFalse", args: [query.where.where] } }] } }
        : query),
    })), "some and every: every is true over no row and false over an unknown one"));
  test("a layer that gets a function wrong fails its table", () =>
    fails(broken((tx) => ({
      select: (table, query) => tx.select(table, query?.where ? { ...query, where: JSON.parse(JSON.stringify(query.where).replaceAll('"fn":"idiv"', '"fn":"div"')) } : query),
    })), "idiv: every table row, as bound values", expressionTablesThroughLayer));
});
