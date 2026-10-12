import { expect, test } from "bun:test";
import { lowerSource, type CustomTag } from "@mxlang/core";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

// `Dialect.contracts` is `@unstable` in MX 0.1.0-alpha.21. A contract that cannot register stops the whole dialect, where the
// same contract passed as `customTags` fails only the call that uses it (`atom-contracts.test.ts` pins that path).
test("a malformed contract in the dialect's contracts stops every file of the dialect, naming the entry", () => {
  const broken = { box: { attributes: { a: { type: "string", pattern: "^x" } } } } as unknown as Record<string, CustomTag>;
  const found = lowerSource("<div/>", "/v/x.mesh.mx", { dialect: { ...MESH_DIALECT, contracts: broken } }).diagnostics;
  expect(found.map((d) => d.code)).toEqual(["MX_INVALID_DIALECT_CONTRACT"]);
  expect(found[0]?.message).toContain("`dialect.contracts.box`");
});

test("Mesh's own contracts register: a valid file lowers clean with only the dialect passed", () => {
  const source = "entity :Todo\n  attributes\n    string :title\n";
  expect(lowerSource(source, "/v/todo.mesh.mx", { dialect: MESH_DIALECT }).diagnostics).toEqual([]);
});
