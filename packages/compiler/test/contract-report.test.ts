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
    [
      "two bad string lines and two bad belongs-to lines",
      "    string :s match=x\n    string :t match=y\n  relationships\n    belongs-to :a entity=getList()\n    belongs-to :b entity=(List)\n",
      [["MESH_ATTRIBUTE_RULE", 5, 14], ["MESH_ATTRIBUTE_RULE", 6, 14], ["MESH_ENTITY_REFERENCE", 8, 18], ["MESH_ENTITY_REFERENCE", 9, 25]],
    ],
  ])("%s", (_label, body, expected) => {
    expect(codes(body)).toEqual(expected);
  });
});

// These hooks went from a throw to an explicit `continue`, `else if` or `break` when `ctx.fail` became `ctx.report`.
describe("hooks whose control flow changed each report every bad line", () => {
  test.each([
    [
      "handles: a call, an empty list and a wrapped reference on three handler lines",
      "  handlers\n    listen :a [on=getEvent()] ({ event }) {}\n    listen :b [on=[]] ({ event }) {}\n    process :c [on=(List)] ({ event }) {}\n",
      [["MESH_UNKNOWN_EVENT", 6, 15], ["MESH_UNKNOWN_EVENT", 7, 15], ["MESH_UNKNOWN_EVENT", 8, 19]],
    ],
    [
      "references: an empty actions= and an actions= that is no list on two policies",
      "  policies\n    policy :p actions=[]\n      authorize-if=() => true\n    policy :q actions=x\n      authorize-if=() => true\n",
      [["MESH_MEMBER_REFERENCE", 6, 14], ["MESH_MEMBER_REFERENCE", 8, 14]],
    ],
    [
      "rollups: a string of= on one line, a bad of= and a two-parameter filter= on the next",
      '  computed\n    count :n of="lines"\n    count :m of=1 filter=(a, b) => true\n',
      [["MESH_ROLLUP_PATH_STRING", 6, 13], ["MESH_ROLLUP_PATH", 7, 13], ["MESH_EXPRESSION", 7, 29]],
    ],
  ])("%s", (_label, body, expected) => {
    expect(codes(body)).toEqual(expected);
  });
});

describe("still one error per option", () => {
  test("values= that is no list is MESH_ATOM_LIST alone, not also the enum hook's MESH_ENUM_VALUES", () => {
    expect(codes("    enum :e values=x\n")).toEqual([["MESH_ATOM_LIST", 5, 12]]);
  });

  test("the tag's own hook still checks the options the shared checks did not report", () => {
    // Line 6 has a value= that is no function (shared check) and a match= that is no regular expression (string's hook).
    expect(codes("  computed\n    string :b value=x match=y\n    string :a match=x\n")).toEqual([
      ["MESH_EXPRESSION", 6, 14],
      ["MESH_ATTRIBUTE_RULE", 6, 22],
      ["MESH_ATTRIBUTE_RULE", 7, 14],
    ]);
  });

  test("a name the shared checks reported is not reported again as missing", () => {
    expect(codes('  actions\n    create name="x" on=f()\n    read name="y"\n')).toEqual([
      ["MESH_NAME", 6, 11],
      ["MESH_UNKNOWN_COMMAND", 6, 20],
      ["MESH_NAME", 7, 9],
    ]);
  });

  test("a call with tag parameters is not handed to its tag's hook", () => {
    expect(codes("    string|x| :t match=y\n")).toEqual([["MESH_SYNTAX", 5, 4]]);
  });
});
