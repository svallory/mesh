// An owner's `events` and `commands` sections with listing lines, and the owner check (`MESH_PUBLISH`'s fourth case):
// `notes/architecture/aggregates-design.md`, PR 1. A listing line is an imported event or command, by its identifier or as
// a member of a namespace import, alone on its line; MX claims it through a wildcard child (`listing()`), which works only
// with `bindingsCallTags: false` on Mesh's dialect. Inline declarations and aggregate files come later.
import { describe, expect, test } from "bun:test";
import type { Diagnostic, Entity, Expression, Step } from "@meshfw/model";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { REFERENCE_HEAD, listing } from "../src/front-end/contracts.ts";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { copyExpression, publishTargetsOf } from "../src/front-end/expression.ts";
import { lineHeadReference } from "../src/front-end/references.ts";

const PAID = "event :InvoicePaid\n  uuid :invoiceId\n";
const OVERDUE = "event :InvoiceOverdue\n  uuid :invoiceId\n";
const PAY = "command :PayInvoice\n  uuid :id\n";
const IMPORTS = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
import { InvoicePaid as Paid } from "./invoice-paid.mesh.mx"
import * as notices from "./notices/invoice-overdue.mesh.mx"
import { PayInvoice } from "./pay-invoice.mesh.mx"
import { Task } from "../work/task.mesh.mx"
`;
/** `billing.Invoice`, answering `PayInvoice`, with the sections the test writes after its actions. */
const invoice = (sections: string, { imports = IMPORTS, steps = "" } = {}) => `${imports}entity :Invoice
  attributes
    uuid :id primary-key
  actions auto=[:read]
    update on=PayInvoice
${steps ? `      do\n${steps}` : ""}${sections}`;
/** An entity of `work/` whose `go` action runs `steps`; it imports the paid event under `Paid` and as `ev`. */
const worker = (name: string, steps: string, sections = "") => `import { InvoicePaid as Paid } from "../billing/invoice-paid.mesh.mx"
import * as ev from "../billing/invoice-paid.mesh.mx"
entity :${name}
  attributes
    uuid :id primary-key
  actions auto=[:read]
    update :go
      do
