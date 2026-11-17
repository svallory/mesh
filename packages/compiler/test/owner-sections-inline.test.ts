// Events and commands declared inline in an owner's `events` or `commands` section: `notes/architecture/aggregates-design.md`,
// PR 2 (rules R5 to R11 and R9b, rulings D35 OD15 and OD16). An inline declaration means what the same declaration in a
// file of its own means: the same fields, class, FQN and generated file. The owner's file names it without an import,
// another file imports it from the owner's file by its class name, and a file then declares several things, so a named
// import stands for the declaration its imported name names (R8a) and the expressions view resolves an import by (file,
// declared name). The listing lines and the owner check are `owner-sections.test.ts`.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, Entity } from "@meshfw/model";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { publishTargetsOf } from "../src/front-end/expression.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { checkTypes, configOf } from "./generated.ts";
import { closeTypeServer } from "./type-server.ts";

afterAll(closeTypeServer);

const PAID = "event :InvoicePaid\n  uuid :invoiceId\n";
/** The inline event's fields, as a file of its own writes them and as the section writes them (indented two more). */
const VOIDED_FIELDS = ["uuid :invoiceId", "string :reason nullable max=200", "enum :by values=[:staff, :system]"];
const VOIDED = (indent: string) => VOIDED_FIELDS.map((field) => `${indent}${field}\n`).join("");
/**
 * `billing.Invoice`, which declares `InvoiceVoided` and `VoidInvoice` inline, answers the command with an unnamed `update`,
 * publishes the event without an import, and lists the imported `InvoicePaid` beside its inline event.
 */
const invoice = ({ imports = 'import { InvoicePaid } from "./invoice-paid.mesh.mx"\n', steps = "", events = "", commands = "", attributes = "" } = {}) => `${imports}entity :Invoice
  attributes
    uuid :id primary-key
${attributes}  actions auto=[:read]
    update on=VoidInvoice
      input
        string :reason nullable
      do
        publish=() => new InvoiceVoided({ invoiceId: &id, reason: null, by: "staff" })
${steps}  events
    event :InvoiceVoided
${VOIDED("      ")}    InvoicePaid
${events}  commands
    command :VoidInvoice
      uuid :id
      string :reason optional
${commands}`;
/** An entity of `work/` whose `go` action runs `steps`, with the imports and sections the test gives. */
const worker = (name: string, imports: string, steps: string, sections = "", attributes = "") => `${imports}entity :${name}
  attributes
    uuid :id primary-key
${attributes}  actions auto=[:read]
    update :go
      do
${steps}${sections}`;
const files = (extra: Record<string, string>, entity = invoice()) => ({
  root: "/project",
  files: Object.entries({ "billing/invoice-paid.mesh.mx": PAID, "billing/invoice.mesh.mx": entity, ...extra }).map(([file, source]) => ({ file, source })),
});
const build = (extra: Record<string, string> = {}, entity = invoice()) => buildModel(files(extra, entity));
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
const errors = (result: ReturnType<typeof buildModel>) => brief(result.diagnostics.filter((d) => d.severity === "error"));
const entityOf = (result: ReturnType<typeof buildModel>, name: string): Entity => result.document!.entities.find((e) => e.name === name)!;
/** The same entity with `InvoiceVoided` in a file of its own, imported and listed. */
const FILE_FORM = invoice({ imports: 'import { InvoicePaid } from "./invoice-paid.mesh.mx"\nimport { InvoiceVoided } from "./invoice-voided.mesh.mx"\n' })
  .replace(/    event :InvoiceVoided\n(      .*\n)+/, "    InvoiceVoided\n");
const IMPORT_ALL = 'import { InvoiceVoided, VoidInvoice, Invoice } from "../billing/invoice.mesh.mx"\n';
const PUBLISH_VOIDED = '        publish=() => new InvoiceVoided({ invoiceId: &id, reason: null, by: "system" })\n';

