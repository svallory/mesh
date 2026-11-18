// Every contract error of a file is reported, not only the first (bead mesh-contract-fail-stops-pass). Mesh's `analyze`
// hooks (`src/front-end/contracts.ts`) report through MX's `ctx.report` (MX 0.1.0-alpha.38, `@unstable`), which does not
// end the hook, and MX runs every tag's hook even when an earlier one reported. Before, each check was `ctx.fail`, which
// throws: the first bad call ended its tag's loop, and no later tag's hook ran, so a file showed one contract error.
import { describe, expect, test } from "bun:test";
import { build } from "./v4.ts";

const head = 'import { List } from "./list.mesh.mx"\nentity :Todo\n  attributes\n    uuid :id primary-key\n';
const codes = (body: string) => build(head + body).diagnostics.map((d) => [d.code, d.position.line, d.position.column]);

describe("two bad calls of one tag each report", () => {
  test.each([
    [
      "two belongs-to lines with a bad entity=",
      "  relationships\n    belongs-to :a entity=getList()\n    belongs-to :b entity=(List)\n",
      [["MESH_ENTITY_REFERENCE", 6, 18], ["MESH_ENTITY_REFERENCE", 7, 25]],
    ],
    [
      "two checks with a message that is neither text nor a function",
      '  actions\n    create :c\n      validate\n        check :a that=() => true code="a" message=1\n        check :b that=() => true code="b" message=2\n',
      [["MESH_OPTION_VALUE", 8, 42], ["MESH_OPTION_VALUE", 9, 42]],
    ],
    [
      "two enum lines with a bad values=, one from the checks every tag shares",
      "    enum :e values=[]\n    enum :f values=x\n",
      [["MESH_ATOM_LIST", 5, 12], ["MESH_ATOM_LIST", 6, 12]],
    ],
  ])("%s", (_label, body, expected) => {
    expect(codes(body)).toEqual(expected);
  });

  test("two bad options of one line each report", () => {
    expect(codes("  relationships\n    has-many :a entity=getList() through=(List)\n")).toEqual([
      ["MESH_ENTITY_REFERENCE", 6, 16],
      ["MESH_ENTITY_REFERENCE", 6, 41],
    ]);
  });
});

describe("bad calls on two tags each report", () => {
  test.each([
    [
      "a string with a bad match= and a belongs-to with a bad entity=",
      "    string :t match=x\n  relationships\n    belongs-to :a entity=getList()\n",
      [["MESH_ATTRIBUTE_RULE", 5, 14], ["MESH_ENTITY_REFERENCE", 7, 18]],
    ],
    [
      "two actions with a bad on= and a belongs-to with a bad entity=",
      "  actions\n    create :c on=f()\n    update :u on=(List)\n  relationships\n    belongs-to :a entity=getList()\n",
      [["MESH_UNKNOWN_COMMAND", 6, 14], ["MESH_UNKNOWN_COMMAND", 7, 17], ["MESH_ENTITY_REFERENCE", 9, 18]],
    ],
  ])("%s", (_label, body, expected) => {
    expect(codes(body)).toEqual(expected);
  });
});

describe("still one error per option", () => {
  test("values= that is no list is MESH_ATOM_LIST alone, not also the enum hook's MESH_ENUM_VALUES", () => {
    expect(codes("    enum :e values=x\n")).toEqual([["MESH_ATOM_LIST", 5, 12]]);
  });

  test("a line the shared checks reported skips its tag's own hook; the tag's other lines still get it", () => {
    // Line 6 has a value= that is no function (shared check) and a match= that is no regular expression (string's hook).
    expect(codes("  computed\n    string :b value=x match=y\n    string :a match=x\n")).toEqual([
      ["MESH_EXPRESSION", 6, 14],
      ["MESH_ATTRIBUTE_RULE", 7, 14],
    ]);
  });
});
