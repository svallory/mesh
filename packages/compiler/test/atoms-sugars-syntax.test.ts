// Mesh's atoms and name sugar through `lowerSource` with `MESH_DIALECT` (ported from MX's `atoms-sugars-syntax.test.ts` at MX
// commit 750c80ec1). MX's copy compared the module with core's built-in path; that path is core's to delete, so the texts and
// positions it gave are pinned here as literals (checked equal to the built-in path when this was ported, less the decision
// numbers, which Mesh's messages never quote). Tests of core's trigger hook contract (`ctx.shorthand`, `ctx.use`, `ctx.fail`
// options and the `#id`/`.class` rows) are MX's, not Mesh's, and are not ported.
import type { Attr, DelegatedTag, Spanned } from "@mxlang/core";
import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { ATOM, NAME_SUGAR, atomsHooks } from "../src/front-end/syntax/atoms-sugars.ts";
import { MEMBER } from "../src/front-end/syntax/member.ts";
import { ATOM_VALUE, MESH_SYNTAX } from "../src/front-end/syntax/mesh.ts";

const lower = (source: string) => lowerSource(source, "/v/x.mesh.mx", { dialect: MESH_DIALECT });

function firstTag(source: string): Spanned<DelegatedTag> {
  const result = lower(source);
  expect(result.diagnostics).toEqual([]);
  const node = result.ir?.body.find((each) => each.kind === "DelegatedTag");
  if (node?.kind !== "DelegatedTag") throw new Error("no tag");
  return node.tag;
}

function attr(tag: Spanned<DelegatedTag>, name: string): Attr {
  const found = tag.attrs.find((each) => each.kind !== "spread" && each.name === name);
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

/** The first diagnostic as `[message, line, column]`. */
const firstError = (source: string) => {
  const [first] = lower(source).diagnostics;
  return first && [first.message, first.line, first.column];
};

describe("atoms in every position", () => {
  test.each([
    ["a whole value", "<div x=:a/>", "x", { kind: "static", value: "a", atom: { kind: "atom", name: "a" } }],
    ["a name", "<input type='email' :email/>", "name", { kind: "static", value: "email", atom: { kind: "atom", name: "email" } }],
    ["a hyphenated name", "kind :first-name\n", "name", { kind: "static", value: "first-name", atom: { name: "first-name" } }],
    ["a name with a default value", "kind :n=1\n", "name", { kind: "static", value: "n", atom: { name: "n" } }],
    ["`async` before nothing is no method", "kind async :n\n", "name", { kind: "static", value: "n" }],
  ])("%s", (_, source, name, expected) => {
    expect(attr(firstTag(source), name)).toMatchObject(expected);
  });

  test("atoms in a list, a ternary and a comparison are marked string literals", () => {
    const tag = firstTag("<div x=[:draft, :sent] y=(c ? :a : :b)/>");
    const x = attr(tag, "x");
    if (x.kind !== "dynamic") throw new Error(x.kind);
    expect(x.value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        { type: "StringLiteral", value: "draft", extra: { mxAtom: { span: { sourceStart: 8, sourceEnd: 14 } } } },
        { type: "StringLiteral", value: "sent", extra: { mxAtom: {} } },
      ],
    });
    const y = attr(tag, "y");
    if (y.kind !== "dynamic") throw new Error(y.kind);
    expect(y.value.code).toBe('c ? "a" : "b"');
  });

  test("a second `:name` is the duplicate rule (a warning, last wins), not a parse error", () => {
    const result = lower("<div :a :b/>");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ severity: "warning" });
  });

  test("the combined dialect keeps the member rows beside the atom rows", () => {
    const tag = firstTag("sort asc &dueOn :n x=[&a, :b]\n");
    expect(attr(tag, "member")).toMatchObject({ kind: "static", value: "dueOn" });
    expect(attr(tag, "name")).toMatchObject({ kind: "static", value: "n", atom: { name: "n" } });
    const x = attr(tag, "x");
    if (x.kind !== "dynamic") throw new Error(x.kind);
    expect(x.value.code).toBe('[self.a, "b"]');
  });
});

