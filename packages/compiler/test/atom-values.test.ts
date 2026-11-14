import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";
import { buildModel } from "../src/front-end/build.ts";
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
// stands in its place). Mesh finds an atom by the forward's identity; an `extra.mxAtom` mark on a literal (which MX
// no longer sets since alpha.34) makes nothing an atom, and its absence makes nothing a plain string.
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
    ["a string where an atom is required", '    timestamp :t on="create"\n', "must be atom, got string"],
    ["an expression where an atom is required", "    timestamp :t on=(1)\n", "must be atom, got number"],
    ["a string inverse", '    string :a\n  relationships\n    has-many :xs entity=User inverse="owner"\n', "`inverse` must be atom, got string"],
    ["a inverse that breaks the pattern", "    string :a\n  relationships\n    has-many :xs entity=User inverse=:Own-er\n", "does not match the pattern"],
    ["a string in a list of atoms", '    enum :s values=[:a, "b"]\n', "item 2 must be atom, got string"],
    ["a repeated atom in a list", "    enum :s values=[:a, :a]\n", "must be non-empty with no repeated values"],
  ])("rejects %s", (_name, body, message) => {
    const found = diagnostics(body);
    expect(found.length).toBe(1);
    expect(found[0]).toContain(message);
  });
});

// An atom slot takes one atom and nothing else. Core's node-type check refuses what it can type (a string, a number, a
// list, a member) and passes an identifier or any other expression, which the builder then read as no atom at all:
// `inverse=other` kept the inferred inverse, `on=create` left the timestamp unmanaged and `run [after=write]` ran before
// the write, each with no diagnostic. `checkAtomSlots` (Mesh's `afterLower`, `syntax/atoms-sugars.ts`) refuses the value
// where it is written, and in a list of atoms the item that is none.
describe("an atom slot refuses an identifier or any other expression", () => {
  const found = (body: string) => parse(head + body, "x.mesh.mx").diagnostics.map((d) => [d.code, `${d.line}:${d.column}`, d.message]);
  // Each fixture puts the value on the line and column the case names; the body starts on line 5 of the file.
  const inverse = (value: string) => `  relationships\n    has-many :xs entity=User inverse=${value}\n`;
  const on = (value: string) => `    timestamp :at on=${value}\n`;
  const after = (value: string) => `  actions auto=[:read]\n    update :go\n      do\n        run [after=${value}] ({ self }) { console.log(self) }\n`;
  const auto = (list: string) => `  actions auto=${list}\n`;
  const types = (list: string) => `  actions auto=[:read]\n    update :go\n    always types=${list}\n      validate\n        check :ok that=() => true code="a" message="m"\n`;
  const values = (list: string) => `    enum :s values=${list}\n`;
  const ACTIONS = " (one of :create, :destroy, :read, :update)";

  test.each([
    ["an identifier names its atom", inverse("other"), "6:37", "`has-many`: option `inverse` must be atom, got expression; write it as `:other`"],
    ["a member access has no atom to write", inverse("a.b"), "6:37", "`has-many`: option `inverse` must be atom, got expression"],
    ["a call", inverse("pick()"), "6:37", "`has-many`: option `inverse` must be atom, got expression"],
    ["`null`", inverse("null"), "6:37", "`has-many`: option `inverse` must be atom, got expression"],
    ["`undefined` is an identifier nobody means as a name", inverse("undefined"), "6:37", "`has-many`: option `inverse` must be atom, got expression"],
    ["the transaction's instant", inverse("%.now"), "6:37", "`has-many`: option `inverse` must be atom, got expression"],
    ["two atoms in a conditional, at the expression inside the parentheses", inverse("(c ? :owner : :other)"), "6:38", "`has-many`: option `inverse` must be atom, got expression"],
    ["an identifier in parentheses", inverse("(other)"), "6:38", "`has-many`: option `inverse` must be atom, got expression; write it as `:other`"],
    ["an identifier under `as`", inverse("other as any"), "6:37", "`has-many`: option `inverse` must be atom, got expression; write it as `:other`"],
    ["an identifier the slot's pattern refuses as an atom", inverse("$other"), "6:37", "`has-many`: option `inverse` must be atom, got expression"],
    ["an identifier of the fixed set", on("create"), "5:21", "`timestamp`: option `on` must be atom, got expression (one of :create, :update); write it as `:create`"],
    ["an identifier outside the fixed set gets the set, not an atom the set refuses", on("nope"), "5:21", "`timestamp`: option `on` must be atom, got expression (one of :create, :update)"],
    ["`after=write`", after("write"), "8:19", "`run`: option `after` must be atom, got expression (one of :write); write it as `:write`"],
  ])("a single atom: %s", (_name, body, at, message) => {
    expect(found(body)).toEqual([["MESH_OPTION_VALUE", at, message]]);
  });

  test.each([
    ["`auto=[read]`", auto("[read]"), "5:16", `\`actions\`: option \`auto\` item 1 must be atom, got expression${ACTIONS}; write it as \`:read\``],
    ["an identifier before a string comes first", auto('[read, "destroy"]'), "5:16", `\`actions\`: option \`auto\` item 1 must be atom, got expression${ACTIONS}; write it as \`:read\``],
    ["the item that is no atom, not the first", auto("[:read, destroy]"), "5:23", `\`actions\`: option \`auto\` item 2 must be atom, got expression${ACTIONS}; write it as \`:destroy\``],
    ["an item on a line of its own", auto("[\n    :read,\n    destroy,\n  ]"), "7:4", `\`actions\`: option \`auto\` item 2 must be atom, got expression${ACTIONS}; write it as \`:destroy\``],
    ["an identifier outside the fixed set", auto("[:read, list]"), "5:23", `\`actions\`: option \`auto\` item 2 must be atom, got expression${ACTIONS}`],
    ["a member access", auto("[:read, a.b]"), "5:23", `\`actions\`: option \`auto\` item 2 must be atom, got expression${ACTIONS}`],
    ["a spread", auto("[:read, ...rest]"), "5:23", `\`actions\`: option \`auto\` item 2 must be atom, got expression${ACTIONS}`],
    ["an empty item, at the list", auto("[:read, , :destroy]"), "5:15", `\`actions\`: option \`auto\` item 2 must be atom, got nothing${ACTIONS}`],
    ["`types=[read]`", types("[read]"), "7:18", `\`always\`: option \`types\` item 1 must be atom, got expression${ACTIONS}; write it as \`:read\``],
    ["`values=[a, b]`, at the first: two identifiers are not a repeated value", values("[a, b]"), "5:20", "`enum`: option `values` item 1 must be atom, got expression; write it as `:a`"],
    ["an identifier after an enum's atoms", values("[:a, :b-c, d]"), "5:30", "`enum`: option `values` item 3 must be atom, got expression; write it as `:d`"],
  ])("a list of atoms: %s", (_name, body, at, message) => {
    expect(found(body)).toEqual([["MESH_OPTION_VALUE", at, message]]);
  });

  test("the atom, alone or inside parentheses or `as`, stays accepted", () => {
    for (const body of [
      inverse(":owner"), inverse("(:owner)"), inverse("(:owner as const)"),
      on(":create"), on("(:update)"),
      after(":write"),
      auto("[:read]"), auto("[(:read), :destroy]"),
      types("[:update]"),
      values("[:a, :b-c]"),
    ])
      expect(found(body)).toEqual([]);
  });

  test("an identifier where the option takes a reference stays accepted: the slot is the contract's, not the option's name", () => {
    // `entity=User` in every relationship above. An action's `on=` is a command reference; a timestamp's is an atom.
    const command = 'import { Rename } from "./rename.mesh.mx"\nentity :Post\n  attributes\n    uuid :id primary-key\n  actions\n    update on=Rename\n';
    expect(parse(command, "x.mesh.mx").diagnostics).toEqual([]);
  });

  test.each([
    ["a string keeps core's wording", inverse('"owner"'), ["MESH_OPTION_VALUE", "6:37", "`has-many`: option `inverse` must be atom, got string"]],
    ["a member keeps core's wording", inverse("&owner"), ["MESH_OPTION_VALUE", "6:37", "`has-many`: option `inverse` must be atom, got member"]],
    ["a string in parentheses keeps core's wording", on('("create")'), ["MESH_OPTION_VALUE", "5:22", "`timestamp`: option `on` must be atom, got string (one of :create, :update)"]],
    ["a string in a list keeps core's wording", auto('["read"]'), ["MESH_OPTION_VALUE", "5:16", `\`actions\`: option \`auto\` item 1 must be atom, got string${ACTIONS}`]],
    ["a string before an identifier in a list comes first", auto('["read", destroy]'), ["MESH_OPTION_VALUE", "5:16", `\`actions\`: option \`auto\` item 1 must be atom, got string${ACTIONS}`]],
    ["a number in a list keeps core's wording", auto("[:read, 1]"), ["MESH_OPTION_VALUE", "5:23", `\`actions\`: option \`auto\` item 2 must be atom, got number${ACTIONS}`]],
    ["an atom outside the fixed set is still the set's error", on(":bogus"), ["MESH_SYNTAX", "5:21", "`timestamp`: option `on`: `:bogus` is not one of :create, :update"]],
    ["an atom outside the fixed set comes before the shape of the expression around it", on("(c ? :create : :bogus)"), ["MESH_SYNTAX", "5:36", "`timestamp`: option `on`: `:bogus` is not one of :create, :update"]],
    ["an identifier in the name slot is the name's error", "    string name=title\n", ["MESH_NAME", "5:11", "`string`: a declaration needs one atom name"]],
    ["an identifier for the whole list", auto("read"), ["MESH_ATOM_LIST", "5:10", "`actions`: auto must be a list of atoms"]],
    ["an empty list", auto("[]"), ["MESH_ATOM_LIST", "5:10", "`actions`: auto must be non-empty with no repeated values"]],
    ["a repeated atom beside an identifier", values("[:a, b, :a]"), ["MESH_ATOM_LIST", "5:12", "`enum`: values must be non-empty with no repeated values"]],
  ])("the errors around it keep their code: %s", (_name, body, expected) => {
    expect(found(body)).toEqual([expected]);
  });

  // The three that built a wrong model in silence: the build now stops at the value.
  test.each([
    ["`inverse=other` (the inferred inverse was kept)", "    string :a\n  relationships\n    has-many :xs entity=User inverse=other\n", 7, 37],
    ["`on=create` (the timestamp was not managed)", "    timestamp :at on=create\n", 5, 21],
    ["`run [after=write]` (the step ran before the write)", after("write"), 8, 19],
  ])("the build fails on %s", (_name, body, line, column) => {
    const user = 'import { Post } from "./x.mesh.mx"\nentity :User\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :post entity=Post\n    belongs-to :other entity=Post\n';
    const built = buildModel({ root: "/p", files: [{ file: "x.mesh.mx", source: head + body }, { file: "user.mesh.mx", source: user }] });
    expect(built.diagnostics.map((d) => [d.severity, d.code, d.position.file, d.position.line, d.position.column])).toEqual([["error", "MESH_OPTION_VALUE", "x.mesh.mx", line, column]]);
  });

  // The slot is the contract's, not a name: any `mesh:Atom` option of any tag, and any list of them.
  const slot = (declaration: object, source: string) =>
    lowerSource(source, "/v/x.mesh.mx", { dialect: { ...SYNTAX_DIALECT, contracts: { box: { attributes: { mode: declaration, label: { type: "string" } } } } } as never }).diagnostics.map((d) => [d.code, d.message]);
  test("a contract's own atom slot, with no fixed set or pattern", () => {
    expect(slot({ type: "mesh:Atom" }, "box mode=strict\n")).toEqual([["MESH_OPTION_VALUE", "`box`: option `mode` must be atom, got expression; write it as `:strict`"]]);
    expect(slot({ type: "array", items: "mesh:Atom" }, "box mode=[:a, strict]\n")).toEqual([["MESH_OPTION_VALUE", "`box`: option `mode` item 2 must be atom, got expression; write it as `:strict`"]]);
    // An identifier `:name` cannot spell has no atom to write.
    expect(slot({ type: "mesh:Atom" }, "box mode=café\n")).toEqual([["MESH_OPTION_VALUE", "`box`: option `mode` must be atom, got expression"]]);
    expect(slot({ type: "mesh:Atom" }, "box mode=:strict label=strict\n")).toEqual([]);
    expect(slot({ type: "array", items: "mesh:Atom" }, "box mode=[:a, :b]\n")).toEqual([]);
    // A list of anything else is not a list of atoms.
    expect(slot({ type: "array" }, "box mode=[a, b]\n")).toEqual([]);
    expect(slot({ type: "array", items: "string" }, 'box mode=["a", b]\n')).toEqual([]);
  });
});
