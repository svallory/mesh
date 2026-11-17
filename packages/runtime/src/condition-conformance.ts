import type { CapabilityManifest } from "./capabilities.ts";
import type { Condition, Hop, OrderKey, SqlFunction, ValueClass } from "./condition.ts";
import type { DataLayer, DataOperations, Filter, Query, RollupFn, RollupHop, RollupQuery, Row, Scalar, TableHandle } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { EXPRESSION_TABLES, QUANTIFIER_TABLES } from "./expression-tables.ts";

/**
 * What the condition checks need. Every call of the factory returns a fresh, isolated layer with these tables
 * prepared and empty:
 *
 * - `parent`: `id` text primary key, `s` text, `n` integer, `f` real, `b` boolean, `d` date (millisecond precision),
 *   `parentId` text (a key of another `parent` row), and `label` text whose database column is named `db_label`
 *   (any name other than `label`), every column but `id` nullable.
 * - `child`: `id` text primary key, `parentId` text, `qty` integer nullable, `pos` integer nullable.
 * - `link`: `id` text primary key, `parentId` text, `childId` text nullable (a through relationship parent → child).
 * - `values`: `id` integer primary key, and for each argument position `a`, `b` and `c` one nullable column per
 *   class: `a_s` text, `a_i` integer, `a_f` real, `a_b` boolean, `a_d` date, and the same for `b_` and `c_`.
 */
