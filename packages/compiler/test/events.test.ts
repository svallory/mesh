// M6 PR 1: `event :Name` and `command :Name` as files of their own, and the `publish` step, at build time. The build reads
// them into the model (`document.events`, `document.commands`, `Step` `publish`), checks them (`MESH_PUBLISH`,
// `MESH_PUBLISH_BEFORE_WRITE`, `MESH_EVENT_NOT_PUBLISHED`) and generates a class per declaration, a barrel export, `DomainEvent`
// and the table of event classes in `#mesh`; a `publish` is a plain function with the reason `publish-step` in the
// entity's `.expressions.ts`. What `mesh build` does end to end, with the classes run, is `packages/cli/test/events.test.ts`.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { closeTypeServer } from "./type-server.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, Entity, Step } from "@meshfw/model";
import { eventsDiagnostics } from "../src/capabilities.ts";
import { buildModel as buildWithWarnings } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { checkTypes, configOf } from "./generated.ts";

afterAll(closeTypeServer);

/**
 * These tests declare `PayInvoice` to name it in a `publish`, and nothing answers it: `MESH_COMMAND_UNANSWERED` (a warning,
 * `commands.test.ts`) is not what they are about, so it is left out of what they compare.
 */
const buildModel = (project: Parameters<typeof buildWithWarnings>[0]): ReturnType<typeof buildWithWarnings> => {
  const result = buildWithWarnings(project);
  return { ...result, diagnostics: result.diagnostics.filter((d) => !(d.code === "MESH_COMMAND_UNANSWERED" && d.message.startsWith("Command billing.PayInvoice "))) };
};
const PAID = `event :InvoicePaid
  uuid :invoiceId
  decimal :amount min=0
  string :note nullable max=20
  enum :method values=[:card, :wire]
  datetime :paidAt
`;
const PAY = `command :PayInvoice
  uuid :id
`;
const REFUND = `event :refundIssued
  uuid :invoiceId
  integer :cents min=1
`;
/** An entity of billing/ whose body the test writes; imports first. */
const IMPORTS = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
import { PayInvoice } from "./pay-invoice.mesh.mx"
`;
const invoice = (actions: string, imports = IMPORTS) => `${imports}entity :Invoice
  attributes
    uuid :id primary-key
    boolean :paid default=false
  actions auto=[:read]
