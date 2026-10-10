import { expect, test } from "bun:test";
import { ATTRIBUTE_TYPES, findNonJsonValue } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { postDocument, postFile, postSource } from "../../model/test/sample.ts";
import { fixture, fixtureDir } from "./helpers.ts";
import { build, keyed, project, todo } from "./v4.ts";

/** Drop `tree`, `plain` and a function computed field's inferred `nullable`, recursively. */
function withoutTrees<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutTrees) as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record)
      .filter(([k]) => k !== "tree" && k !== "plain" && k !== "helper" && !(k === "nullable" && "body" in record))
      .map(([k, v]) => [k, withoutTrees(v)])) as T;
  }
  return value;
}

test("all currently parseable v4 constructs are represented", () => {
  const result = buildModel(project());
  expect(result.diagnostics).toEqual([]);
  const entity = result.document!.entities[0]!;
  expect(findNonJsonValue(result.document)).toBeNull();
  expect(JSON.parse(JSON.stringify(result.document))).toStrictEqual(
    result.document,
  );
  expect(new Set(entity.attributes.map((a) => a.type))).toEqual(
    new Set(ATTRIBUTE_TYPES.map((t) => t.name)),
  );
  expect(entity.module).toBe("todo");
  expect(entity.table).toBe("todos");
  expect(entity.imports[0]).toMatchObject({
    identifiers: ["List"],
    from: "./list.mesh.mx",
  });
  expect(entity.relationships.map((r) => r.keyColumn)).toEqual([
    "listId",
    undefined,
    undefined,
  ]);
  expect(entity.computed[0]).toMatchObject({
    type: "string",
    body: { source: "({ self }) { return self.title }", params: ["self"] },
  });
  expect(entity.computed.slice(1).map((c) => c.rollup?.fn)).toEqual([
    "count",
    "sum",
    "avg",
    "min",
    "max",
  ]);
  expect(entity.actions[0]!.input.map((f) => f.kind)).toEqual([
    "member",
    "member",
    "member",
    "argument",
  ]);
  expect(entity.actions[1]!.do[0]).toMatchObject({
    kind: "set",
    assignments: [
      { member: { name: "done" }, value: true },
      { member: { name: "status" }, value: { value: "sent" } },
    ],
  });
  expect(entity.always[0]!.do[0]).toMatchObject({
    kind: "run",
    fn: { params: ["self", "actor"] },
  });
  expect(entity.policies[0]!.authorizeIf).toHaveLength(2);
  expect(entity.policies[0]!.forbidIf).toHaveLength(1);
});
test("reference fixture is the hand-built model's authored file", () =>
  expect(fixture("post.mesh.mx").source).toBe(postSource));