${steps}${sections}`;
const TASK = worker("Task", "        run=() => undefined\n");
const files = (extra: Record<string, string>) => ({
  root: "/project",
  files: Object.entries({
    "billing/invoice-paid.mesh.mx": PAID,
    "billing/notices/invoice-overdue.mesh.mx": OVERDUE,
    "billing/pay-invoice.mesh.mx": PAY,
    "work/task.mesh.mx": TASK,
    ...extra,
  }).map(([file, source]) => ({ file, source })),
});
const build = (extra: Record<string, string>) => buildModel(files(extra));
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
/** The diagnostics of the files the test is about: the fixtures' own warnings (an unused import, an unanswered command) aside. */
const errors = (result: ReturnType<typeof buildModel>) => brief(result.diagnostics.filter((d) => d.severity === "error"));
const entityOf = (result: ReturnType<typeof buildModel>, name: string): Entity => result.document!.entities.find((e) => e.name === name)!;
const lowered = (source: string) => parseEntitySource(source, "/project/billing/invoice.mesh.mx").diagnostics.map((d) => [d.line, d.column, d.code, d.message]);

describe("the dialect and the contracts", () => {
  test("Mesh's dialect reads a name an import binds as a plain tag name (ruling D10)", () => {
    expect(MESH_DIALECT.bindingsCallTags).toBe(false);
  });

  test("a listing line is a wildcard child whose head is any dotted identifier path, with the options given and no child", () => {
    expect(listing()).toEqual({ pattern: REFERENCE_HEAD, attributes: {}, attributeTags: {}, children: {} });
    const head = new RegExp(`^(?:${REFERENCE_HEAD})$`);
    for (const name of ["InvoicePaid", "notices.InvoiceOverdue", "a.b.c", "_x", "$x"]) expect(head.test(name), name).toBe(true);
    for (const name of ["a.", ".a", "a..b", "1a", "a-b"]) expect(head.test(name), name).toBe(false);
  });

  test("a listing, plain or dotted, lowers to one tag named as written, with no diagnostic", () => {
    const source = invoice("  events\n    InvoicePaid\n    notices.InvoiceOverdue\n  commands\n    PayInvoice\n");
    const result = parseEntitySource(source, "/project/billing/invoice.mesh.mx");
    expect(result.diagnostics).toEqual([]);
    const names = (section: string) => {
      const root = result.ir!.body.find((n) => n.kind === "DelegatedTag")!;
      const tag = (root as { tag: { children: { kind: string; tag?: { name: string; children: unknown[] } }[] } }).tag.children.find((c) => c.tag?.name === section)!.tag!;
      return (tag.children as { kind: string; tag?: { name: string; attrs: unknown[] } }[]).filter((c) => c.kind === "DelegatedTag").map((c) => [c.tag!.name, c.tag!.attrs]);
    };
    expect(names("events")).toEqual([["InvoicePaid", []], ["notices.InvoiceOverdue", []]]);
    expect(names("commands")).toEqual([["PayInvoice", []]]);
  });

  test.each([
    ["a second section", "  events\n    InvoicePaid\n  events\n    Paid\n", [[13, 2, "MESH_REPEATED_CHILD", "`entity`: `events` may not be repeated"]], ""],
    ["a declaration line under events", "  events\n    command :X\n      uuid :id\n", [[12, 4, "MESH_TAG_NOT_ALLOWED", `\`events\`: \`command\` is not allowed here; names must match \`${REFERENCE_HEAD}\` (\`command\` is a registered tag, so the wildcard does not apply to it)`]], ""],
    ["an attribute line under commands", "  commands\n    string :s\n", [[12, 4, "MESH_TAG_NOT_ALLOWED", `\`commands\`: \`string\` is not allowed here; names must match \`${REFERENCE_HEAD}\` (\`string\` is a registered tag, so the wildcard does not apply to it)`]], ""],
    ["an option on a listing", "  events\n    InvoicePaid prop=:x\n", [[12, 16, "MESH_UNKNOWN_OPTION", "`InvoicePaid` (inline contract): accepts no options"]], ""],
    ["a name after a listing", "  events\n    InvoicePaid :x\n", [[12, 16, "MESH_UNKNOWN_OPTION", "`InvoicePaid` (inline contract): accepts no options"]], ""],
    ["a child under a listing", "  events\n    InvoicePaid\n      uuid :x\n", [[13, 6, "MESH_TAG_NOT_ALLOWED", "`InvoicePaid` (inline contract): `uuid` is not allowed here; allowed children: none"]], ""],
    ["a value on a listing", "  events\n    InvoicePaid=1\n", [[12, 15, "MESH_UNKNOWN_OPTION", "`InvoicePaid` (inline contract): accepts no options"]], ""],
    ["whitespace after the dot", "  events\n    notices. InvoiceOverdue\n", [[12, 11, "MESH_INVALID_TAG_NAME", "a tag name cannot have an empty part: a `.` must be followed by a name, as in `billing.InvoiceVoided`, and cannot end the name or follow another `.`"]], ""],
    ["an entity line under events", "  events\n    entity :X\n", [[12, 4, "MESH_TAG_NOT_ALLOWED", `\`events\`: \`entity\` is not allowed here; names must match \`${REFERENCE_HEAD}\` (\`entity\` is a registered tag, so the wildcard does not apply to it)`]], ""],
    ["whitespace before the dot", "  events\n    notices .InvoiceOverdue\n", [[12, 12, "MESH_INVALID_OPTION", "Invalid option name `.InvoiceOverdue` — this file's dialect has no `.class` shorthand; write `class=` as an option"]], ""],
    ["a section under actions", "", [[11, 4, "MESH_TAG_NOT_ALLOWED", "`actions`: `events` is not allowed here; allowed children: `create`, `read`, `update`, `destroy`, `always`"]], "    events\n"],
  ])("MX refuses %s", (_label, sections, expected, inActions) => {
    expect(lowered(invoice(sections, { steps: "", imports: IMPORTS }).replace("    update on=PayInvoice\n", `    update on=PayInvoice\n${inActions}`))).toEqual(expected);
  });

  test("an empty section, or a section of either kind alone, is legal (OD10)", () => {
    expect(lowered(invoice("  events\n  commands\n"))).toEqual([]);
    expect(lowered(invoice("  commands\n    PayInvoice\n"))).toEqual([]);
  });

  test("outside a listing section a name an import binds is still no tag: as the root line, and as an attribute line head (D10)", () => {
    const root = parseEntitySource('import { InvoicePaid } from "./invoice-paid.mesh.mx"\nInvoicePaid\n', "/project/billing/x.mesh.mx");
    expect(root.diagnostics.map((d) => [d.line, d.column, d.code, d.message])).toEqual([[2, 0, "MESH_UNKNOWN_TAG", "`InvoicePaid` is not a known tag in the `mesh` dialect"]]);
    const money = lowered('import { Task } from "../work/task.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n    Task :price\n');
    expect(money).toEqual([[5, 4, "MESH_UNKNOWN_TAG", "`Task` is not a known tag in the `mesh` dialect"]]);
  });
});