${actions}`;
const PUBLISH_PAID = "publish=() => new InvoicePaid({ invoiceId: &id, amount: 1, method: \"card\", paidAt: %.now })";
const files = (extra: Record<string, string> = {}, entity = invoice(`    update :pay\n      do\n        ${PUBLISH_PAID}\n`)) => ({
  root: "/project",
  files: Object.entries({ "billing/invoice-paid.mesh.mx": PAID, "billing/pay-invoice.mesh.mx": PAY, "billing/invoice.mesh.mx": entity, ...extra }).map(([file, source]) => ({ file, source })),
});
const build = (entity: string, extra: Record<string, string> = {}) => buildModel(files(extra, entity));
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
const entityOf = (result: ReturnType<typeof buildModel>, name = "Invoice"): Entity => result.document!.entities.find((e) => e.name === name)!;
const stepsOf = (entity: Entity, action: string): Step[] => entity.actions.find((a) => a.name === action)!.do;

describe("an event and a command file", () => {
  test("an event is plain data: name, FQN, file, module and fields without storage or creation options", () => {
    const result = buildModel(files({ "sales/refunds/refund-issued.mesh.mx": REFUND }));
    expect(result.diagnostics).toEqual([]);
    const [paid, refund] = result.document!.events!;
    expect(paid).toMatchObject({ name: "InvoicePaid", fqn: "billing.InvoicePaid", file: "billing/invoice-paid.mesh.mx", module: "billing" });
    expect(paid!.fields.map(({ position: _, ...field }) => field)).toEqual([
      { name: "invoiceId", type: "uuid", nullable: false },
      { name: "amount", type: "decimal", nullable: false, min: 0 },
      { name: "note", type: "string", nullable: true, max: 20 },
      { name: "method", type: "enum", nullable: false, values: [{ value: "card" }, { value: "wire" }] },
      { name: "paidAt", type: "datetime", nullable: false },
    ]);
    expect(paid!.position).toEqual({ file: "billing/invoice-paid.mesh.mx", line: 1, column: 0, offset: 0 });
    // `event :refundIssued` makes the class `RefundIssued`, and the FQN carries the class's name; the module is the folders as written.
    expect(refund).toMatchObject({ name: "refundIssued", fqn: "sales.refunds.RefundIssued", module: "sales/refunds" });
  });

  test("a command is the same plain data, in its own list", () => {
    const result = buildModel(files());
    expect(result.document!.commands).toEqual([{
      name: "PayInvoice", fqn: "billing.PayInvoice", file: "billing/pay-invoice.mesh.mx", module: "billing",
      fields: [{ name: "id", type: "uuid", nullable: false, position: { file: "billing/pay-invoice.mesh.mx", line: 2, column: 2, offset: 22 } }],
      position: { file: "billing/pay-invoice.mesh.mx", line: 1, column: 0, offset: 0 },
    }]);
    expect(result.document!.events!.map((event) => event.fqn)).toEqual(["billing.InvoicePaid"]);
  });

  test("a project with neither keeps a model with no events or commands key, so its model.json is what it was", () => {
    const result = buildModel({ root: "/project", files: [{ file: "a/todo.mesh.mx", source: "entity :Todo\n  attributes\n    uuid :id primary-key\n" }] });
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.document!)).toEqual(["entities"]);
  });

  test("a field takes the options that constrain a value, and not default, unique, primary-key or on", () => {
    const refused = (field: string) => buildModel({ root: "/project", files: [{ file: "billing/bad.mesh.mx", source: `event :Bad\n  ${field}\n` }] }).diagnostics;
    const message = (name: string, kind = "an event") => `\`${name}\` is not an option of a field of ${kind}: a field has no row behind it, so it takes the options that constrain a value (\`nullable\`, \`values\`, \`min\`, \`max\`, \`match\`) and none that concern storage or creation`;
    expect(brief(refused("uuid :id default=1"))).toEqual([["billing/bad.mesh.mx", 2, 19, "error", "MESH_UNKNOWN_OPTION", message("default"), "remove `default`"]]);
    expect(brief(refused("string :s unique"))).toEqual([["billing/bad.mesh.mx", 2, 12, "error", "MESH_UNKNOWN_OPTION", message("unique"), "remove `unique`"]]);
    expect(brief(refused("uuid :k primary-key"))).toEqual([["billing/bad.mesh.mx", 2, 10, "error", "MESH_UNKNOWN_OPTION", message("primary-key"), "remove `primary-key`"]]);
    expect(refused("datetime :at on=:create").map((d) => [d.code, d.severity])).toEqual([["MESH_UNKNOWN_OPTION", "error"]]);
    const command = buildModel({ root: "/project", files: [{ file: "billing/bad.mesh.mx", source: "command :Bad\n  uuid :k primary-key\n" }] }).diagnostics.filter((d) => d.severity === "error");
    expect(brief(command)[0]![5]).toBe(message("primary-key", "a command"));
  });

  test.each([
    "event :Bad\n  string :title optional\n",
    "entity :Bad\n  attributes\n    uuid :id primary-key\n    string :title optional\n",
    "entity :Bad\n  attributes\n    uuid :id primary-key\n  actions\n    update :change\n      input\n        string :title optional\n",
    "entity :Bad\n  attributes\n    uuid :id primary-key\n  computed\n    string :title optional value=() => 'title'\n",
  ])("optional belongs only to a command field: %s", (source) => {
    const result = buildModel({ root: "/project", files: [{ file: "billing/bad.mesh.mx", source }] });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "MESH_UNKNOWN_OPTION", severity: "error" });
  });

  test("the name, the fields and the file are checked", () => {
    const one = (source: string, file = "billing/bad.mesh.mx") => buildModel({ root: "/project", files: [{ file, source }] }).diagnostics.filter((d) => d.severity === "error");
    // `_` is dropped and the next letter capitalised (`notes/spec/names.md`): no error, and the FQN carries the class's name.
    const snake = buildModel({ root: "/project", files: [{ file: "billing/x.mesh.mx", source: "event :invoice_paid\n  uuid :id\n" }, { file: "billing/y.mesh.mx", source: "command :_pay__it_now\n  uuid :id\n" }] });
    // the one command is answered by no action: the warning is the only finding
    expect(snake.diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual([["MESH_COMMAND_UNANSWERED", "warning", "Command billing.PayItNow is answered by no action: nothing runs when it is dispatched"]]);
    expect(snake.document!.events!.map((event) => event.fqn)).toEqual(["billing.InvoicePaid"]);
    expect(snake.document!.commands!.map((command) => command.fqn)).toEqual(["billing.PayItNow"]);
    expect(brief(one("event :_1\n  uuid :id\n"))).toEqual([["billing/bad.mesh.mx", 1, 0, "error", "MESH_NAME",
      "Event :_1 makes no class name: Mesh drops each `_` and capitalises the letter after it, so the name needs a letter, such as :InvoicePaid", null]]);
    expect(brief(one("command :__\n  uuid :id\n"))[0]![5]).toBe("Command :__ makes no class name: Mesh drops each `_` and capitalises the letter after it, so the name needs a letter, such as :PayInvoice");
    expect(brief(one("event :E\n  string :x\n  string :x\n"))).toEqual([["billing/bad.mesh.mx", 3, 2, "error", "MESH_DUPLICATE_MEMBER", "Duplicate member :x", null]]);
    expect(brief(one("event :E\n  string :constructor\n"))).toEqual([["billing/bad.mesh.mx", 2, 2, "error", "MESH_ATTRIBUTE_NAME",
      ":constructor cannot be a field name: the generated class has its constructor under that name. Choose another name.", null]]);
    expect(brief(one("event :E\n  string :__proto__\n"))[0]![4]).toBe("MESH_ATTRIBUTE_NAME");
    expect(brief(one("event :E\n  enum :e\n"))[0]![4]).toBe("MESH_ENUM_VALUES");
    expect(brief(one("event :E\n  integer :n min=5 max=1\n"))[0]![4]).toBe("MESH_ATTRIBUTE_RULE");
    expect(brief(one("event :A\n  uuid :id\nevent :B\n  uuid :id\n"))).toEqual([["billing/bad.mesh.mx", 3, 0, "error", "MESH_DUPLICATE_ENTITY", "An event file must contain exactly one event", null]]);
    expect(brief(one("command :A\n  uuid :id\ncommand :B\n  uuid :id\n"))[0]![5]).toBe("A command file must contain exactly one command");
    expect(brief(one("import { X } from \"./invoice-paid.mesh.mx\"\nevent :Bad\n  uuid :id\n"))).toEqual([["billing/bad.mesh.mx", 1, 0, "error", "MESH_UNKNOWN_IMPORT",
      "An event file takes no import: its fields are attribute lines, whose kinds are attribute types", "remove the import"]]);
    // a field line is an attribute line: a relationship, an action or anything else is not allowed under an event
    expect(one("event :R\n  belongs-to :x entity=R\n").map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
    expect(one("event :R\n  actions\n    read :all\n").map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });

  test("two declarations with one FQN are one error naming both files; the same name in two modules is fine", () => {
    const result = buildModel(files({ "billing/dup.mesh.mx": "event :InvoicePaid\n  uuid :id\n" }));
    expect(brief(result.diagnostics)).toEqual([["billing/dup.mesh.mx", 1, 0, "error", "MESH_DUPLICATE_ENTITY", "Duplicate event billing.InvoicePaid; first declared in billing/invoice-paid.mesh.mx", null]]);
    expect(buildModel(files({ "other/invoice-paid.mesh.mx": PAID })).diagnostics).toEqual([]);
  });

  test("an import of an event file names what it declares, by its class name", () => {
    expect(brief(build(invoice(`    update :pay\n      do\n        ${PUBLISH_PAID}\n`, `import { Nope } from "./invoice-paid.mesh.mx"\n`)).diagnostics.filter((d) => d.code === "MESH_UNKNOWN_IMPORT")))
      .toEqual([["billing/invoice.mesh.mx", 1, 9, "error", "MESH_UNKNOWN_IMPORT", "`Nope` is not what ./invoice-paid.mesh.mx declares; it declares `InvoicePaid`", null]]);
    // `event :refundIssued` is imported as `RefundIssued`
    const ok = build(invoice("    update :pay\n      do\n        publish=() => new RefundIssued({ invoiceId: &id, cents: 1 })\n", `import { RefundIssued } from "../sales/refunds/refund-issued.mesh.mx"\n`), { "sales/refunds/refund-issued.mesh.mx": REFUND });
    expect(ok.diagnostics).toEqual([]);
  });
});

describe("a publish step", () => {
  test("is a step of do, of a when and of an always block's do, each plain code with the reason publish-step", () => {
    const result = build(invoice(`    update :pay
      do
        set
          &paid=true
        ${PUBLISH_PAID}
    update :settle
      do
        when=() => &paid
          ${PUBLISH_PAID}
    always types=[:create]
      do
        ${PUBLISH_PAID}
`));
    expect(result.diagnostics).toEqual([]);
    const entity = entityOf(result);
    const [, inDo] = stepsOf(entity, "pay") as Extract<Step, { kind: "publish" }>[];
    expect(inDo!.kind).toBe("publish");
    expect(inDo!.fn.source).toBe(PUBLISH_PAID.slice("publish=".length));
    expect(inDo!.fn.plain).toMatchObject({ why: "publish-step", events: ["InvoicePaid"], internal: { self: "$self", now: "$now" } });
    expect(inDo!.fn.tree).toBeUndefined();
    expect(inDo!.position).toMatchObject({ line: 12, column: 8 });
    const [when] = stepsOf(entity, "settle") as Extract<Step, { kind: "when" }>[];
    expect(when!.steps.map((step) => step.kind)).toEqual(["publish"]);
    expect(entity.always[0]!.do.map((step) => step.kind)).toEqual(["publish"]);
    expect((entity.always[0]!.do[0] as Extract<Step, { kind: "publish" }>).fn.plain!.why).toBe("publish-step");
  });

  test("reads the scope roots a run step reads, and may be async", () => {
    const result = build(invoice(`    update :pay
      do
        publish=async ({ self, before, input, actor, context }) => new InvoicePaid({ invoiceId: self.id, amount: 1, method: "card", paidAt: %.now })
`));
    expect(result.diagnostics).toEqual([]);
    const [step] = stepsOf(entityOf(result), "pay") as Extract<Step, { kind: "publish" }>[];
    expect(step!.fn.plain!.why).toBe("publish-step");
    expect(step!.fn.params).toEqual(["self", "before", "input", "actor", "context"]);
  });

  test("an imported event is named by its identifier, an alias, or a member of a namespace import", () => {
    const publish = (imports: string, name: string) => build(invoice(`    update :pay\n      do\n        publish=() => new ${name}({ invoiceId: &id, amount: 1, method: "card", paidAt: %.now })\n`, imports));
    expect(publish(`import { InvoicePaid as Paid } from "./invoice-paid.mesh.mx"\n`, "Paid").diagnostics).toEqual([]);
    const namespaced = publish(`import * as billing from "./invoice-paid.mesh.mx"\n`, "billing.InvoicePaid");
    expect(namespaced.diagnostics).toEqual([]);
    expect((stepsOf(entityOf(namespaced), "pay")[0] as Extract<Step, { kind: "publish" }>).fn.plain!.events).toEqual(["billing"]);
    expect(brief(publish(`import * as ev from "./invoice-paid.mesh.mx"\n`, "ev.InvoicePad").diagnostics)).toEqual([["billing/invoice.mesh.mx", 9, 29, "error", "MESH_PUBLISH",
      "ev.InvoicePad is not an imported event: ./invoice-paid.mesh.mx declares `InvoicePaid`. Did you mean ev.InvoicePaid?", "write `ev.InvoicePaid`"]]);
  });
});

describe("MESH_PUBLISH", () => {
  const publish = (value: string, imports = IMPORTS) => build(invoice(`    update :pay\n      do\n        publish=${value}\n`, imports)).diagnostics;
  const NOT_AN_EVENT = "a `publish` function returns `new` of an event the file imports";

  test("a value that is not a function", () => {
    expect(brief(publish('"InvoicePaid"'))).toEqual([["billing/invoice.mesh.mx", 10, 15, "error", "MESH_PUBLISH",
      "`publish`: this value is no function: a `publish` raises the event its function returns, as in `publish=() => new InvoicePaid({ ... })`", null]]);
  });

  test("a new that names no declared or imported event, with the nearest name", () => {
    expect(brief(publish("() => new InvoicePad({ invoiceId: &id })"))).toEqual([["billing/invoice.mesh.mx", 10, 26, "error", "MESH_PUBLISH", "InvoicePad is not an imported event. Did you mean InvoicePaid?", null]]);
    expect(brief(publish("() => new Zzz({})"))).toEqual([["billing/invoice.mesh.mx", 10, 26, "error", "MESH_PUBLISH", "Zzz is not an imported event.", null]]);
  });

  test("a new of an entity, of its own entity or of a global is not an event either", () => {
    expect(brief(publish("() => new Invoice({})"))[0]!.slice(1)).toEqual([10, 26, "error", "MESH_PUBLISH", "Invoice is not an imported event.", null]);
    expect(brief(publish("() => new Date()"))[0]!.slice(3, 6)).toEqual(["error", "MESH_PUBLISH", "Date is not an imported event."]);
  });

  test("a command is named as one: it asks for a write, and an event records a fact", () => {
    expect(brief(publish("() => new PayInvoice({ id: &id })"))).toEqual([["billing/invoice.mesh.mx", 10, 26, "error", "MESH_PUBLISH",
      `\`PayInvoice\` is a command, not an event: ${NOT_AN_EVENT}, and a command asks for a write instead of recording a fact`, "publish an event that records what the action did"]]);
  });

  test("is checked at an expression body, each return of a block body and each branch of a conditional; a helper's result is not checked", () => {
    const command = (line: number, column: number) => ["billing/invoice.mesh.mx", line, column, "error", "MESH_PUBLISH", expect.stringContaining("`PayInvoice` is a command, not an event"), "publish an event that records what the action did"];
    expect(brief(publish("() => { if (&paid) return new PayInvoice({ id: &id }); return new InvoicePaid({ invoiceId: &id, amount: 1, method: \"card\", paidAt: %.now }) }"))).toEqual([command(10, 46)]);
    expect(brief(publish("() => &paid ? new InvoicePaid({ invoiceId: &id, amount: 1, method: \"card\", paidAt: %.now }) : new PayInvoice({ id: &id })"))).toEqual([command(10, 114)]);
    expect(brief(publish("() => ((&paid ? (new PayInvoice({ id: &id })) : new PayInvoice({ id: &id })) as any)")).map((d) => d.slice(1, 3))).toEqual([[10, 37], [10, 68]]);
    // not seen: a helper's result, a variable, a function nested in the body
    const publishCodes = (value: string, imports = IMPORTS) => publish(value, imports).filter((d) => d.code === "MESH_PUBLISH");
    expect(publishCodes("() => makeEvent(&id)", `${IMPORTS}import { makeEvent } from "./make"\n`)).toEqual([]);
    expect(publishCodes("() => { const e = new PayInvoice({ id: &id }); return e }")).toEqual([]);
    expect(publishCodes("() => { const f = () => new PayInvoice({ id: &id }); return new InvoicePaid({ invoiceId: &id, amount: 1, method: \"card\", paidAt: %.now }) }")).toEqual([]);
  });

  test("a new of a variable of the function, and a new with no name to read", () => {
    expect(brief(publish("({ input }) => { const InvoicePaid = input.kind; return new InvoicePaid({}) }"))[0]!.slice(3, 6)).toEqual(["error", "MESH_PUBLISH",
      `\`InvoicePaid\` is a variable of this function, not an imported event: ${NOT_AN_EVENT}`]);
    expect(brief(publish("() => new (function () {})()"))[0]!.slice(3, 6)).toEqual(["error", "MESH_PUBLISH",
      `${NOT_AN_EVENT}, as in \`new InvoicePaid({ ... })\`: this \`new\` names no event`]);
  });

  test("a publish in validate, in a check or in a read", () => {
    const where = (actions: string) => brief(build(invoice(actions)).diagnostics);
    const rule = (what: string) => `a \`publish\` step is not allowed in ${what}: it raises an event after the action's row is written, in the action's \`do\``;
    expect(where(`    update :pay\n      validate\n        ${PUBLISH_PAID}\n`)).toEqual([["billing/invoice.mesh.mx", 10, 8, "error", "MESH_PUBLISH", rule("`validate`"), "move it under `do`"]]);
    expect(where(`    update :pay\n      validate\n        check :ok that=() => true code="x" message="m"\n          ${PUBLISH_PAID}\n`))
      .toEqual([["billing/invoice.mesh.mx", 11, 10, "error", "MESH_PUBLISH", rule("a `check`"), "move it under `do`"]]);
    expect(where(`    read :list\n      do\n        ${PUBLISH_PAID}\n`)).toEqual([["billing/invoice.mesh.mx", 10, 8, "error", "MESH_PUBLISH", rule("a read action"), "move it under `do`"]]);
  });

  test("an event is no entity: it is not a relationship's target, and not a member (&name)", () => {
    const related = buildModel(files({}, `import { InvoicePaid } from "./invoice-paid.mesh.mx"\nentity :Other\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :paid entity=InvoicePaid\n`));
    expect(brief(related.diagnostics)).toEqual([["billing/invoice.mesh.mx", 6, 28, "error", "MESH_UNKNOWN_ENTITY", "InvoicePaid is not an imported entity.", null]]);
    expect(brief(build(invoice(`    update :pay\n      do\n        set\n          &InvoicePaid=true\n`)).diagnostics).map((d) => d[4])).toEqual(["MESH_UNKNOWN_MEMBER"]);
  });
});

describe("MESH_PUBLISH_BEFORE_WRITE", () => {
  const warn = (steps: string) => brief(build(invoice(`    update :pay\n      do\n${steps}`)).diagnostics);
  const message = "A `publish` of billing.Invoice#pay is written among the steps before the write, and it runs after the write, in written order among the `run [after=:write]` steps: it reads `self` as the stored record";
  const fix = "write it after the steps that run before the write, so the order on the page is the order it runs in";

  test("a publish written ahead of a step that runs before the write", () => {
    expect(warn(`        ${PUBLISH_PAID}\n        set\n          &paid=true\n`)).toEqual([["billing/invoice.mesh.mx", 10, 8, "warning", "MESH_PUBLISH_BEFORE_WRITE", message, fix]]);
    // a `load`, a plain `run` and a `when` (whose condition is read before the write) are such steps
    expect(warn(`        ${PUBLISH_PAID}\n        run (ctx) { return 1 }\n`).map((d) => d[4])).toEqual(["MESH_PUBLISH_BEFORE_WRITE"]);
    expect(warn(`        ${PUBLISH_PAID}\n        when=() => &paid\n          set\n            &paid=false\n`).map((d) => d[4])).toEqual(["MESH_PUBLISH_BEFORE_WRITE"]);
  });

  test("one warning per such publish, inside a when too", () => {
    const warned = warn(`        when=() => &paid\n          ${PUBLISH_PAID}\n          set\n            &paid=false\n        ${PUBLISH_PAID}\n        set\n          &paid=true\n`);
    expect(warned.map((d) => [d[1], d[4]])).toEqual([[11, "MESH_PUBLISH_BEFORE_WRITE"], [14, "MESH_PUBLISH_BEFORE_WRITE"]]);
  });

  test("none for a publish written after the steps that run before the write, or among the after-write steps", () => {
    expect(warn(`        set\n          &paid=true\n        ${PUBLISH_PAID}\n`)).toEqual([]);
    expect(warn(`        set\n          &paid=true\n        ${PUBLISH_PAID}\n        run [after=:write] (ctx) { return 1 }\n        ${PUBLISH_PAID}\n`)).toEqual([]);
    expect(warn(`        ${PUBLISH_PAID}\n        run [after=:write] (ctx) { return 1 }\n`)).toEqual([]);
    expect(warn(`        ${PUBLISH_PAID}\n        ${PUBLISH_PAID}\n`)).toEqual([]);
  });

  test("none for a publish written ahead of a when that holds only publish steps: one when= per outcome", () => {
    const outcomes = `        set\n          &paid=true\n        when=() => &paid\n          ${PUBLISH_PAID}\n        when=() => !&paid\n          ${PUBLISH_PAID}\n          when=() => true\n            ${PUBLISH_PAID}\n`;
    expect(warn(outcomes)).toEqual([]);
    // a when that also holds a step that runs before the write is still such a step
    expect(warn(`        set\n          &paid=true\n        ${PUBLISH_PAID}\n        when=() => &paid\n          ${PUBLISH_PAID}\n          set\n            &paid=false\n`).map((d) => [d[1], d[4]]))
      .toEqual([[12, "MESH_PUBLISH_BEFORE_WRITE"], [14, "MESH_PUBLISH_BEFORE_WRITE"]]);
  });

  test("an always block's do is checked on its own", () => {
    const result = build(invoice(`    update :pay\n    always types=[:update]\n      do\n        ${PUBLISH_PAID}\n        set\n          &paid=true\n`));
    expect(brief(result.diagnostics)).toEqual([["billing/invoice.mesh.mx", 11, 8, "warning", "MESH_PUBLISH_BEFORE_WRITE",
      message.replace("billing.Invoice#pay", "an always block of billing.Invoice (block 1)"), fix]]);
  });
});

describe("MESH_EVENT_NOT_PUBLISHED", () => {
  const NEW = 'new InvoicePaid({ invoiceId: "x", amount: 1, method: "card", paidAt: %.now })';
  const warned = (steps: string, imports = IMPORTS) => brief(build(invoice(`    update :pay\n      do\n${steps}`, imports)).diagnostics);
  const message = "`new InvoicePaid(...)` constructs an event here, and constructing one raises nothing: only a `publish` step raises an event";
  const fix = "raise it with a `publish` step in the action's `do`: `publish=() => new InvoicePaid({ ... })`";

  test("an event constructed in a run step, a set value, a check or a when", () => {
    expect(warned(`        run (ctx) { return ${NEW} }\n`)).toEqual([["billing/invoice.mesh.mx", 10, 27, "warning", "MESH_EVENT_NOT_PUBLISHED", message, fix]]);
    expect(warned(`        set\n          &paid=() => (${NEW}, true)\n`).map((d) => d[4])).toEqual(["MESH_EVENT_NOT_PUBLISHED"]);
    expect(warned(`        when=() => (${NEW}, true)\n          set\n            &paid=true\n`).map((d) => d[4])).toEqual(["MESH_EVENT_NOT_PUBLISHED"]);
    const check = build(invoice(`    update :pay\n      validate\n        check :ok that=() => (${NEW}, true) code="x" message="m"\n`)).diagnostics;
    expect(check.map((d) => [d.severity, d.code])).toEqual([["warning", "MESH_EVENT_NOT_PUBLISHED"]]);
  });

  test("through an alias and a namespace import, and never an error", () => {
    expect(warned(`        run (ctx) { return new Paid({}) }\n`, `import { InvoicePaid as Paid } from "./invoice-paid.mesh.mx"\n`)[0]!.slice(3, 6))
      .toEqual(["warning", "MESH_EVENT_NOT_PUBLISHED", message.replace("InvoicePaid", "Paid")]);
    expect(warned(`        run (ctx) { return new ev.InvoicePaid({}) }\n`, `import * as ev from "./invoice-paid.mesh.mx"\n`)[0]!.slice(3, 6))
      .toEqual(["warning", "MESH_EVENT_NOT_PUBLISHED", message.replace("InvoicePaid", "ev.InvoicePaid")]);
    expect(build(invoice(`    update :pay\n      do\n        run (ctx) { return ${NEW} }\n`)).document).not.toBeNull();
  });

  test("not for a publish step, a command, a name the function binds itself, or a mention that is no new", () => {
    expect(warned(`        ${PUBLISH_PAID}\n`)).toEqual([]);
    expect(warned("        run (ctx) { return new PayInvoice({}) }\n")).toEqual([]);
    expect(warned("        run (ctx) { const InvoicePaid = class {}; return new InvoicePaid() }\n")).toEqual([]);
    expect(warned("        run (ctx) { return InvoicePaid.name }\n")).toEqual([]);
  });
});

describe("the bus at build time (MESH_EVENTS_CONFIG, MESH_CAPABILITY)", () => {
  const at = { file: "/project/mesh.config.ts", line: 1, column: 1, offset: 0 };
  const bus = (capabilities: readonly string[]) => ({ manifest: { adapter: "fake", capabilities }, create: () => { throw new Error("never started"); } }) as never;
  const data = (capabilities: readonly string[]) => ({ ...configOf("/project").data, capabilities: { adapter: "sqlite", capabilities } }) as never;
  const declared = () => buildModel(files()).document!;
  const none = () => buildModel({ root: "/project", files: [{ file: "billing/invoice.mesh.mx", source: invoice("", "") }] }).document!;

  test("a project that declares an event and sets no bus: one error naming the event, at the config", () => {
    expect(eventsDiagnostics(declared(), { data: data([]) }, at)).toEqual([{
      severity: "error", code: "MESH_EVENTS_CONFIG", position: at,
      message: "The project declares the event billing.InvoicePaid, and mesh.config.ts sets no events.bus: an event is delivered by a bus, and there is no default",
      fix: "Set events: { bus: localBus() } in mesh.config.ts (localBus from @meshfw/bus-local)",
    }]);
    expect(eventsDiagnostics(declared(), { data: data([]), events: { bus: bus(["ordered-delivery"]) } }, at)).toEqual([]);
    expect(eventsDiagnostics(none(), { data: data([]) }, at)).toEqual([]);
  });

  test("requires: each capability the bus or the data adapter does not declare is MESH_CAPABILITY", () => {
    const config = { data: data(["gapless-positions"]), events: { bus: bus(["ordered-delivery", "replay"]), requires: ["replay", "gapless-positions", "subscribe", "upserts"] as never } };
    expect(eventsDiagnostics(declared(), config, at).map(({ code, message, fix }) => ({ code, message, fix }))).toEqual([
      { code: "MESH_CAPABILITY", message: "events.requires lists subscribe, and the event bus \"fake\" does not declare it", fix: "Use a bus that declares subscribe, or remove it from events.requires" },
      { code: "MESH_CAPABILITY", message: "events.requires lists upserts, and the data adapter \"sqlite\" does not declare it", fix: "Use a data adapter that declares upserts, or remove it from events.requires" },
    ]);
    expect(eventsDiagnostics(none(), { data: data([]), events: { requires: ["replay"] as never } }, at).map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "MESH_CAPABILITY", message: "events.requires lists the bus capability replay, and mesh.config.ts sets no events.bus to declare it" },
    ]);
  });
});

