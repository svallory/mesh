// Mesh's v4 reference file through `lowerSource` with `SYNTAX_DIALECT` (ported from MX's `ir-entry/mesh-syntax.test.ts` at MX
// commit 750c80ec1; Mesh owns the syntax now): atoms and the name sugar as layer-2 triggers plus the `&` member rows. The shapes
// the front end reads: a whole-value atom is a `static` attribute carrying `atom`, an atom inside an expression a `StringLiteral`
// marked `extra.mxAtom`, a member a `static` attribute carrying `member` or `extra.mxMember`. The "dialect package" loader is
// covered by `dialect-registration.test.ts`.
import type { Attr, DelegatedTag, LowerSourceOptions, Spanned } from "@mxlang/core";
import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { TRANSACTION } from "../src/front-end/syntax/transaction.ts";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";

const BASE: LowerSourceOptions = { structural: "reject", imports: "pass" };

/** An excerpt of Mesh's entity-file reference (its ADR 0050, `0050-entity-file-syntax.md`), every v4 form once. */
const INVOICE = `import { Customer } from "./customer.mesh.mx"

entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    enum :status values=[:draft, :sent, :paid] default=:draft
    date :dueOn
  relationships
    belongs-to :customer entity=Customer
  computed
    boolean :isOverdue() {
      return &status === :sent && &dueOn < today()
    }
  actions auto=[:read, :destroy] on:load=&visible
    update :send
      do
        set
          &status=:sent
    read :overdue
      filter=() => &isOverdue
      sort
        asc &dueOn
`;

type SpannedTag = Spanned<DelegatedTag>;
type SpannedAttr = Spanned<Attr>;
type SpannedNode = { kind: string };

function tags(nodes: readonly SpannedNode[]): SpannedTag[] {
  return nodes.flatMap((node) =>
    node.kind === "DelegatedTag"
      ? [(node as unknown as { tag: SpannedTag }).tag]
      : [],
  );
}

/** The first tag named `name`, depth first. */
function find(nodes: readonly SpannedNode[], name: string): SpannedTag {
  for (const tag of tags(nodes)) {
    if (tag.name === name) return tag;
    try {
      return find(tag.children, name);
    } catch {
      // not under this one
    }
  }
  throw new Error(`no <${name}>`);
}

function attr(tag: SpannedTag, name: string): SpannedAttr {
  const found = tag.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name} on <${tag.name}>`);
  return found;
}

describe("Mesh's v4 reference file through SYNTAX_DIALECT", () => {
  function parsed() {
    const result = lowerSource(INVOICE, "/v/invoice.mesh.mx", { dialect: SYNTAX_DIALECT, ...BASE });
    expect(result.diagnostics).toEqual([]);
    return result.ir as NonNullable<typeof result.ir>;
  }

  test("a declaration's name is a whole-value atom", () => {
    const ir = parsed();
    expect(attr(find(ir.body, "entity"), "name")).toMatchObject({
      kind: "static",
      value: "Invoice",
      atom: { kind: "atom", name: "Invoice" },
    });
    expect(attr(find(ir.body, "uuid"), "name")).toMatchObject({
      kind: "static",
      value: "id",
      atom: { kind: "atom", name: "id" },
    });
  });

  test("atoms in expressions are marked string literals", () => {
    const ir = parsed();
    const status = find(ir.body, "enum");
    expect(attr(status, "default")).toMatchObject({
      kind: "static",
      value: "draft",
      atom: { kind: "atom", name: "draft" },
    });
    const values = attr(status, "values");
    if (values.kind !== "dynamic") throw new Error(values.kind);
    expect(values.value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        { type: "StringLiteral", value: "draft", extra: { mxAtom: {} } },
        { type: "StringLiteral", value: "sent" },
        { type: "StringLiteral", value: "paid" },
      ],
    });
  });

  test("`:name` then a method is the name and the default value, members inside", () => {
    const overdue = find(parsed().body, "boolean");
    expect(attr(overdue, "name")).toMatchObject({
      kind: "static",
      value: "isOverdue",
      atom: { kind: "atom", name: "isOverdue" },
    });
    const value = attr(overdue, "value");
    expect(value.kind).toBe("dynamic");
    expect(JSON.stringify(value)).toContain('"mxMember"');
    expect(JSON.stringify(value)).toContain('"mxAtom"');
  });

  test("members after a kind, on a tagless line and in a value", () => {
    const ir = parsed();
    expect(attr(find(ir.body, "asc"), "member")).toMatchObject({
      kind: "static",
      value: "dueOn",
      member: { kind: "member", name: "dueOn" },
    });
    const member = find(find(ir.body, "set").children, "member");
    expect(attr(member, "name")).toMatchObject({ value: "status" });
    expect(attr(member, "value")).toMatchObject({
      kind: "static",
      value: "sent",
      atom: { kind: "atom", name: "sent" },
    });
    const load = find(ir.body, "actions").attrs.find(
      (each) => each.kind !== "spread" && each.name.startsWith("on"),
    );
    expect(JSON.stringify(load)).toContain('"mxMember"');
  });
});


describe("a diagnostic in the parsed file has no `file` (it names only another file)", () => {
  const SOURCES = ["enum values=[::x]\n", "<x :a:b/>", "<y x=(/>", "entity :A\n  <for of=[1]|x|>\n  </for>\n"];
  test.each(SOURCES)("%j", (source) => {
    for (const file of ["/v/x.mesh.mx", "relative/x.mesh.mx"]) {
      const { diagnostics } = lowerSource(source, file, { ...BASE, dialect: SYNTAX_DIALECT });
      expect(diagnostics.length, file).toBeGreaterThan(0);
      for (const diagnostic of diagnostics) expect(diagnostic, file).not.toHaveProperty("file");
    }
  });
});

describe("what Mesh's dialect does not read", () => {
  // MX's reference module also carried the `#id` and `.class` shorthand rows; Mesh's copy drops them.
  test("`#` and `.` are no trigger rows", () => {
    const rows = SYNTAX_DIALECT.table.attributeTriggers ?? [];
    expect(rows.map((row) => row.id)).toEqual(["name", "member"]);
    expect((SYNTAX_DIALECT.table.expressionTriggers ?? []).map((row) => row.id)).toEqual(["atom", "member", "transaction"]);
    expect((SYNTAX_DIALECT.table.lineTriggers ?? []).map((row) => row.id)).toEqual(["member"]);
  });
});

