import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LiteralNode } from "@meshfw/runtime";
import { lowerCondition, lowerSortKey, type LowerResult } from "../src/model/sql-condition.ts";
import { printTree } from "../src/typescript/expression-printer.ts";
import { invoice, project, type Built } from "./sql-fixture.ts";

// Lowering (M10, design section 3.2): a translated function in a SQL position as the condition literal the data adapter
// prints, each maximal record-independent subtree a parameter. The cases pin the literal and the parameters' source.

let fixture: Awaited<ReturnType<typeof project>>;
beforeAll(async () => { fixture = await project(); });
afterAll(() => fixture.close());

const col = (name: string, cls: string, depth = 0) => ({ kind: "column", depth, name, class: cls });
const param = (index: number, cls: string) => ({ kind: "param", index, class: cls });
const val = (value: unknown, cls: string) => ({ kind: "value", value, class: cls });
const call = (fn: string, ...args: unknown[]) => ({ kind: "call", fn, args });
const CUSTOMER = { table: "billing.Customer", column: "id", outer: "customerId", key: "id" };
const LINES = { table: "billing.Line", column: "invoiceId", outer: "id", key: "id" };
const INVOICES = { table: "billing.Invoice", column: "customerId", outer: "id", key: "id" };

/** Lower each filter in one build: the result per filter, and the parameters printed as the back end prints them. */
function lowered(filters: readonly string[], extra = ""): { built: Built; results: LowerResult[] } {
  const built = fixture.build(invoice(filters, extra));
  expect(built.diagnostics.filter((d) => d.severity === "error"), filters.join(" | ")).toEqual([]);
  const entity = built.entity("Invoice");
  return { built, results: entity.actions.filter((a) => a.filter).map((a) => lowerCondition(built.document!, entity, a.filter!)) };
}
const ok = (result: LowerResult) => {
  if (!result.ok) throw new Error(`not lowered: ${JSON.stringify(result.problems)}`);
  return result.lowered;
};

