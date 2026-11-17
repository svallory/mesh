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
  // Rewrites every node of a where or an order key, children first; `change` returns the node or a replacement.
  const mapTree = (node: Condition, change: (node: Condition) => Condition): Condition => {
    const go = (part: Condition) => mapTree(part, change);
    switch (node.kind) {
      case "call": return change({ ...node, args: node.args.map(go) });
      case "one": return change({ ...node, value: go(node.value) });
      case "some": case "every": return change({ ...node, where: go(node.where) });
      case "count": return change(node.where ? { ...node, where: go(node.where) } : node);
      case "first": return change({ ...node, where: go(node.where), value: go(node.value) });
      default: return change(node);
    }
  };
  const rewriting = (change: (node: Condition) => Condition) => broken((tx) => ({
    select: (table, query) => tx.select(table, query && {
      ...query,
      where: query.where && mapTree(query.where, change),
      order: query.order?.map((key) => ({ ...key, by: mapTree(key.by, change) })),
    }),
  }));
  const isNullValue = (node: Condition) => node.kind === "value" && node.value === null;

  test("a layer that compares with null as IS, so null = null is true", () =>
    fails(rewriting((node) => node.kind === "call" && node.fn === "eq" && node.args.some(isNullValue)
      ? { kind: "call", fn: "isNull", args: node.args.filter((part) => !isNullValue(part)) } : node),
      "null on each side of a comparison is unknown; isNull and isNotNull test it"));
  test("a layer that binds false as null", () =>
    fails(rewriting((node) => node.kind === "value" && node.value === false ? { ...node, value: null } : node),
      "each value class compares with its column, a renamed column included"));
  test("a layer that runs div as integer division", () =>
    fails(rewriting((node) => node.kind === "call" && node.fn === "div" ? { ...node, fn: "idiv" } : node),
      "logic, arithmetic and the other functions run in the database"));
  test("a layer that drops the caller's filter when a where is set", () =>
    fails(broken((tx) => ({ select: (table, query) => tx.select(table, query?.where ? { ...query, filter: undefined } : query) })),
      "where is ANDed with the caller's filter"));
  test("a layer that drops sort when an order is set, instead of refusing both", () =>
    fails(broken((tx) => ({ select: (table, query) => tx.select(table, query?.order ? { ...query, sort: undefined } : query) })),
      "sort and order together are refused"));
  test("a layer whose one joins on the wrong outer column", () =>
    fails(rewriting((node) => node.kind === "one" ? { ...node, hop: { ...node.hop, outer: "id" } } : node),
      "one reads the related row, null when there is none or the key dangles"));
  test("a layer whose first ignores its where", () =>
    fails(rewriting((node) => node.kind === "first" ? { kind: "one", hop: node.hop, value: node.value } : node),
      "count and first: first takes the lowest key"));
  test("a layer whose count ignores its where", () =>
    fails(rewriting((node) => node.kind === "count" ? { kind: "count", hop: node.hop } : node),
      "count and first: first takes the lowest key"));
  test("a layer that drops the link of a through hop", () =>
    fails(rewriting((node) => "hop" in node && node.hop.through ? { ...node, hop: { ...node.hop, through: undefined } } : node),
      "a through hop counts a far row once and skips a link with no exit"));
  test("a layer that drops order keys crossing a relationship", () =>
    fails(broken((tx) => ({ select: (table, query) => tx.select(table, query?.order ? { ...query, order: query.order.filter((key) => key.by.kind === "column") } : query) })),
      "an order key may cross a relationship"));
  test("a layer whose aggregates drop a where that crosses a relationship", () =>
    fails(broken((tx) => ({
      count: (table, attribute, filter, where) => tx.count(table, attribute, filter, where?.kind === "some" ? undefined : where),
      max: (table, attribute, filter, where) => tx.max(table, attribute, filter, where?.kind === "some" ? undefined : where),
    })), "max and count honour a where that crosses a relationship"));
  test("a manifest without conditions fails its own check", async () => {
    const check = dataLayerConditionConformance(make, { ...capabilities, capabilities: capabilities.capabilities.filter((name) => name !== "conditions") })["the manifest declares conditions"];
    expect(check).toBeDefined();
    await expect(check!()).rejects.toThrow("Data-layer condition conformance");
  });

  // Each quantifier row check, against a layer that runs the quantifier as another.
  const quantifierBreaks: Record<string, (node: Condition) => Condition> = {
    some: (node) => node.kind === "some" ? { ...node, kind: "every" } : node,
    every: (node) => node.kind === "every" ? { ...node, kind: "some" } : node,
    find: (node) => node.kind === "first" ? { kind: "one", hop: node.hop, value: node.value } : node,
    filter: (node) => node.kind === "count" ? { kind: "count", hop: node.hop } : node,
  };
  for (const [fn, change] of Object.entries(quantifierBreaks)) {
    test(`a layer that gets ${fn} wrong fails its quantifier rows`, () =>
      fails(rewriting(change), `${fn}: every quantifier row, over related rows`, expressionTablesThroughLayer));
  }
  test("every quantifier check has a broken double", () => {
    const names = Object.keys(expressionTablesThroughLayer(make, capabilities)).filter((name) => name.endsWith("quantifier row, over related rows"));
    expect(names.map((name) => name.split(":")[0]).sort()).toEqual(Object.keys(quantifierBreaks).sort());
  });

  // Each function table check, both forms, against a layer that replaces that function's result with a value no row
  // of the table expects (not null, and equal to no number, string, boolean or date).
  const functionChecks = Object.keys(expressionTablesThroughLayer(make, capabilities)).filter((name) => name.includes(": every table row, as "));
  for (const name of functionChecks) {
    const fn = name.split(":")[0]!;
    test(`a layer that gets ${fn} wrong fails "${name}"`, () =>
      fails(rewriting((node) => node.kind === "call" && node.fn === fn ? { kind: "value", value: "\u0000broken", class: "string" } : node), name, expressionTablesThroughLayer));
  }
  test("every condition check has a broken double", () => {
    // The names this file proves; a check added to the suite without a double fails here.
    const proven = new Set([
      "the manifest declares conditions",
      "where keeps only the rows a condition makes true; unknown leaves a row out",
      "null on each side of a comparison is unknown; isNull and isNotNull test it",
      "each value class compares with its column, a renamed column included",
      "logic, arithmetic and the other functions run in the database",
      "where is ANDed with the caller's filter",
      "order sorts nulls as the smallest value, and ties come back in key order",
      "sort and order together are refused",
      "max and count honour where",
      "one reads the related row, null when there is none or the key dangles",
      "some and every: every is true over no row and false over an unknown one",
      "count and first: first takes the lowest key",
      "a through hop counts a far row once and skips a link with no exit",
      "an order key may cross a relationship",
      "max and count honour a where that crosses a relationship",
    ]);
    expect(Object.keys(dataLayerConditionConformance(make, capabilities)).sort()).toEqual([...proven].sort());
  });
  test("a layer that gets a function wrong fails its table", () =>
    fails(broken((tx) => ({
      select: (table, query) => tx.select(table, query?.where ? { ...query, where: JSON.parse(JSON.stringify(query.where).replaceAll('"fn":"idiv"', '"fn":"div"')) } : query),
    })), "idiv: every table row, as bound values", expressionTablesThroughLayer));
});
