import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
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
    ${fn} :value of="${path}"
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
  ["max", "lines.amount", "decimal", true],
  ["max", "lines.dueOn", "date", true],
  ["max", "lines.createdAt", "timestamp", true],
] as const)("%s of %s infers %s, nullable %s", (fn, path, type, nullable) => {
  const { result } = build(fn, path);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({
    type,
    nullable,
    rollup: { fn, of: path },
  });
});

// sum, avg and min are valid, typed and not built: the build says so, naming when (ADR-0018).
test.each([
  ["sum", "lines.units"], ["sum", "lines.amount"], ["avg", "lines.units"], ["avg", "lines.amount"],
  ["min", "lines.units"], ["min", "lines.paidAt"], ["min", "lines.createdAt"],
] as const)("%s of %s is not implemented yet, and the build says when", (fn, path) => {
  const { result } = build(fn, path);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([expect.objectContaining({
    code: "MESH_NOT_IMPLEMENTED",
    message: `${fn} rollups are not implemented yet: only count and max run before Mesh 1.0; sum, avg and min come after it`,
  })]);
});

// A path through a belongs-to or through more than one relationship needs a join, which is M10.
test.each([
  ["max", "lines.parent.dueOn", "more than one relationship"],
  ["count", "lines.parent", "more than one relationship"],
] as const)("%s of %s needs a join: a build error that names M10", (fn, path, what) => {
  const { result } = build(fn, path);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([expect.objectContaining({
    code: "MESH_NOT_IMPLEMENTED",
    message: expect.stringContaining(`goes through ${what}, which needs a join; joins arrive with the SQL evaluator (M10)`),
  })]);
});

test("a rollup through a belongs-to needs a join too", () => {
  const { result } = build("count", "lines", "belongs-to :lines entity=Line");
  expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_NOT_IMPLEMENTED", message: expect.stringContaining("goes through a belongs-to") })]);
});

test("a rollup over a relationship that nothing points back at cannot be loaded, and the build says so", () => {
  const source = `import { Line } from "./line.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lines entity=Line\n  computed\n    count :lineCount of="lines"\n`;
  const result = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source },
    { file: "billing/line.mesh.mx", source: "entity :Line\n  attributes\n    uuid :id primary-key\n" },
  ] });
  expect(result.diagnostics).toEqual([expect.objectContaining({
    code: "MESH_NO_INVERSE",
    message: "count :lineCount reads has-many :lines, which cannot be loaded: :Line has no belongs-to back to :Invoice",
  })]);
  // The same relationship with nothing that reads it builds.
  const unused = buildModel({ root: "/project", files: [
    { file: "billing/invoice.mesh.mx", source: source.replace('  computed\n    count :lineCount of="lines"\n', "") },
    { file: "billing/line.mesh.mx", source: "entity :Line\n  attributes\n    uuid :id primary-key\n" },
  ] });
  expect(unused.diagnostics).toEqual([]);
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
    "min needs a number, date, datetime or timestamp, &done is :boolean",
  ],
  [
    "count",
    "linnes",
    "MESH_UNKNOWN_MEMBER",
    "&linnes is not a member of :Invoice. Did you mean &lines?",
  ],
  [
    "sum",
    "lines.amunt",
    "MESH_UNKNOWN_MEMBER",
    "&amunt is not a member of :Line. Did you mean &amount?",
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
    source.indexOf(`of="${path}"`) + 4 + path.indexOf(member),
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
