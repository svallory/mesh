import { expect, test } from "bun:test";
import { parseExpression } from "@babel/parser";
import type { DataAttr, DataTag } from "@mxlang/data/tree";
import { positionAt } from "../src/build.ts";
import {
  expression,
  readMember,
  readMemberLine,
  readMembers,
  type MemberAttribute,
  type SyntaxNode,
} from "../src/tree.ts";

const source = "asc &dueOn";
const span = { sourceStart: 4, sourceEnd: 10 };
const at = (offset: number) => positionAt(source, "todo.mesh.mx", offset);
const mark = (node: unknown, name = "dueOn") => {
  (node as SyntaxNode).extra = { mxMember: { name, span } };
  return node;
};
function dynamic(text: string): Extract<DataAttr, { kind: "expression" }> {
  return {
    kind: "expression",
    name: "value",
    nameSpan: { sourceStart: 0, sourceEnd: 1 },
    value: { code: text, shape: "other", span, node: parseExpression(text) },
  };
}

test("MX addendum: after-kind DataAttr member uses value, not attribute name", () => {
  const attribute: MemberAttribute = {
    kind: "member",
    name: "member",
    value: "dueOn",
    span,
  };
  expect(readMember(attribute, at)).toEqual({ name: "dueOn", position: at(4) });
  expect(
    readMember(
      { ...attribute, nameSpan: { sourceStart: 0, sourceEnd: 3 } },
      at,
    ),
  ).toEqual({ name: "dueOn", position: at(4) });
});

test("MX addendum: marked member expressions and arrays carry authored token spans", () => {
  const single = dynamic("self.dueOn");
  mark(single.value.node);
  expect(readMember(single, at)).toEqual({ name: "dueOn", position: at(4) });
  const list = dynamic("[self.dueOn, self.title]");
  const elements = (list.value.node as unknown as SyntaxNode).elements!;
  mark(elements[0]);
  mark(elements[1], "title");
  expect(readMembers(list, at).map((ref) => ref.name)).toEqual([
    "dueOn",
    "title",
  ]);
  expect(() => readMember(dynamic("self.dueOn"), at)).toThrow(
    "Expected a member reference",
  );
  expect(() => readMembers(dynamic('["dueOn"]'), at)).toThrow(
    "Expected a member reference",
  );
});

test("MX addendum: expression source uses authored text, params and marked references", () => {
  const value = dynamic("({ self, actor }) => self.dueOn === actor.id");
  const body = (value.value.node as unknown as { body: { left: unknown } })
    .body;
  mark(body.left);
  Object.assign(value.value, {
    text: "({ self, actor }) => &dueOn === actor.id",
  });
  const names: string[] = [];
  expect(expression(value, source, at, (ref) => names.push(ref.name))).toEqual({
    source: "({ self, actor }) => &dueOn === actor.id",
    params: ["self", "actor"],
    position: at(4),
  });
  expect(names).toEqual(["dueOn"]);
});

test("MX addendum: promised tagless member line and provisional line share one reader", () => {
  const tag: DataTag = {
    kind: "tag",
    name: "member",
    attrs: [{ kind: "string", name: "name", value: "dueOn", valueSpan: span }],
    args: [],
    params: [],
    attrTags: [],
    children: [],
    nameSpan: span,
    span,
  };
  const expected = { ref: { name: "dueOn", position: at(4) }, options: false };
  expect(() => readMemberLine(tag, at)).toThrow("Expected a tagless member line");
  expect(readMemberLine(tag, at, true)).toEqual(expected);
  expect(readMemberLine({ ...tag, name: "&dueOn", attrs: [] }, at)).toEqual(
    expected,
  );
  const value = dynamic("() => 1");
  tag.attrs.push(value);
  expect(readMemberLine(tag, at, true)).toEqual({ ...expected, value });
});
