// An atom names one of an enum's values, so a function compares it only with an enum: an enum attribute, a related
// record's, or an input field Mesh types as an enum (an `enum` argument, a member input of an enum attribute). Compared
// with anything else it is the build error MESH_EXPR_ATOM, whose fix writes the string. Pure builds, no generated files.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/front-end/build.ts";

interface Places {
  /** `that=` of a check of the update `:go`, whose input is typed. */
  check?: string;
  /** `that=` of a check of the create `:open`, which takes `&title` and `&state` as member inputs. */
  createCheck?: string;
  /** A line of the `do` block of `:go`. */
  step?: string;
  /** A line of the `computed` section. */
  computed?: string;
  /** A check line of the policy that covers the writes. */
  policy?: string;
  /** `filter=` of the read `:some`. */
  filter?: string;
  /** `that=` of a check of an `always` block that covers `:go`. */
  always?: string;
  imports?: string;
}
/** A Ticket with one member of each type class, an update with typed arguments and member inputs, a create, a read and two policies. */
const ticket = (at: Places) => `import { Ticket } from "./ticket.mesh.mx"
${at.imports ?? ""}entity :Ticket
  attributes
    uuid :id primary-key
    string :title
    integer :n
    boolean :ok default=false
    timestamp :dueAt nullable
    json :meta
    enum :state values=[:open, :done] default=:open
    enum :flag values=[:a, :b] nullable
  relationships
    belongs-to :parent entity=Ticket nullable
    has-many :children entity=Ticket
  computed
    boolean :settled value=() => &state === :done
${at.computed ? `    ${at.computed}\n` : ""}  policies
    policy :readers types=[:read]
      authorize-if=() => true
    policy :writers types=[:create, :update, :destroy]
      authorize-if=({ actor }) => actor.id !== null
${at.policy ? `      ${at.policy}\n` : ""}  actions auto=[:destroy]
${at.always ? `    always actions=[&go]\n      validate\n        check :every that=${at.always} code="every" message="m"\n` : ""}    read :some
      filter=${at.filter ?? "() => &state !== :done"}
    create :open
      input
        &title
        &n
        &state
      validate
        check :fresh that=${at.createCheck ?? "({ input }) => input.state !== :done"} code="fresh" message="m"
    update :go
      input
        &state
        &title
        string :note
        integer :count
        enum :outcome values=[:released, :revoked]
      validate
        check :c that=${at.check ?? "({ input }) => input.outcome !== :revoked"} code="c" message="m"
      do
        ${at.step ?? "set\n          &ok=({ before }) => before.state === :open"}
`;
const diagnosticsOf = (source: string) => buildModel({ root: "/p", files: [{ file: "ticket.mesh.mx", source }] }).diagnostics;
/** Each diagnostic as `[severity, code, the source text it points at]`. */
const brief = (source: string, length = 2) => diagnosticsOf(source).map((d) => [d.severity, d.code, source.slice(d.position.offset, d.position.offset + length)]);
const message = (atom: string, other: string) => `:${atom} is compared with ${other}, and an atom is compared only with an enum: it names one of the enum's values`;
const fix = (atom: string) => `write the string \`"${atom}"\``;
const UNTYPED = "a value Mesh has no type for";

