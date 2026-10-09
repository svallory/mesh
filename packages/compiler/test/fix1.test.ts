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
