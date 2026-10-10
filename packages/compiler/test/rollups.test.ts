import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
const target = `import { Line } from "./line.mesh.mx"
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
  ["sum", "lines.units", "integer", true],
  ["sum", "lines.amount", "decimal", true],
  ["avg", "lines.units", "decimal", true],
  ["avg", "lines.amount", "decimal", true],
  ["min", "lines.units", "integer", true],
  ["max", "lines.amount", "decimal", true],
  ["min", "lines.paidAt", "datetime", true],
  ["max", "lines.dueOn", "date", true],
  ["max", "lines.createdAt", "timestamp", true],
  ["min", "lines.createdAt", "timestamp", true],
  ["max", "lines.parent.dueOn", "date", true],
] as const)("%s of %s infers %s, nullable %s", (fn, path, type, nullable) => {
  const { result } = build(fn, path);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({
    type,
    nullable,
    rollup: { fn, of: path },
  });
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
  ["belongs-to :lines entity=Line", false],
  ["belongs-to :lines entity=Line nullable", true],
  ["has-one :lines entity=Line", true],
  ["has-many :lines entity=Line", true],
] as const)("rollup nullability follows %s", (relationship, nullable) => {
  const { result } = build("sum", "lines.amount", relationship);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.computed[0]).toMatchObject({ nullable });
  const count = build("count", "lines", relationship).result;
  expect(count.diagnostics).toEqual([]);
  expect(count.document!.entities[0]!.computed[0]).toMatchObject({
    nullable: false,
  });
});
