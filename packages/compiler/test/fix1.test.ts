import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("fix6: member is not an authored tag", () => {
  const result = build(fixture("fix1/authored-member.mesh.mx").source);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_SYNTAX", position: { line: 8, column: 8 } });
  expect(result.diagnostics[0]!.message).toContain("member");
});

test("fix10: import diagnostics distinguish duplicates, forms and relative paths", () => {
  const duplicate = buildModel(project('import { List } from "./list.mesh.mx"\nimport { List } from "./list.mesh.mx"\n' + keyed));
  expect(duplicate.diagnostics.map((d) => d.code)).toEqual(["MESH_DUPLICATE_IMPORT"]);
  for (const declaration of ['import List from "./list.mesh.mx"', 'import * as List from "./list.mesh.mx"', 'import "./list.mesh.mx"']) {
    expect(buildModel(project(declaration + '\n' + keyed)).diagnostics).toEqual([expect.objectContaining({ code: "MESH_IMPORT_FORM", message: "import the entity by name: `import { List } from …`" })]);
  }
  const nonrelative = build('import { List } from "lists"\n' + keyed);
  expect(nonrelative.diagnostics).toEqual([expect.objectContaining({ code: "MESH_UNKNOWN_IMPORT", message: "The import path must be relative (start with ./ or ../)" })]);
});

test("fix11: existing but unconfigured entity imports are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-import-"));
  try {
    mkdirSync(join(root, "todo"));
    writeFileSync(join(root, "todo/list.mesh.mx"), list);
    const configured = project('import { List } from "./list.mesh.mx"\n' + keyed);
    const result = buildModel({ root, files: configured.files.slice(0, 1) });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_UNKNOWN_ENTITY", message: "./list.mesh.mx exists but is not under the configured entity directories", position: expect.objectContaining({ line: 1, column: 0 }) })]);
    expect(buildModel({ ...configured, root }).diagnostics).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