describe("the contracts", () => {
  test("an inline event and command lower with their field lines, beside a listing", () => {
    expect(parseEntitySource(invoice(), "/project/billing/invoice.mesh.mx").diagnostics).toEqual([]);
  });

  test("`optional` is an option of an inline command's field, and not of an inline event's", () => {
    const diagnostics = parseEntitySource(invoice({ events: "    event :Noted\n      string :note optional\n" }), "/project/billing/invoice.mesh.mx").diagnostics;
    expect(diagnostics.map((d) => [d.line, d.code, d.message])).toEqual([
      [18, "MESH_UNKNOWN_OPTION", "`optional` is only an option of a command's field: an event field may be left out only when it is `nullable`"],
    ]);
  });

  test("an event line under commands, and a command line under events, stay refused", () => {
    const codes = (source: string) => parseEntitySource(source, "/project/billing/invoice.mesh.mx").diagnostics.map((d) => d.code);
    expect(codes(invoice({ events: "    command :X\n" }))).toEqual(["MESH_TAG_NOT_ALLOWED"]);
    expect(codes(invoice({ commands: "    event :X\n" }))).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });
});

describe("an inline declaration", () => {
  test("builds to the declaration a file of its own builds, its file aside, with no import and no diagnostic", () => {
    const inline = build();
    expect(errors(inline)).toEqual([]);
    const own = build({ "billing/invoice-voided.mesh.mx": `event :InvoiceVoided\n${VOIDED("  ")}` }, FILE_FORM);
    expect(errors(own)).toEqual([]);
    const shape = (result: ReturnType<typeof buildModel>) => {
      const { file, position, fields, ...rest } = result.document!.events!.find((e) => e.name === "InvoiceVoided")!;
      return { ...rest, fields: fields.map(({ position: _, ...field }) => field) };
    };
    expect(shape(inline)).toEqual(shape(own));
    expect(inline.document!.events!.find((e) => e.name === "InvoiceVoided")!.file).toBe("billing/invoice.mesh.mx");
    expect(inline.document!.commands!.map((c) => [c.fqn, c.file, c.fields.map((f) => [f.name, f.optional ?? false])])).toEqual([
      ["billing.VoidInvoice", "billing/invoice.mesh.mx", [["id", false], ["reason", true]]],
    ]);
  });

  test("is owned by its entity, listed in written order beside the listings, with its FQN", () => {
    const entity = entityOf(build(), "Invoice");
    expect(entity.events!.map((ref) => [ref.identifier, ref.from, ref.fqn, ref.position.line])).toEqual([
      ["InvoiceVoided", "./invoice.mesh.mx", "billing.InvoiceVoided", 12],
      ["InvoicePaid", "./invoice-paid.mesh.mx", "billing.InvoicePaid", 16],
    ]);
    expect(entity.commands!.map((ref) => [ref.identifier, ref.from, ref.fqn])).toEqual([["VoidInvoice", "./invoice.mesh.mx", "billing.VoidInvoice"]]);
  });

  test("is named in its file without an import: a publish's new and on= (the action takes the command's name)", () => {
    const result = build();
    const entity = entityOf(result, "Invoice");
    const action = entity.actions.find((a) => a.kind === "update")!;
    expect([action.name, action.command]).toEqual(["voidInvoice", { identifier: "VoidInvoice", from: "./invoice.mesh.mx", fqn: "billing.VoidInvoice", position: action.command!.position }]);
    const publish = action.do[0]!;
    expect(publish.kind).toBe("publish");
    expect(publishTargetsOf((publish as { fn: Parameters<typeof publishTargetsOf>[0] }).fn)?.map((t) => [t.from, t.declared])).toEqual([["./invoice.mesh.mx", "InvoiceVoided"]]);
    // the command is answered, so nothing warns that it is not
    expect(result.diagnostics.filter((d) => d.code === "MESH_COMMAND_UNANSWERED")).toEqual([]);
  });

  test("an own class read anywhere else in a function: a run step's new warns only, a local and instanceof are no free variables", () => {
    const result = build({}, invoice({ steps: '        run=() => new InvoiceVoided({ invoiceId: &id, reason: null, by: "staff" })\n        run=({ input }) => input instanceof VoidInvoice\n    update :again\n      do\n        publish=() => { const e = new InvoiceVoided({ invoiceId: &id, reason: null, by: "staff" }); return e }\n' }));
    expect(brief(result.diagnostics.filter((d) => d.code !== "MESH_PUBLISH_BEFORE_WRITE"))).toEqual([
      ["billing/invoice.mesh.mx", 11, 18, "warning", "MESH_EVENT_NOT_PUBLISHED", "`new InvoiceVoided(...)` constructs an event here, and constructing one raises nothing: only a `publish` step raises an event", "raise it with a `publish` step in the action's `do`: `publish=() => new InvoiceVoided({ ... })`"],
    ]);
  });

  test("a group folder's mistake is reported once, at the entity, not once per inline declaration", () => {
    const result = buildModel({ root: "/project", files: [{ file: "billing/_/invoice.mesh.mx", source: invoice({ imports: "" }).replace("    InvoicePaid\n", "") }] });
    expect(errors(result).map((d) => [d[1], d[4]])).toEqual([[1, "MESH_GROUP_NAME"]]);
  });

  test("in a group folder it belongs to the module, as a file of its own would", () => {
    const result = buildModel({ root: "/project", files: [{ file: "billing/_ledger/invoice.mesh.mx", source: invoice({ imports: "" }).replace("    InvoicePaid\n", "") }] });
    expect(errors(result)).toEqual([]);
    expect(result.document!.events!.map((e) => [e.fqn, e.module, e.file])).toEqual([["billing.InvoiceVoided", "billing", "billing/_ledger/invoice.mesh.mx"]]);
  });

  test("its name and fields are checked as a file's: MESH_NAME, a refused option, a repeated field; it takes no import of its own (R11)", () => {
    const result = build({}, invoice({ events: "    event :_1\n      uuid :a default=1\n      uuid :a\n" }));
    expect(errors(result).map((d) => [d[1], d[4]])).toEqual([[17, "MESH_NAME"], [18, "MESH_UNKNOWN_OPTION"], [19, "MESH_DUPLICATE_MEMBER"]]);
    expect(result.diagnostics.some((d) => d.message.includes("takes no import"))).toBe(false);
  });

  test("an events listing of the section's own inline declaration is listed twice (OD4a)", () => {
    expect(errors(build({}, invoice({ events: "    InvoiceVoided\n" })))).toEqual([
      ["billing/invoice.mesh.mx", 17, 4, "error", "MESH_DUPLICATE_MEMBER", "InvoiceVoided is listed twice in the events section of billing.Invoice", "remove one"],
    ]);
  });

  test("an own inline command listed under events is no event", () => {
    expect(errors(build({}, invoice({ events: "    VoidInvoice\n" }))).map((d) => [d[4], d[5]])).toEqual([["MESH_UNKNOWN_EVENT", "VoidInvoice is not an imported event."]]);
  });
});

