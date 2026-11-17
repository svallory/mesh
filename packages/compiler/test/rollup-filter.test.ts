import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic, ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { capabilityDiagnostics } from "../src/capabilities.ts";
import { loadView } from "../src/typescript/views/load.ts";
import { expressionsView, hasExpressions } from "../src/typescript/views/expressions.ts";
import { configOf } from "./generated.ts";

/**
 * `filter=(line) => ...` on a rollup line (unit m10-rollups, PR 4; design notes/architecture/m10-rollups-design.md R17-R21,
 * ruling D33): the contract's parameter rule, the model, what the filter may read, its SQL form and what is generated.
 */
const line = `import { Invoice } from "./invoice.mesh.mx"
import { Product } from "./product.mesh.mx"
entity :Line
  attributes
    uuid :id primary-key
    integer :units
    decimal :amount
    enum :state values=[:open, :closed]
    date :dueOn
    json :data
  relationships
    belongs-to :invoice entity=Invoice
    belongs-to :product entity=Product nullable
  computed
    boolean :big() { return &units > 10 }
  actions auto=[:read]
`;
const product = `import { Line } from "./line.mesh.mx"
entity :Product
  attributes
    uuid :id primary-key
    decimal :price
    boolean :active
  relationships
    has-many :lines entity=Line
  actions auto=[:read]
`;
const invoice = (computed: string, imports = "") => `${imports}import { Line } from "./line.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    integer :limit
  relationships
    has-many :lines entity=Line
  computed
    ${computed}
  actions auto=[:read]
`;
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function build(computed: string, imports = "", root = "/project") {
  return buildModel({
    root,
    files: [
      { file: "billing/invoice.mesh.mx", source: invoice(computed, imports) },
      { file: "billing/line.mesh.mx", source: line },
      { file: "billing/product.mesh.mx", source: product },
    ],
  });
}
const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.code, d.message]);
const errors = (diagnostics: readonly Diagnostic[]) => diagnostics.filter((d) => d.severity === "error");
const rollupOf = (document: ModelDocument | null | undefined, name = "n") =>
  document!.entities.find((entity) => entity.name === "Invoice")!.computed.find((c) => c.name === name)!.rollup!;

describe("the contract", () => {
  test("filter= with one identifier parameter builds, on every rollup function", () => {
    for (const computed of [
      "count :n of=&lines filter=(line) => line.state === :open",
      "sum :n of=&lines.amount filter=(line) => line.state === :open",
      "avg :n of=&lines.units filter=(line) => line.units > 1",
      "min :n of=&lines.dueOn filter=(line) => line.state !== :closed",
      "max :n of=&lines.amount filter=(l) => l.amount > 0 && l.units < 5",
    ]) expect([computed, codes(build(computed).diagnostics)]).toEqual([computed, []]);
  });

  test.each([
    ["() => true", "`count`: filter takes one parameter, the record the path reaches: write filter=(<name>) => ..."],
    ["({ self }) => self.units > 1", "`count`: filter takes one parameter, the record the path reaches: write filter=(<name>) => ..."],
    ["(...rest) => true", "`count`: filter takes one parameter, the record the path reaches: write filter=(<name>) => ..."],
    ["(l = 1) => true", "`count`: filter takes one parameter, the record the path reaches: write filter=(<name>) => ..."],
    ["(self) => self.units > 1", "`count`: filter's parameter is the record the path reaches, and `self` is a scope name: call it after the record, filter=(line) => ..."],
    ["(input) => input.units > 1", "`count`: filter's parameter is the record the path reaches, and `input` is a scope name: call it after the record, filter=(line) => ..."],
  ])("filter=%s is MESH_ROLLUP_FILTER at the parameter list", (fn, message) => {
    const source = `count :n of=&lines filter=${fn}`;
    const { diagnostics } = build(source);
    expect(codes(diagnostics)).toEqual([["MESH_ROLLUP_FILTER", message]]);
    // At the parameters (or the empty list), not the line.
    const text = invoice(source);
    expect(diagnostics[0]!.position.offset).toBeGreaterThan(text.indexOf("filter="));
    expect(diagnostics[0]!.position.offset).toBeLessThan(text.indexOf("=>", text.indexOf("filter=")));
  });

  test("two parameters is MESH_EXPRESSION, as a function with a second parameter is anywhere; a string is MESH_OPTION_VALUE, as on a read", () => {
    expect(codes(build("count :n of=&lines filter=(a, b) => true").diagnostics))
      .toEqual([["MESH_EXPRESSION", "`count`: filter takes one parameter, the record the path reaches, and this function has 2"]]);
    // A string is refused as on a read's `filter=`: the option's type is a function.
    expect(codes(build('count :n of=&lines filter="x"').diagnostics)).toEqual([["MESH_OPTION_VALUE", "`count`: option `filter` must be function, got string"]]);
    const read = buildModel({ root: "/project", files: [{ file: "t.mesh.mx", source: 'entity :T\n  attributes\n    uuid :id primary-key\n  actions\n    read :x filter="x"\n' }] });
    expect(read.diagnostics.map((d) => d.code)).toEqual(["MESH_OPTION_VALUE"]);
  });
});

