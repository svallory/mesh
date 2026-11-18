import { describe, expect, test } from "bun:test";
import type { Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { newInstanceComputed, newInstanceGaps, newInstanceMembers } from "../src/model/new-instance.ts";
const target = `import { Invoice } from "./invoice.mesh.mx"
import { Line } from "./line.mesh.mx"
entity :Line
  attributes
    uuid :id primary-key
    integer :units
    decimal :amount
    string :title
    float :ratio
    boolean :done
    date :dueOn
    datetime :paidAt
    timestamp :createdAt on=:create
  relationships
    belongs-to :parent entity=Line
    belongs-to :invoice entity=Invoice nullable
  actions auto=[:read]
`;
function build(
  fn: string,
  path: string,
  relationship = "has-many :lines entity=Line",
) {
  const source = `import { Line } from "./line.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    decimal :amount
  relationships
    ${relationship}
  computed
    ${fn} :value of=&${path}
  actions auto=[:read]
`;
  return {
    source,
    result: buildModel({
      root: "/project",
      files: [
        { file: "billing/invoice.mesh.mx", source },
        { file: "billing/line.mesh.mx", source: target },
      ],
    }),
  };
}

test.each([
  ["count", "lines", "integer", false],
  ["max", "lines.units", "integer", true],
  ["max", "lines.amount", "decimal", true],
  ["max", "lines.dueOn", "date", true],
  ["max", "lines.paidAt", "datetime", true],
] as const)("%s of %s infers %s, nullable %s", (fn, path, type, nullable) => {
  const { result } = build(fn, path);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({
    type,
    nullable,
    rollup: { fn, of: path },
  });
});

// sum, avg and min build with the type and nullability of the spec's table: over a has-many they can reach no record.
test.each([
  ["sum", "lines.units", "integer"], ["sum", "lines.amount", "decimal"], ["avg", "lines.units", "decimal"], ["avg", "lines.amount", "decimal"],
  ["min", "lines.units", "integer"], ["min", "lines.amount", "decimal"], ["min", "lines.dueOn", "date"], ["min", "lines.paidAt", "datetime"],
] as const)("%s of %s builds as a nullable %s", (fn, path, type) => {
  const { result } = build(fn, path);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({ type, nullable: true, rollup: { fn, of: path } });
});

test.each([
  ["sum", "lines.ratio", "a number", "float"], ["sum", "lines.createdAt", "a number", "timestamp"], ["avg", "lines.title", "a number", "string"],
  ["sum", "lines.done", "a number", "boolean"], ["min", "lines.createdAt", "a number, date or datetime", "timestamp"], ["min", "lines.title", "a number, date or datetime", "string"],
] as const)("%s of %s is MESH_ROLLUP_TYPE", (fn, path, needs, type) => {
  const { result } = build(fn, path);
  expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_ROLLUP_TYPE", message: `${fn} needs ${needs}, &${path.split(".")[1]} is :${type}` })]);
});

// One belongs-to hop is one table (`select id, max(units) from lines where id in (...) group by id`): no join, so it
// builds. It reaches exactly one record when the belongs-to and the attribute are both required, so it is not nullable then.
test.each([
  ["max", "lines.units", "belongs-to :lines entity=Line", "integer", false],
  ["sum", "lines.amount", "belongs-to :lines entity=Line", "decimal", false],
  ["min", "lines.dueOn", "belongs-to :lines entity=Line", "date", false],
  ["avg", "lines.units", "belongs-to :lines entity=Line", "decimal", false],
  ["max", "lines.units", "belongs-to :lines entity=Line nullable", "integer", true],
  ["count", "lines", "belongs-to :lines entity=Line", "integer", false],
  ["count", "lines", "belongs-to :lines entity=Line nullable", "integer", false],
  ["max", "lines.units", "has-one :lines entity=Line", "integer", true],
  ["sum", "lines.units", "has-one :lines entity=Line", "integer", true],
] as const)("%s of %s over %s builds as %s, nullable %p", (fn, path, relationship, type, nullable) => {
  const { result } = build(fn, path, relationship);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({ type, nullable, rollup: { fn, of: path } });
});

test("a rollup over one belongs-to is nullable when the attribute is", () => {
  const { result } = build("max", "lines.units", "belongs-to :lines entity=Line");
  expect(result.document!.entities[0]!.computed[0]!.nullable).toBe(false);
  const optional = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source: build("max", "lines.units", "belongs-to :lines entity=Line").source },
    { file: "billing/line.mesh.mx", source: target.replace("integer :units", "integer :units nullable") },
  ] });
  expect(optional.diagnostics).toEqual([]);
  expect(optional.document!.entities[0]!.computed[0]).toMatchObject({ type: "integer", nullable: true });
});

