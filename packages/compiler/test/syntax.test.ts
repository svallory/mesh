import { expect, test } from "bun:test";
import { parseData } from "@mxlang/data";
import type { DataAttr, DataNode, DataTag } from "@mxlang/data/tree";
import { MESH_SYNTAX } from "../src/syntax.ts";

// The module alone, without contracts: these pin the four tree shapes the
// compiler reads, on one Mesh sample each.
function parse(source: string) {
  const result = parseData(source, "todo/todo.mesh.mx", { syntax: MESH_SYNTAX });
  expect(result.diagnostics).toEqual([]);
  return result.tree!;
}
const tagsOf = (nodes: readonly DataNode[]) =>
  nodes.filter((n): n is DataTag => n.kind === "tag");
const attrOf = (tag: DataTag, name: string): DataAttr | undefined =>
  tag.attrs.find((a) => a.kind !== "spread" && a.name === name);

test("MESH_SYNTAX is frozen and names Mesh", () => {
  expect(Object.isFrozen(MESH_SYNTAX)).toBe(true);
  expect(MESH_SYNTAX.productName).toBe("Mesh");
});

test("shape 1: &status in an expression is a marked self.status; the atom is unchanged", () => {
  const source = "boolean :isOverdue value=(() => &status === :sent)\n";
  const [tag] = tagsOf(parse(source).children);
  const value = attrOf(tag!, "value");
  if (value?.kind !== "expression") throw new Error(String(value?.kind));
  const start = source.indexOf("&status");
  expect(value.value.node).toMatchObject({
    type: "ArrowFunctionExpression",
    body: {
      type: "BinaryExpression",
      left: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "self" },
        property: { type: "Identifier", name: "status" },
        extra: { mxMember: { name: "status", span: { sourceStart: start, sourceEnd: start + 7 } } },
      },
      right: { type: "StringLiteral", value: "sent", extra: { mxAtom: {} } },
    },
  });
  // The authored text is the span's slice; `code` is the printed replacement.
  expect(source.slice(value.value.span.sourceStart, value.value.span.sourceEnd)).toBe("() => &status === :sent");
  expect(value.value.code).toBe('() => self.status === "sent"');
});

test("shape 1: a chain marks the inner self.x and an array holds marked members", () => {
  const [tag] = tagsOf(parse("load value=[&author, &title.length]\n").children);
  const value = attrOf(tag!, "value");
  if (value?.kind !== "expression") throw new Error(String(value?.kind));
  expect(value.value.node).toMatchObject({
    type: "ArrayExpression",
    elements: [
      { type: "MemberExpression", extra: { mxMember: { name: "author" } } },
      {
        type: "MemberExpression",
        property: { name: "length" },
        object: { type: "MemberExpression", extra: { mxMember: { name: "title" } } },
      },
    ],
  });
});

test("shape 2: &dueOn after a kind is a { kind: \"member\" } attribute named member", () => {
  const source = "sort\n  asc &dueOn\n";
  const [sort] = tagsOf(parse(source).children);
  const [asc] = tagsOf(sort!.children);
  const start = source.indexOf("&dueOn");
  expect(asc!.name).toBe("asc");
  expect(asc!.attrs).toEqual([
    { kind: "member", name: "member", value: "dueOn", span: { sourceStart: start, sourceEnd: start + 6 } },
  ]);
});

test("shape 3: tagless &title and &done=true are member child tags", () => {
  const source = "set\n  &title\n  &done=true\n  &total=&price * 2\n";
  const [set] = tagsOf(parse(source).children);
  const [title, done, total] = tagsOf(set!.children);
  expect([title, done, total].map((t) => t!.name)).toEqual(["member", "member", "member"]);
  const titleStart = source.indexOf("&title");
  expect(title!.attrs).toEqual([
    {
      kind: "string",
      name: "name",
      value: "title",
      nameSpan: { sourceStart: titleStart, sourceEnd: titleStart + 6 },
      valueSpan: { sourceStart: titleStart + 1, sourceEnd: titleStart + 6 },
    },
  ]);
  expect(attrOf(done!, "name")).toMatchObject({ kind: "string", value: "done" });
  expect(attrOf(done!, "value")).toMatchObject({ kind: "boolean", name: "value" });
  const value = attrOf(total!, "value");
  if (value?.kind !== "expression") throw new Error(String(value?.kind));
  expect(value.value.node).toMatchObject({
    type: "BinaryExpression",
    left: { type: "MemberExpression", extra: { mxMember: { name: "price" } } },
  });
});

test("shape 4: atoms are unchanged by the module", () => {
  const [tag] = tagsOf(parse("enum :status values=[:draft, :sent]\n").children);
  expect(attrOf(tag!, "name")).toMatchObject({ kind: "atom", value: "status" });
  const values = attrOf(tag!, "values");
  if (values?.kind !== "expression") throw new Error(String(values?.kind));
  expect(JSON.stringify(values)).not.toContain("mxMember");
  expect(values.value.node).toMatchObject({
    type: "ArrayExpression",
    elements: [
      { type: "StringLiteral", value: "draft", extra: { mxAtom: {} } },
      { type: "StringLiteral", value: "sent", extra: { mxAtom: {} } },
    ],
  });
});