describe("an atom compared with anything but an enum is MESH_EXPR_ATOM", () => {
  // One error, at the atom, with the fix; the comparison stays translated, so no plain-code warning follows.
  test.each([
    ["a string attribute", "() => &title === :a", "a", "a string"],
    ["the atom on the left, with !==", "() => :a !== &title", "a", "a string"],
    ["an integer attribute", "() => &n === :a", "a", "a number"],
    ["a boolean attribute", "() => &ok !== :yes", "yes", "a boolean"],
    ["a timestamp attribute", "() => &dueAt === :soon", "soon", "a date"],
    ["a json attribute", "() => &meta === :a", "a", "a json value"],
    ["a related record", "() => &parent === :a", "a", "a record"],
    ["a string literal", '() => "a" === :a', "a", "a string"],
    ["a number literal", "() => 1 !== :a", "a", "a number"],
    ["a string's length", "() => &title.length === :long", "long", "a number"],
    ["a field of actor", "({ actor }) => actor.role === :admin", "admin", UNTYPED],
    ["a field of context", "({ context }) => context.tenant !== :acme", "acme", UNTYPED],
    ["a string argument", "({ input }) => input.note === :a", "a", "a string"],
    ["an integer argument", "({ input }) => input.count === :a", "a", "a number"],
    ["a member input of a string attribute", "({ input }) => input.title === :a", "a", "a string"],
    ["an input field the action does not declare", "({ input }) => input.nope === :a", "a", UNTYPED],
    ["a string of a related row, in a list method", "() => &children.some((c) => c.title === :open)", "open", "a string"],
    ["a string read through a nullable relationship", "() => &parent?.title === :a", "a", "a string"],
    ["an ordering operator against a number", "() => &n < :a", "a", "a number"],
    ["one comparison of a larger expression", "() => &n > 0 && (&title === :a || &ok)", "a", "a string"],
    ["a comparison that is itself compared", "() => (&title === :a) === &ok", "a", "a string"],
  ])("%s", (_, that, atom, other) => {
    const source = ticket({ check: that });
    const diagnostics = diagnosticsOf(source);
    expect(diagnostics.map((d) => [d.severity, d.code, d.message, d.fix])).toEqual([["error", "MESH_EXPR_ATOM", message(atom, other), fix(atom)]]);
    expect(source.slice(diagnostics[0]!.position.offset)).toStartWith(`:${atom}`);
    expect(diagnostics[0]!.position.line).toBe(source.slice(0, diagnostics[0]!.position.offset).split("\n").length);
  });

  test("two atoms compared with each other are one error, whose fix writes both strings", () => {
    for (const [that, at] of [["() => :a === :b", ":a ==="], ["() => :a < :b", ":a <"], ["() => :a !== :a", ":a !=="]] as const) {
      const source = ticket({ check: that });
      const diagnostics = diagnosticsOf(source);
      const second = that.includes(":b") ? "b" : "a";
      expect(diagnostics.map((d) => [d.severity, d.code, d.message, d.fix]), that)
        .toEqual([["error", "MESH_EXPR_ATOM", message("a", "another atom"), `write the strings \`"a"\` and \`"${second}"\``]]);
      expect(source.slice(diagnostics[0]!.position.offset)).toStartWith(at);
    }
  });

  test("each comparison of one function is reported", () => {
    expect(brief(ticket({ check: "({ actor }) => &title === :a || actor.role === :admin || &state === :open" }), 6))
      .toEqual([["error", "MESH_EXPR_ATOM", ":a || "], ["error", "MESH_EXPR_ATOM", ":admin"]]);
  });

  test("it is reported wherever a function is typed: a computed field, a policy, a filter, a `set` value and a step's `when=`", () => {
    expect(brief(ticket({ computed: "boolean :isA() { return &title === :a }" }))).toEqual([["error", "MESH_EXPR_ATOM", ":a"]]);
    expect(brief(ticket({ computed: "boolean :isA value=() => &title === :a" }))).toEqual([["error", "MESH_EXPR_ATOM", ":a"]]);
    expect(brief(ticket({ policy: "forbid-if=({ actor }) => actor.role === :guest" }), 6)).toEqual([["error", "MESH_EXPR_ATOM", ":guest"]]);
    expect(brief(ticket({ filter: "({ actor }) => actor.plan === :free" }), 5)).toEqual([["error", "MESH_EXPR_ATOM", ":free"]]);
    expect(brief(ticket({ step: "set\n          &ok=({ actor }) => actor.role === :admin" }), 6)).toEqual([["error", "MESH_EXPR_ATOM", ":admin"]]);
    expect(brief(ticket({ step: "when=({ input }) => input.note === :urgent\n          set\n            &ok=true" }), 7)).toEqual([["error", "MESH_EXPR_ATOM", ":urgent"]]);
  });

  test("the input of a policy or an `always` block is not typed, since each covers several actions: an atom compared with one of its fields is the error", () => {
    // `outcome` is an enum argument of `:go`, which both cover; Mesh types it only inside the action.
    for (const places of [{ policy: "forbid-if=({ input }) => input.outcome === :revoked" }, { always: "({ input }) => input.outcome === :revoked" }])
      expect(diagnosticsOf(ticket(places)).map((d) => [d.severity, d.code, d.message, d.fix]), JSON.stringify(places))
        .toEqual([["error", "MESH_EXPR_ATOM", message("revoked", UNTYPED), fix("revoked")]]);
    // Their own record is typed there as anywhere.
    expect(diagnosticsOf(ticket({ always: "() => &state !== :done" }))).toEqual([]);
  });

  test("a create's check that reads `&x` of a member input: a string keeps the error beside the warning, an enum only warns", () => {
    // On a create `&title` is the new instance's value before the input (MESH_VALIDATE_NOT_APPLIED), and still a string.
    expect(brief(ticket({ createCheck: "() => &title === :a" }), 6).sort())
      .toEqual([["error", "MESH_EXPR_ATOM", ":a cod"], ["warning", "MESH_VALIDATE_NOT_APPLIED", "&title"]]);
    expect(brief(ticket({ createCheck: "() => &state === :open" }), 6)).toEqual([["warning", "MESH_VALIDATE_NOT_APPLIED", "&state"]]);
  });

  test("a helper's result is a plain TypeScript value: an atom compared with it is the error", () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-atom-"));
    roots.push(root);
    writeFileSync(join(root, "ticket.helpers.ts"), 'export const tier = (n: number): string => (n > 1 ? "high" : "low");\n');
    const source = ticket({ imports: 'import { tier } from "./ticket.helpers"\n', check: "({ input }) => tier(input.count) === :high" });
    const diagnostics = buildModel({ root, files: [{ file: "ticket.mesh.mx", source }] }).diagnostics;
    expect(diagnostics.map((d) => [d.severity, d.code, d.message, d.fix])).toEqual([["error", "MESH_EXPR_ATOM", message("high", UNTYPED), fix("high")]]);
  });
});

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("an atom compared with an enum stays legal", () => {
  test("the fixture, which compares atoms with enums in every place a function goes, builds with no diagnostic", () => {
    // An enum attribute in a computed field and a filter, an enum argument and a member input of an enum attribute in
    // checks, and `before`'s enum attribute in a `set` value.
    expect(diagnosticsOf(ticket({}))).toEqual([]);
  });

  test.each([
    ["an enum attribute", "() => &state === :open"],
    ["the atom on the left", "() => :open === &state"],
    ["a nullable enum attribute", "() => &flag === :a"],
    ["an enum argument", "({ input }) => input.outcome === :released"],
    ["a member input of an enum attribute", "({ input }) => input.state === :open"],
    ["the value the action will store", "({ input }) => (input.state ?? &state) === :open"],
    ["a related record's enum", "() => &parent?.state === :open"],
    ["an enum of each related row, in a list method", "() => &children.some((c) => c.state === :open)"],
    ["a conditional whose branches are atoms", "() => (&ok ? :a : :b) === :a"],
  ])("%s", (_, that) => {
    expect(diagnosticsOf(ticket({ check: that }))).toEqual([]);
  });

  test("an atom is still a value where an enum is expected: a `set` value and an enum computed field", () => {
    expect(diagnosticsOf(ticket({ step: "set\n          &state=() => :done" }))).toEqual([]);
    expect(diagnosticsOf(ticket({ computed: "enum :phase values=[:early, :late] value=() => &state === :open ? :early : :late" }))).toEqual([]);
  });

  test("the typo check is kept for an enum input: an atom that is none of its values is MESH_EXPR_UNKNOWN_ATOM", () => {
    for (const [that, values] of [
      ["({ input }) => input.outcome === :relesed", ":released, :revoked"],
      ["({ input }) => input.state === :opne", ":open, :done"],
      ["() => &state === :opne", ":open, :done"],
    ] as const) {
      const diagnostics = diagnosticsOf(ticket({ check: that }));
      expect(diagnostics.map((d) => [d.severity, d.code]), that).toEqual([["error", "MESH_EXPR_UNKNOWN_ATOM"]]);
      expect(diagnostics[0]!.message).toContain(`is not one of the values of this enum (${values})`);
    }
  });

  test("neighbours keep their own diagnostic: `before` in a check, an ordering against an enum, and plain code is not typed", () => {
    // `before` is refused in a check; the atom compared with its member is not a second error.
    expect(brief(ticket({ check: "({ before }) => before.state === :open" }), 6)).toEqual([["error", "MESH_VALIDATE_BEFORE", "before"]]);
    expect(brief(ticket({ policy: "forbid-if=({ before }) => before.state === :open" }), 6)).toEqual([["error", "MESH_POLICY_BEFORE", "before"]]);
    // An enum has no order: plain code with its warning, as before.
    expect(brief(ticket({ check: "() => &state < :done" }), 6)).toEqual([["warning", "MESH_EXPR_PLAIN", "&state"]]);
    // A block body with a statement is plain code, which the build does not type.
    expect(diagnosticsOf(ticket({ computed: "boolean :isA() { const t = &title; return t === :a }" }))).toEqual([]);
    expect(diagnosticsOf(ticket({ step: "run ({ actor }) { if (actor.role === :admin) return }" }))).toEqual([]);
  });
});
