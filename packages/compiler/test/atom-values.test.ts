import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { atomOf, containsAtom, valueOf, type Attr } from "../src/front-end/tree.ts";
import { parse } from "./helpers.ts";

// Atoms in value position (`type`-like options, `values=[...]`, `via=:x`, `on=:create`) arrive through
// Mesh's own `mesh:Atom` node type (`syntax/mesh.ts`). These pin that the front end reads each one as the atom it
// was on alpha.15, and that MX's atom contract checks still see them (`ContractAttr` has no atom kind
// until MX's slice c, so a blind check would show here as a missing diagnostic).
const head = 'import { User } from "./user.mesh.mx"\nentity :Post\n  attributes\n    uuid :id primary-key\n';
const diagnostics = (body: string) => parse(head + body, "x.mesh.mx").diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);

describe("normalisation", () => {
  const span = { sourceStart: 0, sourceEnd: 5 };
  const base = { kind: "static", name: "via", value: "owner", nameSpan: span, valueSpan: span } as const;
  test("the atom mark reads as one atom", () => {
    const marked = { ...base, atom: { kind: "atom", name: "owner", span } } as unknown as Attr;
    expect(atomOf(marked)?.name).toBe("owner");
    expect(valueOf(marked)).toEqual({ value: "owner" });
    expect(containsAtom(marked)).toBe(true);
  });
  test("a plain string is not an atom, and a node on the attribute does not make it one", () => {
    const plain = { ...base } as unknown as Attr;
    const withNode = { ...base, node: { type: "mesh:Atom", name: "owner", span } } as unknown as Attr;
    expect(atomOf(plain)).toBeUndefined();
    expect(atomOf(withNode)).toBeUndefined();
    expect(valueOf(plain)).toBe("owner");
  });
  test("a whole-value atom lowers to the atom-marked static attribute, with `node` unset", () => {
    const { ir, diagnostics } = lowerSource("<a via=:owner/>", "/v/x.mesh.mx", { dialect: MESH_DIALECT });
    expect(diagnostics).toEqual([]);
    const node = ir?.body[0];
    const attr = node?.kind === "DelegatedTag" ? node.tag.attrs[0] : undefined;
    expect(attr?.kind).toBe("static");
    if (attr?.kind !== "static") return;
    expect(attr.atom?.name).toBe("owner");
    expect(attr.node).toBeUndefined();
  });
});

describe("the atom contract checks see value atoms", () => {
  test("accepted forms", () => {
    expect(diagnostics("    timestamp :t on=:create\n")).toEqual([]);
    expect(diagnostics('    enum :s values=[:a, :b-c] default=:a\n')).toEqual([]);
    expect(diagnostics("    string :a\n  relationships\n    has-many :xs entity=User via=:owner\n")).toEqual([]);
  });
  test.each([
    ["a value outside the fixed set", "    timestamp :t on=:bogus\n", "`:bogus` is not one of :create, :update"],
    ["a string where an atom is required", '    timestamp :t on="create"\n', "must be atom, got string"],
    ["an expression where an atom is required", "    timestamp :t on=(1)\n", "must be atom, got number"],
    ["a string via", '    string :a\n  relationships\n    has-many :xs entity=User via="owner"\n', "`via` must be atom, got string"],
    ["a via that breaks the pattern", "    string :a\n  relationships\n    has-many :xs entity=User via=:Own-er\n", "does not match the pattern"],
    ["a string in a list of atoms", '    enum :s values=[:a, "b"]\n', "must be atom, got string"],
    ["a repeated atom in a list", "    enum :s values=[:a, :a]\n", "MESH_ATOM_LIST"],
  ])("rejects %s", (_name, body, message) => {
    const found = diagnostics(body);
    expect(found.length).toBe(1);
    expect(found[0]).toContain(message);
  });
});
