import { expect, test } from "bun:test";
import { lowerSource } from "@mxlang/core";
import type { Attr, Tag } from "../src/front-end/tree.ts";
import type { SpannedIr } from "@mxlang/core";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

// The module alone, without contracts: these pin the four tree shapes the
// compiler reads, on one Mesh sample each.
function parse(source: string) {
  const result = lowerSource(source, "todo/todo.mesh.mx", { dialect: MESH_DIALECT });
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}
const tagsOf = (nodes: SpannedIr["body"]): Tag[] =>
  nodes.flatMap((n) => (n.kind === "DelegatedTag" ? [n.tag] : []));
const attrOf = (tag: Tag, name: string): Attr | undefined =>
  tag.attrs.find((a) => a.kind !== "spread" && a.name === name);

test("MESH_DIALECT is frozen and is Mesh's: id, name, tag rules and no #id or .class row", () => {
  expect(Object.isFrozen(MESH_DIALECT)).toBe(true);
  expect(MESH_DIALECT).toMatchObject({ id: "mesh", name: "Mesh", tagRules: "none" });
  const rows = (list: readonly { id: string }[] | undefined) => (list ?? []).map((row) => row.id).sort();
  expect(rows(MESH_DIALECT.table.attributeTriggers)).toEqual(["member", "name"]);
  expect(rows(MESH_DIALECT.table.expressionTriggers)).toEqual(["atom", "member"]);
  expect(rows(MESH_DIALECT.table.lineTriggers)).toEqual(["member"]);
});

test("shape 1: &status in an expression is a marked self.status; the atom is unchanged", () => {
  const source = "boolean :isOverdue value=(() => &status === :sent)\n";
  const [tag] = tagsOf(parse(source).body);
  const value = attrOf(tag!, "value");
  if (value?.kind !== "dynamic") throw new Error(String(value?.kind));
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
  const [tag] = tagsOf(parse("load value=[&author, &title.length]\n").body);
  const value = attrOf(tag!, "value");
  if (value?.kind !== "dynamic") throw new Error(String(value?.kind));
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

test("shape 2: &dueOn after a kind is a static attribute named member carrying a member mark", () => {
  const source = "sort\n  asc &dueOn\n";
  const [sort] = tagsOf(parse(source).body);
  const [asc] = tagsOf(sort!.children);
  const start = source.indexOf("&dueOn");
  expect(asc!.name).toBe("asc");
  expect(asc!.attrs).toHaveLength(1);
  expect(asc!.attrs[0]).toMatchObject({
    kind: "static",
    name: "member",
    value: "dueOn",
    member: { kind: "member", name: "dueOn", span: { sourceStart: start, sourceEnd: start + 6 } },
  });
  expect((asc!.attrs[0] as { atom?: unknown }).atom).toBeUndefined();
});

test("shape 3: tagless &title and &done=true are member child tags", () => {
  const source = "set\n  &title\n  &done=true\n  &total=&price * 2\n";
  const [set] = tagsOf(parse(source).body);
  const [title, done, total] = tagsOf(set!.children);
  expect([title, done, total].map((t) => t!.name)).toEqual(["member", "member", "member"]);
  const titleStart = source.indexOf("&title");
  expect(title!.attrs).toHaveLength(1);
  expect(title!.attrs[0]).toMatchObject({
    kind: "static",
    name: "name",
    value: "title",
    nameSpan: { sourceStart: titleStart, sourceEnd: titleStart + 6 },
    valueSpan: { sourceStart: titleStart + 1, sourceEnd: titleStart + 6 },
  });
  // A plain string: neither an atom nor a member.
  expect(attrOf(title!, "name")).not.toHaveProperty("atom");
  expect(attrOf(title!, "name")).not.toHaveProperty("member");
  expect(title!.trigger).toMatchObject({ id: "member", text: "&title" });
  expect(attrOf(done!, "name")).toMatchObject({ kind: "static", value: "done" });
  expect(attrOf(done!, "value")).toMatchObject({ kind: "boolean", name: "value" });
  const value = attrOf(total!, "value");
  if (value?.kind !== "dynamic") throw new Error(String(value?.kind));
  expect(value.value.node).toMatchObject({
    type: "BinaryExpression",
    left: { type: "MemberExpression", extra: { mxMember: { name: "price" } } },
  });
});

test("shape 4: atoms are unchanged by the module", () => {
  const [tag] = tagsOf(parse("enum :status values=[:draft, :sent]\n").body);
  expect(attrOf(tag!, "name")).toMatchObject({ kind: "static", value: "status", atom: { kind: "atom", name: "status" } });
  const values = attrOf(tag!, "values");
  if (values?.kind !== "dynamic") throw new Error(String(values?.kind));
  expect(JSON.stringify(values)).not.toContain("mxMember");
  expect(values.value.node).toMatchObject({
    type: "ArrayExpression",
    elements: [
      { type: "StringLiteral", value: "draft", extra: { mxAtom: {} } },
      { type: "StringLiteral", value: "sent", extra: { mxAtom: {} } },
    ],
  });
});
