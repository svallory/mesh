// an entity file names another file's entity by an imported identifier (`entity=List`) or as a member of a
// namespace import (`import * as billing from "../billing/invoice.mesh.mx"`, `entity=billing.Invoice`); the alias is
// the author's, never a module name Mesh checks and never part of an FQN. A helper module can be a namespace import too,
// and a function calls `h.isStaff(...)` as it calls an imported `isStaff(...)`. One function resolves every reference
// (`front-end/references.ts`); the relationships and the functions of an entity file both call it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Diagnostic, Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { printTree } from "../src/typescript/expression-printer.ts";

const INVOICE = `entity :Invoice
  attributes
    uuid :id primary-key
    integer :amount
  actions auto=[:read]
    create :open
      input
        &amount
`;
const CUSTOMER = `entity :Customer
  attributes
    uuid :id primary-key
    string :name
`;
/** A Line in ledger/, whose relationships and imports the test writes. */
const line = (imports: string, relationships: string, rest = "") => `${imports}
entity :Line
  attributes
    uuid :id primary-key
    integer :amount
  relationships
${relationships}${rest}`;

/** The files of a project in memory: billing/invoice, billing/customer and the given ledger/line. */
const project = (lineSource: string, extra: Record<string, string> = {}) => ({
  root: "/project",
  files: Object.entries({ "billing/invoice.mesh.mx": INVOICE, "billing/customer.mesh.mx": CUSTOMER, "ledger/line.mesh.mx": lineSource, ...extra })
    .map(([file, source]) => ({ file, source })),
});
const build = (lineSource: string, extra: Record<string, string> = {}) => buildModel(project(lineSource, extra));
const entityOf = (result: ReturnType<typeof buildModel>, name: string): Entity => result.document!.entities.find((e) => e.name === name)!;
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.code, d.message, d.position.line, d.position.column, d.fix]);

/** Projects written to disk, for a helper module, which the build finds on disk. */
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function onDisk(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "mesh-namespace-"));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return buildModel({ root, files: Object.entries(files).filter(([file]) => file.endsWith(".mesh.mx")).map(([file, source]) => ({ file, source })) });
}

describe("a namespace import in each reference position", () => {
  test("belongs-to, has-many and has-one resolve a member of a namespace import to the entity the file declares", () => {
    const invoice = `import * as ledger from "../ledger/line.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
  relationships
    has-many :lines entity=ledger.Line
    has-one :first entity=ledger.Line
`;
    const result = build(line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Invoice\n"), { "billing/invoice.mesh.mx": invoice });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Line").relationships.map((r) => [r.kind, r.entity])).toEqual([
      ["belongs-to", { identifier: "billing.Invoice", from: "../billing/invoice.mesh.mx" }],
    ]);
    // The inverse, the belongs-to of the other side, is found through the namespaces as through named imports.
    expect(entityOf(result, "Invoice").relationships.map((r) => [r.kind, r.entity, r.inverse])).toEqual([
      ["has-many", { identifier: "ledger.Line", from: "../ledger/line.mesh.mx" }, "invoice"],
      ["has-one", { identifier: "ledger.Line", from: "../ledger/line.mesh.mx" }, "invoice"],
    ]);
    // The alias is never part of an FQN, nor of the module: those follow the folders.
    expect(result.document!.entities.map((e) => [e.fqn, e.module]).sort()).toEqual([["billing.Customer", "billing"], ["billing.Invoice", "billing"], ["ledger.Line", "ledger"]]);
    expect(entityOf(result, "Line").imports).toEqual([expect.objectContaining({ identifiers: ["billing"], from: "../billing/invoice.mesh.mx", namespace: true })]);
    expect(entityOf(result, "Line").imports[0]!.imported).toBeUndefined();
  });

  test("short and qualified forms mix across the files of one project, and in one file", () => {
    const result = build(
      line('import { Invoice } from "../billing/invoice.mesh.mx"\nimport * as people from "../billing/customer.mesh.mx"', "    belongs-to :invoice entity=Invoice\n    belongs-to :customer entity=people.Customer nullable\n"),
      { "billing/customer.mesh.mx": `import * as ledger from "../ledger/line.mesh.mx"\n${CUSTOMER}  relationships\n    has-many :lines entity=ledger.Line\n` },
    );
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Line").relationships.map((r) => r.entity.identifier)).toEqual(["Invoice", "people.Customer"]);
    expect(entityOf(result, "Customer").relationships.map((r) => r.entity)).toEqual([{ identifier: "ledger.Line", from: "../ledger/line.mesh.mx" }]);
  });

  test("the same file imported both ways in one entity file names the same entity", () => {
    const result = build(line(
      'import { Invoice } from "../billing/invoice.mesh.mx"\nimport * as billing from "../billing/invoice.mesh.mx"',
      "    belongs-to :invoice entity=Invoice\n    belongs-to :original entity=billing.Invoice nullable\n",
    ));
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Line").relationships.map((r) => r.entity)).toEqual([
      { identifier: "Invoice", from: "../billing/invoice.mesh.mx" },
      { identifier: "billing.Invoice", from: "../billing/invoice.mesh.mx" },
    ]);
  });

  test("an alias may be the name of what its file declares, and an entity names itself with no import", () => {
    const result = build(line('import * as Invoice from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=Invoice.Invoice\n    belongs-to :parent entity=Line nullable\n"));
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Line").relationships.map((r) => r.entity)).toEqual([
      { identifier: "Invoice.Invoice", from: "../billing/invoice.mesh.mx" },
      { identifier: "Line", from: "./line.mesh.mx" },
    ]);
  });
});