describe("lowerCondition", () => {
  // [filter, tree, the parameters as printed, the crossings' paths]
  const cases: [string, unknown, string[], string[]][] = [
    ["() => &total > 2", call("gt", col("total", "integer"), val(2, "integer")), [], []],
    // R11: `&customer.id` is the stored key, with no subquery.
    ["({ input }) => &customer.id === input.customerId", call("eq", col("customerId", "string"), param(0, "string")), ["$s.input?.customerId"], []],
    // A member of a belongs-to is read on its one row (a left join).
    ["({ actor }) => &customer.ownerId === actor.id", call("eq", { kind: "one", hop: CUSTOMER, value: col("ownerId", "string", 1) }, param(0, "string")), ["$s.actor?.id"], ["&customer.ownerId"]],
    // Two steps: belongs-to, then a nullable belongs-to, read with `?.`.
    ['() => &customer.region?.name === "eu"', call("eq", { kind: "one", hop: CUSTOMER, value: { kind: "one", hop: { table: "billing.Region", column: "id", outer: "regionId", key: "id" }, value: col("name", "string", 2) } }, val("eu", "string")), [], ["&customer.region.name"]],
    // A null test of a belongs-to reads its key; of a has-one, the key of its one row.
    ["() => &customer.region === null", call("isNull", { kind: "one", hop: CUSTOMER, value: col("regionId", "string", 1) }), [], ["&customer.region"]],
    ["() => &customer.profile !== null", call("isNotNull", { kind: "one", hop: CUSTOMER, value: { kind: "one", hop: { table: "billing.Profile", column: "customerId", outer: "id", key: "id" }, value: col("id", "string", 2) } }), [], ["&customer.profile"]],
    ["() => &customer.profile?.verified === true", call("eq", { kind: "one", hop: CUSTOMER, value: { kind: "one", hop: { table: "billing.Profile", column: "customerId", outer: "id", key: "id" }, value: col("verified", "boolean", 2) } }, val(true, "boolean")), [], ["&customer.profile.verified"]],
    ["() => &lines.length > 2", call("gt", { kind: "count", hop: LINES }, val(2, "integer")), [], ["&lines"]],
    // A quantifier's predicate reads the related row (depth 1) and the outer one (depth 0).
    ["() => &lines.some((l) => l.qty > &total)", { kind: "some", hop: LINES, where: call("gt", col("qty", "integer", 1), col("total", "integer")) }, [], ["&lines"]],
    ["() => &lines.every((l) => l.qty > 0)", { kind: "every", hop: LINES, where: call("gt", col("qty", "integer", 1), val(0, "integer")) }, [], ["&lines"]],
    ["() => &lines.find((l) => l.qty > 1)?.qty === 3", call("eq", { kind: "first", hop: LINES, where: call("gt", col("qty", "integer", 1), val(1, "integer")), value: col("qty", "integer", 1) }, val(3, "integer")), [], ["&lines"]],
    ["() => &lines.find((l) => l.qty > 1) !== null", call("isNotNull", { kind: "first", hop: LINES, where: call("gt", col("qty", "integer", 1), val(1, "integer")), value: col("id", "string", 1) }), [], ["&lines"]],
    ["() => &lines.filter((l) => l.qty > 1).length === 2", call("eq", { kind: "count", hop: LINES, where: call("gt", col("qty", "integer", 1), val(1, "integer")) }, val(2, "integer")), [], ["&lines"]],
    ["() => &lines.filter((l) => l.qty > 1).some((m) => m.qty < 9)", { kind: "some", hop: LINES, where: call("and", call("gt", col("qty", "integer", 1), val(1, "integer")), call("lt", col("qty", "integer", 1), val(9, "integer"))) }, [], ["&lines"]],
    // `filter(p).every(q)`: every element is either not kept or satisfies `q`.
    ["() => &lines.filter((l) => l.qty > 1).every((m) => m.qty < 9)", { kind: "every", hop: LINES, where: call("or", call("not", call("isTrue", call("gt", col("qty", "integer", 1), val(1, "integer")))), call("lt", col("qty", "integer", 1), val(9, "integer"))) }, [], ["&lines"]],
    // Through a link entity: the far rows whose key the link rows name.
    ['() => &tags.some((t) => t.name === "x")', { kind: "some", hop: { table: "billing.Tag", column: "id", outer: "id", key: "id", through: { table: "billing.InvoiceTag", entry: "invoiceId", exit: "tagId" } }, where: call("eq", col("name", "string", 1), val("x", "string")) }, [], ["&tags"]],
    // A translated computed field is inlined: `isLate` reads `%.today` (a parameter), `bigCustomer` a has-many of the customer.
    ["() => &isLate", call("lt", col("dueOn", "date"), param(0, "date")), ["$.today($s)"], []],
    ["() => &customer.bigCustomer && &isLate", call("and", { kind: "one", hop: CUSTOMER, value: call("gt", { kind: "count", hop: INVOICES }, val(2, "integer")) }, call("lt", col("dueOn", "date"), param(0, "date"))), ["$.today($s)"], ["&customer.bigCustomer"]],
    // `idiv` is the type pass's, and a parameter under arithmetic is integer only when both sides are.
    ["({ input }) => &total / input.n > 1", call("gt", call("idiv", col("total", "integer"), param(0, "integer")), val(1, "integer")), ["$s.input?.n"], []],
    ["({ input }) => &total + input.f > 1", call("gt", call("add", col("total", "integer"), param(0, "float")), val(1, "float")), ["$s.input?.f"], []],
    ["({ input }) => &total + input.n > 1", call("gt", call("add", col("total", "integer"), param(0, "integer")), val(1, "integer")), ["$s.input?.n"], []],
    // A maximal record-independent subtree is one parameter (O2(a)), `??` and `?:` included.
    ["({ input }) => (input.n ?? 0) === (&rate ?? 0)", call("eq", param(0, "float"), call("coalesce", col("rate", "float"), val(0, "float"))), ["$.coalesce($s.input?.n, () => 0)"], []],
    ["({ input }) => (&paid ? input.n : 0) > 1", call("gt", call("cond", col("paid", "boolean"), param(0, "integer"), val(0, "integer")), val(1, "integer")), ["$s.input?.n"], []],
    // An imported helper, `Mesh.isSystem` and a quantifier over a list of the caller are parameters (R10).
    ["() => &total > cutoff(2)", call("gt", col("total", "integer"), param(0, "integer")), ['$.pure(cutoff(2), "cutoff")'], []],
    ['({ actor }) => actor.roles.some((r) => r === "admin") || &paid', call("or", param(0, "boolean"), col("paid", "boolean")), ['$.some($s.actor?.roles, (l$r: any) => $.eq(l$r, "admin"))'], []],
    ["({ input }) => flag(input.n > 1) === &paid", call("eq", param(0, "boolean"), col("paid", "boolean")), ['$.pure(flag($.gt($s.input?.n, 1)), "flag")'], []],
    ["() => &status === :sent", call("eq", col("status", "string"), val("sent", "string")), [], []],
  ];
  test("each tree lowers to its literal, with its parameters and crossings", () => {
    const { results } = lowered(cases.map(([filter]) => filter));
    cases.forEach(([filter, tree, params, crossings], i) => {
      const result = ok(results[i]!);
      expect(result.tree as unknown, filter).toEqual(tree);
      expect(result.params.map((p) => printTree(p.tree)), filter).toEqual(params);
      expect(result.params.every((p) => p.from === "billing.Invoice"), filter).toBe(true);
      expect(result.crossings.map((c) => c.path), filter).toEqual(crossings);
      expect(result.imports, filter).toEqual([]);
    });
  });

  test("`Mesh.isSystem(context)` is a parameter", () => {
    const { results } = lowered(["({ context }) => Mesh.isSystem(context) || &paid"]);
    const result = ok(results[0]!);
    expect(result.tree as unknown).toEqual(call("or", param(0, "boolean"), col("paid", "boolean")));
    expect(result.params.map((p) => printTree(p.tree))).toEqual(["$.isSystem($s.context)"]);
  });

  test("a helper call inside another entity's inlined body is a parameter from that file, with its import", async () => {
    const more = {
      "billing/customer.mesh.mx": (await import("./sql-fixture.ts")).FILES["billing/customer.mesh.mx"]!
        .replace('import { Profile } from "./profile.mesh.mx"', 'import { Profile } from "./profile.mesh.mx"\nimport { cutoff as limit } from "./helpers"')
        .replace("    string :label()", "    boolean :rich() { return &invoices.length > limit(1) }\n    string :label()"),
    };
    const built = fixture.build(invoice(["() => &customer.rich"]), more);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const entity = built.entity("Invoice");
    const result = ok(lowerCondition(built.document!, entity, entity.actions[0]!.filter!));
    expect(result.tree as unknown).toEqual({ kind: "one", hop: CUSTOMER, value: call("gt", { kind: "count", hop: INVOICES }, param(0, "integer")) });
    expect(result.params.map((p) => [printTree(p.tree), p.from])).toEqual([['$.pure(limit(1), "limit")', "billing.Customer"]]);
    expect(result.imports).toEqual([{ name: "limit", module: "./helpers", file: "billing/customer.mesh.mx" }]);
  });

  test("`root` makes a function's parameter depth 0, and `mode: \"write\"` refuses a helper call", () => {
    const { built } = lowered(["() => true"]);
    const entity = built.entity("Invoice");
    const line = built.entity("Line");
    const at = line.position;
    const tree = { kind: "call", fn: "gt", position: at, args: [
      { kind: "member", object: { kind: "var", name: "line", position: at }, name: "qty", optional: false, position: at },
      { kind: "literal", value: 1, position: at }] } as const;
    const expression = { source: "(line) => line.qty > 1", params: ["line"], position: at, tree } as never;
    expect(ok(lowerCondition(built.document!, line, expression, { root: { param: "line" } })).tree as unknown).toEqual(call("gt", col("qty", "integer"), val(1, "integer")));
    const { built: helper, results } = lowered(["() => &total > cutoff(2)"]);
    expect(results[0]!.ok).toBe(true);
    const invoiceEntity = helper.entity("Invoice");
    const written = lowerCondition(helper.document!, invoiceEntity, invoiceEntity.actions[0]!.filter!, { mode: "write" });
    expect(written.ok ? [] : written.problems.map((p) => [p.kind, "callee" in p ? p.callee : ""])).toEqual([["write-call", "cutoff"]]);
  });
});

