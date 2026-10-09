import { expect, test } from "bun:test";
import { buildModel } from "../src/build.ts";
import { fixture } from "./helpers.ts";
import { build, keyed, list, project } from "./v4.ts";

test("fix2: imported name must be exported by the target entity", () => {
  const result = buildModel(project(fixture("fix1/import-name-mismatch.mesh.mx").source));
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_UNKNOWN_IMPORT", message: "`Usr` is not what ./list.mesh.mx declares; it declares `List`", position: { line: 1, column: 9 } });
  const alias = fixture("fix1/import-name-mismatch.mesh.mx").source.replace("{ Usr }", "{ List as Usr }");
  expect(buildModel(project(alias)).diagnostics).toEqual([]);
});

test.each(["sum", "avg", "min", "max"])("fix3: %s must cross a relationship", (fn) => {
  const result = build(keyed.replace(":Todo", ":Invoice") + `    integer :n\n  computed\n    ${fn} :x of="n"\n`);
  expect(result.document).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_ROLLUP_PATH", message: "`n` is an attribute of :Invoice, not a relationship; `of` is a path through relationships", position: { line: 6, column: 12 + fn.length } });
});

test("fix4: duplicate policy and check names use member diagnostics", () => {
  const policies = build(keyed + "  policies\n    policy :p\n    policy :p\n");
  expect(policies.diagnostics).toEqual([expect.objectContaining({ code: "MESH_DUPLICATE_MEMBER", message: "Duplicate member :p", position: expect.objectContaining({ line: 6, column: 4 }) })]);
  const check = '        check :a that=() => true code="bad" message="bad"\n';
  const prefix = keyed + "  actions\n    update :change\n      validate\n";
  expect(build(prefix + check + check).diagnostics).toEqual([expect.objectContaining({ code: "MESH_DUPLICATE_MEMBER", message: "Duplicate member :a", position: expect.objectContaining({ line: 8, column: 8 }) })]);
  expect(build(prefix + check + "    update :other\n      validate\n" + check).diagnostics).toEqual([]);
});

test.each(["id", "insertedAt", "updatedAt"])("fix5: managed &%s is rejected by the builder", (name) => {
  const result = build(keyed + `    timestamp :insertedAt on=:create\n    timestamp :updatedAt on=:update\n  actions\n    create :create\n      input\n        &${name}\n`);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_INPUT_MANAGED", message: `&${name} is set by Mesh and cannot be an input`, position: expect.objectContaining({ line: 9, column: 8 }) })]);
});

for (const [name, codes] of [
  ["computed-missing-body", [["MESH_MODEL_SHAPE", 6, 4]]],
  ["set-missing-value", [["MESH_MEMBER_LINE_OPTIONS", 9, 10]]],
  ["set-nonliteral", [["MESH_MODEL_SHAPE", 9, 10]]],
  ["multiple-shape-errors", [["MESH_MODEL_SHAPE", 6, 4], ["MESH_UNKNOWN_MEMBER", 10, 8]]],
] as const) test(`fix1: positioned recovery for ${name}`, () => {
  const result = build(fixture(`fix1/${name}.mesh.mx`).source);
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => [d.code, d.position.line, d.position.column])).toEqual(codes.map((c) => [...c]));
});
