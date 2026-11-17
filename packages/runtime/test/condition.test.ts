import { describe, expect, test } from "bun:test";
import { EXPRESSION_TABLES } from "@meshfw/runtime/testing";
import {
  FrameworkError, allOf, bindCondition, callerQuery, expr, orderOf, scope, whereFor,
  type CallerComputed,
  type Condition, type ConditionLiteral, type LiteralNode, type SqlFunction, type TableHandle, type ValueClass,
} from "@meshfw/runtime";

const customers: TableHandle = { name: "customers" };
const lines: TableHandle = { name: "lines" };
const links: TableHandle = { name: "links" };
const handles: Record<string, TableHandle> = { "billing.Customer": customers, "billing.Line": lines, "billing.Link": links };
const tableOf = (fqn: string) => {
  const handle = handles[fqn];
  if (!handle) throw new Error(`no table for ${fqn}`);
  return handle;
};

const col = (name: string, cls: ValueClass = "string", depth = 0): LiteralNode => ({ kind: "column", depth, name, class: cls });
const param = (index: number, cls: ValueClass): LiteralNode => ({ kind: "param", index, class: cls });
const val = (value: string | number | boolean | Date | null, cls: ValueClass): LiteralNode => ({ kind: "value", value, class: cls });
const call = (fn: SqlFunction, ...args: LiteralNode[]): LiteralNode => ({ kind: "call", fn, args });
const literal = (tree: LiteralNode, params: readonly unknown[] = [], what = "the filter of read :open of billing.Invoice"): ConditionLiteral<unknown> =>
  ({ what, entity: "billing.Invoice", tree, params: () => params });
const bind = (tree: LiteralNode, params: readonly unknown[] = []) => bindCondition(tableOf, literal(tree, params), {});