describe("lineHeadReference", () => {
  test("splits a head on its dot, each part at its offset in the file; three parts are no reference", () => {
    expect(lineHeadReference({ name: "InvoicePaid", nameSpan: { sourceStart: 40 } })).toEqual({ name: "InvoicePaid", offset: 40 });
    expect(lineHeadReference({ name: "notices.InvoiceOverdue", nameSpan: { sourceStart: 40 } }))
      .toEqual({ qualifier: { name: "notices", offset: 40 }, name: "InvoiceOverdue", offset: 48 });
    expect(lineHeadReference({ name: "a.b.c", nameSpan: { sourceStart: 0 } })).toBeUndefined();
  });
});

describe("listing lines in the model", () => {
  test("each line resolves, by identifier, alias or namespace member, to its declaration's FQN, in written order", () => {
    const result = build({ "billing/invoice.mesh.mx": invoice("  events\n    Paid\n    notices.InvoiceOverdue\n  commands\n    PayInvoice\n") });
    expect(errors(result)).toEqual([]);
    const { events, commands } = entityOf(result, "Invoice");
    expect(events).toEqual([
      { identifier: "Paid", from: "./invoice-paid.mesh.mx", fqn: "billing.InvoicePaid", position: { file: "billing/invoice.mesh.mx", line: 12, column: 4, offset: 385 } },
      { identifier: "notices.InvoiceOverdue", from: "./notices/invoice-overdue.mesh.mx", fqn: "billing.notices.InvoiceOverdue", position: { file: "billing/invoice.mesh.mx", line: 13, column: 4, offset: 394 } },
    ]);
    expect(commands).toEqual([{ identifier: "PayInvoice", from: "./pay-invoice.mesh.mx", fqn: "billing.PayInvoice", position: { file: "billing/invoice.mesh.mx", line: 15, column: 4, offset: 432 } }]);
  });

  test("a commands line resolves through a namespace import too", () => {
    const imports = `${IMPORTS}import * as c from "./pay-invoice.mesh.mx"\n`;
    const result = build({ "billing/invoice.mesh.mx": invoice("  commands\n    c.PayInvoice\n", { imports }) });
    expect(errors(result)).toEqual([]);
    expect(entityOf(result, "Invoice").commands?.map((c) => [c.identifier, c.from, c.fqn])).toEqual([["c.PayInvoice", "./pay-invoice.mesh.mx", "billing.PayInvoice"]]);
  });

  test("an entity with no section, or an empty one, has no events or commands key, so its model.json is what it was", () => {
    for (const sections of ["", "  events\n  commands\n"]) {
      const result = build({ "billing/invoice.mesh.mx": invoice(sections) });
      expect(errors(result)).toEqual([]);
      const entity = entityOf(result, "Invoice");
      expect(Object.hasOwn(entity, "events")).toBe(false);
      expect(Object.hasOwn(entity, "commands")).toBe(false);
    }
  });

  test.each([
    ["an unknown name, with the nearest", "  events\n    InvoicePad\n", [[12, 4, "MESH_UNKNOWN_EVENT", "InvoicePad is not an imported event. Did you mean InvoicePaid?", null]]],
    ["an unknown member of a namespace import", "  events\n    notices.InvoiceOverdu\n", [[12, 12, "MESH_UNKNOWN_EVENT", "notices.InvoiceOverdu is not an imported event: ./notices/invoice-overdue.mesh.mx declares `InvoiceOverdue`. Did you mean notices.InvoiceOverdue?", "write `notices.InvoiceOverdue`"]]],
    ["a namespace alias alone", "  events\n    notices\n", [[12, 4, "MESH_UNKNOWN_EVENT", "notices is a namespace import of ./notices/invoice-overdue.mesh.mx, not an event: name the event it declares, `notices.InvoiceOverdue`", "write `notices.InvoiceOverdue`"]]],
    ["a qualifier that is no import", "  events\n    alerts.InvoiceOverdue\n", [[12, 4, "MESH_UNKNOWN_EVENT", "alerts.InvoiceOverdue is not an imported event: no import of this file is named alerts.", null]]],
    ["a head of three parts", "  events\n    a.b.c\n", [[12, 4, "MESH_UNKNOWN_EVENT", "a.b.c is not an imported event: a listing is an imported identifier (`InvoicePaid`) or a member of a namespace import (`notices.InvoiceOverdue`)", null]]],
    ["an entity", "  events\n    Task\n", [[12, 4, "MESH_UNKNOWN_EVENT", "Task is not an imported event.", null]]],
    ["the file's own entity", "  events\n    Invoice\n", [[12, 4, "MESH_UNKNOWN_EVENT", "Invoice is not an imported event.", null]]],
    ["a command under events", "  events\n    PayInvoice\n", [[12, 4, "MESH_UNKNOWN_EVENT", "PayInvoice is not an imported event.", null]]],
    ["an event under commands", "  commands\n    InvoicePaid\n", [[12, 4, "MESH_UNKNOWN_COMMAND", "InvoicePaid is not an imported command.", null]]],
    ["a namespace alias under commands", "  commands\n    notices.InvoiceOverdue\n", [[12, 4, "MESH_UNKNOWN_COMMAND", "notices.InvoiceOverdue is not an imported command: notices is a namespace import of ./notices/invoice-overdue.mesh.mx, which is not a command file", null]]],
    ["a head of three parts under commands", "  commands\n    a.b.c\n", [[12, 4, "MESH_UNKNOWN_COMMAND", "a.b.c is not an imported command: a listing is an imported identifier (`PayInvoice`) or a member of a namespace import (`billing.PayInvoice`)", null]]],
  ])("a listing that names no event or command: %s", (_label, sections, expected) => {
    const result = build({ "billing/invoice.mesh.mx": invoice(sections) });
    expect(errors(result).map((d) => d.slice(1, 3).concat(d.slice(4)))).toEqual(expected);
  });

  test("one declaration listed twice in a section, under one name or two, is MESH_DUPLICATE_MEMBER at the later line (OD4a)", () => {
    const twice = (sections: string) => errors(build({ "billing/invoice.mesh.mx": invoice(sections) }));
    expect(twice("  events\n    InvoicePaid\n    InvoicePaid\n")).toEqual([["billing/invoice.mesh.mx", 13, 4, "error", "MESH_DUPLICATE_MEMBER", "InvoicePaid is listed twice in the events section of billing.Invoice", "remove one"]]);
    expect(twice("  events\n    InvoicePaid\n    Paid\n")).toEqual([["billing/invoice.mesh.mx", 13, 4, "error", "MESH_DUPLICATE_MEMBER", "Paid is listed twice in the events section of billing.Invoice", "remove one"]]);
    expect(twice("  commands\n    PayInvoice\n    PayInvoice\n")).toEqual([["billing/invoice.mesh.mx", 13, 4, "error", "MESH_DUPLICATE_MEMBER", "PayInvoice is listed twice in the commands section of billing.Invoice", "remove one"]]);
    // A named import and a namespace member of one file are one declaration.
    const both = (sections: string) => errors(build({ "billing/invoice.mesh.mx": invoice(sections, { imports: `${IMPORTS}import * as ev from "./invoice-paid.mesh.mx"\nimport * as c from "./pay-invoice.mesh.mx"\n` }) }));
    expect(both("  events\n    InvoicePaid\n    ev.InvoicePaid\n")).toEqual([["billing/invoice.mesh.mx", 15, 4, "error", "MESH_DUPLICATE_MEMBER", "ev.InvoicePaid is listed twice in the events section of billing.Invoice", "remove one"]]);
    expect(both("  commands\n    c.PayInvoice\n    PayInvoice\n")).toEqual([["billing/invoice.mesh.mx", 15, 4, "error", "MESH_DUPLICATE_MEMBER", "PayInvoice is listed twice in the commands section of billing.Invoice", "remove one"]]);
    // Two events, and an event and a command, are no repeat.
    expect(twice("  events\n    InvoicePaid\n    notices.InvoiceOverdue\n  commands\n    PayInvoice\n")).toEqual([]);
  });

  test("tag parameters on a listing are MESH_SYNTAX, with the contracts' wording; a variable binding is MX's", () => {
    expect(errors(build({ "billing/invoice.mesh.mx": invoice("  events\n    InvoicePaid|x|\n  commands\n    PayInvoice|y|\n") }))).toEqual([
      ["billing/invoice.mesh.mx", 12, 4, "error", "MESH_SYNTAX", "`InvoicePaid`: tag parameters and variable bindings are not entity declarations", null],
      ["billing/invoice.mesh.mx", 14, 4, "error", "MESH_SYNTAX", "`PayInvoice`: tag parameters and variable bindings are not entity declarations", null],
    ]);
    expect(lowered(invoice("  events\n    InvoicePaid/y\n")).map((d) => d[2])).toEqual(["MESH_SYNTAX"]);
  });

  test("a binding its file does not declare is reported once, at the import, and nothing more where it is used", () => {
    const result = build({
      "billing/invoice.mesh.mx": `import { Nope } from "../work/task.mesh.mx"
import { Nop } from "./invoice-paid.mesh.mx"
import { No } from "./pay-invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
  relationships
    belongs-to :task entity=Nope
  actions auto=[:read]
    update on=No
      do
        publish=() => new Nop({ invoiceId: &id })
  events
    Nop
  commands
    No
`,
    });
    expect(errors(result)).toEqual([
      ["billing/invoice.mesh.mx", 1, 9, "error", "MESH_UNKNOWN_IMPORT", "`Nope` is not what ../work/task.mesh.mx declares; it declares `Task`", null],
      ["billing/invoice.mesh.mx", 2, 9, "error", "MESH_UNKNOWN_IMPORT", "`Nop` is not what ./invoice-paid.mesh.mx declares; it declares `InvoicePaid`", null],
      ["billing/invoice.mesh.mx", 3, 9, "error", "MESH_UNKNOWN_IMPORT", "`No` is not what ./pay-invoice.mesh.mx declares; it declares `PayInvoice`", null],
    ]);
  });
});