// A path through more than one relationship builds (it runs as a join, which needs the adapter's joins capability):
// its type and nullability come from the path, nullable as soon as one hop is a has-many, a has-one or a nullable
// belongs-to.
test.each([
  ["max", "lines.parent.dueOn", "has-many :lines entity=Line", "date", true],
  ["count", "lines.parent", "has-many :lines entity=Line", "integer", false],
  ["sum", "lines.invoice.amount", "has-many :lines entity=Line", "decimal", true],
  ["count", "lines.parent", "belongs-to :lines entity=Line", "integer", false],
  ["max", "lines.parent.units", "belongs-to :lines entity=Line", "integer", false],
  ["min", "lines.invoice.amount", "belongs-to :lines entity=Line", "decimal", true],
  ["avg", "lines.parent.parent.units", "belongs-to :lines entity=Line", "decimal", false],
] as const)("%s of %s over %s builds as %s, nullable %p", (fn, path, relationship, type, nullable) => {
  const { result } = build(fn, path, relationship);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({ type, nullable, rollup: { fn, of: path } });
});

// Every has-many or has-one on the path must say which belongs-to back it follows, the later ones too.
describe("a later has-many on the path whose target has several belongs-to back", () => {
  const line = target.replace("    belongs-to :invoice entity=Invoice nullable\n", "    belongs-to :invoice entity=Invoice nullable\n    has-many :children entity=Line\n");
  const builtWith = (lineSource: string, path = "lines.children.units", relationship = "belongs-to :lines entity=Line") => buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source: build("sum", path, relationship).source },
    { file: "billing/line.mesh.mx", source: lineSource },
  ] });
  test("is MESH_INVERSE_REQUIRED at the rollup, naming the entity it is declared on", () => {
    const twoBack = line.replace("    belongs-to :parent entity=Line\n", "    belongs-to :parent entity=Line\n    belongs-to :mentor entity=Line nullable\n");
    const result = builtWith(twoBack);
    const atRollup = result.diagnostics.filter((d) => d.position.file === "billing/invoice.mesh.mx");
    expect(atRollup).toEqual([{
      severity: "error",
      code: "MESH_INVERSE_REQUIRED",
      message: "sum :value reads has-many :children of billing.Line, which cannot be loaded: billing.Line has 2 belongs-to back to billing.Line (:parent, :mentor) and has-many :children does not say which it follows",
      position: expect.objectContaining({ line: 9 }),
      fix: "Choose one: `inverse=:parent`",
    }]);
    // The declaration's own error stays where it is.
    expect(result.diagnostics.filter((d) => d.position.file === "billing/line.mesh.mx").map((d) => d.code)).toEqual(["MESH_INVERSE_REQUIRED"]);
    // Chosen, it builds.
    expect(builtWith(twoBack.replace("has-many :children entity=Line", "has-many :children entity=Line inverse=:parent")).diagnostics).toEqual([]);
  });
  test("one belongs-to back builds; none is the declaration's MESH_NO_INVERSE alone", () => {
    expect(builtWith(line).diagnostics).toEqual([]);
    const none = builtWith(line.replace("has-many :children entity=Line", "has-many :children entity=Invoice"), "lines.children.amount", "has-many :lines entity=Line");
    expect(none.diagnostics.map((d) => [d.code, d.position.file])).toEqual([["MESH_NO_INVERSE", "billing/line.mesh.mx"]]);
  });
});

test("a rollup over a relationship that nothing points back at is the one MESH_NO_INVERSE, at the has-many line", () => {
  const source = `import { Line } from "./line.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lines entity=Line\n  computed\n    count :lineCount of=&lines\n`;
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: "entity :Line\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
  ] });
  expect(result.diagnostics).toEqual([expect.objectContaining({
    code: "MESH_NO_INVERSE",
    message: "has-many :lines of billing.Invoice needs a belongs-to back, and billing.Line has none to billing.Invoice: add `belongs-to :invoice entity=Invoice` to billing.Line",
    position: expect.objectContaining({ line: 6 }),
  })]);
  // Nothing reading it changes nothing: the error is the relationship's.
  const unused = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source: source.replace('  computed\n    count :lineCount of=&lines\n', "") },
    { file: "billing/line.mesh.mx", source: "entity :Line\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
  ] });
  expect(unused.diagnostics.map((d) => d.code)).toEqual(["MESH_NO_INVERSE"]);
});