describe("a reference that does not resolve is MESH_UNKNOWN_ENTITY, from the one resolver", () => {
  test("an unknown member names what the file declares and suggests the nearest, at the member", () => {
    const source = line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Invoce\n");
    expect(brief(build(source).diagnostics)).toEqual([[
      "MESH_UNKNOWN_ENTITY", "billing.Invoce is not an imported entity: ../billing/invoice.mesh.mx declares `Invoice`. Did you mean billing.Invoice?",
      7, source.split("\n")[6]!.indexOf("Invoce"), "write `billing.Invoice`",
    ]]);
    // A member nothing like it still names what the file declares.
    expect(brief(build(line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Zzzzzzzzz\n")).diagnostics).map((d) => [d[1], d[4]]))
      .toEqual([["billing.Zzzzzzzzz is not an imported entity: ../billing/invoice.mesh.mx declares `Invoice`. Did you mean billing.Invoice?", "write `billing.Invoice`"]]);
  });

  test("an unknown name is suggested the qualified references of the file too", () => {
    const result = build(line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Invoice\n    belongs-to :other entity=bililng.Invoice\n"));
    expect(brief(result.diagnostics).map((d) => [d[0], d[1], d[2], d[3]])).toEqual([
      ["MESH_UNKNOWN_ENTITY", "bililng.Invoice is not an imported entity: no import of this file is named bililng. Did you mean billing.Invoice?", 8, 29],
    ]);
    expect(brief(build(line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=Invoice\n")).diagnostics).map((d) => d[1]))
      .toEqual(["Invoice is not an imported entity. Did you mean billing.Invoice?"]);
  });

  test("a namespace alias alone names a file, not an entity", () => {
    expect(brief(build(line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing\n")).diagnostics).map((d) => [d[0], d[1], d[4]])).toEqual([[
      "MESH_UNKNOWN_ENTITY", "billing is a namespace import of ../billing/invoice.mesh.mx, not an entity: name the entity it declares, `billing.Invoice`", "write `billing.Invoice`",
    ]]);
  });

  test("a member of a named import is not a reference: the named import is the entity itself", () => {
    expect(brief(build(line('import { Invoice } from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=Invoice.Invoice\n")).diagnostics).map((d) => [d[0], d[1], d[4]])).toEqual([[
      "MESH_UNKNOWN_ENTITY",
      'Invoice.Invoice is not an imported entity: Invoice is imported by name, as the entity itself; a member access reads a namespace import (`import * as invoice from "../billing/invoice.mesh.mx"`)',
      "write `Invoice`",
    ]]);
  });

  test("a namespace of a file that is not an entity file is no entity, in a member or alone", () => {
    const helper = "export const isStaff = (actor: { staff?: boolean }) => actor.staff === true;\n";
    const member = onDisk({ "ledger/rules.ts": helper, "billing/invoice.mesh.mx": INVOICE, "ledger/line.mesh.mx": line('import * as rules from "./rules"', "    belongs-to :invoice entity=rules.Invoice\n") });
    expect(brief(member.diagnostics).map((d) => [d[0], d[1]])).toEqual([["MESH_UNKNOWN_ENTITY", "rules.Invoice is not an imported entity: rules is a namespace import of ./rules, which is not an entity file"]]);
    const alone = onDisk({ "ledger/rules.ts": helper, "billing/invoice.mesh.mx": INVOICE, "ledger/line.mesh.mx": line('import * as rules from "./rules"', "    belongs-to :invoice entity=rules\n") });
    expect(brief(alone.diagnostics).map((d) => [d[0], d[1]])).toEqual([["MESH_UNKNOWN_ENTITY", "rules is a namespace import of ./rules, not an entity: name an entity that an entity file declares"]]);
  });

  test("a namespace import of a file the project does not have is the import's error alone", () => {
    expect(brief(build(line('import * as billing from "../billing/missing.mesh.mx"', "    belongs-to :invoice entity=billing.Invoice\n")).diagnostics).map((d) => [d[0], d[2]]))
      .toEqual([["MESH_UNKNOWN_IMPORT", 1]]);
  });

  test("entity= takes an identifier or one member of one; anything else is MESH_ENTITY_REFERENCE", () => {
    for (const written of ["billing.Invoice.Line", "billing?.Invoice", 'billing["Invoice"]', "billing.Invoice()", "billing[0]", "getInvoice()", "&billing.Invoice", ":billing"]) {
      const result = build(line('import * as billing from "../billing/invoice.mesh.mx"', `    belongs-to :invoice entity=${written}\n`));
      expect(result.diagnostics.map((d) => d.code), written).toEqual(["MESH_ENTITY_REFERENCE"]);
    }
  });

  // MX lowers a wrapped value to the bare one and keeps the value as written in the option's `valueSpan` (MX 0.1.0-alpha.28,
  // IR version 5): a reference is written bare, so a wrapper is refused at the value as written, in every reference position.
  test("a wrapped reference is MESH_ENTITY_REFERENCE at the value as written, in belongs-to, has-many and has-one", () => {
    const imports = 'import * as billing from "../billing/invoice.mesh.mx"\nimport { Customer } from "../billing/customer.mesh.mx"';
    const wrapped = [
      "(Customer)", "Customer!", "Customer as any", "Customer satisfies object", "<any>Customer",
      "(billing.Invoice)", "billing.Invoice!", "billing.Invoice as any", "billing.Invoice satisfies object", "<any>billing.Invoice",
      "( Customer )", "((Customer as any)!)", "(billing.Invoice) nullable",
    ];
    for (const kind of ["belongs-to", "has-many", "has-one"])
      for (const written of wrapped) {
        if (kind !== "belongs-to" && written.endsWith("nullable")) continue;
        const relationship = `    ${kind} :other entity=${written}`;
        const result = build(line(imports, `${relationship}\n`));
        expect(brief(result.diagnostics).map((d) => [d[0], d[2], d[3]]), `${kind} ${written}`)
          .toEqual([["MESH_ENTITY_REFERENCE", 8, relationship.indexOf("entity=") + "entity=".length]]);
        expect(result.diagnostics[0]!.message, `${kind} ${written}`).toContain("entity must be the reference alone");
      }
  });

  // One mistake, one error: a wrapped value that is no reference either gets the not-a-reference error alone, at the
  // option, since that one says what to write.
  test("a wrapped value that is not a reference is one MESH_ENTITY_REFERENCE, the not-a-reference one", () => {
    const imports = 'import * as billing from "../billing/invoice.mesh.mx"';
    for (const kind of ["belongs-to", "has-many", "has-one"])
      for (const written of ["(getList())", "(billing?.Invoice)"]) {
        const relationship = `    ${kind} :other entity=${written}`;
        const result = build(line(imports, `${relationship}\n`));
        expect(brief(result.diagnostics).map((d) => [d[0], d[2], d[3]]), `${kind} ${written}`)
          .toEqual([["MESH_ENTITY_REFERENCE", 7, relationship.indexOf("entity=")]]);
        expect(result.diagnostics[0]!.message, `${kind} ${written}`).toContain("entity must be an imported identifier");
      }
  });

  test("a wrapped option that is not a reference still builds: max=(5), min=(1 as const), code=(\"42\" as const)", () => {
    const source = `entity :Note
  attributes
    uuid :id primary-key
    string :title max=(5) min=(1 as const)
  actions
    create :open
      validate
        check :titled that=({ input }) => input.title.length > 0 code=("42" as const) message=("a title is required")
      input
        &title
`;
    const result = buildModel({ root: "/project", files: [{ file: "notes/note.mesh.mx", source }] });
    expect(result.diagnostics).toEqual([]);
    const note = entityOf(result, "Note");
    expect(note.attributes.find((a) => a.name === "title")).toMatchObject({ min: 1, max: 5 });
    expect(note.actions[0]!.validate).toMatchObject([{ label: "titled", code: "42", message: "a title is required" }]);
  });

  test("whitespace and comments around the reference, and a comma after it, are accepted", () => {
    const imports = 'import * as billing from "../billing/invoice.mesh.mx"\nimport { Customer } from "../billing/customer.mesh.mx"';
    for (const [written, identifier] of [
      ["billing. Invoice", "billing.Invoice"],
      ["billing .Invoice", "billing.Invoice"],
      ["billing /* the ledger's */ . Invoice nullable", "billing.Invoice"],
      ["billing.Invoice  ", "billing.Invoice"],
      ["billing.Invoice // the invoice", "billing.Invoice"],
      ["billing.Invoice, nullable", "billing.Invoice"],
      ["Customer\t nullable /* (x) */", "Customer"],
    ] as const) {
      const result = build(line(imports, `    belongs-to :invoice entity=${written}\n`));
      expect(result.diagnostics, written).toEqual([]);
      expect(entityOf(result, "Line").relationships.map((r) => r.entity.identifier), written).toEqual([identifier]);
    }
  });
});

describe("namespace import forms", () => {
  test("a type-only namespace import is refused; a default one with it keeps both bindings in the fix", () => {
    expect(brief(build(line('import type * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Invoice\n")).diagnostics).filter((d) => d[0] === "MESH_IMPORT_FORM")).toEqual([[
      "MESH_IMPORT_FORM", "import the entity by name or as a namespace, not as a type: `import { List } from …` or `import * as billing from …`", 1, 0,
      'write `import * as billing from "../billing/invoice.mesh.mx"`, the entity that file declares',
    ]]);
    expect(brief(build(line('import Invoice, * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Invoice\n")).diagnostics).filter((d) => d[0] === "MESH_IMPORT_FORM").map((d) => d[4])).toEqual([
      'write `import { Invoice } from "../billing/invoice.mesh.mx"` and `import * as billing from "../billing/invoice.mesh.mx"`, the entity that file declares',
    ]);
  });

  test("an alias another import binds is a duplicate, as TypeScript refuses it", () => {
    const result = build(line('import { Invoice } from "../billing/invoice.mesh.mx"\nimport * as Invoice from "../billing/customer.mesh.mx"', "    belongs-to :invoice entity=Invoice\n"));
    expect(brief(result.diagnostics).map((d) => [d[0], d[1], d[2], d[3]])).toEqual([["MESH_DUPLICATE_IMPORT", "Duplicate import identifier Invoice", 2, 12]]);
  });

  // The second binding binds nothing, and a use of the name, whichever binding it means, says nothing the duplicate does not.
  test.each([
    ["the named import first, a member of the namespace", 'import { Invoice } from "../billing/invoice.mesh.mx"\nimport * as Invoice from "../billing/customer.mesh.mx"', "Invoice.Customer"],
    ["the named import first, the name alone", 'import { Invoice } from "../billing/invoice.mesh.mx"\nimport * as Invoice from "../billing/customer.mesh.mx"', "Invoice"],
    ["the namespace first, the name alone", 'import * as Invoice from "../billing/customer.mesh.mx"\nimport { Invoice } from "../billing/invoice.mesh.mx"', "Invoice"],
    ["the namespace first, an unknown member", 'import * as Invoice from "../billing/customer.mesh.mx"\nimport { Invoice } from "../billing/invoice.mesh.mx"', "Invoice.Custmer"],
  ])("a duplicate name reports MESH_DUPLICATE_IMPORT alone: %s", (_, imports, reference) => {
    const withUses = line(`import { Mesh } from "meshfw"\n${imports}`, `    belongs-to :invoice entity=${reference}\n`, `  actions auto=[:read]
    update :touch
      do
        run async ({ context }) {
          await Mesh.privileged(${reference}).read({}, context)
          void ${reference}
        }
`);
    expect(brief(build(withUses).diagnostics).map((d) => [d[0], d[2]])).toEqual([["MESH_DUPLICATE_IMPORT", 3]]);
  });

  test("a check on a duplicate binding's name runs once, on the binding that keeps the name", () => {
    const result = onDisk({
      "a.helpers.ts": "export const $one = 1\n",
      "b.helpers.ts": "export const $one = 2\n",
      "line.mesh.mx": line('import { $one } from "./a.helpers"\nimport { $one } from "./b.helpers"', "    belongs-to :line entity=Line nullable\n"),
    });
    expect(brief(result.diagnostics).map((d) => [d[0], d[2]])).toEqual([["MESH_HELPER_NAME", 1], ["MESH_DUPLICATE_IMPORT", 2]]);
  });

  test("the second binding reaches no function: a helper namespace that keeps the name is no entity there", () => {
    // Were the entity file's binding to reach the functions too, the call would be an entity's action, MESH_POLICY_ACTS.
    const result = onDisk({
      "billing/invoice.mesh.mx": INVOICE,
      "ledger/line.helpers.ts": "export const isStaff = (context: unknown) => context !== null\n",
      "ledger/line.mesh.mx": line('import * as Invoice from "./line.helpers"\nimport * as Invoice from "../billing/invoice.mesh.mx"', "    belongs-to :line entity=Line nullable\n", `  actions auto=[:read]
    update :touch
  policies
    policy :staff types=[:read, :update]
      authorize-if=({ context }) => Invoice.isStaff(context)
`),
    });
    expect(brief(result.diagnostics).map((d) => [d[0], d[2]])).toEqual([["MESH_DUPLICATE_IMPORT", 2]]);
  });

  test("an alias generated code could take is refused, as a named import's is", () => {
    expect(build(line('import * as $billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=$billing.Invoice\n")).diagnostics.map((d) => d.code)).toEqual(["MESH_HELPER_NAME"]);
  });

  test('"meshfw" stays a named import of `Mesh` alone', () => {
    expect(build(line('import * as M from "meshfw"', "    belongs-to :invoice entity=Line\n")).diagnostics.map((d) => [d.code, d.fix])).toEqual([["MESH_IMPORT_FORM", 'write `import { Mesh } from "meshfw"`']]);
  });
});

describe("functions name an entity through a namespace import as through a named one", () => {
  const withRun = (body: string, imports = 'import { Mesh } from "meshfw"\nimport * as billing from "../billing/invoice.mesh.mx"') =>
    line(imports, "    belongs-to :invoice entity=billing.Invoice\n", `  actions auto=[:read]
    update :touch
      do
        run async ({ context }) { ${body} }
`);
  const stepOf = (result: ReturnType<typeof buildModel>) => {
    const step = entityOf(result, "Line").actions.find((a) => a.name === "touch")!.do[0]!;
    if (step.kind !== "run") throw new Error("expected a run step");
    return step.fn;
  };

  test("a call to an action through the namespace is acting, and the function binds the alias", () => {
    const result = build(withRun("await billing.Invoice.open({ amount: 1 }, context)"));
    expect(result.diagnostics).toEqual([]);
    expect(stepOf(result).plain).toMatchObject({ entities: ["billing"], acts: true });
  });

  test("a call through the namespace acts whatever the member syntax: no spelling escapes MESH_POLICY_ACTS or MESH_COMPUTED_COMPOSES", () => {
    const withRules = (call: string, around = (c: string) => c) => line('import * as billing from "../billing/invoice.mesh.mx"', "    belongs-to :invoice entity=billing.Invoice\n", `  computed
    integer :opened() {
      void ${around(`${call}({ amount: 7 }, {})`)}
      return 1
    }
  actions auto=[:read]
    update :touch
  policies
    policy :acts types=[:update]
      forbid-if=async ({ context }) => { await ${around(`${call}({ amount: 7 }, context)`)}; return false }
`);
    for (const call of ["billing?.Invoice.open", 'billing["Invoice"].open', "billing.Invoice?.open", 'billing.Invoice["open"]', "billing.Invoice.open.call"]) {
      const result = build(withRules(call));
      expect([call, result.diagnostics.map((d) => d.code).sort()]).toEqual([call, ["MESH_COMPUTED_COMPOSES", "MESH_POLICY_ACTS"]]);
    }
    // An unknown member written as a string is the same unknown member.
    expect(build(withRules('billing["Invoce"].open')).diagnostics.map((d) => d.code)).toContain("MESH_UNKNOWN_ENTITY");
    // A parameter of the alias's name is not the namespace: its calls are its own.
    expect(build(withRules("billing?.Invoice.open", (c) => `[{ Invoice: { open: (..._: unknown[]) => 1 } }].map((billing) => ${c})`)).diagnostics).toEqual([]);
  });

  test("Mesh.privileged takes a member of a namespace import, never the alias alone", () => {
    const ok = build(withRun("await Mesh.privileged(billing.Invoice).read({})"));
    expect(ok.diagnostics).toEqual([]);
    expect(stepOf(ok).plain).toMatchObject({ why: "run-step", privileged: true, entities: ["billing"] });
    expect(brief(build(withRun("await Mesh.privileged(billing).read({})")).diagnostics).map((d) => [d[0], d[1]])).toEqual([[
      "MESH_PRIVILEGED_ENTITY",
      "`Mesh.privileged()` takes an entity this file names, its own or an imported one, and `billing` is not one: it is a namespace import, and `billing.Name` names the entity it holds",
    ]]);
  });

  test("an unknown member read in a function is MESH_UNKNOWN_ENTITY at the member, as in entity=", () => {
    const source = withRun("await billing.Invoce.open({ amount: 1 }, context)");
    const result = build(source);
    expect(brief(result.diagnostics)).toEqual([[
      "MESH_UNKNOWN_ENTITY", "billing.Invoce is not an imported entity: ../billing/invoice.mesh.mx declares `Invoice`. Did you mean billing.Invoice?",
      12, source.split("\n")[11]!.indexOf("Invoce"), "write `billing.Invoice`",
    ]]);
    // A parameter of the alias's name hides it: its members are its own.
    expect(build(withRun("const f = (billing: { Invoce: number }) => billing.Invoce; void f")).diagnostics).toEqual([]);
  });

  test("a helper module imported as a namespace is called as an imported function: translated, and imported by its alias", () => {
    const helper = "export const isStaff = (actor: { staff?: boolean }) => actor.staff === true;\nexport const big = (n: number) => n > 100;\n";
    const task = (that: string) => `import * as h from "./rules"
entity :Task
  attributes
    uuid :id primary-key
    integer :n
  actions auto=[:read]
    update :go
      validate
        check :c that=${that} code="c" message="c"
`;
    const ok = onDisk({ "work/rules.ts": helper, "work/task.mesh.mx": task("({ actor }) => h.isStaff(actor) && &n > 1") });
    expect(ok.diagnostics).toEqual([]);
    const entity = ok.document!.entities[0]!;
    expect(entity.imports).toEqual([expect.objectContaining({ identifiers: ["h"], from: "./rules", helper: true, namespace: true })]);
    const tree = entity.actions[0]!.validate[0]!.that.tree!;
    expect(tree).toMatchObject({ fn: "and", args: [{ kind: "helper", name: "h.isStaff", from: "./rules" }, {}] });
    expect(printTree(tree, true)).toContain('$.asBool($.pure(h.isStaff($s.actor), "h.isStaff"))');
    // Given the record, it is plain code, as an imported function given the record is; it still names the import.
    const plain = onDisk({ "work/rules.ts": helper, "work/task.mesh.mx": task("() => h.big(&n)") }).document!.entities[0]!.actions[0]!.validate[0]!.that.plain;
    expect(plain).toMatchObject({ why: "reads-record-in-helper", helpers: ["h"] });
    // A parameter of the alias's name hides the namespace: `h.isStaff(h)` is a method of the parameter, not a helper call.
    // `actor.roles` is translated, so the quantifier's body reaches the helper-namespace branch of the translation.
    const hidden = onDisk({ "work/rules.ts": helper, "work/task.mesh.mx": task("({ actor }) => actor.roles.some((h) => h.isStaff(h))") }).document!.entities[0]!.actions[0]!.validate[0]!.that;
    expect(hidden.plain).toMatchObject({ why: "unsupported-construct", detail: "a method call", position: { column: 61 } });
    expect(hidden.plain?.helpers).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain('"kind":"helper"');
    // The namespace itself is no function.
    const called = onDisk({ "work/rules.ts": helper, "work/task.mesh.mx": task("({ actor }) => h(actor)") }).document!.entities[0]!.actions[0]!.validate[0]!.that;
    expect(called.tree).toBeUndefined();
  });
});