describe("what has no SQL form", () => {
  // A function in a SQL position that has none is a build error (sql-required.test.ts), so the build gives no model to
  // lower: each case is written as a computed body here, where it builds, and lowered as a filter would be.
  const problemsOf = (bodies: readonly string[], params = "", more: Record<string, string> = {}, entityName = "Invoice") => {
    const built = fixture.build(invoice([], "", bodies.map((body, i) => `    boolean :probe${i}(${params}) { return ${body} }\n`).join("")), more);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const entity = built.entity(entityName);
    return { built, results: bodies.map((_, i) => lowerCondition(built.document!, entity, entity.computed.find((c) => c.name === `probe${i}`)!.body!)) };
  };
  const kinds = (result: LowerResult) => (result.ok ? [] : result.problems.map((p) => p.kind));
  test("a plain computed field (directly and through another), a rollup, a foreign list, a json member", () => {
    const { built, results } = problemsOf([
      '&customer.label === "a!"',
      '&shout === "a!"',
      "&nLines > 2",
      "[&total].some((c) => c === 1)",
      "&customer.meta !== null",
      '&customer.label === "a" && &nLines > 1',
    ]);
    expect(results.map(kinds)).toEqual([["plain-computed"], ["plain-computed"], ["rollup"], ["plain"], ["json"], ["plain-computed", "rollup"]]);
    const [direct, through, rollup] = results as (LowerResult & { ok: false })[];
    expect(direct!.problems[0]).toMatchObject({ field: "customer.label", detail: "arithmetic on values that are not numbers" });
    expect(through!.problems[0]).toMatchObject({ field: "label of billing.Customer", through: "shout" });
    expect(rollup!.problems[0]).toMatchObject({ field: "nLines", fn: "count", relation: "lines" });
    // Reported at the read in the function, not inside the body it inlines.
    expect(through!.problems[0]!.position.offset).toBe(built.source.indexOf('&shout === "a!"'));
  });

  test("a quantifier over a list of the caller that reads the row is a foreign list", () => {
    const { results } = problemsOf(["context.ids.some((i) => i === &id)"], "{ context }");
    expect(results.map((r) => (r.ok ? [] : r.problems.map((p) => [p.kind, "op" in p ? p.op : ""])))).toEqual([[["foreign-list", "some"]]]);
  });

  test("a computed field that reaches itself through a relationship cannot be unfolded", () => {
    const built = fixture.build(invoice([]), { "billing/node.mesh.mx": FILES_NODE });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const entity = built.entity("Node");
    const result = lowerCondition(built.document!, entity, entity.computed.find((c) => c.name === "deep")!.body!);
    expect(result.ok ? [] : result.problems.map((p) => [p.kind, "field" in p ? p.field : ""])).toEqual([["self-reaching", "depth"]]);
  });
});