describe("one name, one meaning (R9, R9b, R10)", () => {
  test("R9b: an inline declaration named as the file's entity, or as an earlier inline declaration, is an error at the later line", () => {
    expect(errors(build({}, invoice({ events: "    event :Invoice\n", commands: "    command :invoice_voided\n" })))).toEqual([
      ["billing/invoice.mesh.mx", 17, 4, "error", "MESH_DUPLICATE_ENTITY", "Duplicate name Invoice in billing/invoice.mesh.mx: the entity Invoice and the event Invoice would be one class name billing.Invoice", "rename one"],
      ["billing/invoice.mesh.mx", 22, 4, "error", "MESH_DUPLICATE_ENTITY", "Duplicate name InvoiceVoided in billing/invoice.mesh.mx: the event InvoiceVoided and the command InvoiceVoided would be one class name billing.InvoiceVoided", "rename one"],
    ]);
    expect(errors(build({}, invoice({ commands: "    command :Invoice\n" }))).map((d) => d[5])).toEqual([
      "Duplicate name Invoice in billing/invoice.mesh.mx: the entity Invoice and the command Invoice would be one class name billing.Invoice",
    ]);
  });

  test("R9: an import binding an inline class name, or the file's own entity name, is MESH_DUPLICATE_IMPORT at the binding", () => {
    const imports = 'import { InvoicePaid } from "./invoice-paid.mesh.mx"\nimport { InvoicePaid as InvoiceVoided } from "./invoice-paid.mesh.mx"\nimport { Task as Invoice } from "../work/task.mesh.mx"\n';
    const task = worker("Task", "", "        run=() => undefined\n");
    expect(errors(build({ "work/task.mesh.mx": task }, invoice({ imports })))).toEqual([
      ["billing/invoice.mesh.mx", 2, 24, "error", "MESH_DUPLICATE_IMPORT", "Duplicate import identifier InvoiceVoided: the file declares the event InvoiceVoided too", null],
      ["billing/invoice.mesh.mx", 3, 17, "error", "MESH_DUPLICATE_IMPORT", "Duplicate import identifier Invoice: the file declares the entity Invoice too", null],
    ]);
  });

  test("R9's legal neighbour: an import of the file itself binds the very declaration, the entity or an inline one", () => {
    const imports = 'import { InvoicePaid } from "./invoice-paid.mesh.mx"\nimport { Invoice, InvoiceVoided } from "./invoice.mesh.mx"\n';
    expect(errors(build({}, invoice({ imports })))).toEqual([]);
  });

  test("R10: an inline event and an event file of one FQN are one duplicate", () => {
    const result = build({ "billing/invoice-voided.mesh.mx": `event :InvoiceVoided\n${VOIDED("  ")}` });
    expect(errors(result).map((d) => [d[4], d[5]])).toEqual([
      ["MESH_DUPLICATE_ENTITY", "Duplicate event billing.InvoiceVoided; first declared in billing/invoice.mesh.mx"],
    ]);
  });

  test("the same inline name in two modules is two declarations", () => {
    const other = invoice({ imports: "" }).replace("    InvoicePaid\n", "");
    expect(errors(build({ "sales/invoice.mesh.mx": other }))).toEqual([]);
  });
});