export interface ConditionFixture {
  layer: DataLayer;
  parent: TableHandle;
  child: TableHandle;
  link: TableHandle;
  values: TableHandle;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Data-layer condition conformance: ${message}`);
}

type Node = Condition;
const col = (name: string, cls: ValueClass, depth = 0): Node => ({ kind: "column", depth, name, class: cls });
const val = (value: Scalar, cls: ValueClass): Node => ({ kind: "value", value, class: cls });
const call = (fn: SqlFunction, ...args: Node[]): Node => ({ kind: "call", fn, args });
const D = (ms: number) => new Date(ms);

/** A rollup's result as `{ anchor: value }`, each anchor once. */
const rollupsOf = (layer: DataLayer) => async (query: RollupQuery): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const row of await layer.transaction((tx) => tx.rollup(query))) {
    assert(!Object.hasOwn(out, String(row.anchor)), `a rollup must give each anchor once, and gave ${String(row.anchor)} twice`);
    out[String(row.anchor)] = row.value;
  }
  return out;
};
const same = (actual: Record<string, unknown>, expected: Record<string, unknown>, message: string) => {
  const show = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))));
  assert(show(actual) === show(expected), `${message}: expected ${show(expected)} but got ${show(actual)}`);
};

/**
 * The rows of the condition fixture: four parents (one with a dangling parent key), their children and links. Rows are
 * inserted out of key order, so an adapter whose scan order is insertion order (SQLite's rowid) cannot pass the "lowest
 * key" and "ties in key order" checks without ordering by the key.
 */
const PARENTS: Row[] = [
  { id: "p4", s: "delta", n: 4, f: 0.5, b: true, d: D(4000), parentId: "zz", label: "L4" },
  { id: "p2", s: "beta", n: 2, f: null, b: false, d: D(2000), parentId: "p1", label: "L2" },
  { id: "p3", s: null, n: null, f: 2.5, b: null, d: null, parentId: "p2", label: null },
  { id: "p1", s: "alpha", n: 1, f: 1.5, b: true, d: D(1000), parentId: null, label: "L1" },
];
// p1's lowest-key child has no qty and its second has one, so a `first` that drops its where reads the wrong child.
const CHILDREN: Row[] = [
  { id: "c4", parentId: "p2", qty: 5, pos: 1 },
  { id: "c3", parentId: "p2", qty: 1, pos: 0 },
  { id: "c5", parentId: "p3", qty: null, pos: 0 },
  { id: "c2", parentId: "p1", qty: 3, pos: 1 },
  { id: "c1", parentId: "p1", qty: null, pos: 0 },
];
// p1 reaches c3 through two links and has a link with no exit; p2 reaches c2; p3 and p4 reach nothing.
const LINKS: Row[] = [
  { id: "k4", parentId: "p2", childId: "c2" },
  { id: "k3", parentId: "p1", childId: null },
  { id: "k2", parentId: "p1", childId: "c3" },
  { id: "k1", parentId: "p1", childId: "c3" },
];

/**
 * The checks every adapter that declares `conditions` passes: the condition reaches the database, unknown leaves a
 * row out, each value class compares with its column, `order` sorts nulls as the smallest value with ties in key
 * order, `max`/`count` honour `where`, and, with `aggregates`, `rollup` honours `where`. With `joins` declared too, the
 * hops: `one` (null for no row and for a dangling key), `some`, `every` (true over no row, false over unknown), `count`,
 * `first` (the lowest key), a through hop counting a far row once and skipping a null exit, two steps, a depth-0 column
 * inside a hop, a rollup node (each row its route reaches once, from its own starting row, narrowed by its filter, in
 * `where` and in `order`), and a rollup's route honouring the `where` of its start and of each hop and the `linkWhere` of
 * a link.
 */
export function dataLayerConditionConformance(makeLayer: () => Promise<ConditionFixture>, manifest: CapabilityManifest): Record<string, () => Promise<void>> {
  const declared = (name: string) => (manifest.capabilities as readonly string[]).includes(name);
  const withRows = (run: (read: (query: Query) => Promise<string[]>, fixture: ConditionFixture) => Promise<void>) => async () => {
    const fixture = await makeLayer();
    try {
      await fixture.layer.transaction(async (tx) => {
        for (const row of PARENTS) await tx.insert(fixture.parent, row);
        for (const row of CHILDREN) await tx.insert(fixture.child, row);
        for (const row of LINKS) await tx.insert(fixture.link, row);
      });
      const read = (query: Query) => fixture.layer.transaction(async (tx) => (await tx.select(fixture.parent, query)).map((row) => String(row.id)));
      await run(read, fixture);
    } finally { await fixture.layer.close(); }
  };
  const expectIds = async (read: (query: Query) => Promise<string[]>, query: Query, expected: string[], message: string) => {
    const actual = await read(query);
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${expected.join(",") || "no row"} but got ${actual.join(",") || "no row"}`);
  };
  const cases = (name: string, list: readonly (readonly [string, Node, string[]])[]) =>
    [name, withRows(async (read) => { for (const [message, where, expected] of list) await expectIds(read, { where }, expected, message); })] as const;

  const checks: (readonly [string, () => Promise<void>])[] = [
    ["the manifest declares conditions", async () => {
      assert(declared("conditions"), "an adapter that runs these checks must declare the conditions capability");
    }],
    cases("where keeps only the rows a condition makes true; unknown leaves a row out", [
      ["n = 2", call("eq", col("n", "integer"), val(2, "integer")), ["p2"]],
      ["n > 0, unknown for p3", call("gt", col("n", "integer"), val(0, "integer")), ["p1", "p2", "p4"]],
      ["not (n > 1), unknown for p3", call("not", call("gt", col("n", "integer"), val(1, "integer"))), ["p1"]],
      ["a constant true", val(true, "boolean"), ["p1", "p2", "p3", "p4"]],
      ["a constant false", val(false, "boolean"), []],
      ["a constant unknown", val(null, "boolean"), []],
    ]),
    cases("null on each side of a comparison is unknown; isNull and isNotNull test it", [
      ["s = null", call("eq", col("s", "string"), val(null, "string")), []],
      ["null = s", call("eq", val(null, "string"), col("s", "string")), []],
      ["s <> null", call("ne", col("s", "string"), val(null, "string")), []],
      ["isNull(s)", call("isNull", col("s", "string")), ["p3"]],
      ["isNotNull(f)", call("isNotNull", col("f", "float")), ["p1", "p3", "p4"]],
    ]),
    cases("each value class compares with its column, a renamed column included", [
      ["b = true", call("eq", col("b", "boolean"), val(true, "boolean")), ["p1", "p4"]],
      ["b = false", call("eq", col("b", "boolean"), val(false, "boolean")), ["p2"]],
      ["d < 2500 ms", call("lt", col("d", "date"), val(D(2500), "date")), ["p1", "p2"]],
      ["d >= 2000 ms", call("gte", col("d", "date"), val(D(2000), "date")), ["p2", "p4"]],
      ["f > 1", call("gt", col("f", "float"), val(1, "float")), ["p1", "p3"]],
      ["s = 'beta'", call("eq", col("s", "string"), val("beta", "string")), ["p2"]],
      ["s < 'b' (code point order)", call("lt", col("s", "string"), val("b", "string")), ["p1"]],
      ["label = 'L2' (column db_label)", call("eq", col("label", "string"), val("L2", "string")), ["p2"]],
    ]),
    cases("logic, arithmetic and the other functions run in the database", [
      ["b and n > 1", call("and", col("b", "boolean"), call("gt", col("n", "integer"), val(1, "integer"))), ["p4"]],
      ["b or n = 2", call("or", col("b", "boolean"), call("eq", col("n", "integer"), val(2, "integer"))), ["p1", "p2", "p4"]],
      ["isTrue(b)", call("isTrue", col("b", "boolean")), ["p1", "p4"]],
      ["isFalse(b)", call("isFalse", col("b", "boolean")), ["p2"]],
      ["not isTrue(b)", call("not", call("isTrue", col("b", "boolean"))), ["p2", "p3"]],
      ["n + 1 = 3", call("eq", call("add", col("n", "integer"), val(1, "integer")), val(3, "integer")), ["p2"]],
      ["n - 5 = -1", call("eq", call("sub", col("n", "integer"), val(5, "integer")), val(-1, "integer")), ["p4"]],
      ["n * f = 2", call("eq", call("mul", col("n", "integer"), col("f", "float")), val(2, "float")), ["p4"]],
      ["n idiv 3 = 1", call("eq", call("idiv", col("n", "integer"), val(3, "integer")), val(1, "integer")), ["p4"]],
      ["n div 4 = 0.5", call("eq", call("div", col("n", "integer"), val(4, "integer")), val(0.5, "float")), ["p2"]],
      ["n div 0 is null", call("isNull", call("div", col("n", "integer"), val(0, "integer"))), ["p1", "p2", "p3", "p4"]],
      ["-n = -4", call("eq", call("neg", col("n", "integer")), val(-4, "integer")), ["p4"]],
      ["length(s) = 4", call("eq", call("length", col("s", "string")), val(4, "integer")), ["p2"]],
      ["coalesce(f, 9) = 9", call("eq", call("coalesce", col("f", "float"), val(9, "float")), val(9, "float")), ["p2"]],
      ["coalesce of two parameters = n", call("eq", call("coalesce", val(null, "integer"), val(4, "integer")), col("n", "integer")), ["p4"]],
      ["cond(n > 1, 10, 20) = 10, two parameter branches", call("eq", call("cond", call("gt", col("n", "integer"), val(1, "integer")), val(10, "integer"), val(20, "integer")), val(10, "integer")), ["p2", "p4"]],
      ["cond with an unknown test takes the else branch", call("eq", call("cond", col("b", "boolean"), val("yes", "string"), val("no", "string")), val("no", "string")), ["p2", "p3"]],
    ]),
    ["where is ANDed with the caller's filter", withRows(async (read) => {
      const filter: Filter = { n: { gte: 2 } };
      await expectIds(read, { filter, where: call("isNotNull", col("s", "string")) }, ["p2", "p4"], "n >= 2 and isNotNull(s)");
      await expectIds(read, { filter, where: val(false, "boolean") }, [], "a filter and a false condition");
    })],
    ["order sorts nulls as the smallest value, and ties come back in key order", withRows(async (read) => {
      const by = (name: string, cls: ValueClass, desc: boolean): OrderKey => ({ by: col(name, cls), desc });
      await expectIds(read, { order: [by("n", "integer", false)] }, ["p3", "p1", "p2", "p4"], "n ascending");
      await expectIds(read, { order: [by("n", "integer", true)] }, ["p4", "p2", "p1", "p3"], "n descending");
      await expectIds(read, { order: [by("b", "boolean", false)] }, ["p3", "p2", "p1", "p4"], "b ascending, p1 and p4 tie");
      await expectIds(read, { order: [by("b", "boolean", true)] }, ["p1", "p4", "p2", "p3"], "b descending, p1 and p4 tie");
      await expectIds(read, { order: [by("s", "string", true)] }, ["p4", "p2", "p1", "p3"], "s descending");
      await expectIds(read, { order: [by("label", "string", false)] }, ["p3", "p1", "p2", "p4"], "label (column db_label)");
      await expectIds(read, { order: [{ by: call("mul", col("n", "integer"), val(-1, "integer")), desc: false }] }, ["p3", "p4", "p2", "p1"], "an expression key");
      await expectIds(read, { order: [by("n", "integer", true)], limit: 2, offset: 1 }, ["p2", "p1"], "an order with paging");
      await expectIds(read, { where: col("b", "boolean"), order: [by("d", "date", true)] }, ["p4", "p1"], "a where and an order");
    })],
    ["sort and order together are refused", withRows(async (_read, { layer, parent }) => {
      let error: unknown;
      try { await layer.transaction((tx) => tx.select(parent, { sort: ["n"], order: [{ by: col("n", "integer"), desc: false }] })); }
      catch (cause) { error = cause; }
      assert(error instanceof FrameworkError, "a query with both sort and order must reject with FrameworkError");
    })],
    ["max and count honour where", withRows(async (_read, { layer, parent }) => {
      const run = <T>(work: (tx: DataOperations) => Promise<T>) => layer.transaction(work);
      const isB = call("isTrue", col("b", "boolean"));
      assert(await run((tx) => tx.count(parent, "id", undefined, isB)) === 2, "count of the rows where b is true");
      assert(await run((tx) => tx.count(parent, "n", { s: { ne: "alpha" } }, isB)) === 1, "count under a filter and a where");
      assert(await run((tx) => tx.max(parent, "n", undefined, isB)) === 4, "max of n where b is true");
      assert(await run((tx) => tx.max(parent, "n", undefined, call("isFalse", col("b", "boolean")))) === 2, "max of n where b is false");
      assert(await run((tx) => tx.max(parent, "n", undefined, val(false, "boolean"))) === null, "max under a false where is null");
      assert(await run((tx) => tx.count(parent, "id", undefined, val(null, "boolean"))) === 0, "count under an unknown where is 0");
    })],
  ];
  if (declared("aggregates"))
    checks.push(["rollup honours where on a one-table route", withRows(async (_read, { layer, parent, child }) => {
      const byAnchor = rollupsOf(layer);
      const over = (fn: RollupFn, value: string, where: Node | undefined): RollupQuery => ({ fn, table: child, anchor: "parentId", anchors: ["p1", "p2", "p3"], value, where });
      same(await byAnchor(over("sum", "qty", call("gt", col("qty", "integer"), val(1, "integer")))), { p1: 3, p2: 5 }, "sum of qty where qty > 1: c5's unknown leaves p3 out");
      same(await byAnchor(over("count", "id", call("eq", col("pos", "integer"), val(0, "integer")))), { p1: 1, p2: 1, p3: 1 }, "count where pos = 0");
      same(await byAnchor(over("max", "qty", undefined)), { p1: 3, p2: 5, p3: null }, "no where: every row");
      same(await byAnchor(over("count", "id", val(false, "boolean"))), {}, "a false where reaches no row");
      same(await byAnchor(over("count", "id", val(null, "boolean"))), {}, "an unknown where reaches no row");
      // The parents grouped by their own parent: p2 is p1's, p3 is p2's (its label is null).
      same(await byAnchor({ fn: "sum", table: parent, anchor: "parentId", anchors: ["p1", "p2"], value: "n", where: call("eq", col("label", "string"), val("L2", "string")) }), { p1: 2 }, "a where on a renamed column (db_label)");
      let error: unknown;
      try { await layer.transaction((tx) => tx.rollup(over("count", "id", call("isNull", col("nope", "string"))))); }
      catch (cause) { error = cause; }
      assert(error instanceof FrameworkError, "a where on an unknown column must reject with FrameworkError");
    })]);

  if (declared("joins")) {
    // The fixture's tables are known only once it is made, so the hops are made per fixture.
    const hops = (fixture: ConditionFixture) => ({
      children: { table: fixture.child, column: "parentId", outer: "id", key: "id" } satisfies Hop,
      toParent: { table: fixture.parent, column: "id", outer: "parentId", key: "id" } satisfies Hop,
      linked: { table: fixture.child, column: "id", outer: "id", key: "id", through: { table: fixture.link, entry: "parentId", exit: "childId" } } satisfies Hop,
    });
    const hopCases = (name: string, list: (h: ReturnType<typeof hops>) => readonly (readonly [string, Node, string[]])[]) =>
      [name, withRows(async (read, fixture) => {
        for (const [message, where, expected] of list(hops(fixture))) await expectIds(read, { where }, expected, message);
      })] as const;
    const qty = (cls: ValueClass = "integer") => col("qty", cls, 1);
    checks.push(
      hopCases("one reads the related row, null when there is none or the key dangles", (h) => [
        ["parent's s = 'alpha'", call("eq", { kind: "one", hop: h.toParent, value: col("s", "string", 1) }, val("alpha", "string")), ["p2"]],
        ["parent's s is null (no parent, a dangling key)", call("isNull", { kind: "one", hop: h.toParent, value: col("s", "string", 1) }), ["p1", "p4"]],
        ["parent's label = 'L1' (column db_label at depth 1)", call("eq", { kind: "one", hop: h.toParent, value: col("label", "string", 1) }, val("L1", "string")), ["p2"]],
        ["the grandparent's s = 'alpha' (two steps)", call("eq", { kind: "one", hop: h.toParent, value: { kind: "one", hop: h.toParent, value: col("s", "string", 2) } }, val("alpha", "string")), ["p3"]],
        ["a has-many hop read as one takes the lowest-key child: p1's c1 has no qty", call("isNull", { kind: "one", hop: h.children, value: qty() }), ["p1", "p3", "p4"]],
        ["a has-many hop read as one takes the lowest-key child: p2's c3 has qty 1", call("eq", { kind: "one", hop: h.children, value: qty() }, val(1, "integer")), ["p2"]],
        ["parent's n + 1 = my n (a depth-0 column inside the hop)", call("isTrue", { kind: "one", hop: h.toParent, value: call("eq", call("add", col("n", "integer", 1), val(1, "integer")), col("n", "integer")) }), ["p2"]],
      ]),
      hopCases("some and every: every is true over no row and false over an unknown one", (h) => [
        ["some child qty > 2", { kind: "some", hop: h.children, where: call("gt", qty(), val(2, "integer")) }, ["p1", "p2"]],
        ["every child qty > 0", { kind: "every", hop: h.children, where: call("gt", qty(), val(0, "integer")) }, ["p2", "p4"]],
        ["not some child qty > 0", call("not", { kind: "some", hop: h.children, where: call("gt", qty(), val(0, "integer")) }), ["p3", "p4"]],
        ["some child qty = my n + 2 (a depth-0 column inside the body)", { kind: "some", hop: h.children, where: call("eq", qty(), call("add", col("n", "integer"), val(2, "integer"))) }, ["p1"]],
      ]),
      hopCases("count and first: first takes the lowest key", (h) => [
        ["two children", call("eq", { kind: "count", hop: h.children }, val(2, "integer")), ["p1", "p2"]],
        ["no child", call("eq", { kind: "count", hop: h.children }, val(0, "integer")), ["p4"]],
        ["one child with qty > 2", call("eq", { kind: "count", hop: h.children, where: call("gt", qty(), val(2, "integer")) }, val(1, "integer")), ["p1", "p2"]],
        ["the first child with a qty has qty 1", call("eq", { kind: "first", hop: h.children, where: call("isNotNull", qty()), value: qty() }, val(1, "integer")), ["p2"]],
        ["the first child with a qty has qty 3, past a lower-key child without one", call("eq", { kind: "first", hop: h.children, where: call("isNotNull", qty()), value: qty() }, val(3, "integer")), ["p1"]],
        ["the first child with a qty has qty 5", call("eq", { kind: "first", hop: h.children, where: call("isNotNull", qty()), value: qty() }, val(5, "integer")), []],
        ["no child with a qty", call("isNull", { kind: "first", hop: h.children, where: call("isNotNull", qty()), value: qty() }), ["p3", "p4"]],
      ]),
      hopCases("a through hop counts a far row once and skips a link with no exit", (h) => [
        ["one linked child", call("eq", { kind: "count", hop: h.linked }, val(1, "integer")), ["p1", "p2"]],
        ["no linked child", call("eq", { kind: "count", hop: h.linked }, val(0, "integer")), ["p3", "p4"]],
        ["some linked child with qty 1", { kind: "some", hop: h.linked, where: call("eq", qty(), val(1, "integer")) }, ["p1"]],
        ["every linked child with qty 3", { kind: "every", hop: h.linked, where: call("eq", qty(), val(3, "integer")) }, ["p2", "p3", "p4"]],
      ]),
      ["an order key may cross a relationship", withRows(async (read, fixture) => {
        const h = hops(fixture);
        await expectIds(read, { order: [{ by: { kind: "count", hop: h.children }, desc: true }] }, ["p1", "p2", "p3", "p4"], "by number of children, ties in key order");
        await expectIds(read, { order: [{ by: { kind: "one", hop: h.toParent, value: col("s", "string", 1) }, desc: false }] }, ["p1", "p4", "p2", "p3"], "by the parent's s, nulls first");
      })],
      ["a rollup reads each row its route reaches once, from the row it starts at, narrowed by its filter", withRows(async (read, fixture) => {
        const h = hops(fixture);
        const rollup = (fn: RollupFn, steps: Hop[], value: string, cls: ValueClass, where?: Node, depth = 0): Node =>
          ({ kind: "rollup", fn, depth, hops: steps, value, class: cls, ...(where ? { where } : {}) });
        const list: (readonly [string, Node, string[]])[] = [
          // p1: c1 (no qty), c2 (3); p2: c3 (1), c4 (5); p3: c5 (no qty); p4: none.
          ["two children", call("eq", rollup("count", [h.children], "id", "integer"), val(2, "integer")), ["p1", "p2"]],
          ["no child counts 0", call("eq", rollup("count", [h.children], "id", "integer"), val(0, "integer")), ["p4"]],
          ["a sum of 6", call("eq", rollup("sum", [h.children], "qty", "integer"), val(6, "integer")), ["p2"]],
          ["a sum over no row or only null values is null", call("isNull", rollup("sum", [h.children], "qty", "integer")), ["p3", "p4"]],
          ["an average of 3 leaves a null value out", call("eq", rollup("avg", [h.children], "qty", "float"), val(3, "float")), ["p1", "p2"]],
          ["a min of 1", call("eq", rollup("min", [h.children], "qty", "integer"), val(1, "integer")), ["p2"]],
          // Over a belongs-to: p1 has no parent and p4's parent key dangles, so both reach nothing.
          ["the max over a belongs-to", call("eq", rollup("max", [h.toParent], "d", "date"), val(D(1000), "date")), ["p2"]],
          ["a belongs-to with no key or a dangling one reaches nothing", call("isNull", rollup("max", [h.toParent], "d", "date")), ["p1", "p4"]],
          // p1 reaches c3 through two links and skips the link with no exit: c3 counts once.
          ["a through hop counts a far row once", call("eq", rollup("sum", [h.linked], "qty", "integer"), val(1, "integer")), ["p1"]],
          ["a through hop's count", call("eq", rollup("count", [h.linked], "id", "integer"), val(1, "integer")), ["p1", "p2"]],
          // Children, then their parent: two children of p1 reach p1 itself, which counts once.
          ["two paths to one row count it once", call("eq", rollup("count", [h.children, h.toParent], "id", "integer"), val(1, "integer")), ["p1", "p2", "p3"]],
          ["and add it once", call("eq", rollup("sum", [h.children, h.toParent], "n", "integer"), val(1, "integer")), ["p1"]],
          // A route of two hops whose second is a through hop, one with a filter, and one whose through hop comes first
          // (its IN subquery then sits inside the join of the route).
          ["a through hop after a belongs-to", call("eq", rollup("sum", [h.toParent, h.linked], "qty", "integer"), val(1, "integer")), ["p2"]],
          ["a filter on a route of two hops", call("eq", rollup("count", [h.toParent, h.children], "id", "integer", call("gt", col("qty", "integer"), val(2, "integer"))), val(1, "integer")), ["p2", "p3"]],
          ["a through hop first in a route of two hops", call("eq", rollup("count", [h.linked, h.toParent], "id", "integer"), val(1, "integer")), ["p1", "p2"]],
          ["the filter keeps the rows of the last table it makes true", call("eq", rollup("count", [h.children], "id", "integer", call("gt", col("qty", "integer"), val(2, "integer"))), val(1, "integer")), ["p1", "p2"]],
          ["a filter that is unknown for a row leaves it out", call("eq", rollup("count", [h.children], "id", "integer", call("gt", col("qty", "integer"), val(0, "integer"))), val(2, "integer")), ["p2"]],
          // Inside a hop: the parent's number of children (p1 has 2, p2 has 2).
          ["a rollup of the row a hop reaches", call("eq", { kind: "one", hop: h.toParent, value: rollup("count", [h.children], "id", "integer", undefined, 1) }, val(2, "integer")), ["p2", "p3"]],
          // Inside a quantifier, of the outer row: a child whose qty is under the sum of its siblings' and its own.
          ["a rollup of the outer row inside a quantifier", { kind: "some", hop: h.children, where: call("lt", col("qty", "integer", 1), rollup("sum", [h.children], "qty", "integer")) }, ["p2"]],
        ];
        for (const [message, where, expected] of list) await expectIds(read, { where }, expected, message);
        const bySum = rollup("sum", [h.children], "qty", "integer");
        await expectIds(read, { order: [{ by: bySum, desc: true }] }, ["p2", "p1", "p3", "p4"], "by the sum of qty, descending: nulls last, ties in key order");
        await expectIds(read, { order: [{ by: bySum, desc: false }] }, ["p3", "p4", "p1", "p2"], "by the sum of qty, ascending: nulls first");
      })],
      ["max and count honour a where that crosses a relationship", withRows(async (_read, fixture) => {
        const h = hops(fixture);
        const where: Node = { kind: "some", hop: h.children, where: call("gt", qty(), val(2, "integer")) };
        assert(await fixture.layer.transaction((tx) => tx.max(fixture.parent, "n", undefined, where)) === 2, "max of n over parents with a child of qty > 2");
        assert(await fixture.layer.transaction((tx) => tx.count(fixture.parent, "id", undefined, where)) === 2, "count of parents with a child of qty > 2");
      })],
    );
    if (declared("aggregates"))
      checks.push(["rollup with hops honours the where of its start, of each hop and of a link", withRows(async (_read, fixture) => {
        const h = hops(fixture);
        const byAnchor = rollupsOf(fixture.layer);
        const route = (fn: RollupFn, value: string, steps: RollupHop[], anchors: string[], where?: Node): RollupQuery =>
          ({ fn, table: fixture.parent, anchor: "id", anchors, value, hops: steps, key: "id", where });
        const qtyOver = (n: number) => call("gt", col("qty", "integer"), val(n, "integer"));
        same(await byAnchor(route("sum", "qty", [{ hop: h.children, where: qtyOver(2) }], ["p1", "p2"])), { p1: 3, p2: 5 }, "a hop's where keeps the children with qty > 2");
        same(await byAnchor(route("sum", "qty", [{ hop: h.children }], ["p1", "p2", "p4"], call("isTrue", col("b", "boolean")))), { p1: 3 }, "the start's where leaves p2 out, and p4 reaches no child");
        // A where that crosses a relationship itself: its subquery's aliases do not collide with the route's.
        same(await byAnchor(route("sum", "pos", [{ hop: h.children }], ["p1", "p2", "p3"], { kind: "some", hop: h.children, where: call("gt", qty(), val(2, "integer")) })), { p1: 1, p2: 1 }, "a start's where with a hop of its own");
        // Children, then their parent: the later hop's where admits p2 (n 2) and not p1 (n 1).
        same(await byAnchor(route("count", "id", [{ hop: h.children }, { hop: h.toParent, where: call("gt", col("n", "integer"), val(1, "integer")) }], ["p1", "p2"])), { p2: 1 }, "the where of a later hop");
        // p1 reaches c3 through k1 and k2, p2 reaches c2 through k4.
        same(await byAnchor(route("count", "id", [{ hop: h.linked, linkWhere: call("ne", col("id", "string"), val("k1", "string")) }], ["p1", "p2"])), { p1: 1, p2: 1 }, "a far row another admitted link leads to still counts, once");
        same(await byAnchor(route("count", "id", [{ hop: h.linked, linkWhere: call("eq", col("id", "string"), val("k4", "string")) }], ["p1", "p2"])), { p2: 1 }, "a link row the linkWhere leaves out leads nowhere");
        same(await byAnchor(route("sum", "qty", [{ hop: h.linked, where: call("eq", col("qty", "integer"), val(1, "integer")) }], ["p1", "p2"])), { p1: 1 }, "a through hop's where is on the far rows");
        same(await byAnchor(route("count", "id", [{ hop: h.linked, where: val(true, "boolean"), linkWhere: val(false, "boolean") }], ["p1", "p2"])), {}, "a false linkWhere reaches nothing");
      })]);
  }
  return Object.fromEntries(checks);
}

