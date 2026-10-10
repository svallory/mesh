// Mesh's v4 reference file through `lowerSource` with `MESH_DIALECT` (ported from MX's `ir-entry/mesh-syntax.test.ts` at MX
// commit 750c80ec1; Mesh owns the syntax now): atoms and the name sugar as layer-2 triggers plus the `&` member rows. The shapes
// the front end reads: a whole-value atom is a `static` attribute carrying `atom`, an atom inside an expression a `StringLiteral`
// marked `extra.mxAtom`, a member a `static` attribute carrying `member` or `extra.mxMember`. The "dialect package" loader is
// covered by `dialect-registration.test.ts`.
import type { Attr, DelegatedTag, LowerSourceOptions, Spanned } from "@mxlang/core";
import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

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

describe("Mesh's v4 reference file through MESH_DIALECT", () => {
  function parsed() {
    const result = lowerSource(INVOICE, "/v/invoice.mesh.mx", { dialect: MESH_DIALECT, ...BASE });
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
      const { diagnostics } = lowerSource(source, file, { ...BASE, dialect: MESH_DIALECT });
      expect(diagnostics.length, file).toBeGreaterThan(0);
      for (const diagnostic of diagnostics) expect(diagnostic, file).not.toHaveProperty("file");
    }
  });
});

describe("what Mesh's dialect does not read", () => {
  // MX's reference module also carried the `#id` and `.class` shorthand rows; Mesh's copy drops them.
  test("`#` and `.` are no trigger rows", () => {
    const rows = MESH_DIALECT.table.attributeTriggers ?? [];
    expect(rows.map((row) => row.id)).toEqual(["name", "member"]);
    expect((MESH_DIALECT.table.expressionTriggers ?? []).map((row) => row.id)).toEqual(["atom", "member"]);
    expect((MESH_DIALECT.table.lineTriggers ?? []).map((row) => row.id)).toEqual(["member"]);
  });
});