const FILES_NODE = `entity :Node
  attributes
    uuid :id primary-key
  relationships
    belongs-to :parent entity=Node nullable
  computed
    integer :depth() { return (&parent?.depth ?? -1) + 1 }
    boolean :deep() { return &depth > 2 }
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`;

describe("lowerSortKey", () => {
  test("an attribute is a column; a translated computed field its body; a plain one and a rollup are refused", () => {
    const built = fixture.build(invoice([], `    read :sorted
      sort
        desc &dueOn
        asc &isLate
`));
    const entity = built.entity("Invoice");
    const keys = entity.actions.find((a) => a.name === "sorted")!.sort!;
    // A key the build refuses is not in a built model: the last two are made by hand.
    const results = [...keys, ...["shout", "nLines"].map((name) => ({ direction: "asc" as const, member: { name, position: entity.position } }))]
      .map((key) => lowerSortKey(built.document!, entity, key));
    expect(ok(results[0]!).tree as LiteralNode).toEqual(col("dueOn", "date") as LiteralNode);
    expect(ok(results[1]!).tree as unknown).toEqual(call("lt", col("dueOn", "date"), param(0, "date")));
    expect(results.slice(2).map((r) => (r.ok ? "ok" : r.problems.map((p) => p.kind).join()))).toEqual(["plain-computed", "rollup"]);
  });
});