describe("the model", () => {
  test("the filter is carried with its parameter and its tree; a rollup without one is exactly { fn, of }", () => {
    const { document, diagnostics } = build("count :n of=&lines filter=(line) => line.state === :open\n    count :all of=&lines");
    expect(diagnostics).toEqual([]);
    const filter = rollupOf(document).filter!;
    expect(filter).toMatchObject({ param: "line", source: "(line) => line.state === :open", params: [] });
    expect(filter.tree).toMatchObject({ kind: "call", fn: "eq" });
    expect("rest" in filter || "takesScope" in filter).toBe(false);
    expect(rollupOf(document, "all")).toEqual({ fn: "count", of: "lines" });
  });
});

describe("what the filter may read", () => {
  test("stored columns, a belongs-to's key column, atoms, literals, %.now and %.today, and the registry's functions build", () => {
    for (const fn of [
      '(line) => line.productId === "x"',
      "(line) => line.productId !== null && line.dueOn < %.today",
      "(line) => (line.units ?? 0) + 1 > 2 || !(line.amount > 3)",
      "(line) => line.state === :open ? line.units > 1 : false",
    ]) expect([fn, codes(build(`count :n of=&lines filter=${fn}`).diagnostics)]).toEqual([fn, []]);
    // A two-hop path filters the far entity: the parameter is a Product.
    expect(codes(build("count :n of=&lines.product filter=(p) => p.active === true && p.price > 1").diagnostics)).toEqual([]);
  });

  const fix = "compare columns of line with literals, atoms, %.now or %.today";
  test.each([
    ["(line) => line.units > &limit", "the filter of count :n reads &limit; it reads only line, the billing.Line the path reaches, and fixed values"],
    ["(line) => line.units > input.x", "the filter of count :n reads input; it reads only line, the billing.Line the path reaches, and fixed values"],
    ["(line) => line.units > actor.id", "the filter of count :n reads actor; it reads only line, the billing.Line the path reaches, and fixed values"],
    ["(line) => line.units > context.x", "the filter of count :n reads context; it reads only line, the billing.Line the path reaches, and fixed values"],
    ["(line) => before === null", "the filter of count :n reads before; it reads only line, the billing.Line the path reaches, and fixed values"],
    ["(line) => line.invoice.limit > 1", "the filter of count :n reads line.invoice, a relationship of billing.Line; it reads only stored columns of line"],
    ["(line) => line.big === true", "the filter of count :n reads line.big, a computed field of billing.Line; it reads only stored columns of line"],
  ])("filter=%s is MESH_ROLLUP_FILTER", (fn, message) => {
    const diagnostics = errors(build(`count :n of=&lines filter=${fn}`).diagnostics);
    expect(diagnostics.map((d) => [d.code, d.message, d.fix])).toEqual([["MESH_ROLLUP_FILTER", message, fix]]);
  });

  test("a helper call is MESH_ROLLUP_FILTER at the call", () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-rollup-filter-"));
    roots.push(root);
    writeFileSync(join(root, "open.ts"), "export const isOpen = (state: string | null): boolean => state === \"open\";\nexport const most = (): number => 3;\n");
    const imports = 'import { isOpen, most } from "../open"\n';
    // Handed the record, the call leaves the function plain; handed nothing, it is a call in the tree: both are the filter's error.
    const handed = errors(build("count :n of=&lines filter=(line) => isOpen(line.state)", imports, root).diagnostics);
    expect(handed.map((d) => [d.code, d.message])).toEqual([["MESH_ROLLUP_FILTER", "the filter of count :n calls isOpen; it reads only line and fixed values"]]);
    const fixed = errors(build("count :n of=&lines filter=(line) => line.units > most()", imports, root).diagnostics);
    expect(fixed.map((d) => [d.code, d.message])).toEqual([["MESH_ROLLUP_FILTER", "the filter of count :n calls most; it reads only line and fixed values"]]);
  });

  test("a name the record does not have is MESH_UNKNOWN_MEMBER", () => {
    const diagnostics = errors(build("count :n of=&lines filter=(line) => line.colour === 1").diagnostics);
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([["MESH_UNKNOWN_MEMBER", "line.colour: `colour` is not a member of billing.Line"]]);
  });

  test("an atom that is no value of the enum is the type pass's error, as anywhere", () => {
    expect(errors(build("count :n of=&lines filter=(line) => line.state === :lost").diagnostics).map((d) => d.code)).toEqual(["MESH_EXPR_UNKNOWN_ATOM"]);
  });

  test("a json column compared is MESH_FILTER_TYPE", () => {
    expect(codes(errors(build("count :n of=&lines filter=(line) => line.data === null").diagnostics)))
      .toEqual([["MESH_FILTER_TYPE", "line.data is :json, which a filter cannot use: the database does not look inside it"]]);
  });

  test("a filter Mesh does not translate is MESH_EXPR_NOT_SQL: it runs only as SQL", () => {
    const diagnostics = errors(build("count :n of=&lines filter=(line) => { return line.units > 1 }").diagnostics);
    expect(diagnostics.map((d) => d.code)).toEqual(["MESH_EXPR_NOT_SQL"]);
    expect(diagnostics[0]!.message).toStartWith("the filter of count :n of billing.Invoice must run as SQL, and Mesh does not translate it (");
  });

  test("the neighbour stays legal: a body that filters the loaded list", () => {
    expect(errors(build("integer :n() { return &lines.filter((l) => l.state === :open).length }").diagnostics)).toEqual([]);
  });
});