const SUFFIX: Record<ValueClass, string> = { string: "s", integer: "i", float: "f", boolean: "b", date: "d" };
const LOGIC = new Set(["and", "or", "not"]);

function classOfValue(value: unknown): ValueClass | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (typeof value === "string") return "string";
  return Number.isInteger(value) ? "integer" : "float";
}

/** The test a row passes iff SQL gives `expected` for `node`: `isNull` for null, else `eq`. */
function expecting(part: Node, expected: unknown): Node {
  const cls = classOfValue(expected);
  return cls === undefined ? call("isNull", part) : call("eq", part, val(expected as Scalar, cls));
}

/**
 * Every row of `EXPRESSION_TABLES` (but `now`, `today` and `isSystem`, which are always parameters, and the list rows of
 * `length`, which are `count` nodes) and of `QUANTIFIER_TABLES` through the data layer: the in-memory answers are the
 * definition, so SQL must give each one (ADR-0012). Each function row runs in two forms, its arguments as bound
 * values and as columns of a row of `values`; the quantifier rows go over `child` (`joins` required). One select per
 * function; a failing one is retried case by case to name the case.
 */
export function expressionTablesThroughLayer(makeLayer: () => Promise<ConditionFixture>, manifest: CapabilityManifest): Record<string, () => Promise<void>> {
  const declared = (name: string) => (manifest.capabilities as readonly string[]).includes(name);
  const withFixture = (run: (fixture: ConditionFixture) => Promise<void>) => async () => {
    const fixture = await makeLayer();
    try { await run(fixture); } finally { await fixture.layer.close(); }
  };
  const show = (args: readonly unknown[]) => args.map((a) => a instanceof Date ? `Date(${a.getTime()})` : JSON.stringify(a)).join(", ");
  const skip = new Set(["now", "today", "isSystem"]);
  const functions = Object.entries(EXPRESSION_TABLES)
    .filter(([fn]) => !skip.has(fn))
    .map(([fn, rows]) => [fn as SqlFunction, rows.filter((row) => !row.args.some(Array.isArray))] as const);

  const classesOf = (fn: string, args: readonly unknown[]): ValueClass[] => {
    const known = args.map(classOfValue);
    const fallback = known.find((c) => c !== undefined && (fn !== "cond" || c !== "boolean")) ?? (LOGIC.has(fn) ? "boolean" : "integer");
    return known.map((c, i) => c ?? (fn === "cond" && i === 0 ? "boolean" : LOGIC.has(fn) ? "boolean" : fallback));
  };

  const checks: (readonly [string, () => Promise<void>])[] = [];
  for (const [fn, rows] of functions) {
    checks.push([`${fn}: every table row, as bound values`, withFixture(async ({ layer, values }) => {
      await layer.transaction((tx) => tx.insert(values, { id: 0 }));
      const test = (args: readonly unknown[], expected: unknown) => {
        const classes = classesOf(fn, args);
        return expecting(call(fn, ...args.map((a, i) => val(a as Scalar, classes[i]!))), expected);
      };
      const holds = (where: Node) => layer.transaction(async (tx) => (await tx.select(values, { where })).length === 1);
      const all: Node = rows.length === 1 ? test(rows[0]!.args, rows[0]!.result) : call("and", ...rows.map((row) => test(row.args, row.result)));
      if (await holds(all)) return;
      for (const row of rows) assert(await holds(test(row.args, row.result)), `${fn}(${show(row.args)}) as bound values must give ${show([row.result])}`);
      assert(false, `${fn}: every row passes alone and fails together`);
    })]);
    checks.push([`${fn}: every table row, as columns`, withFixture(async ({ layer, values }) => {
      const tests: Node[] = [];
      await layer.transaction(async (tx) => {
        for (const [k, row] of rows.entries()) {
          const classes = classesOf(fn, row.args);
          const record: Row = { id: k + 1 };
          const args = row.args.map((a, i) => {
            const name = `${"abc"[i]}_${SUFFIX[classes[i]!]}`;
            record[name] = a;
            return col(name, classes[i]!);
          });
          await tx.insert(values, record);
          tests.push(call("and", call("eq", col("id", "integer"), val(k + 1, "integer")), expecting(call(fn, ...args), row.result)));
        }
      });
      const ids = await layer.transaction(async (tx) =>
        (await tx.select(values, { where: tests.length === 1 ? tests[0] : call("or", ...tests) })).map((row) => Number(row.id)));
      for (const [k, row] of rows.entries()) assert(ids.includes(k + 1), `${fn}(${show(row.args)}) over columns must give ${show([row.result])}`);
    })]);
  }

  if (declared("joins")) {
    for (const [fn, rows] of Object.entries(QUANTIFIER_TABLES)) {
      checks.push([`${fn}: every quantifier row, over related rows`, withFixture(async ({ layer, parent, child }) => {
        const hop: Hop = { table: child, column: "parentId", outer: "id", key: "id" };
        // The predicate's outcome per element: qty 1 is true, 0 false, null unknown.
        const where = call("eq", col("qty", "integer", 1), val(1, "integer"));
        const tests: Node[] = [];
        await layer.transaction(async (tx) => {
          for (const [k, row] of rows.entries()) {
            const id = `q${k}`;
            await tx.insert(parent, { id });
            // In reverse key order, so `find` must order by the key rather than read the first row inserted.
            for (const [i, outcome] of [...row.outcomes.entries()].reverse()) {
              await tx.insert(child, { id: `${id}-${String(i).padStart(3, "0")}`, parentId: id, qty: outcome === null ? null : outcome ? 1 : 0, pos: i });
            }
            const part: Node =
              fn === "some" || fn === "every" ? expecting({ kind: fn, hop, where }, row.result)
              : fn === "find" ? expecting({ kind: "first", hop, where, value: col("pos", "integer", 1) }, row.result)
              : expecting({ kind: "count", hop, where }, (row.result as unknown[]).length);
            tests.push(call("and", call("eq", col("id", "string"), val(id, "string")), part));
          }
        });
        const ids = await layer.transaction(async (tx) => (await tx.select(parent, { where: tests.length === 1 ? tests[0] : call("or", ...tests) })).map((row) => String(row.id)));
        for (const [k, row] of rows.entries()) assert(ids.includes(`q${k}`), `${fn} over outcomes ${show(row.outcomes)} must give ${show([row.result])}`);
      })]);
    }
  }
  return Object.fromEntries(checks);
}
