// The concept hook, `conceptTagFile` (`front-end/concept-file.ts`; concepts design 3.3, ruling D36), called directly with a
// stub `ctx.lower` that lowers the text as MX would (Mesh's dialect, no scan). What it returns is what MX turns into each
// use's contract, or into `MESH_TAG_FILE_ERROR` at each use with the file's own diagnostics beside it.
import type { TagFileContext, TagFileResult } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { CONCEPT_USE, conceptTagFile } from "../src/front-end/concept-file.ts";
import { parseEntitySource } from "../src/front-end/build.ts";

const PATH = "/v/src/domain/concepts/Money.mesh.mx";
const MONEY = "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n";

function hook(source: string, name = "Money", lowered = parseEntitySource(source, PATH)): TagFileResult {
  const ctx: TagFileContext = { lower: () => lowered, dependsOn: () => {} };
  return conceptTagFile({ path: PATH, source, name }, ctx);
}
const said = (result: TagFileResult) => (result.diagnostics ?? []).map((d) => `${d.line}:${d.column} ${d.code} ${d.message}`);

describe("conceptTagFile", () => {
  test("a sound concept file is the contract of a concept use, with no diagnostic", () => {
    const result = hook(MONEY);
    expect(result.contract).toBe(CONCEPT_USE);
    expect(said(result)).toEqual([]);
    // What a use takes: its name, `nullable` and `optional` (OD6), under the four field parents, with no child.
    expect(Object.keys(CONCEPT_USE.attributes ?? {})).toEqual(["name", "nullable", "optional"]);
    expect(CONCEPT_USE.parents).toEqual(["attributes", "event", "command", "concept"]);
    expect(CONCEPT_USE.children).toEqual({});
  });

  test("legal neighbours: a one-field concept, an acronym, a digit, a `constructor` field, every scalar kind", () => {
    expect(hook("concept :Money\n  integer :amount\n").contract).toBe(CONCEPT_USE);
    expect(hook("concept :HTTPStatus\n  integer :code\n", "HTTPStatus").contract).toBe(CONCEPT_USE);
    expect(hook("concept :Money2\n  integer :amount\n", "Money2").contract).toBe(CONCEPT_USE);
    expect(hook("concept :Money\n  string :constructor\n").contract).toBe(CONCEPT_USE);
    expect(hook("concept :Money\n  uuid :a\n  string :b\n  integer :c\n  float :d\n  decimal :e\n  boolean :f\n  enum :g values=[:x, :y]\n  json :h\n").contract).toBe(CONCEPT_USE);
  });

  test.each([
    ["a name other than the file's", "concept :Right\n  integer :amount\n", "Wrong",
      "1:8 MESH_CONCEPT_NAME concepts/Money.mesh.mx declares `concept :Right`: a concept's name is its file name, so write `concept :Wrong` or rename the file Right.mesh.mx"],
    ["a lower-case name", "concept :money\n  integer :amount\n", "money",
      "1:8 MESH_CONCEPT_NAME concept :money is not PascalCase: a concept is used as a PascalCase line head (`Money :price`), so name the file Money.mesh.mx and write `concept :Money`"],
    ["an entity root", "entity :Order\n  attributes\n    uuid :id primary-key\n", "Money",
      "1:0 MESH_CONCEPT_PLACE concepts/Money.mesh.mx is in a `concepts` folder, so it declares one concept: move this entity out of the folder, or write `concept :Order`"],
    ["two roots", "concept :Money\n  integer :amount\nconcept :Other\n  integer :x\n", "Money",
      "3:0 MESH_DUPLICATE_ENTITY A concept file declares exactly one concept"],
    ["no field line", "concept :Money\n", "Money", "1:0 MESH_MISSING_CHILD `concept`: a concept needs at least one field line"],
    ["two fields of one name", "concept :Money\n  integer :amount\n  string :amount\n", "Money", "3:2 MESH_DUPLICATE_MEMBER Duplicate member :amount"],
    ["a `__proto__` field", "concept :Money\n  string :__proto__\n", "Money",
      "2:2 MESH_ATTRIBUTE_NAME :__proto__ cannot be a field name: __proto__ sets an object's prototype instead of adding a property. Choose another name."],
    ["a date field", "concept :Money\n  date :issuedOn\n", "Money",
      "2:2 MESH_CONCEPT_FIELD `date :issuedOn` cannot be a field of a concept yet: a concept is stored as one JSON value, which keeps no date; write it as a `string`, or declare it on the entity"],
  ])("%s gives no contract and one diagnostic", (_, source, name, expected) => {
    const result = hook(source, name);
    expect(result.contract).toBeUndefined();
    expect(said(result)).toEqual([expected]);
  });

  test("`datetime` and `timestamp` fields are refused as `date` is", () => {
    expect(said(hook("concept :Money\n  datetime :a\n  timestamp :b\n")).map((line) => line.split(" ")[1])).toEqual(["MESH_CONCEPT_FIELD", "MESH_CONCEPT_FIELD"]);
  });

  test("a file that does not lower passes MX's diagnostics on as the same objects, and no contract", () => {
    const lowered = parseEntitySource("concept :Money\n  bogus :x\n", PATH);
    expect(lowered.ir).toBeUndefined();
    const result = hook("concept :Money\n  bogus :x\n", "Money", lowered);
    expect(result.contract).toBeUndefined();
    expect(result.diagnostics).toHaveLength(lowered.diagnostics.length);
    result.diagnostics!.forEach((d, i) => expect(d).toBe(lowered.diagnostics[i] as never));
  });

  test("an error that came with a lowered tree is kept beside the contract, so MX still fails each use", () => {
    const base = parseEntitySource(MONEY, PATH);
    const kept = { severity: "error" as const, code: "MESH_UNKNOWN_OPTION", message: "`optional` is only an option of a command's field", line: 2, column: 20, offset: 0 };
    const result = hook(MONEY, "Money", { ...base, diagnostics: [kept] } as never);
    expect(result.contract).toBe(CONCEPT_USE);
    expect(result.diagnostics?.[0]).toBe(kept as never);
  });
});
