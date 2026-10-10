import { expect, test } from "bun:test";
import { lowerSource } from "@mxlang/core";
import type { Tag } from "../src/front-end/tree.ts";
import type { SpannedIr } from "@mxlang/core";
import { positionAt } from "../src/model/index.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import {
  attr,
  expression,
  isMemberLine,
  readMember,
  readMemberLine,
  readMembers,
  type MemberAssignment,
} from "../src/front-end/tree.ts";

// Real lowered trees from MESH_DIALECT (no contracts): the readers take members
// from MX's shapes only, never from `code` or the text.
const tagsOf = (nodes: SpannedIr["body"]): Tag[] =>
  nodes.flatMap((n) => (n.kind === "DelegatedTag" ? [n.tag] : []));
function lowered(source: string) {
  const result = lowerSource(source, "todo.mesh.mx", { dialect: MESH_DIALECT });
  expect(result.diagnostics).toEqual([]);
  const at = (offset: number) => positionAt(source, "todo.mesh.mx", offset);
  return { root: tagsOf(result.ir!.body)[0]!, at };
}

test("after a kind: the { kind: \"member\" } attribute's value, positioned at the &", () => {
  const { root, at } = lowered("sort\n  asc &dueOn\n");
  const asc = tagsOf(root.children)[0]!;
  expect(readMember(attr(asc, "member"), at)).toEqual({ name: "dueOn", position: at(11) });
});

test("whole value: on:load=&visible is one marked member", () => {
  const { root, at } = lowered("actions on:load=&visible\n");
  expect(readMember(attr(root, "on:load"), at)).toEqual({ name: "visible", position: at(16) });
});

test("arrays of marked members; unmarked values are refused", () => {
  const { root, at } = lowered("always actions=[&publish, &archive] other=[self.x] one=(self.x)\n");
  expect(readMembers(attr(root, "actions"), at)).toEqual([
    { name: "publish", position: at(16) },
    { name: "archive", position: at(26) },
  ]);
  expect(() => readMembers(attr(root, "other"), at)).toThrow("Expected a member reference");
  expect(() => readMember(attr(root, "one"), at)).toThrow("Expected a member reference");
});

test("expressions: authored source, destructured params, every marked member", () => {
  const source = "boolean :ok value=(({ self, actor }) => &author.id === actor.id && [&title].length > 0)\n";
  const { root, at } = lowered(source);
  const names: string[] = [];
  const result = expression(attr(root, "value"), source, at, (ref) => names.push(ref.name));
  expect(result).toEqual({
    source: "({ self, actor }) => &author.id === actor.id && [&title].length > 0",
    params: ["self", "actor"],
    position: at(19),
  });
  expect(names).toEqual(["author", "title"]);
});

test("method shorthand bodies are walked", () => {
  const source = "boolean :isOverdue() { return &status === :sent }\n";
  const { root, at } = lowered(source);
  const names: string[] = [];
  expression(attr(root, "value"), source, at, (ref) => names.push(ref.name));
  expect(names).toEqual(["status"]);
});

// [body, the assignment's authored start, the members it writes]
test.each([
  ["() => { &a = 1; return true }", "&a = 1", ["a"]],
  ["() => { &a += 1; return true }", "&a += 1", ["a"]],
  ["() => { &a++; return true }", "&a++", ["a"]],
  ["() => { [&a, &b] = [1, 2]; return true }", "[&a, &b] =", ["a", "b"]],
  ["() => { for (&a of [1]) {} return true }", "for (", ["a"]],
  ["() => { &a.x = 1; return true }", "&a.x = 1", ["a"]],
  ["() => { &a[0] = 1; return true }", "&a[0] = 1", ["a"]],
  ["() => { &a.b.c++; return true }", "&a.b.c++", ["a"]],
  ["() => { [&a.x] = [1]; return true }", "[&a.x] =", ["a"]],
] as const)("assignments to a member are reported at the assignment: %s", (body, start, names) => {
  const source = `check value=(${body})\n`;
  const { root, at } = lowered(source);
  const assignments: MemberAssignment[] = [];
  expression(attr(root, "value"), source, at, () => {}, (a) => assignments.push(a));
  expect(assignments).toEqual(
    names.map((name) => ({
      ref: { name, position: at(source.indexOf(`&${name}`)) },
      position: at(source.indexOf(start)),
    })),
  );
});

test.each([
  "() => &a === 1",
  "() => { const x = &a; return x === 1 }",
  "() => { let x = 0; x = &a; return x }",
  "(x = &a) => x",
  "() => { const x = {}; x[&a] = 1; return x }",
  "() => { const x = {}; x.y = &a.z; return x }",
])("reading a member is not an assignment: %s", (body) => {
  const source = `check value=(${body})\n`;
  const { root, at } = lowered(source);
  const assignments: MemberAssignment[] = [];
  expression(attr(root, "value"), source, at, () => {}, (a) => assignments.push(a));
  expect(assignments).toEqual([]);
});

test("tagless lines are lowered member tags; an authored member tag is not", () => {
  const source = 'set\n  &dueOn\n  &done=true\n  member name="title" value=1\n';
  const { root, at } = lowered(source);
  const [dueOn, done, authored] = tagsOf(root.children);
  expect(isMemberLine(dueOn!)).toBe(true);
  expect(readMemberLine(dueOn!, at)).toEqual({ ref: { name: "dueOn", position: at(6) } });
  expect(readMemberLine(done!, at)).toMatchObject({ ref: { name: "done" }, value: { kind: "boolean", name: "value" } });
  expect(isMemberLine(authored!)).toBe(false);
  expect(() => readMemberLine(authored!, at)).toThrow("Expected a tagless member line");
});