describe("bindCondition", () => {
  test("puts parameters in by index, keeping each one's class", () => {
    const tree = call("and", call("eq", col("customerId"), param(1, "string")), call("gt", col("total", "integer"), param(0, "integer")));
    expect(bind(tree, [10, "c1"])).toEqual({ kind: "call", fn: "and", args: [
      { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "customerId", class: "string" }, { kind: "value", value: "c1", class: "string" }] },
      { kind: "call", fn: "gt", args: [{ kind: "column", depth: 0, name: "total", class: "integer" }, { kind: "value", value: 10, class: "integer" }] },
    ] });
  });

  test("resolves every hop's entity through tableOf, the link of a through included", () => {
    const tree: LiteralNode = call("and",
      { kind: "one", hop: { table: "billing.Customer", column: "id", outer: "customerId", key: "id" }, value: col("name", "string", 1) },
      { kind: "some", hop: { table: "billing.Line", column: "id", outer: "id", key: "id", through: { table: "billing.Link", entry: "invoiceId", exit: "lineId" } }, where: call("gt", col("qty", "integer", 1), param(0, "integer")) });
    const bound = bind(tree, [2]) as Extract<Condition, { kind: "call" }>;
    const [one, some] = bound.args as [Extract<Condition, { kind: "one" }>, Extract<Condition, { kind: "some" | "every" }>];
    expect(one.hop.table).toBe(customers);
    expect(some.hop.table).toBe(lines);
    expect(some.hop.through?.table).toBe(links);
    expect(some.hop.through).toEqual({ table: links, entry: "invoiceId", exit: "lineId" });
    expect(some.where).toEqual({ kind: "call", fn: "gt", args: [col("qty", "integer", 1), { kind: "value", value: 2, class: "integer" }] } as never);
  });

  test("a literal with no hop never calls tableOf", () => {
    const refusing = () => { throw new Error("called"); };
    expect(bindCondition(refusing, literal(call("eq", col("id"), param(0, "string")), ["a"]), {})).toMatchObject({ kind: "call", fn: "eq" });
  });

  test("an undefined parameter is null, and an unknown index is refused", () => {
    expect(bind(call("eq", col("id"), param(0, "string")), [undefined])).toEqual({ kind: "call", fn: "eq", args: [col("id") as never, { kind: "value", value: null, class: "string" }] });
    expect(() => bind(call("eq", col("id"), param(1, "string")), ["a"])).toThrow(FrameworkError);
    expect(() => bindCondition(tableOf, { ...literal(col("done", "boolean")), params: () => "x" as never }, {})).toThrow(FrameworkError);
  });

  test("parameters are computed on the scope, inside mark when one is given", () => {
    const seen: unknown[] = [];
    const marks: string[] = [];
    const lit: ConditionLiteral<{ input: { id: string } }> = {
      what: "policy :owner authorize-if of billing.Invoice", entity: "billing.Invoice", tree: call("eq", col("ownerId"), param(0, "string")),
      params: (s) => { seen.push(s); marks.push("computed"); return [s.input.id]; },
    };
    const s = { input: { id: "u1" } };
    const bound = bindCondition(tableOf, lit, s, (run) => { marks.push("enter"); const result = run(); marks.push("leave"); return result; });
    expect(seen).toEqual([s]);
    expect(marks).toEqual(["enter", "computed", "leave"]);
    expect(bound).toMatchObject({ args: [{}, { value: "u1" }] });
  });

  test("a parameter's helper that throws throws out of the binding", () => {
    const lit: ConditionLiteral<unknown> = { ...literal(col("done", "boolean")), params: () => { throw new FrameworkError("helper failed"); } };
    expect(() => bindCondition(tableOf, lit, {})).toThrow("helper failed");
  });

  test("every registered function folds as the in-memory one answers, null included", () => {
    const skip = new Set(["now", "today", "isSystem"]);
    const classOf = (v: unknown): ValueClass => typeof v === "boolean" ? "boolean" : v instanceof Date ? "date" : typeof v === "string" ? "string" : typeof v === "number" && !Number.isInteger(v) ? "float" : "integer";
    let checked = 0;
    for (const [fn, cases] of Object.entries(EXPRESSION_TABLES)) {
      if (skip.has(fn)) continue;
      for (const row of cases) {
        if (row.args.some((a) => Array.isArray(a))) continue; // the list rows of length are count nodes
        const tree = call(fn as SqlFunction, ...row.args.map((a, i) => param(i, a === null ? "integer" : classOf(a))));
        const bound = bind(tree, row.args);
        const result = bound === true || bound === false || bound === null ? bound : (bound as { kind: string; value?: unknown }).kind === "value" ? (bound as { value: unknown }).value : "not folded";
        const expected = row.result instanceof Date ? row.result.getTime() : row.result;
        expect({ fn, args: row.args, result: result instanceof Date ? result.getTime() : result }).toEqual({ fn, args: row.args, result: expected });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("returns true, false and null for a tree that folds to each", () => {
    expect(bind(call("eq", param(0, "integer"), param(1, "integer")), [1, 1])).toBe(true);
    expect(bind(call("eq", param(0, "integer"), param(1, "integer")), [1, 2])).toBe(false);
    expect(bind(call("eq", param(0, "integer"), param(1, "integer")), [1, null])).toBeNull();
    expect(bind(val(true, "boolean"))).toBe(true);
  });

  test("Kleene folding: false AND x is false, true OR x is true, true AND x is x, unknown AND x stays", () => {
    const done = col("done", "boolean");
    expect(bind(call("and", param(0, "boolean"), done), [false])).toBe(false);
    expect(bind(call("and", done, param(0, "boolean")), [false])).toBe(false);
    expect(bind(call("or", param(0, "boolean"), done), [true])).toBe(true);
    expect(bind(call("and", param(0, "boolean"), done), [true])).toEqual(done as never);
    expect(bind(call("or", done, param(0, "boolean")), [false])).toEqual(done as never);
    expect(bind(call("and", param(0, "boolean"), done), [null])).toEqual({ kind: "call", fn: "and", args: [{ kind: "value", value: null, class: "boolean" }, done] } as never);
    expect(bind(call("or", param(0, "boolean"), done), [null])).toEqual({ kind: "call", fn: "or", args: [{ kind: "value", value: null, class: "boolean" }, done] } as never);
  });

  test("cond and coalesce fold on a known test or a known first operand only", () => {
    const a = col("a", "integer");
    const b = col("b", "integer");
    expect(bind(call("cond", param(0, "boolean"), a, b), [true])).toEqual(a as never);
    expect(bind(call("cond", param(0, "boolean"), a, b), [false])).toEqual(b as never);
    expect(bind(call("cond", param(0, "boolean"), a, b), [null])).toEqual(b as never); // an unknown test takes the else branch
    expect(bind(call("coalesce", param(0, "integer"), a), [3])).toEqual({ kind: "value", value: 3, class: "integer" } as never);
    expect(bind(call("coalesce", param(0, "integer"), a), [null])).toEqual(a as never);
    expect(bind(call("coalesce", a, param(0, "integer")), [3])).toMatchObject({ kind: "call", fn: "coalesce" });
  });

  test("a hop node is never folded, even when its where reads no column", () => {
    const tree: LiteralNode = { kind: "some", hop: { table: "billing.Line", column: "invoiceId", outer: "id", key: "id" }, where: param(0, "boolean") };
    expect(bind(tree, [true])).toEqual({ kind: "some", hop: { table: lines, column: "invoiceId", outer: "id", key: "id" }, where: { kind: "value", value: true, class: "boolean" } });
    const count: LiteralNode = call("gt", { kind: "count", hop: { table: "billing.Line", column: "invoiceId", outer: "id", key: "id" } }, param(0, "integer"));
    expect(bind(count, [2])).toMatchObject({ kind: "call", fn: "gt" });
  });

  test("a rollup node resolves each hop's tables, binds its filter's parameters, and is never folded", () => {
    const toLine = { table: "billing.Line", column: "invoiceId", outer: "id", key: "id" };
    const through = { table: "billing.Customer", column: "id", outer: "customerId", key: "id", through: { table: "billing.Link", entry: "lineId", exit: "customerId" } };
    const tree: LiteralNode = call("gt", { kind: "rollup", fn: "sum", depth: 0, hops: [toLine, through], value: "score", class: "integer", where: call("gt", col("score", "integer"), param(0, "integer")) }, param(1, "integer"));
    expect(bind(tree, [3, 10])).toEqual({ kind: "call", fn: "gt", args: [
      { kind: "rollup", fn: "sum", depth: 0, value: "score", class: "integer",
        hops: [{ ...toLine, table: lines }, { ...through, table: customers, through: { table: links, entry: "lineId", exit: "customerId" } }],
        where: { kind: "call", fn: "gt", args: [col("score", "integer") as never, { kind: "value", value: 3, class: "integer" }] } },
      { kind: "value", value: 10, class: "integer" },
    ] });
    // No filter: no where; a filter that folds stays inside the node, which is never folded itself.
    expect(bind({ kind: "rollup", fn: "count", depth: 0, hops: [toLine], value: "id", class: "integer" })).toEqual({ kind: "rollup", fn: "count", depth: 0, hops: [{ ...toLine, table: lines }], value: "id", class: "integer" });
    expect(bind({ kind: "rollup", fn: "count", depth: 0, hops: [toLine], value: "id", class: "integer", where: param(0, "boolean") }, [true]))
      .toMatchObject({ kind: "rollup", where: { kind: "value", value: true, class: "boolean" } });
    // The class check names the rollup as the stored side.
    expect(() => bind(call("gt", { kind: "rollup", fn: "max", depth: 0, hops: [toLine], value: "qty", class: "integer" }, param(0, "integer")), ["2"]))
      .toThrow("compares the max rollup of related rows (integer) with the string \"2\"");
    // A malformed node is refused, never printed.
    expect(() => bind({ kind: "rollup", fn: "median", depth: 0, hops: [toLine], value: "qty", class: "integer" } as never)).toThrow('has a rollup of unknown function "median"');
    expect(() => bind({ kind: "rollup", fn: "count", depth: 0, hops: [], value: "id", class: "integer" })).toThrow("has a rollup with no hops");
    expect(() => bind({ kind: "rollup", fn: "count", depth: 0, hops: [toLine], value: "id", class: "number" } as never)).toThrow("of unknown class");
  });

  test("isTrue and isFalse fold two-valued", () => {
    for (const [v, t, f] of [[true, true, false], [false, false, true], [null, false, false]] as const) {
      expect(bind(call("isTrue", param(0, "boolean")), [v])).toBe(t);
      expect(bind(call("isFalse", param(0, "boolean")), [v])).toBe(f);
    }
  });

  test("an unknown function or node kind is refused", () => {
    expect(() => bind(call("like" as SqlFunction, col("s"), param(0, "string")), ["x"])).toThrow(FrameworkError);
    expect(() => bind({ kind: "fragment" } as never)).toThrow(FrameworkError);
  });

  describe("the class check (a value the database would convert is refused)", () => {
    const at = (cls: ValueClass, value: unknown) => () => bind(call("eq", col("x", cls), param(0, cls)), [value]);
    test("null passes for every class", () => {
      for (const cls of ["string", "integer", "float", "boolean", "date"] as const) expect(at(cls, null)).not.toThrow();
    });
    test("values of the class pass", () => {
      for (const [cls, value] of [["string", "1"], ["integer", -3], ["float", 2.5], ["float", 2], ["boolean", false], ["date", new Date(5)]] as const) expect(at(cls, value)).not.toThrow();
    });
    test("a number for a string, a fraction for an integer, a string for a date, an invalid Date are refused, naming the condition", () => {
      for (const [cls, value] of [["string", 1], ["integer", 2.5], ["date", "2026-01-01"], ["date", new Date(Number.NaN)], ["boolean", 1], ["float", Number.POSITIVE_INFINITY], ["string", { id: 1 }], ["integer", "1"]] as const) {
        expect(at(cls, value)).toThrow(FrameworkError);
      }
      expect(at("string", 1)).toThrow("the filter of read :open of billing.Invoice compares the column x (string) with the number 1 from parameter 0: the database would convert it, so Mesh refuses it");
    });
    test("the parameter's source text, when the literal carries it, is named", () => {
      const tree = call("eq", col("ownerId"), { kind: "param", index: 0, class: "string", source: "actor.id" });
      expect(() => bind(tree, [7])).toThrow("compares the column ownerId (string) with the number 7 from actor.id:");
    });
    test("the column side is named on either side, and through a function", () => {
      expect(() => bind(call("eq", param(0, "string"), col("ownerId")), [7])).toThrow("compares the column ownerId (string) with the number 7 from parameter 0:");
      expect(() => bind(call("eq", call("length", col("s")), param(0, "integer")), ["x"])).toThrow("compares length of the column s (integer) with the string \"x\" from parameter 0:");
    });
    test("where no column is met, the message names the function argument it fills", () => {
      expect(() => bind(call("isTrue", param(0, "boolean")), [1])).toThrow("needs a boolean for argument 1 of isTrue and got the number 1 from parameter 0:");
      expect(() => bind(param(0, "boolean"), [1])).toThrow("needs a boolean and got the number 1 from parameter 0:");
    });
    test("a literal value is checked too", () => {
      expect(() => bind(call("eq", col("n", "integer"), val("1", "integer")))).toThrow(FrameworkError);
    });
  });
});

describe("allOf", () => {
  const c: Condition = { kind: "column", depth: 0, name: "done", class: "boolean" };
  const d: Condition = { kind: "column", depth: 0, name: "open", class: "boolean" };
  test("false or unknown anywhere is false; true parts drop out", () => {
    expect(allOf([])).toBe(true);
    expect(allOf([true, true])).toBe(true);
    expect(allOf([true, false])).toBe(false);
    expect(allOf([c, null])).toBe(false);
    expect(allOf([null])).toBe(false);
    expect(allOf([true, c])).toBe(c);
    expect(allOf([c, true, d])).toEqual({ kind: "call", fn: "and", args: [c, d] });
  });
});

describe("whereFor", () => {
  const manifest = (...capabilities: string[]) => ({ capabilities: { adapter: "fake", capabilities } });
  const c: Condition = { kind: "column", depth: 0, name: "done", class: "boolean" };
  const hop: Condition = { kind: "some", hop: { table: lines, column: "invoiceId", outer: "id", key: "id" }, where: c };
  test("true is no condition, for any layer", () => {
    expect(whereFor({}, true)).toBeUndefined();
  });
  test("a condition goes to a layer that declares conditions", () => {
    expect(whereFor(manifest("conditions"), c)).toBe(c);
    expect(whereFor(manifest("conditions", "joins"), hop)).toBe(hop);
  });
  test("false is refused for any layer: the caller returns no row without a query", () => {
    expect(() => whereFor(manifest("conditions"), false)).toThrow("returns no row without running the query");
    expect(() => whereFor({}, false)).toThrow(FrameworkError);
  });
  test("a layer without conditions is refused, and a hop needs joins", () => {
    expect(() => whereFor({}, c)).toThrow(FrameworkError);
    expect(() => whereFor(manifest("aggregates"), c)).toThrow('the data adapter "fake" does not declare the conditions capability');
    expect(() => whereFor(manifest("conditions"), hop)).toThrow('the data adapter "fake" does not declare the joins capability');
    expect(() => whereFor(manifest("conditions"), { kind: "call", fn: "not", args: [hop] })).toThrow(FrameworkError);
    // A rollup runs as a subquery over its route: it needs joins, even over one relationship.
    const rollup: Condition = { kind: "call", fn: "gt", args: [{ kind: "rollup", fn: "count", depth: 0, hops: [{ table: lines, column: "invoiceId", outer: "id", key: "id" }], value: "id", class: "integer" }, { kind: "value", value: 0, class: "integer" }] };
    expect(() => whereFor(manifest("conditions"), rollup)).toThrow("does not declare the joins capability");
    expect(whereFor(manifest("conditions", "joins"), rollup)).toBe(rollup);
  });
});

describe("orderOf", () => {
  const classes = { dueOn: "date", title: "string", total: "integer" } as const;
  test("the caller's keys, then the declared keys", () => {
    const order = orderOf(tableOf, ["-total", "title"], classes, [{ column: "dueOn", class: "date", desc: false }], {});
    expect(order).toEqual([
      { by: { kind: "column", depth: 0, name: "total", class: "integer" }, desc: true },
      { by: { kind: "column", depth: 0, name: "title", class: "string" }, desc: false },
      { by: { kind: "column", depth: 0, name: "dueOn", class: "date" }, desc: false },
    ]);
  });
  test("neither is undefined; a declared key the caller already sorts by is not repeated", () => {
    expect(orderOf(tableOf, undefined, classes, [], {})).toBeUndefined();
    expect(orderOf(tableOf, [], classes, [], {})).toBeUndefined();
    expect(orderOf(tableOf, ["-dueOn"], classes, [{ column: "dueOn", class: "date", desc: false }], {})).toEqual([
      { by: { kind: "column", depth: 0, name: "dueOn", class: "date" }, desc: true },
    ]);
  });
  test("a declared computed key is its bound literal; one that folds to a constant orders nothing", () => {
    const late: ConditionLiteral<{ clock: () => Date }> = {
      what: "the sort of read :open of billing.Invoice", entity: "billing.Invoice",
      tree: call("lt", col("dueOn", "date"), param(0, "date")), params: (s) => [expr.today(s as never)],
    };
    const constant: ConditionLiteral<unknown> = { ...literal(call("add", param(0, "integer"), param(1, "integer")), [1, 2]) };
    const s = scope({}, { clock: () => new Date(86_400_000 * 3 + 5) });
    expect(orderOf(tableOf, undefined, classes, [{ literal: late, desc: true }, { literal: constant, desc: false }], s)).toEqual([
      { by: { kind: "call", fn: "lt", args: [{ kind: "column", depth: 0, name: "dueOn", class: "date" }, { kind: "value", value: new Date(86_400_000 * 3), class: "date" }] }, desc: true },
    ]);
  });
  test("an unknown caller key, an empty name or a sort that is not a list of names is refused", () => {
    expect(() => orderOf(tableOf, ["nope"], classes, [], {})).toThrow(FrameworkError);
    expect(() => orderOf(tableOf, ["-"], classes, [], {})).toThrow(FrameworkError);
    expect(() => orderOf(tableOf, "title" as never, classes, [], {})).toThrow(FrameworkError);
    expect(() => orderOf(tableOf, ["toString"], classes, [], {})).toThrow(FrameworkError);
  });
});

describe("callerQuery", () => {
  const classes = { title: "string", total: "integer", dueOn: "date" } as const;
  const layer = { capabilities: { adapter: "fake", capabilities: ["conditions", "joins"] } };
  const c = (name: string, cls: ValueClass): Condition => ({ kind: "column", depth: 0, name, class: cls });
  const v = (value: string | number | boolean | Date | null, cls: ValueClass): Condition => ({ kind: "value", value, class: cls });
  const k = (fn: SqlFunction, ...args: Condition[]): Condition => ({ kind: "call", fn, args });
  const lineHop = { table: "billing.Line", column: "invoiceId", outer: "id", key: "id" };
  // doubled: &total * 2. busy: &lines.some((l) => l.qty > input-independent 2). late: &dueOn < %.today (a parameter).
  const doubled = { class: "integer", literal: () => literal(call("mul", col("total", "integer"), val(2, "integer")), [], "computed :doubled of billing.Invoice") } as const;
  const busy = { class: "boolean", literal: () => literal({ kind: "some", hop: lineHop, where: call("gt", col("qty", "integer", 1), val(2, "integer")) }, []) } as const;
  const late = {
    class: "boolean",
    literal: () => ({ what: "computed :late", entity: "billing.Invoice", tree: call("lt", col("dueOn", "date"), param(0, "date")), params: (s: never) => [expr.today(s)] }) as ConditionLiteral<never>,
  } as const;
  const always = { class: "boolean", literal: () => literal(val(true, "boolean")) } as const;
  const nothing = { class: "string", literal: () => literal(param(0, "string"), [null]) } as const;
  const computed: Record<string, CallerComputed> = { doubled, busy, late, always, nothing, label: "plain" as const, lineCount: "rollup" as const, toString: "plain" as const };
  const s = scope({}, { clock: () => new Date(86_400_000 * 3 + 5) });
  const sql = { tableOf, scope: s, classes, layer };
  const doubledNode = k("mul", c("total", "integer"), v(2, "integer"));
  const busyNode: Condition = { kind: "some", hop: { table: lines, column: "invoiceId", outer: "id", key: "id" }, where: k("gt", { kind: "column", depth: 1, name: "qty", class: "integer" }, v(2, "integer")) };

  test("a filter with no translated computed field stays a filter; the sort stays a sort", () => {
    const filter = { title: { eq: "a" } };
    const q = callerQuery("billing.Invoice", computed, { filter, sort: ["-title"] }, sql);
    expect(q).toEqual({ filter, where: true, sort: ["-title"] });
    expect(q.filter).toBe(filter);
    expect(callerQuery("billing.Invoice", computed, {}, sql)).toEqual({ filter: undefined, where: true, sort: undefined });
  });
  test("a filter that compares a translated computed field moves, whole, to where", () => {
    const q = callerQuery("billing.Invoice", computed, { filter: { title: { eq: "a" }, doubled: { gt: 10 } } }, sql);
    expect(q.filter).toBeUndefined();
    expect(q.where).toEqual(k("and", k("eq", c("title", "string"), v("a", "string")), k("gt", doubledNode, v(10, "integer"))));
    // Under or, beside a stored column: the stored column is a column of the condition.
    expect(callerQuery("billing.Invoice", computed, { filter: { or: [{ total: { lt: 3 } }, { busy: { eq: true } }] } }, sql).where)
      .toEqual(k("or", k("lt", c("total", "integer"), v(3, "integer")), k("eq", busyNode, v(true, "boolean"))));
    // A literal's parameters are computed on the read's scope.
    expect(callerQuery("billing.Invoice", computed, { filter: { late: { eq: false } } }, sql).where)
      .toEqual(k("eq", k("lt", c("dueOn", "date"), v(new Date(86_400_000 * 3), "date")), v(false, "boolean")));
  });
  test("every operator is the data layer's: eq/ne null are null tests, in is one of, nil, several operators all hold", () => {
    const where = (spec: unknown) => callerQuery("billing.Invoice", computed, { filter: { doubled: spec } }, sql).where;
    expect(where({ eq: null })).toEqual(k("isNull", doubledNode));
    expect(where({ ne: null })).toEqual(k("isNotNull", doubledNode));
    expect(where({ ne: 4 })).toEqual(k("ne", doubledNode, v(4, "integer")));
    expect(where({ nil: true })).toEqual(k("isNull", doubledNode));
    expect(where({ nil: false })).toEqual(k("isNotNull", doubledNode));
    expect(where({ in: [2] })).toEqual(k("eq", doubledNode, v(2, "integer")));
    expect(where({ in: [2, 4] })).toEqual(k("or", k("eq", doubledNode, v(2, "integer")), k("eq", doubledNode, v(4, "integer"))));
    expect(where({ in: [] })).toBe(false);
    expect(where({ gte: 2, lt: 9 })).toEqual(k("and", k("gte", doubledNode, v(2, "integer")), k("lt", doubledNode, v(9, "integer"))));
    // A fraction against an integer field is compared as a number.
    expect(where({ gt: 2.5 })).toEqual(k("gt", doubledNode, v(2.5, "float")));
  });
  test("and/or of nothing, and a body that folds to a constant, fold", () => {
    const where = (filter: unknown) => callerQuery("billing.Invoice", computed, { filter }, sql).where;
    expect(where({ always: { eq: true } })).toBe(true);
    expect(where({ always: { eq: false } })).toBe(false);
    expect(where({ and: [], always: { eq: true } })).toBe(true);
    expect(where({ or: [], always: { eq: true } })).toBe(false);
    // An unknown body: eq is unknown, and an unknown where returns no row (allOf).
    expect(where({ nothing: { eq: "x" } })).toBeNull();
    expect(where({ nothing: { eq: null } })).toBe(true);
    expect(where({ or: [{ always: { eq: true } }, { busy: { eq: true } }] })).toBe(true);
  });
  test("a filter the data layer would refuse is refused with its message", () => {
    const refused = (filter: unknown) => () => callerQuery("billing.Invoice", computed, { filter: { doubled: { eq: 1 }, ...(filter as object) } }, sql);
    expect(refused({ nope: { eq: 1 } })).toThrow('Unknown column "nope"; use an attribute in the emitted table');
    expect(refused({ title: "a" })).toThrow('Filter on "title" must be an object such as { eq: value }, not a bare value');
    expect(refused({ title: {} })).toThrow('Filter on "title" has no operator');
    expect(refused({ title: { like: "a" } })).toThrow('Unknown filter operator "like" on "title"');
    expect(refused({ total: { in: 1 } })).toThrow("Filter total.in must be a list");
    expect(refused({ total: { in: [null] } })).toThrow("must not contain null; combine it with nil: true under or");
    expect(refused({ total: { lt: null } })).toThrow("Filter total.lt cannot compare with null; use nil");
    expect(refused({ total: { nil: 1 } })).toThrow("Filter total.nil must be true or false");
    expect(refused({ and: {} })).toThrow('Filter "and" must be a list of filters');
    expect(refused({ total: { eq: "1" } })).toThrow('Filter total.eq compares total (integer) with the string "1": the database would convert it, so Mesh refuses it');
    expect(refused({ dueOn: { eq: new Date(Number.NaN) } })).toThrow(FrameworkError);
    expect(() => callerQuery("billing.Invoice", computed, { filter: { and: [{ doubled: { eq: 1 } }, 3] } }, sql)).toThrow("A filter must be an object");
  });
  test("a computed field Mesh runs in memory, or a rollup, is refused in a filter and in a sort", () => {
    const run = (query: { filter?: unknown; sort?: unknown }, withSql = true) => () => callerQuery("billing.Invoice", computed, query, withSql ? sql : undefined);
    const plain = (what: string) => `A ${what} by billing.Invoice#label is not available: label is a computed field Mesh runs in memory`;
    const rollup = (what: string) => `A ${what} by billing.Invoice#lineCount is not available: lineCount is a rollup, which a caller's filter and sort cannot name; a read's own filter= and sort can`;
    expect(run({ filter: { label: { eq: "a" } } })).toThrow(plain("filter"));
    expect(run({ sort: ["-label"] })).toThrow(plain("sort"));
    expect(run({ filter: { and: [{ title: { eq: "a" } }, { or: [{ lineCount: { gt: 1 } }] }] } })).toThrow(rollup("filter"));
    expect(run({ sort: ["title", "lineCount"] })).toThrow(rollup("sort"));
    // Without the SQL half (an entity with no translated field), a translated name cannot be: it is refused too.
    expect(run({ filter: { doubled: { eq: 1 } } }, false)).toThrow("A filter by billing.Invoice#doubled is not available: doubled is a computed field Mesh runs in memory");
    // A name that only resembles one, or an inherited member of Object, is not a computed field.
    expect(run({ filter: { labels: { eq: "a" } }, sort: ["-labels"] }, false)).not.toThrow();
    expect(run({ sort: ["valueOf"] }, false)).not.toThrow();
  });
  test("a computed field given as undefined is left out, at any depth; a stored column stays; nothing to take out is the filter itself", () => {
    const clean = (filter: unknown) => callerQuery<unknown, unknown>("billing.Invoice", computed, { filter }).filter;
    expect(clean({ toString: undefined, label: undefined, title: { eq: "a" } })).toEqual({ title: { eq: "a" } });
    const cleaned = clean({ or: [{ toString: undefined, title: { eq: "a" } }, { and: [{ label: undefined }, { title: { eq: "b" } }] }] });
    expect(cleaned).toEqual({ or: [{ title: { eq: "a" } }, { and: [{}, { title: { eq: "b" } }] }] });
    const stored = { title: undefined, toString: undefined };
    expect(Object.keys(clean(stored) as object)).toEqual(["title"]);
    const plain = { and: [{ title: { eq: "a" } }], title: undefined };
    expect(clean(plain)).toBe(plain);
    const given = { or: [{ toString: undefined }] };
    clean(given);
    expect(Object.keys(given.or[0]!)).toEqual(["toString"]);
    // Given as undefined beside a translated comparison: left out of the condition too.
    expect(callerQuery("billing.Invoice", computed, { filter: { label: undefined, doubled: { eq: 4 } } }, sql).where).toEqual(k("eq", doubledNode, v(4, "integer")));
    expect(() => clean({ toString: undefined, label: { eq: "v" } })).toThrow("label is a computed field Mesh runs in memory");
  });
  test("a sort by a translated computed field is an order: the caller's keys, then the declared ones", () => {
    expect(callerQuery("billing.Invoice", computed, { sort: ["-doubled", "title"] }, sql)).toEqual({
      filter: undefined, where: true,
      order: [{ by: doubledNode, desc: true }, { by: c("title", "string"), desc: false }],
    });
    const declared = [{ column: "dueOn", class: "date", desc: false }, { literal: busy.literal() as ConditionLiteral<unknown>, desc: true }] as const;
    expect(callerQuery("billing.Invoice", computed, { sort: ["busy"] }, { ...sql, declared }).order).toEqual([
      { by: busyNode, desc: false }, { by: c("dueOn", "date"), desc: false }, { by: busyNode, desc: true },
    ]);
    // A declared sort with no caller sort is the order too; a constant computed key orders nothing.
    expect(callerQuery("billing.Invoice", computed, { sort: ["always"] }, { ...sql, declared }).order).toEqual([{ by: c("dueOn", "date"), desc: false }, { by: busyNode, desc: true }]);
    expect(callerQuery("billing.Invoice", computed, { sort: ["always"] }, sql).order).toBeUndefined();
  });
  test("a computed field named by the caller runs only on a layer that declares conditions, and joins for a hop", () => {
    const without = { ...sql, layer: { capabilities: { adapter: "fake", capabilities: [] } } };
    const noJoins = { ...sql, layer: { capabilities: { adapter: "fake", capabilities: ["conditions"] } } };
    expect(() => callerQuery("billing.Invoice", computed, { filter: { doubled: { eq: 2 } } }, without)).toThrow("does not declare the conditions capability");
    expect(() => callerQuery("billing.Invoice", computed, { filter: { busy: { eq: true } } }, noJoins)).toThrow("does not declare the joins capability");
    expect(() => callerQuery("billing.Invoice", computed, { sort: ["busy"] }, noJoins)).toThrow("does not declare the joins capability");
    // What needs no SQL needs no capability: a stored filter and sort, and a condition that folded to a constant.
    expect(callerQuery("billing.Invoice", computed, { filter: { title: { eq: "a" } }, sort: ["title"] }, without).where).toBe(true);
    expect(callerQuery("billing.Invoice", computed, { filter: { always: { eq: false } } }, without).where).toBe(false);
  });
});
