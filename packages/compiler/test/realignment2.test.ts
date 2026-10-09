import { expect, test } from "bun:test";
import { build, keyed } from "./v4.ts";

const assignment = (declaration: string, value: string) => `${keyed}    ${declaration}\n  actions\n    update :change\n      do\n        set\n          &value=${value}\n`;
const scalars = [
  { declaration: "string :value", valid: '"hello"', invalid: "123" },
  { declaration: "boolean :value", valid: "true", invalid: '"true"' },
  { declaration: "integer :value", valid: "-2", invalid: "1.5" },
  { declaration: "float :value", valid: "1.25", invalid: '"1.25"' },
  { declaration: "decimal :value", valid: "1.25", invalid: "false" },
  { declaration: "date :value", valid: '"2024-02-29"', invalid: '"2025-02-29"' },
  { declaration: "datetime :value", valid: '"2024-02-29T23:59:59+02:30"', invalid: '"2024-02-29T25:00:00Z"' },
  { declaration: "timestamp :value", valid: '"2024-02-29T23:59:59.123Z"', invalid: '"yesterday"' },
  { declaration: "uuid :value", valid: '"00000000-0000-4000-8000-000000000001"', invalid: '"not-a-uuid"' },
  { declaration: "enum :value values=[:draft, :sent]", valid: ":sent", invalid: ":unknown" },
];
for (const { declaration, valid, invalid } of scalars) {
  test(`set accepts a ${declaration} literal`, () => {
    expect(build(assignment(declaration, valid)).diagnostics).toEqual([]);
  });
  test(`set rejects the wrong ${declaration} literal at its member line`, () => {
    const result = build(assignment(declaration, invalid));
    expect(result.document).toBeNull();
    expect(result.diagnostics).toMatchObject([{
      code: "MESH_SET_VALUE", position: { line: 9, column: 10 },
    }]);
    expect(result.diagnostics[0]?.message).toContain("`&value=` needs a literal that fits");
  });
  test(`set functions for ${declaration} are preserved, never evaluated`, () => {
    expect(build(assignment(declaration, '() => { throw new Error("never run") }')).diagnostics).toEqual([]);
  });
}
test("set null follows nullable and enum strings/objects are not atoms", () => {
  expect(build(assignment("string :value nullable", "null")).diagnostics).toEqual([]);
  for (const [declaration, value] of [
    ["string :value", "null"], ["string :value", "[]"],
    ["enum :value values=[:draft]", '"draft"'], ["enum :value values=[:draft]", '{value:"draft"}'],
  ]) expect(build(assignment(declaration!, value!)).diagnostics[0]?.code).toBe("MESH_SET_VALUE");
});
test.each([
  ["uuid", '"not-a-uuid"'], ["datetime", '"2026-02-30T12:00:00Z"'],
  ["datetime", '"2026-10-09"'], ["datetime", '"2026-10-09T12:00:00"'],
  ["date", '"2026-02-30"'],
])("%s default %s must fit the scalar format", (type, value) => {
  expect(build(`${keyed}    ${type} :value default=${value}\n`).diagnostics).toMatchObject([
    { code: "MESH_DEFAULT", position: { line: 4, column: 4 } },
  ]);
});
test.each([
  ["uuid", '"00000000-0000-4000-8000-000000000001"'], ["uuid", '"00000000-0000-0000-0000-000000000000"'],
  ["datetime", '"2024-02-29T12:00:00Z"'], ["datetime", '"2024-02-29T12:00:00.123+05:30"'],
])("%s accepts formatted default %s", (type, value) => {
  expect(build(`${keyed}    ${type} :value default=${value}\n`).diagnostics).toEqual([]);
});
test.each(["todo", "todoItem", "Todo_item", "_Todo"])("entity %s needs PascalCase", (name) => {
  expect(build(keyed.replace(":Todo", `:${name}`)).diagnostics).toMatchObject([
    { code: "MESH_ENTITY_NAME", position: { line: 1, column: 0 } },
  ]);
});
test.each(["Todo", "TodoItem", "HTTPLog", "Todo2"])("PascalCase entity %s is accepted", (name) => {
  expect(build(keyed.replace(":Todo", `:${name}`)).diagnostics).toEqual([]);
});
test.each(["uuid", "integer", "string"])("%s accepts primary-key", (type) => {
  expect(build(keyed.replace("uuid :id", `${type} :id`)).diagnostics).toEqual([]);
});
test.each(["boolean", "date", "datetime", "timestamp", "float", "decimal", "enum"])("%s rejects primary-key at the contract boundary", (type) => {
  const result = build(keyed.replace("uuid :id", `${type} :id${type === "enum" ? " values=[:one]" : ""}`));
  expect(result.document).toBeNull();
  expect(result.diagnostics[0]?.code).toBe("MESH_SYNTAX");
  expect(result.diagnostics[0]?.message).toContain("primary-key");
});
test("nonliteral assignment names the authored member rather than an AST node", () => {
  expect(build(assignment("string :value", "other")).diagnostics).toMatchObject([
    { code: "MESH_MODEL_SHAPE", message: "`&value=` needs a literal value here", position: { line: 9, column: 10 } },
  ]);
});
test("a policy colliding with an auto action is reported on the policy line", () => {
  const result = build(`${keyed}  actions auto=[:read]\n  policies\n    policy :read authorize-if=() => true\n`);
  expect(result.diagnostics).toMatchObject([
    { code: "MESH_DUPLICATE_MEMBER", position: { line: 6, column: 4 } },
  ]);
});
test("an own computed field in a rollup has an author-facing diagnostic", () => {
  const result = build(`${keyed}  computed\n    integer :amount() { return 1 }\n    sum :total of="amount"\n`);
  expect(result.diagnostics).toMatchObject([
    { code: "MESH_ROLLUP_PATH", message: "rollups read attributes through relationships, not computed fields", position: { line: 6, column: 19 } },
  ]);
});
