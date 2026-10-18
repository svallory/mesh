import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";
import { atomForwards, atomList, atomOf, containsAtom, readLiteral, valueOf, type Attr } from "../src/front-end/tree.ts";
import { parse } from "./helpers.ts";

// Atoms in value position (`type`-like options, `values=[...]`, `inverse=:x`, `on=:create`) arrive through
// Mesh's own `mesh:Atom` node type (`syntax/mesh.ts`). These pin that the front end reads each one as the atom it
// was on alpha.15, and that MX's atom contract checks still see them (`ContractAttr` has no atom kind
// until MX's slice c, so a blind check would show here as a missing diagnostic).
const head = 'import { User } from "./user.mesh.mx"\nentity :Post\n  attributes\n    uuid :id primary-key\n';
const diagnostics = (body: string) => parse(head + body, "x.mesh.mx").diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);

describe("normalisation", () => {
  const span = { sourceStart: 0, sourceEnd: 5 };
  const base = { kind: "static", name: "inverse", value: "owner", nameSpan: span, valueSpan: span } as const;
  test("the atom mark reads as one atom", () => {
    const marked = { ...base, node: { type: "mesh:Atom", name: "owner", span } } as unknown as Attr;
    expect(atomOf(marked)?.name).toBe("owner");
    expect(valueOf(marked)).toEqual({ value: "owner" });
    expect(containsAtom(marked)).toBe(true);
  });
  test("a plain string is not an atom, and a node of another type on the attribute does not make it one", () => {
    const plain = { ...base } as unknown as Attr;
    const withNode = { ...base, node: { type: "other:Thing", name: "owner", span } } as unknown as Attr;
    expect(atomOf(plain)).toBeUndefined();
    expect(atomOf(withNode)).toBeUndefined();
    expect(valueOf(plain)).toBe("owner");
  });
  test("a whole-value atom lowers to a static attribute carrying the `mesh:Atom` node", () => {
    const { ir, diagnostics } = lowerSource("<a inverse=:owner/>", "/v/x.mesh.mx", { dialect: SYNTAX_DIALECT });
    expect(diagnostics).toEqual([]);
    const node = ir?.body[0];
    const attr = node?.kind === "DelegatedTag" ? node.tag.attrs[0] : undefined;
    expect(attr?.kind).toBe("static");
    if (attr?.kind !== "static") return;
    expect(attr.node).toMatchObject({ type: "mesh:Atom", name: "owner" });
    expect(attr.value).toBe("owner");
  });
});

// MX 0.1.0-alpha.33 lists the atoms of an expression in `Expr.nodes`, each with its forward (the string literal that
// stands in its place). Mesh finds an atom by the forward's identity; the `extra.mxAtom` mark on a literal (which MX
// stops carrying in alpha.34) makes nothing an atom, and its absence makes nothing a plain string.
describe("an atom inside an expression is found by identity, never by the mark", () => {
  const span = (sourceStart: number, sourceEnd: number) => ({ sourceStart, sourceEnd });
  // `values=[:a, "b"]`, built by hand: `:a`'s forward carries no mark, and `"b"` carries a forged one.
  const listed = { type: "StringLiteral", value: "a" };
  const forged = { type: "StringLiteral", value: "b", extra: { mxAtom: { span: span(12, 15) } } };
  const list = (elements: object[], nodes: object[]) =>
    ({
      kind: "dynamic",
      name: "values",
      value: { code: "", span: span(7, 17), node: { type: "ArrayExpression", elements }, nodes },
      nameSpan: span(0, 6),
      valueSpan: span(7, 17),
    }) as unknown as Attr;
  const atomA = { type: "mesh:Atom", span: span(8, 10), node: { type: "mesh:Atom", name: "a", span: span(8, 10) }, forward: listed };

  test("a listed forward is an atom without a mark", () => {
    const a = list([listed], [atomA]);
    expect(atomForwards(a).get(listed)).toEqual(span(8, 10));
    expect(atomList(a)).toEqual(["a"]);
    expect(containsAtom(a)).toBe(true);
    expect(valueOf(a)).toEqual([{ value: "a" }]);
  });
  test("a marked literal that is not listed is a plain string", () => {
    const a = list([listed, forged], [atomA]);
    expect(() => atomList(a)).toThrow("Each value in this list must be an atom");
    expect(valueOf(a)).toEqual([{ value: "a" }, "b"]);
    expect(containsAtom(list([forged], []))).toBe(false);
    expect(readLiteral(forged as never)).toBe("b");
  });
  test("an equal literal that is not the forward itself is a plain string", () => {
    const twin = { type: "StringLiteral", value: "a" };
    expect(valueOf(list([twin], [atomA]))).toEqual(["a"]);
  });
  test("a static, boolean or missing option holds no expression atoms", () => {
    expect(atomForwards(undefined).size).toBe(0);
    expect(atomForwards({ kind: "boolean", name: "x", nameSpan: span(0, 1) } as unknown as Attr).size).toBe(0);
  });
  test("a lowered `values=[:a, :b]` lists both atoms, each forward the very element of the array", () => {
    const { ir, diagnostics } = lowerSource("<a values=[:a, :b]/>", "/v/x.mesh.mx", { dialect: SYNTAX_DIALECT });
    expect(diagnostics).toEqual([]);
    const node = ir?.body[0];
    const attr = node?.kind === "DelegatedTag" ? node.tag.attrs[0] : undefined;
    if (attr?.kind !== "dynamic") throw new Error(String(attr?.kind));
    const elements = (attr.value.node as { elements: object[] }).elements;
    expect(attr.value.nodes?.map((each) => [each.type, each.forward === elements[attr.value.nodes!.indexOf(each)]])).toEqual([
      ["mesh:Atom", true],
      ["mesh:Atom", true],
    ]);
    expect(atomList(attr)).toEqual(["a", "b"]);
  });
});

describe("the atom contract checks see value atoms", () => {
  test("accepted forms", () => {
    expect(diagnostics("    timestamp :t on=:create\n")).toEqual([]);
    expect(diagnostics('    enum :s values=[:a, :b-c] default=:a\n')).toEqual([]);
    expect(diagnostics("    string :a\n  relationships\n    has-many :xs entity=User inverse=:owner\n")).toEqual([]);
  });
  test.each([
    ["a value outside the fixed set", "    timestamp :t on=:bogus\n", "`:bogus` is not one of :create, :update"],
    ["a string where an atom is required", '    timestamp :t on="create"\n', "must be mesh:Atom, got string"],
    ["an expression where an atom is required", "    timestamp :t on=(1)\n", "must be mesh:Atom, got number"],
    ["a string inverse", '    string :a\n  relationships\n    has-many :xs entity=User inverse="owner"\n', "`inverse` must be mesh:Atom, got string"],
    ["a inverse that breaks the pattern", "    string :a\n  relationships\n    has-many :xs entity=User inverse=:Own-er\n", "does not match the pattern"],
    ["a string in a list of atoms", '    enum :s values=[:a, "b"]\n', "item 2 must be mesh:Atom, got string"],
    ["a repeated atom in a list", "    enum :s values=[:a, :a]\n", "must be non-empty with no repeated values"],
  ])("rejects %s", (_name, body, message) => {
    const found = diagnostics(body);
    expect(found.length).toBe(1);
    expect(found[0]).toContain(message);
  });
});