describe("another file names an inline declaration (R8, R8a)", () => {
  const task = (steps: string, sections = "", imports = IMPORT_ALL, attributes = "") => worker("Task", imports, steps, sections, attributes);

  test("by its class name from the owner's file, named or as a namespace member, and lists it as a second owner (R15)", () => {
    const result = build({
      "work/task.mesh.mx": task(PUBLISH_VOIDED, "  events\n    InvoiceVoided\n"),
      "work/run.mesh.mx": worker("Run", 'import * as billing from "../billing/invoice.mesh.mx"\n', '        publish=() => new billing.InvoiceVoided({ invoiceId: &id, reason: null, by: "system" })\n        run=() => billing.Invoice\n', "  events\n    billing.InvoiceVoided\n  commands\n    billing.VoidInvoice\n"),
    });
    expect(errors(result)).toEqual([]);
    expect(entityOf(result, "Task").events!.map((ref) => ref.fqn)).toEqual(["billing.InvoiceVoided"]);
    expect(entityOf(result, "Run").commands!.map((ref) => [ref.identifier, ref.fqn])).toEqual([["billing.VoidInvoice", "billing.VoidInvoice"]]);
  });

  test("a third entity's publish of an owned inline event is MESH_PUBLISH", () => {
    const result = build({ "work/task.mesh.mx": task(PUBLISH_VOIDED) });
    expect(errors(result).map((d) => [d[1], d[2], d[4], d[5]])).toEqual([
      [8, 26, "MESH_PUBLISH", "`InvoiceVoided` is billing.InvoiceVoided, which billing.Invoice lists in its `events` section, and work.Task is not one of its owners: an action publishes only events its owner lists, or events no owner lists"],
    ]);
  });

  test("a named import of a name the owner's file does not declare lists every name it declares, and its uses report nothing more", () => {
    const result = build({ "work/task.mesh.mx": task("        run=() => new Nope()\n", "", 'import { Nope } from "../billing/invoice.mesh.mx"\n') });
    expect(errors(result).map((d) => [d[1], d[4], d[5]])).toEqual([
      [1, "MESH_UNKNOWN_IMPORT", "`Nope` is not what ../billing/invoice.mesh.mx declares; it declares `Invoice`, `InvoiceVoided`, `VoidInvoice`"],
    ]);
  });

  test("a file that declares one thing keeps its message", () => {
    const result = build({ "work/task.mesh.mx": task("        run=() => undefined\n", "", 'import { Nope } from "../billing/invoice-paid.mesh.mx"\n') });
    expect(errors(result).map((d) => d[5])).toEqual(["`Nope` is not what ../billing/invoice-paid.mesh.mx declares; it declares `InvoicePaid`"]);
  });

  test("R8a: each reference position takes a binding only when its declaration is of the position's kind", () => {
    const result = build({
      "work/task.mesh.mx": task(
        "        publish=() => new Invoice({})\n    update :answer on=Invoice\n",
        "  events\n    Invoice\n  commands\n    InvoiceVoided\n",
        IMPORT_ALL,
        "  relationships\n    belongs-to :voided entity=InvoiceVoided\n    has-many :links entity=Invoice through=VoidInvoice\n",
      ),
    });
    expect(errors(result).map((d) => [d[1], d[4], d[5]])).toEqual([
      [6, "MESH_UNKNOWN_ENTITY", "InvoiceVoided is not an imported entity: ../billing/invoice.mesh.mx declares InvoiceVoided as an event."],
      [7, "MESH_UNKNOWN_ENTITY", "VoidInvoice is not an imported entity: ../billing/invoice.mesh.mx declares VoidInvoice as a command."],
      [11, "MESH_PUBLISH", "Invoice is not an imported event: ../billing/invoice.mesh.mx declares Invoice as an entity."],
      [12, "MESH_UNKNOWN_COMMAND", "Invoice is not an imported command: ../billing/invoice.mesh.mx declares Invoice as an entity."],
      [14, "MESH_UNKNOWN_EVENT", "Invoice is not an imported event: ../billing/invoice.mesh.mx declares Invoice as an entity."],
      [16, "MESH_UNKNOWN_COMMAND", "InvoiceVoided is not an imported command: ../billing/invoice.mesh.mx declares InvoiceVoided as an event."],
    ]);
  });

  test("a namespace alias of a file that declares an entity and events reads both; a member it declares neither is one error", () => {
    const imports = 'import * as billing from "../billing/invoice.mesh.mx"\n';
    const ok = build({ "work/task.mesh.mx": task('        run=() => billing.Invoice.read({})\n        run=() => new billing.VoidInvoice({ id: &id })\n', "", imports) });
    expect(errors(ok)).toEqual([]);
    const bad = build({ "work/task.mesh.mx": task("        run=() => billing.Nope\n", "", imports) });
    expect(errors(bad).map((d) => [d[1], d[2], d[4], d[5]])).toEqual([
      [8, 26, "MESH_UNKNOWN_ENTITY", "billing.Nope is not an imported entity, event or command: ../billing/invoice.mesh.mx declares `Invoice`, `InvoiceVoided`, `VoidInvoice`."],
    ]);
    // an alias of an entity-only file keeps its own message
    const entityOnly = build({ "work/task.mesh.mx": task("        run=() => w.Nope\n", "", 'import * as w from "./run.mesh.mx"\n'), "work/run.mesh.mx": worker("Run", "", "        run=() => undefined\n") });
    expect(errors(entityOnly).map((d) => d[5])).toEqual(["w.Nope is not an imported entity: ./run.mesh.mx declares `Run`. Did you mean w.Run?"]);
  });

  test("a publish through a merged alias calls a member a command only when it is one", () => {
    const imports = 'import * as billing from "../billing/invoice.mesh.mx"\n';
    const published = (callee: string) => errors(build({ "work/task.mesh.mx": task(`        publish=() => new ${callee}({})\n`, "", imports) })).map((d) => [d[1], d[4], d[5]]);
    expect(published("billing.Invoice")).toEqual([
      [8, "MESH_PUBLISH", "billing.Invoice is not an imported event: ../billing/invoice.mesh.mx declares `InvoiceVoided`. Did you mean billing.InvoiceVoided?"],
    ]);
    expect(published("billing.Nope")).toEqual([
      [8, "MESH_PUBLISH", "billing.Nope is not an imported event: ../billing/invoice.mesh.mx declares `InvoiceVoided`. Did you mean billing.InvoiceVoided?"],
    ]);
    expect(published("billing.VoidInvoice").map((d) => d[2])).toEqual([
      "`billing.VoidInvoice` is a command, not an event: a `publish` function returns `new` of an event the file imports, and a command asks for a write instead of recording a fact",
    ]);
  });

  test("another entity answers an inline command by name and through a namespace member", () => {
    // the owner here answers nothing, so the other entity's action is the command's one answer
    const owner = invoice().replace(/    update on=VoidInvoice\n(      .*\n)+/, "");
    for (const [imports, on] of [['import { VoidInvoice } from "../billing/invoice.mesh.mx"\n', "VoidInvoice"], ['import * as billing from "../billing/invoice.mesh.mx"\n', "billing.VoidInvoice"]] as const) {
      const result = build({ "work/task.mesh.mx": task(`        run=() => undefined\n    update on=${on}\n      input\n        string :reason nullable\n`, "", imports) }, owner);
      expect(errors(result)).toEqual([]);
      const action = entityOf(result, "Task").actions.find((a) => a.command !== undefined)!;
      expect([action.name, action.command!.fqn]).toEqual(["voidInvoice", "billing.VoidInvoice"]);
    }
  });
});