test(
  "full reference builds to hand-built model",
  () => {
    const dependencies = ["customer", "invoice-line", "payment"].map(
      (name) => ({
        file: `src/domain/billing/${name}.mesh.mx`,
        source: fixture(`src/domain/billing/${name}.mesh.mx`).source,
      }),
    );
    const result = buildModel({
      root: fixtureDir,
      domainRoot: "src/domain",
      files: [{ file: postFile, source: postSource }, ...dependencies],
    });
    // `label` concatenates strings and calls a helper with the record: plain code, so the build warns (M4).
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_EXPR_PLAIN"]);
    // The hand-built model predates M4: compare it without the trees (expressions.test.ts covers those).
    expect(
      withoutTrees(result.document!.entities.find((entity) => entity.name === "Invoice")),
    ).toStrictEqual(postDocument.entities[0]);
  },
);
test("empty and multiple entities fail positioned", () => {
  expect(build("").diagnostics[0]).toMatchObject({
    code: "MESH_DUPLICATE_ENTITY",
    position: { line: 1, column: 0 },
  });
  expect(build(keyed + keyed).diagnostics[0]).toMatchObject({
    code: "MESH_DUPLICATE_ENTITY",
    position: { line: 4, column: 0 },
  });
});
test("identity is module/path scoped, not a global entity-name index", () => {
  const files = [
    { file: "a/one.mesh.mx", source: keyed },
    { file: "b/two.mesh.mx", source: keyed },
  ];
  expect(buildModel({ root: "/project", files }).diagnostics).toEqual([]);
  files[1]!.file = "a/two.mesh.mx";
  expect(buildModel({ root: "/project", files }).diagnostics[0]?.code).toBe(
    "MESH_DUPLICATE_ENTITY",
  );
});
test.each([
  [keyed.replace("uuid :id primary-key", "string :title"), "MESH_PRIMARY_KEY"],
  [keyed + "    uuid :other primary-key\n", "MESH_PRIMARY_KEY"],
  [keyed + "    enum :status\n", "MESH_ENUM_VALUES"],
  [keyed + "    string :title\n    integer :title\n", "MESH_DUPLICATE_MEMBER"],
  [keyed + "    string :constructor\n", "MESH_ATTRIBUTE_NAME"],
  [
    keyed +
      "  actions\n    create :create\n      input\n        &id\n        uuid :id\n",
    "MESH_DUPLICATE_INPUT",
  ],
  [
    keyed +
      "  actions\n    create :create\n      input\n        &id nullable\n",
    "MESH_SYNTAX",
  ],
  [
    keyed + "  actions\n    create :create\n      input\n        &id=true\n",
    "MESH_SYNTAX",
  ],
  [
    keyed + "  actions\n    read :read\n      input\n        &id\n",
    "MESH_READ_INPUT_MEMBER",
  ],
  [
    keyed + "  relationships\n    belongs-to :list entity=Lost\n",
    "MESH_UNKNOWN_ENTITY",
  ],
  [keyed + "    integer :n default=1.5\n", "MESH_DEFAULT"],
  [keyed + "    boolean :ok min=0\n", "MESH_SYNTAX"],
  [keyed + "    string :title on=:create\n", "MESH_SYNTAX"],
  [keyed + "  actions auto=[:read]\n    read :read\n", "MESH_DUPLICATE_MEMBER"],
])("rejects invalid model %s", (source, code) => {
  const result = build(source);
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
  for (const d of result.diagnostics) {
    expect(d.position.line).toBeGreaterThan(0);
    expect(d.position.offset).toBeGreaterThanOrEqual(0);
  }
});
test("unknown member has exactly the documented suggestion", () => {
  const source =
    keyed +
    "    string :title\n  actions\n    create :create\n      input\n        &titel\n";
  expect(build(source).diagnostics[0]).toMatchObject({
    code: "MESH_UNKNOWN_MEMBER",
    message: "&titel is not a member of :Todo. Did you mean &title?",
    position: { line: 8, column: 8, offset: source.indexOf("&titel") },
  });
});
test("unknown entity suggests nearest entity import", () => {
  const result = buildModel(project(todo.replace("entity=List", "entity=Lst")));
  expect(result.diagnostics[0]).toMatchObject({
    code: "MESH_UNKNOWN_ENTITY",
    message: "Lst is not an imported entity. Did you mean List?",
  });
});
test("missing imports fail and file-relative virtual imports succeed", () => {
  expect(build(todo).diagnostics.map((d) => d.code)).toContain(
    "MESH_UNKNOWN_IMPORT",
  );
  expect(buildModel(project()).diagnostics).toEqual([]);
});
test("errors collect across independent files", () => {
  const result = buildModel({
    root: "/project",
    files: ["a", "b"].map((name) => ({
      file: `${name}/todo.mesh.mx`,
      source:
        keyed +
        "  actions\n    create :create\n      input\n        &missing\n",
    })),
  });
  expect(result.diagnostics.map((d) => d.code)).toEqual([
    "MESH_UNKNOWN_MEMBER",
    "MESH_UNKNOWN_MEMBER",
  ]);
});
test("required by default, default table and module inferred", () => {
  expect(build(keyed).document!.entities[0]).toMatchObject({
    name: "Todo",
    table: "todo",
    module: "todo",
    auto: [],
    imports: [],
    attributes: [{ nullable: false }],
  });
});