describe("what the atom rows refuse, in Mesh's words", () => {
  const misuse = (what: string) =>
    `\`:a\` is an atom, a name and not a value to operate on: ${what} is not allowed on it; write \`"a"\` for a string you mean to operate on`;
  test.each([
    ["<div x=(:a).b/>", misuse("member access"), 8],
    ["<div x=(:a)()/>", misuse("a call"), 8],
    ["<div x=-:a/>", misuse("the unary operator `-`"), 8],
    ["<div x=typeof :a/>", misuse("the unary operator `typeof`"), 14],
    ["<div x=[...:a]/>", misuse("spreading"), 11],
    ["<div ...:a/>", misuse("spreading"), 8],
    [
      "<div x={ :a: 1 }/>",
      "`:a` cannot be an object key: an atom is a value; write `a:` for the key, or `[:a]` to compute it from the atom",
      9,
    ],
    ["<div x=::a/>", "`::a` is reserved: `::` will be the Symbol.for sugar; write `:a` for an atom", 7],
  ])("%s", (source, message, column) => {
    expect(firstError(source)).toEqual([message, 1, column]);
    expect(message).not.toContain("decision");
  });

  test("a call that takes an atom as an argument is fine", () => {
    expect(lower("<div x=f(:a)/>").diagnostics).toEqual([]);
  });

  test("`:a:b` in one token is one name too many", () => {
    expect(firstError("<x :a:b/>")).toEqual(["a tag takes one `:name`; this one already has a name (write the second as `name=\"…\"`)", 1, 5]);
  });

  test.each([
    ["<x :a(p)/>", "arguments are not allowed on `:name`: `:a(…)` is name sugar, not an attribute method", 3],
    ["<x :n:=y/>", "a bound value is not supported on name sugar; write name=... value:=...", 3],
    [
      "<x=1 :n=2/>",
      '`:n` right after a default value is not supported; put it before the value or on the tag (`<input:email type="email">`).',
      5,
    ],
  ])("%s", (source, message, column) => {
    expect(firstError(source)).toEqual([message, 1, column]);
  });

  test.each([
    ["<x value=1 :n=2/>", "`:n=2`", 14],
    ["<x value:=y :n=1/>", "`:n=1`", 15],
    ["<x :n=1 value=2/>", "`value=2`", 8],
    ["<x :a=1 :b=2/>", "`:b=2`", 11],
  ])("%s: a second default value is refused at the later one", (source, written, column) => {
    const [message, line, col] = firstError(source) ?? [];
    expect(message).toContain(`${written} would set the default attribute (\`value\`), but the tag already has a default value`);
    expect([line, col]).toEqual([1, column]);
  });

  test.each([
    ["kind async :n(p) { b }\n", 11],
    ["<x async :n<T>(p: T) { b }/>", 9],
  ])("%j: an async method on `:name` is refused, at the `:name`", (source, column) => {
    expect(firstError(source)).toEqual([
      "`async :n(…) { … }` is not supported: a `:name` method value cannot be async; remove `async`",
      1,
      column,
    ]);
  });
});

describe("the rows", () => {
  test("are frozen data a manifest can name", () => {
    for (const row of [ATOM, NAME_SUGAR, MEMBER, ATOM_VALUE]) expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(MESH_DIALECT)).toBe(true);
    expect(Object.isFrozen(MESH_SYNTAX.table)).toBe(true);
  });

  test("the hooks that carry the atom contracts are all there", () => {
    expect(Object.keys(atomsHooks).sort()).toEqual(["afterLower", "checkContract", "contractFields", "describeAttribute", "lowerTrigger"]);
    expect(MESH_DIALECT.contractFields).toEqual({ attribute: ["values", "pattern", "ref"], tag: ["declares"] });
    expect(typeof MESH_DIALECT.checkContract).toBe("function");
    expect(typeof MESH_DIALECT.afterLower).toBe("function");
    expect(typeof MESH_DIALECT.describeAttribute).toBe("function");
  });
});