describe("what is generated", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  const generate = async (result: ReturnType<typeof buildModel>) => {
    expect(errors(result)).toEqual([]);
    return generateFiles({ document: result.document!, config: configOf("/project", ".mesh") });
  };
  const text = (generated: readonly { path: string; contents: string }[], path: string) => generated.find((file) => file.path === path)!.contents;

  test("the inline event's class file is the file form's, apart from the file its header names", async () => {
    const inline = await generate(build());
    const own = await generate(build({ "billing/invoice-voided.mesh.mx": `event :InvoiceVoided\n${VOIDED("  ")}` }, FILE_FORM));
    const path = ".mesh/domain/billing/invoiceVoided.event.ts";
    expect(text(inline, path).replace("billing/invoice.mesh.mx", "FILE")).toBe(text(own, path).replace("billing/invoice-voided.mesh.mx", "FILE"));
    // the class import of the entity's functions is the same either way: it is derived from the declaration, not the import
    expect(text(inline, ".mesh/domain/billing/invoice.expressions.ts")).toContain('import { InvoiceVoided as $billing$InvoiceVoided$class } from "./invoiceVoided.event";');
    // the file form's entity file has one import line more, so its comments name other lines
    const lines = (code: string) => code.replace(/invoice\.mesh\.mx:\d+:\d+/g, "invoice.mesh.mx:L");
    expect(lines(text(inline, ".mesh/domain/billing/invoice.expressions.ts"))).toBe(lines(text(own, ".mesh/domain/billing/invoice.expressions.ts")));
  });

  test("two inline events of one file come out in written order in the event table", async () => {
    const generated = await generate(build({}, invoice({ events: "    event :AInvoiceNoted\n      uuid :invoiceId\n" })));
    const index = text(generated, ".mesh/index.ts");
    const order = ["billing.InvoicePaid", "billing.InvoiceVoided", "billing.AInvoiceNoted"].map((fqn) => index.indexOf(`"${fqn}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    // invoice-paid.mesh.mx sorts before invoice.mesh.mx; inside invoice.mesh.mx, written order, not name order
    expect(order[1]!).toBeLessThan(order[2]!);
  });

  test("the generated tree type-checks: an own inline event and command, one imported by name, one through a merged namespace alias", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-inline-"));
    roots.push(root);
    const config = configOf(root);
    const result = build({
      "work/task.mesh.mx": worker("Task", IMPORT_ALL, PUBLISH_VOIDED, "  events\n    InvoiceVoided\n"),
      "work/run.mesh.mx": worker("Run", 'import * as billing from "../billing/invoice.mesh.mx"\n',
        '        publish=() => new billing.InvoiceVoided({ invoiceId: &id, reason: null, by: "system" })\n        run=async () => { const rows: readonly billing.Invoice[] = await billing.Invoice.read({}); return rows.length }\n',
        "  events\n    billing.InvoiceVoided\n"),
    });
    expect(errors(result)).toEqual([]);
    const generated = await generateFiles({ document: result.document!, config });
    const run = generated.find((file) => file.path.endsWith("run.expressions.ts"))!.contents.replace(/\s+/g, " ");
    // the alias is bound once, to one object of the entity value and the class, and declared once as a type namespace
    expect(run.match(/const billing:/g)?.length).toBe(2);
    expect(run).toContain("export type Invoice = $billing$Invoice$Record; export type InvoiceVoided = $billing$InvoiceVoided$class;");
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {}, task: {}, run: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    const checked = await checkTypes(root, [...generated.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
  }, 60_000);
});