describe("owners publish (MESH_PUBLISH, the fourth case)", () => {
  const PUBLISH = "        publish=() => new Paid({ invoiceId: &id })\n";
  const owner = (steps = PUBLISH) => invoice("  events\n    InvoicePaid\n", { steps });
  const RULE = "an action publishes only events its owner lists, or events no owner lists";

  test("an action of an entity that does not list an event an owner lists is refused, at the new's callee, whatever name it uses", () => {
    for (const [steps, column, identifier] of [[PUBLISH, 26, "Paid"], ["        publish=() => new ev.InvoicePaid({ invoiceId: &id })\n", 26, "ev.InvoicePaid"]] as const) {
      const result = build({ "billing/invoice.mesh.mx": owner(), "work/task.mesh.mx": worker("Task", steps) });
      expect(errors(result)).toEqual([["work/task.mesh.mx", 9, column, "error", "MESH_PUBLISH",
        `\`${identifier}\` is billing.InvoicePaid, which billing.Invoice lists in its \`events\` section, and work.Task is not one of its owners: ${RULE}`,
        "list it in the `events` section of work.Task, or publish it from an action of billing.Invoice"]]);
    }
  });

  test("an owner's own actions may publish it, through any name (R13)", () => {
    expect(errors(build({ "billing/invoice.mesh.mx": owner() }))).toEqual([]);
    expect(errors(build({ "billing/invoice.mesh.mx": invoice("  events\n    Paid\n", { steps: "        publish=() => new InvoicePaid({ invoiceId: &id })\n" }) }))).toEqual([]);
  });

  test("an event no owner lists may be published by any action (R14), and listing an event one never publishes says nothing", () => {
    expect(errors(build({ "billing/invoice.mesh.mx": invoice("", { steps: PUBLISH }), "work/task.mesh.mx": worker("Task", PUBLISH) }))).toEqual([]);
    expect(build({ "billing/invoice.mesh.mx": invoice("  events\n    InvoicePaid\n    notices.InvoiceOverdue\n") }).diagnostics.filter((d) => d.position.file === "billing/invoice.mesh.mx")).toEqual([]);
  });

  test("two owners may list one event, and each one's actions may publish it; a third entity's may not (R15)", () => {
    const task = worker("Task", PUBLISH, "  events\n    ev.InvoicePaid\n");
    expect(errors(build({ "billing/invoice.mesh.mx": owner(), "work/task.mesh.mx": task }))).toEqual([]);
    const result = build({ "billing/invoice.mesh.mx": owner(), "work/task.mesh.mx": task, "work/note.mesh.mx": worker("Note", PUBLISH) });
    expect(errors(result)).toEqual([["work/note.mesh.mx", 9, 26, "error", "MESH_PUBLISH",
      `\`Paid\` is billing.InvoicePaid, which billing.Invoice, work.Task list in their \`events\` section, and work.Note is not one of its owners: ${RULE}`,
      "list it in the `events` section of work.Note, or publish it from an action of one of billing.Invoice, work.Task"]]);
  });

  test("a publish under a when, in an always block, and each returned new of a function is checked", () => {
    const steps = `        when=() => true
          publish=() => new Paid({ invoiceId: &id })
        publish=({ input }) => { if (input) return new Paid({ invoiceId: &id }); return new ev.InvoicePaid({ invoiceId: &id }) }
`;
    const always = `    always types=[:update]
      do
        publish=() => new Paid({ invoiceId: &id })
`;
    const result = build({ "billing/invoice.mesh.mx": owner(), "work/task.mesh.mx": worker("Task", steps).replace("  actions auto=[:read]\n", `  actions auto=[:read]\n${always}`) });
    // The always block's publish, the one under the when, and both returns of the block body.
    expect(errors(result).map((d) => [d[1], d[2], d[4]])).toEqual([[9, 26, "MESH_PUBLISH"], [13, 28, "MESH_PUBLISH"], [14, 55, "MESH_PUBLISH"], [14, 92, "MESH_PUBLISH"]]);
  });

  test("a publish that returns a helper's result is not checked: the build cannot see its new (OD9)", () => {
    const task = worker("Task", "        publish=() => helper()\n").replace("entity :Task", 'import { helper } from "./helper"\nentity :Task');
    expect(build({ "billing/invoice.mesh.mx": owner(), "work/task.mesh.mx": task }).diagnostics.filter((d) => d.code === "MESH_PUBLISH")).toEqual([]);
  });

  test("not checked when a file of the project could not be parsed: it may list the entity as an owner (R16)", () => {
    const result = build({ "billing/invoice.mesh.mx": owner(), "work/task.mesh.mx": worker("Task", PUBLISH), "work/broken.mesh.mx": "entity :Broken\n  <<<\n" });
    expect(result.diagnostics.filter((d) => d.severity === "error").map((d) => [d.position.file, d.code])).toEqual([["work/broken.mesh.mx", "MESH_TEXT_NOT_ALLOWED"]]);
  });

  test("owning a command restricts nothing: another entity's action answers it", () => {
    const result = build({
      "billing/invoice.mesh.mx": invoice("  commands\n    PayInvoice\n").replace("    update on=PayInvoice\n", "    update :touch\n"),
      "work/task.mesh.mx": worker("Task", "        run=() => undefined\n").replace("entity :Task", 'import { PayInvoice } from "../billing/pay-invoice.mesh.mx"\nentity :Task').replace("    update :go\n", "    update on=PayInvoice\n"),
    });
    expect(errors(result)).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).not.toContain("MESH_COMMAND_UNANSWERED");
  });

  test("what a publish names is kept beside its expression, not in it, so model.json does not change; a copy keeps it", () => {
    const result = build({ "billing/invoice.mesh.mx": owner() });
    const step = entityOf(result, "Invoice").actions.find((a) => a.name === "payInvoice")!.do[0] as Extract<Step, { kind: "publish" }>;
    expect(Object.keys(step.fn)).not.toContain("publishTargets");
    expect(JSON.stringify(step.fn)).not.toContain("declared");
    expect(publishTargetsOf(step.fn)).toEqual([{ from: "./invoice-paid.mesh.mx", declared: "InvoicePaid", identifier: "Paid", position: { file: "billing/invoice.mesh.mx", line: 12, column: 26, offset: 407 } }]);
    expect(publishTargetsOf(copyExpression(step.fn) as Expression)).toEqual(publishTargetsOf(step.fn));
  });
});