describe("what is generated", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  const full = () => buildModel(files({ "sales/refunds/refund-issued.mesh.mx": REFUND }, `import { InvoicePaid } from "./invoice-paid.mesh.mx"
import * as refunds from "../sales/refunds/refund-issued.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    boolean :paid default=false
    decimal :total default=10
  actions auto=[:read]
    create :open
      do
        set
          &paid=false
        ${PUBLISH_PAID}
        run [after=:write] ({ self }) { return self.id }
    destroy :void
      do
        ${PUBLISH_PAID}
    update :pay
      do
        set
          &paid=true
        ${PUBLISH_PAID}
        run [after=:write] ({ self }) { return self.id }
        publish=async () => new refunds.RefundIssued({ invoiceId: &id, cents: 1 })
    update :refund
      do
        when=() => &paid
          publish=() => new InvoicePaid({ invoiceId: &id, amount: &total, method: "wire", paidAt: %.now })
          run [after=:write] ({ self }) { return self.id }
    update :named
      do
        publish=({ self }): InvoicePaid | refunds.RefundIssued => { const made: InvoicePaid = new InvoicePaid({ invoiceId: self.id, amount: 1, method: "card", paidAt: %.now }); return made }
    always types=[:update]
      do
        publish=() => new InvoicePaid({ invoiceId: &id, amount: 2, method: "card", paidAt: %.now })
`));
  const golden = async (name: string, actual: string) => {
    const path = resolve(import.meta.dir, "fixtures/events-golden", name);
    if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
    expect(actual).toBe(await readFile(path, "utf8"));
  };
  const generate = async () => {
    const result = full();
    expect(result.diagnostics).toEqual([]);
    return generateFiles({ document: result.document!, config: configOf("/project", ".mesh") });
  };
  const text = (generated: readonly { path: string; contents: string }[], path: string) => generated.find((file) => file.path === path)!.contents;

  test("a class file per declaration, the module barrels, DomainEvent and the table: goldens", async () => {
    const generated = await generate();
    expect(generated.map((file) => file.path).filter((path) => /event|command|index/.test(path))).toEqual([
      ".mesh/domain/billing/index.ts", ".mesh/domain/billing/invoicePaid.event.ts", ".mesh/domain/billing/payInvoice.command.ts", ".mesh/domain/index.ts",
      ".mesh/domain/sales/index.ts", ".mesh/domain/sales/refunds/index.ts", ".mesh/domain/sales/refunds/refundIssued.event.ts", ".mesh/index.ts",
    ]);
    await golden("invoicePaid.event.ts.golden", text(generated, ".mesh/domain/billing/invoicePaid.event.ts"));
    await golden("payInvoice.command.ts.golden", text(generated, ".mesh/domain/billing/payInvoice.command.ts"));
    await golden("refundIssued.event.ts.golden", text(generated, ".mesh/domain/sales/refunds/refundIssued.event.ts"));
    await golden("billing.index.ts.golden", text(generated, ".mesh/domain/billing/index.ts"));
    await golden("mesh.index.ts.golden", text(generated, ".mesh/index.ts"));
  });

  test("the publish functions in the entity's expressions file: plain (publish-step), typed to return DomainEvent | Promise<DomainEvent>: golden", async () => {
    const generated = await generate();
    const expressions = text(generated, ".mesh/domain/billing/invoice.expressions.ts");
    await golden("invoice.expressions.ts.golden", expressions);
    expect(expressions).toContain("// publish, plain (publish-step) (billing/invoice.mesh.mx:");
    expect([...expressions.matchAll(/\): \$DomainEvent \| \$Promise<\$DomainEvent> => \{/g)].length).toBe(7);
    expect(expressions).toContain('import type { DomainEvent as $DomainEvent } from "../../index";');
    expect(expressions).toContain('import { InvoicePaid as $billing$InvoicePaid$class } from "./invoicePaid.event";');
    expect(expressions).toContain('import { RefundIssued as $sales$refunds$RefundIssued$class } from "../sales/refunds/refundIssued.event";');
    // a namespace import is bound to an object of the classes, and a name used as a type is bound as one
    expect(expressions.replace(/\s+/g, " ")).toContain("const refunds: { readonly RefundIssued: typeof $sales$refunds$RefundIssued$class } = { RefundIssued: $sales$refunds$RefundIssued$class, };");
    expect(expressions).toContain("type InvoicePaid = $billing$InvoicePaid$class;");
  });

  test("the generated action runs a publish after the write, in written order among the after-write steps, under the flag of its when", async () => {
    const actions = text(await generate(), ".mesh/domain/billing/invoice.actions.ts");
    const pay = actions.slice(actions.indexOf("async pay("), actions.indexOf("async refund("));
    const at = (needle: string) => { const index = pay.indexOf(needle); expect(index).toBeGreaterThan(-1); return index; };
    // before the write: the set; then the write and the seam; then, in written order, publish, run, publish; then the result
    expect(at("$changes.paid = $record.paid = true;")).toBeLessThan(at("await tx.updateByKey("));
    expect(at("await tx.updateByKey(")).toBeLessThan(at("await frame.plain(() =>"));
    const publishes = [...pay.matchAll(/\$expressions\["(pay\.step\.\d+\.\w+|always\.0\.step\.\d+\.publish)"\]\(\$after\)/g)].map((match) => match[1]);
    expect(publishes).toEqual(["always.0.step.0.publish", "pay.step.1.publish", "pay.step.2.run", "pay.step.3.publish"]);
    expect(at("$expressions[\"always.0.step.0.publish\"]($after)")).toBeGreaterThan(at("await frame.plain(() =>"));
    expect(at('$expressions["pay.step.3.publish"]($after)')).toBeLessThan(at("const $result = await tx.selectByKey("));
    // none of them runs before the write
    expect(pay.slice(0, at("await tx.updateByKey("))).not.toContain("publish");
    // each publish hands its value to publishEvent, which checks it and appends the row in this transaction
    expect([...pay.matchAll(/\$publishEvent\(\n\s*tx,\n\s*options\.events,\n\s*\{\n\s*entity: "billing\.Invoice",\n\s*action: "pay",\n\s*key: \{ id: \$written\.id \},\n\s*at: "billing\/invoice\.mesh\.mx:\d+:\d+",\n\s*\},\n\s*\$event,\n\s*\$context,\n\s*\$clock,/g)].length).toBe(3);
    expect(pay).not.toContain("$failJoined");
    expect(pay).not.toContain("M6");
    // inside a when, the publish runs only if the condition held before the write
    const refund = actions.slice(actions.indexOf("async refund("), actions.indexOf("async named("));
    expect(refund).toMatch(/\$when0 = !!\(await \$expressions\["refund\.step\.0\.when"\]\(\$s\)\);/);
    expect(refund.indexOf("if ($when0) {")).toBeLessThan(refund.indexOf('["refund.step.0.0.publish"]($after)'));
    expect(refund.indexOf('["refund.step.0.0.publish"]($after)')).toBeLessThan(refund.indexOf('["refund.step.0.1.run"]($after)'));
    expect(refund.indexOf("$when0 = ")).toBeLessThan(refund.indexOf("await tx.updateByKey("));
    expect(refund.indexOf('["refund.step.0.0.publish"]($after)')).toBeGreaterThan(refund.indexOf("await tx.updateByKey("));
  });

  test("a publish on a create runs after the insert, and one on a destroy after the delete, each before the result", async () => {
    const actions = text(await generate(), ".mesh/domain/billing/invoice.actions.ts");
    const open = actions.slice(actions.indexOf("async open("), actions.indexOf("async void("));
    const at = (slice: string, needle: string) => { const index = slice.indexOf(needle); expect(index).toBeGreaterThan(-1); return index; };
    // a create has no stored row before the write, so only after the insert does `self` exist for the function to read
    expect(at(open, "await tx.insert(")).toBeLessThan(at(open, '$expressions["open.step.1.publish"]($after)'));
    expect(at(open, '$expressions["open.step.1.publish"]($after)')).toBeLessThan(at(open, '$expressions["open.step.2.run"]($after)'));
    expect(open.slice(0, at(open, "await tx.insert(")).includes("publish")).toBe(false);
    expect(at(open, '$expressions["open.step.1.publish"]($after)')).toBeLessThan(at(open, "$publishEvent("));
    const destroy = actions.slice(actions.indexOf("async void("), actions.indexOf("async pay("));
    expect(at(destroy, "await tx.deleteByKey(")).toBeLessThan(at(destroy, '$expressions["void.step.0.publish"]($after)'));
    expect(destroy.slice(0, at(destroy, "await tx.deleteByKey(")).includes("publish")).toBe(false);
    expect(at(destroy, '$expressions["void.step.0.publish"]($after)')).toBeLessThan(at(destroy, "$publishEvent("));
    expect(destroy).toContain('action: "void",');
  });

  test("the generated tree passes the project's own type check, a publish function included", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-events-"));
    roots.push(root);
    const config = configOf(root);
    const generated = await generateFiles({ document: full().document!, config });
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    const checked = await checkTypes(root, [...generated.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("a bus that declares replay and subscribe: #mesh exports readEvents and subscribe, merges the capabilities, and type-checks", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-events-"));
    roots.push(root);
    const bus = { manifest: { adapter: "fake", capabilities: ["ordered-delivery", "replay", "subscribe"] as const }, create: () => { throw new Error("never started"); } };
    const config = { ...configOf(root), events: { bus } };
    const generated = await generateFiles({ document: full().document!, config });
    const index = text(generated, "generated/index.ts");
    expect(index).toContain('export { readEvents } from "./binding";\nexport type { ReadEventsPage, ReadEventsQuery } from "@meshfw/runtime";');
    expect(index).toContain('export { subscribe } from "./binding";\nexport type { SubscribeQuery, Subscription } from "@meshfw/runtime";');
    expect(index).toContain('interface EventBusCapabilities {\n    "ordered-delivery": true;\n    replay: true;\n    subscribe: true;\n  }');
    const binding = text(generated, "generated/binding.ts");
    expect(binding).toContain("export function subscribe(");
    expect(binding).toContain("export function readEvents(");
    expect(binding).toContain("export function listSubscriptions(): $Promise<readonly $SubscriptionProgress[]>");
    expect(index).toContain("  listSubscriptions,");
    expect(index).toContain('export type { Delivery, SubscriptionProgress } from "@meshfw/runtime";');
    // disconnect stops delivery before it releases the binding, so the running round's handlers finish on it
    expect(binding.indexOf("await delivery.stop()")).toBeGreaterThan(-1);
    expect(binding.indexOf("await delivery.stop()")).toBeLessThan(binding.indexOf("$releaseBinding(binding)"));
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    // Mesh.handler infers run's event from events; the bus declares no dead-letters, so onFailure "skip" is a type error
    await writeFile(resolve(root, "handlers.ts"), [
      'import { handler } from "@meshfw/runtime";',
      'import { eventClasses } from "./generated/index";',
      'const InvoicePaid = eventClasses["billing.InvoicePaid"];',
      "export const inferred = handler({ events: [InvoicePaid], run: (event) => { const id: string = event.payload.invoiceId; void id; } });",
      "// @ts-expect-error the payload is the listed class's instance, which has no field named nothing",
      "export const unknownField = handler({ events: [InvoicePaid], run: (event) => { void event.payload.nothing; } });",
      '// @ts-expect-error onFailure "skip" needs a bus that declares dead-letters',
      'export const skips = handler({ events: [InvoicePaid], onFailure: "skip", run: () => {} });',
      "",
    ].join("\n"));
    const checked = await checkTypes(root, [...generated.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts"), resolve(root, "handlers.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("a publish function that returns what is not a DomainEvent fails the project's type check, at the generated line", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-events-"));
    roots.push(root);
    const config = configOf(root);
    // the build checks a `new` it can see: an object literal passes the build, and TypeScript refuses what it returns
    const result = buildModel(files({}, invoice(`    update :pay\n      do\n        publish=() => ({ id: &id })\n`)));
    expect(result.diagnostics).toEqual([]);
    const generated = await generateFiles({ document: result.document!, config });
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    const checked = await checkTypes(root, [...generated.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts")]);
    expect(checked.code).toBe(1);
    expect(checked.output).toContain("invoice.expressions.ts");
    expect(checked.output).toContain("Type '{ id: string; }' is not assignable to type");
  }, 30_000);

  test("mesh explain lists a publish with the reason publish-step, after the write", () => {
    const entity = entityOf(full());
    const lines = explainAction(entity, "refund")!;
    const after = lines.slice(lines.findIndex((line) => line.startsWith("  after write")));
    expect(after.slice(0, 4)).toEqual([
      "  after write  self is the stored record",
      "               publish () => new InvoicePaid({ invoiceId: &id, amount: 2, method: \"card\", paidAt: %.now }) (plain, publish-step: it raises the event after the write)",
      "               when () => &paid (as it held before the write)",
      "                 publish () => new InvoicePaid({ invoiceId: &id, amount: &total, method: \"wire\", paidAt: %.now }) (plain, publish-step: it raises the event after the write)",
    ]);
    expect(lines.find((line) => line.startsWith("  steps"))).toBe("  steps        none");
  });
});