describe("the transaction row (SYN-29)", () => {
  test("`%.name` is an expression row only: the row the MX lead gave, an identifier stand-in of the same length", () => {
    expect(TRANSACTION).toEqual({
      id: "transaction",
      chars: "%",
      match: "%\\.[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
      standIn: "identifier",
      node: { call: "transaction" },
    });
    expect(Object.isFrozen(TRANSACTION)).toBe(true);
    for (const list of [SYNTAX_DIALECT.table.attributeTriggers, SYNTAX_DIALECT.table.lineTriggers])
      expect((list ?? []).some((row) => row.id === "transaction")).toBe(false);
    const lower = (body: string) =>
      lowerSource(`entity :T\n  attributes\n    uuid :id primary-key\n  computed\n    boolean :c() { ${body} }\n`, "t.mesh.mx", { ...BASE, dialect: SYNTAX_DIALECT }).diagnostics.map((d) => d.code);
    expect(lower("return %.now.getTime() > %.today.getTime()")).toEqual([]);
    // The lowered node: a member read of `now` on an identifier `%` that no JavaScript name can be, marked with where the
    // authored `%.now` is and its name; the front end reads the mark, never the identifier.
    const source = "entity :T\n  computed\n    boolean :c() { return %.now.getTime() > 0 }\n";
    const { ir } = lowerSource(source, "t.mesh.mx", { ...BASE, dialect: SYNTAX_DIALECT });
    const marked: unknown[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      if ((value as { extra?: { mxTransaction?: unknown } }).extra?.mxTransaction) marked.push(value);
      for (const child of Object.values(value)) walk(child);
    };
    walk(attr(find(ir!.body, "boolean"), "value"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      type: "MemberExpression",
      object: { type: "Identifier", name: "%" },
      property: { type: "Identifier", name: "now" },
      computed: false,
      extra: { mxTransaction: { name: "now", span: { sourceStart: source.indexOf("%.now"), sourceEnd: source.indexOf("%.now") + 5 } } },
    });
    expect(lower("return %.now !== null")).toEqual([]);
    // An operand only: never a modulo, and `%` or `%name` alone is no row.
    for (const body of ["return 1 %.now", "return %now", "return %"]) expect(lower(body), body).toEqual(["MESH_PARSE_EXPRESSION"]);
  });
});

// MX alpha.26 (IR version 4) refuses a write to a read-only binding and reads `await` and prefix operators with new rules; each
// body below is one spaced form Mesh's rows must still lower, with the mark the front end reads (and no MX refusal).
describe("Mesh's rows under MX alpha.26: prefix operators, await and conditionals around a marked operand", () => {
  const lower = (body: string) => {
    const source = `entity :T\n  computed\n    boolean :c() { ${body} }\n`;
    const { ir, diagnostics } = lowerSource(source, "t.mesh.mx", { ...BASE, dialect: SYNTAX_DIALECT });
    const marked: { kind: "member" | "transaction"; name: string }[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      const extra = (value as { extra?: { mxMember?: { name?: string }; mxTransaction?: { name: string } } }).extra;
      if (extra?.mxMember) marked.push({ kind: "member", name: String(extra.mxMember.name) });
      if (extra?.mxTransaction) marked.push({ kind: "transaction", name: extra.mxTransaction.name });
      for (const child of Object.values(value)) walk(child);
    };
    if (ir) walk(attr(find(ir.body, "boolean"), "value"));
    return { codes: diagnostics.map((d) => d.code), marked, ir };
  };

  test("`++&n` lowers a prefix update of one member reference, with no MX refusal", () => {
    const { codes, marked, ir } = lower("return ++ &n");
    expect(codes).toEqual([]);
    expect(marked).toEqual([{ kind: "member", name: "n" }]);
    expect(JSON.stringify(attr(find(ir!.body, "boolean"), "value"))).toContain('"UpdateExpression"');
  });

  test("`++%.now` lowers the transaction mark under a prefix update (Mesh's front end refuses the write, MX does not)", () => {
    const { codes, marked } = lower("return ++ %.now");
    expect(codes).toEqual([]);
    expect(marked).toEqual([{ kind: "transaction", name: "now" }]);
  });

  test("`await &dueAt`, `{ k: await &a }` and `c ? await &a : 1` keep the member reference", () => {
    for (const body of ["return await &dueAt", "return { k: await &a }", "return c ? await &a : 1"]) {
      const { codes, marked } = lower(body);
      expect(codes, body).toEqual([]);
      expect(marked, body).toEqual([{ kind: "member", name: body.includes("&dueAt") ? "dueAt" : "a" }]);
    }
  });
});
