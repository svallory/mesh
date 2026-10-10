import { expect, test } from "bun:test";
import { lowerSource } from "@mxlang/core";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { MESH_EXTENSIONS, hasMeshExtension, meshGlob } from "../src/front-end/extensions.ts";

test("tag rules come from the dialect alone: a void-element name is an ordinary Mesh tag with children", () => {
  // Under MX's default `html` rules `input` is void and cannot hold children.
  const source = "input\n  string :title\n";
  const withDialect = lowerSource(source, "a.mesh.mx", { dialect: MESH_DIALECT });
  expect(withDialect.diagnostics).toEqual([]);
  const [node] = withDialect.ir!.body;
  if (node?.kind !== "DelegatedTag") throw new Error(String(node?.kind));
  expect(node.tag.name).toBe("input");
  expect(node.tag.children).toHaveLength(1);
  // The same nesting on one line, as the html rules would reject it.
  expect(lowerSource("<input><child/></input>\n", "a.mesh.mx", { dialect: MESH_DIALECT }).diagnostics).toEqual([]);
  expect(lowerSource("<input><child/></input>\n", "a.mesh.mx", { dialect: { ...MESH_DIALECT, tagRules: "html" } }).diagnostics.length).toBeGreaterThan(0);
});

test("the extensions are one list", () => {
  expect(MESH_EXTENSIONS).toEqual([".mesh.mx"]);
  expect(Object.isFrozen(MESH_EXTENSIONS)).toBe(true);
  expect(hasMeshExtension("a/b.mesh.mx")).toBe(true);
  expect(hasMeshExtension("a/b.mx")).toBe(false);
  expect(meshGlob).toBe("**/*.mesh.mx");
});

// MX #495 (alpha.16): `:name` as a whole attribute value is a dialect row. Mesh owns it (`syntax/mesh.ts`),
// and it names the dialect id, so `MESH_DIALECT.id` has to stay `mesh`.
test("the dialect carries the value-position atom row and the Atom node type, under the id mesh", () => {
  expect(MESH_DIALECT.id).toBe("mesh");
  const rows = MESH_DIALECT.table.valueTriggers ?? [];
  expect(rows.map((row) => row.id)).toEqual(["atom-value"]);
  expect(rows[0]!.node).toEqual({ type: "Atom", dialect: MESH_DIALECT.id });
  expect(Object.keys(MESH_DIALECT.nodeTypes ?? {})).toEqual(["Atom"]);
});