test.each([
  [
    "count",
    "amount",
    "MESH_ROLLUP_PATH",
    "&amount is an attribute, not a relationship",
  ],
  [
    "sum",
    "amount.units",
    "MESH_ROLLUP_PATH",
    "&amount is an attribute, not a relationship",
  ],
  [
    "sum",
    "lines",
    "MESH_ROLLUP_PATH",
    "&lines is a relationship, not an attribute",
  ],
  [
    "sum",
    "lines.title",
    "MESH_ROLLUP_TYPE",
    "sum needs a number, &title is :string",
  ],
  [
    "sum",
    "lines.ratio",
    "MESH_ROLLUP_TYPE",
    "sum needs a number, &ratio is :float",
  ],
  [
    "avg",
    "lines.dueOn",
    "MESH_ROLLUP_TYPE",
    "avg needs a number, &dueOn is :date",
  ],
  [
    "min",
    "lines.done",
    "MESH_ROLLUP_TYPE",
    "min needs a number, date or datetime, &done is :boolean",
  ],
  // A timestamp is not an operand of min or max (integer, decimal, date and datetime are), even though it is stored like a datetime.
  [
    "max",
    "lines.createdAt",
    "MESH_ROLLUP_TYPE",
    "max needs a number, date or datetime, &createdAt is :timestamp",
  ],
  // The type is checked before what is built: a min over a timestamp is the type error, not MESH_NOT_IMPLEMENTED.
  [
    "min",
    "lines.createdAt",
    "MESH_ROLLUP_TYPE",
    "min needs a number, date or datetime, &createdAt is :timestamp",
  ],
  [
    "max",
    "lines.ratio",
    "MESH_ROLLUP_TYPE",
    "max needs a number, date or datetime, &ratio is :float",
  ],
  [
    "count",
    "linnes",
    "MESH_UNKNOWN_MEMBER",
    "&linnes is not a member of billing.Invoice. Did you mean &lines?",
  ],
  [
    "sum",
    "lines.amunt",
    "MESH_UNKNOWN_MEMBER",
    "&amunt is not a member of billing.Line. Did you mean &amount?",
  ],
] as const)("rejects %s of %s with %s", (fn, path, code, message) => {
  const { source, result } = build(fn, path);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  expect(diagnostic).toMatchObject({
    code,
    message,
    position: { file: "billing/invoice.mesh.mx", line: 9 },
  });
  const member = /&([A-Za-z]+)/.exec(message)![1]!;
  expect(diagnostic.position.offset).toBe(
    source.indexOf(`of=&${path}`) + 3 + (path.indexOf(member) === 0 ? 0 : 1 + path.indexOf(member)),
  );
});

test.each([
  ["has-one :lines entity=Line", true],
  ["has-many :lines entity=Line", true],
] as const)("rollup nullability follows %s", (relationship, nullable) => {
  const { result } = build("max", "lines.amount", relationship);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({ nullable });
  const count = build("count", "lines", relationship).result;
  expect(count.diagnostics).toEqual([]);
  expect(count.document!.entities[0]!.computed[0]).toMatchObject({
    nullable: false,
  });
});

// A path that follows an entity's own has-many twice is a joined route over one table: it builds as any other.
test.each([
  ["count :n of=&replies.replies", "integer", false],
  ["sum :n of=&replies.replies.score", "integer", true],
] as const)("a self-referencing path %s builds as %s", (line, type, nullable) => {
  const source = `entity :Post
  attributes
    uuid :id primary-key
    integer :score
  relationships
    belongs-to :parent entity=Post nullable
    has-many :replies entity=Post
  computed
    ${line}
  actions auto=[:read]
`;
  const result = buildModel({ root: "/project", files: [{ file: "talk/post.mesh.mx", source }] });
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({ type, nullable });
});