describe("the data adapter", () => {
  const adapter = (capabilities: string[]) => ({ name: "fake", capabilities: { adapter: "fake", capabilities } }) as never;
  test("a filter runs as SQL, so it needs conditions; a filter-less rollup does not", () => {
    const { document } = build("count :n of=&lines filter=(line) => line.units > 1\n    count :all of=&lines");
    expect(codes(capabilityDiagnostics(document!, adapter(["aggregates"])))).toEqual([[
      "MESH_CAPABILITY",
      'the filter of count :n of billing.Invoice runs as SQL, and the data adapter "fake" does not declare the conditions capability, so it would ignore the condition',
    ]]);
    expect(capabilityDiagnostics(document!, adapter(["aggregates", "conditions"]))).toEqual([]);
  });
});

describe("what is generated", () => {
  const config = configOf("/project", "generated");
  test("the plan carries the filter as a thunk over $conditions; the literal reads the last entity's rows", () => {
    const { document } = build("count :n of=&lines filter=(line) => line.state === :open && line.dueOn < %.now\n    count :all of=&lines");
    const view = loadView({ document: document!, config }, "generated/load.ts");
    const entry = view.entities.find((entity) => entity.nameLiteral === '"billing.Invoice"')!;
    expect(entry.computed).toEqual([
      { key: "n", plan: '{ kind: "rollup", fn: "count", of: ["lines"], filter: () => $billing$Invoice$conditions["rollup.n.filter"] }' },
      { key: "all", plan: '{ kind: "rollup", fn: "count", of: ["lines"] }' },
    ]);
    expect(view.expressionImports).toEqual([
      { local: "$billing$Invoice$expressions", fromLiteral: '"./domain/billing/invoice.expressions"', conditions: "$billing$Invoice$conditions" },
      { local: "$billing$Line$expressions", fromLiteral: '"./domain/billing/line.expressions"', conditions: null },
    ]);
    const invoiceEntity = document!.entities.find((entity) => entity.name === "Invoice")!;
    expect(hasExpressions(invoiceEntity)).toBe(true);
    const expressions = expressionsView({ document: document!, config }, invoiceEntity, "generated/domain/billing/invoice.expressions.ts");
    expect(expressions.entries).toEqual([]);
    expect(expressions.conditions).toHaveLength(1);
    const [literal] = expressions.conditions;
    expect(literal!.key).toBe('"rollup.n.filter"');
    expect(literal!.code).toStartWith('{ what: "the filter of count :n of billing.Invoice", entity: "billing.Line", tree: ');
    // `%.now` is the one parameter, computed in memory; no source position is printed.
    expect(literal!.code).toEndWith("params: ($s: $billing$Invoice$Scope) => [$.now($s)] }");
    expect(literal!.code).not.toContain("position");
  });
});
