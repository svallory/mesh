import { expect, test } from "bun:test";
import { buildModel } from "../src/build.ts";
import { fixture } from "./helpers.ts";
import { build, keyed } from "./v4.ts";

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