// `of=` is a member reference. The string form is one build error, with the fix in the message.
test.each([
  ["count", "lines", "of=&lines"],
  ["max", "lines.amount", "of=&lines.amount"],
  ["sum", "lines.amount", "of=&lines.amount"],
] as const)("%s of the string %s is an error that says to write %s", (fn, path, fix) => {
  const source = `import { Line } from "./line.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lines entity=Line\n  computed\n    ${fn} :value of="${path}"\n  actions auto=[:read]\n`;
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: target },
  ] });
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    code: "MESH_ROLLUP_PATH_STRING",
    message: expect.stringContaining(`write ${fix}`),
    position: { file: "billing/invoice.mesh.mx", line: 8 },
  });
});

test.each([
  ["a computed index", "&lines[0]", "MESH_ROLLUP_PATH"],
  ["a call", "&lines.amount()", "MESH_ROLLUP_PATH"],
  ["a plain name", "lines", "MESH_ROLLUP_PATH"],
  ["an atom", ":lines", "MESH_ROLLUP_PATH"],
] as const)("of= with %s is not a member reference: %s", (_, written, code) => {
  const source = `import { Line } from "./line.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lines entity=Line\n  computed\n    max :value of=${written}\n  actions auto=[:read]\n`;
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: target },
  ] });
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => [d.code, d.position.line, d.position.column])).toEqual([[code, 8, 15]]);
});

test.each([
  ["a space before the dot", "&lines .amount"],
  ["a space after the dot", "&lines. amount"],
  ["spaces on both sides of the dot", "&lines . amount"],
  ["a comment before the dot", "&lines/**/.amount"],
  ["a comment after the dot", "&lines./* c */amount"],
  ["a comment after the path", "&lines.amount /* c */"],
  // Not ruled (D11): a parenthesised path builds, as it did before.
  ["parentheses around the path", "(&lines.amount)"],
] as const)("of= with %s is the same member path", (_, written) => {
  const source = `import { Line } from "./line.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lines entity=Line\n  computed\n    max :value of=${written}\n  actions auto=[:read]\n`;
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: target },
  ] });
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities.find((e) => e.name === "Invoice")!.computed[0]!.rollup).toEqual({ fn: "max", of: "lines.amount" });
});

test("a count's path may hold whitespace and comments too", () => {
  const source = `import { Line } from "./line.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lines entity=Line\n  computed\n    count :value of=&lines /* all */\n  actions auto=[:read]\n`;
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: target },
  ] });
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities.find((e) => e.name === "Invoice")!.computed[0]!.rollup).toEqual({ fn: "count", of: "lines" });
});

test("a rollup keeps its path as text in the model, so generated code is unchanged", () => {
  const { result } = build("max", "lines.amount");
  expect(result.document!.entities[0]!.computed[0]!.rollup).toEqual({ fn: "max", of: "lines.amount" });
});

test("the entity a rollup reads needs a read like any relationship's target: the error is the relationship's, not the rollup's", () => {
  const { source } = build("count", "lines");
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: target.replace("  actions auto=[:read]\n", "") },
  ] });
  expect(result.document).toBeNull();
  // Invoice's has-many reaches Line, and so does Line's own belongs-to; Invoice has its auto read.
  expect(result.diagnostics.map((d) => [d.code, d.position.file, d.position.line, d.message])).toEqual([
    ["MESH_ON_LOAD", "billing/invoice.mesh.mx", 7, "has-many :lines of billing.Invoice reaches billing.Line, which has neither `on:load=` nor an auto read, so Mesh has no read to load it with"],
    ["MESH_ON_LOAD", "billing/line.mesh.mx", 15, "belongs-to :parent of billing.Line reaches billing.Line, which has neither `on:load=` nor an auto read, so Mesh has no read to load it with"],
  ]);
});

// A read policy that reads the record is folded into a caller's load of every rollup that reaches its entity: the per-row
// count and max take its condition, and the batched rollup takes it on the entity's table of the route. So every function
// over every route builds under one.
describe("a rollup over an entity whose read policy reads the record", () => {
  const policed = (policy: string) => target.replace("  actions auto=[:read]\n", `  actions auto=[:read]\n  policies\n    ${policy}\n`);
  const builtWith = (fn: string, path: string, relationship: string, policy: string) => buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source: build(fn, path, relationship).source },
    { file: "billing/line.mesh.mx", source: policed(policy) },
  ] });
  const recordReading = "policy :open types=[:read]\n      authorize-if=() => &done === false";
  test.each([
    ["count", "lines", "has-many :lines entity=Line", recordReading],
    ["max", "lines.units", "has-one :lines entity=Line", recordReading],
    ["sum", "lines.units", "has-many :lines entity=Line", recordReading],
    ["avg", "lines.units", "has-many :lines entity=Line", recordReading],
    ["min", "lines.dueOn", "has-one :lines entity=Line", recordReading],
    ["max", "lines.units", "belongs-to :lines entity=Line", recordReading],
    ["count", "lines", "belongs-to :lines entity=Line", recordReading],
    // A joined route, whose every table is the policed entity's.
    ["count", "lines.parent", "has-many :lines entity=Line", recordReading],
    ["max", "lines.parent.units", "has-many :lines entity=Line", recordReading],
    ["sum", "lines.parent.units", "belongs-to :lines entity=Line", recordReading],
    ["sum", "lines.units", "has-many :lines entity=Line", "policy :staff types=[:read]\n      authorize-if=({ actor }) => actor.staff === true"],
    // A policy that does not cover the read a load runs is not run by the load.
    ["sum", "lines.units", "has-many :lines entity=Line", "policy :edit types=[:update]\n      authorize-if=() => &done === false"],
  ] as const)("%s of %s over %s under %s builds", (fn, path, relationship, policy) => {
    expect(builtWith(fn, path, relationship, policy).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

// On a create's new instance a required belongs-to has no key yet, so a rollup over it reaches nothing until the input
// fills the key: Mesh gives it no value (`null`), and the build treats it like any field null on the new instance.
describe("a rollup over a required belongs-to on a create's new instance", () => {
  const invoice = (computed: string, relationship = "belongs-to :lines entity=Line", extra = "") => `import { Line } from "./line.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
  relationships
    ${relationship}
  computed
    ${computed}
  actions auto=[:read]
    create :make
      input
        &lines${extra}
`;
  const entityOf = (source: string) => {
    const result = buildModel({ root: "/project", files: [{ file: "billing/invoice.mesh.mx", source }, { file: "billing/line.mesh.mx", source: target }] });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return { result, entity: result.document!.entities.find((e) => e.name === "Invoice")! };
  };
  const nullOnNew = (entity: Entity) => newInstanceComputed(entity, new Set(newInstanceMembers(newInstanceGaps(entity), true)));
  test.each(["max :value of=&lines.units", "sum :value of=&lines.amount", "min :value of=&lines.dueOn", "max :value of=&lines.parent.units"])("%s is null on the new instance", (computed) => {
    expect(nullOnNew(entityOf(invoice(computed)).entity)).toEqual(["value"]);
  });
  test("a count over it (0 or 1) and a rollup over a has-many are not tainted, nor one over a nullable belongs-to", () => {
    expect(nullOnNew(entityOf(invoice("count :value of=&lines")).entity)).toEqual([]);
    expect(nullOnNew(entityOf(invoice("sum :value of=&lines.units", "has-many :lines entity=Line").replace("      input\n        &lines\n", "")).entity)).toEqual([]);
    expect(nullOnNew(entityOf(invoice("max :value of=&lines.units", "belongs-to :lines entity=Line nullable")).entity)).toEqual([]);
  });
  test("a computed body that reads such a rollup is null on the new instance too", () => {
    expect(nullOnNew(entityOf(invoice("max :value of=&lines.units\n    integer :next() { return &value + 1 }")).entity)).toEqual(["value", "next"]);
  });
  test("a create's check that compares it is warned as a member nothing has filled", () => {
    const { result } = entityOf(invoice("max :value of=&lines.units", undefined, "\n      validate\n        check :rated that=() => &value > 3 code=\"low\" message=\"low\""));
    expect(result.diagnostics.map((d) => d.code)).toContain("MESH_VALIDATE_UNFILLED");
  });
});

test("a rollup whose path crosses into a file that did not build names the entity as not in the model, beside that file's error", () => {
  const { source } = build("max", "lines.units");
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: target.replace("    integer :units\n", "    integer :units\n    mystery :x\n") },
  ] });
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => [d.code, d.position.file, d.position.line, d.message])).toEqual([
    ["MESH_UNKNOWN_ENTITY", "billing/invoice.mesh.mx", 9, "Imported entity Line is not in the model"],
    ["MESH_UNKNOWN_TAG", "billing/line.mesh.mx", 7, "`mystery` is not a known tag in the `mesh` dialect"],
  ]);
});
