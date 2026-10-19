// M6 PR 5: `on=` answers a command (`notes/spec/events-and-commands.md`, "Answering a command"). The build resolves it
// through the file's imports, names an unnamed action after the command, records the command's FQN on the action, and
// checks the command against the action: `MESH_NAME`, `MESH_UNKNOWN_COMMAND`, `MESH_DUPLICATE_MEMBER`,
// `MESH_COMMAND_INPUT`, `MESH_COMMAND_ANSWERED_TWICE` and `MESH_COMMAND_UNANSWERED`. What `dispatch` does at run time, and
// `mesh explain`, are `packages/cli/test/events.test.ts`.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { closeTypeServer } from "./type-server.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { checkTypes, configOf } from "./generated.ts";

afterAll(closeTypeServer);

const PAY = `command :PayInvoice
  uuid :id
  datetime :paidAt
`;
const PAID = `event :InvoicePaid
  uuid :invoiceId
`;
const IMPORT = `import { PayInvoice } from "./pay-invoice.mesh.mx"\n`;
/** An invoice in billing/ with the actions the test writes (indented four spaces), after `imports`. */
const invoice = (actions: string, imports = IMPORT) => `${imports}entity :Invoice
  attributes
    uuid :id primary-key
    boolean :paid default=false
    datetime :paidAt nullable
  actions auto=[:read]
${actions}`;
const project = (entity: string, extra: Record<string, string> = {}, command = PAY) => ({
  root: "/project",
  files: Object.entries({ "billing/pay-invoice.mesh.mx": command, "billing/invoice.mesh.mx": entity, ...extra }).map(([file, source]) => ({ file, source })),
});
/** A project with no `PayInvoice`, for the tests that bring their own commands. */
const bare = (entity: string, extra: Record<string, string>) => ({ root: "/project", files: Object.entries({ "billing/invoice.mesh.mx": entity, ...extra }).map(([file, source]) => ({ file, source })) });
const build = (actions: string, imports = IMPORT, extra: Record<string, string> = {}, command = PAY) => buildModel(project(invoice(actions, imports), extra, command));
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => d.code);
const invoiceOf = (result: ReturnType<typeof buildModel>): Entity => result.document!.entities.find((entity) => entity.name === "Invoice")!;
const PAY_ACTION = "    update on=PayInvoice\n      input\n        &paidAt\n";

describe("naming an action after its command", () => {
  test("update on=PayInvoice is payInvoice, and the model records the command's FQN, the identifier as written and where on= is", () => {
    const result = build(PAY_ACTION);
    expect(result.diagnostics).toEqual([]);
    const action = invoiceOf(result).actions[0]!;
    expect(action.name).toBe("payInvoice");
    expect(action.command).toEqual({ identifier: "PayInvoice", from: "./pay-invoice.mesh.mx", fqn: "billing.PayInvoice", position: { file: "billing/invoice.mesh.mx", line: 8, column: 14, offset: expect.any(Number) } });
  });

  test("through a namespace import, billing.PayInvoice names the same action; the alias is the author's and no part of the FQN", () => {
    const result = build("    update on=pay.PayInvoice\n      input\n        &paidAt\n", `import * as pay from "./pay-invoice.mesh.mx"\n`);
    expect(result.diagnostics).toEqual([]);
    expect(invoiceOf(result).actions[0]).toMatchObject({ name: "payInvoice", command: { identifier: "pay.PayInvoice", fqn: "billing.PayInvoice" } });
  });

  test("after an alias, on=Pay is still payInvoice: the name is the command's class, whatever the file binds", () => {
    const result = build("    update on=Pay\n      input\n        &paidAt\n", `import { PayInvoice as Pay } from "./pay-invoice.mesh.mx"\n`);
    expect(result.diagnostics).toEqual([]);
    expect(invoiceOf(result).actions[0]).toMatchObject({ name: "payInvoice", command: { identifier: "Pay", fqn: "billing.PayInvoice" } });
  });

  test("a name in the slot wins: update :pay on=PayInvoice is pay", () => {
    const result = build("    update :pay on=PayInvoice\n      input\n        &paidAt\n");
    expect(result.diagnostics).toEqual([]);
    expect(invoiceOf(result).actions[0]).toMatchObject({ name: "pay", command: { fqn: "billing.PayInvoice" } });
  });

  test("a command declared in snake case makes its class name: command :pay_invoice is the action payInvoice", () => {
    const result = build(PAY_ACTION, IMPORT, {}, PAY.replace("PayInvoice", "pay_invoice"));
    expect(result.diagnostics).toEqual([]);
    expect(invoiceOf(result).actions[0]).toMatchObject({ name: "payInvoice", command: { fqn: "billing.PayInvoice" } });
  });

  test("create and destroy answer commands as update does; a destroy's key counts as an input", () => {
    const result = buildModel(bare(
      `import { OpenInvoice } from "./open-invoice.mesh.mx"\nimport { VoidInvoice } from "./void-invoice.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n    string :title\n  actions auto=[:read]\n    create on=OpenInvoice\n      input\n        &title\n    destroy on=VoidInvoice\n`,
      { "billing/open-invoice.mesh.mx": "command :OpenInvoice\n  string :title\n", "billing/void-invoice.mesh.mx": "command :VoidInvoice\n  uuid :id\n" },
    ));
    expect(result.diagnostics).toEqual([]);
    expect(invoiceOf(result).actions.map((action) => [action.kind, action.name, action.command?.fqn])).toEqual([["create", "openInvoice", "billing.OpenInvoice"], ["destroy", "voidInvoice", "billing.VoidInvoice"]]);
  });

  test("a project with no on= keeps actions with no command key, so model.json is what it was", () => {
    const result = buildModel({ root: "/project", files: [{ file: "a/todo.mesh.mx", source: "entity :Todo\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n    update :rename\n" }] });
    expect(result.diagnostics).toEqual([]);
    expect("command" in result.document!.entities[0]!.actions[0]!).toBe(false);
  });
});

describe("MESH_DUPLICATE_MEMBER", () => {
  test("a name taken from the command beside an explicit one names the command, at the later member", () => {
    const result = build(`    update :payInvoice\n    ${PAY_ACTION.trimStart()}`);
    expect(brief(result.diagnostics.filter((d) => d.code === "MESH_DUPLICATE_MEMBER"))).toEqual([
      ["billing/invoice.mesh.mx", 9, 4, "error", "MESH_DUPLICATE_MEMBER",
        "Duplicate member :payInvoice: the update that answers PayInvoice takes its name from the command; write a name for it (`update :name on=PayInvoice`) or rename the other member", null],
    ]);
  });

  test("the explicit one after the computed one reports the same clash, at the explicit one", () => {
    const result = build(`${PAY_ACTION}    update :payInvoice\n`);
    expect(brief(result.diagnostics.filter((d) => d.code === "MESH_DUPLICATE_MEMBER")).map((d) => [d[1], d[5]])).toEqual([
      [11, "Duplicate member :payInvoice: the update that answers PayInvoice takes its name from the command; write a name for it (`update :name on=PayInvoice`) or rename the other member"],
    ]);
  });

  test("two actions whose computed names are equal (two commands of one class name in two modules) clash", () => {
    const result = build(
      `${PAY_ACTION}    update on=sales.PayInvoice\n      input\n        &paidAt\n`,
      `${IMPORT}import * as sales from "../sales/pay-invoice.mesh.mx"\n`,
      { "sales/pay-invoice.mesh.mx": PAY },
    );
    expect(brief(result.diagnostics.filter((d) => d.code === "MESH_DUPLICATE_MEMBER"))).toEqual([
      ["billing/invoice.mesh.mx", 12, 4, "error", "MESH_DUPLICATE_MEMBER",
        "Duplicate member :payInvoice: the update that answers sales.PayInvoice takes its name from the command; write a name for it (`update :name on=sales.PayInvoice`) or rename the other member", null],
    ]);
  });

  test("a name taken from the command that clashes with an attribute is reported too", () => {
    const result = buildModel(bare(
      `import { Paid } from "./paid.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n    boolean :paid default=false\n  actions\n    update on=Paid\n`,
      { "billing/paid.mesh.mx": "command :Paid\n  uuid :id\n" },
    ));
    expect(brief(result.diagnostics)).toEqual([
      ["billing/invoice.mesh.mx", 7, 4, "error", "MESH_DUPLICATE_MEMBER", "Duplicate member :paid: the update that answers Paid takes its name from the command; write a name for it (`update :name on=Paid`) or rename the other member", null],
    ]);
  });
});

describe("MESH_NAME", () => {
  test.each(["create", "update", "destroy"])("a bare %s names neither itself nor a command, at the action line, and the message names on=", (kind) => {
    const result = build(`    ${kind}\n`);
    expect(brief(result.diagnostics.filter((d) => d.code === "MESH_NAME"))).toEqual([
      ["billing/invoice.mesh.mx", 8, 4, "error", "MESH_NAME", `\`${kind}\`: an action needs a name or \`on=\`: write \`${kind} :name\`, or \`${kind} on=PayInvoice\` to take the name from the command`, null],
    ]);
  });
});

describe("MESH_UNKNOWN_COMMAND", () => {
  const unknown = (result: ReturnType<typeof buildModel>) => brief(result.diagnostics.filter((d) => d.code === "MESH_UNKNOWN_COMMAND"));

  test("an event is no command", () => {
    const result = build("    update on=InvoicePaid\n", `${IMPORT}import { InvoicePaid } from "./invoice-paid.mesh.mx"\n`, { "billing/invoice-paid.mesh.mx": PAID });
    expect(unknown(result)).toEqual([["billing/invoice.mesh.mx", 9, 14, "error", "MESH_UNKNOWN_COMMAND", "InvoicePaid is not an imported command.", null]]);
  });

  test("an entity is no command, the file's own included", () => {
    const result = build("    update on=Line\n    update on=Invoice\n", `${IMPORT}import { Line } from "./line.mesh.mx"\n`, { "billing/line.mesh.mx": "entity :Line\n  attributes\n    uuid :id primary-key\n" });
    expect(unknown(result).map((d) => [d[1], d[2], d[5]])).toEqual([
      [9, 14, "Line is not an imported command."],
      [10, 14, "Invoice is not an imported command."],
    ]);
  });

  test("a name nothing imports, with the nearest imported command; and with none near, no suggestion", () => {
    expect(unknown(build("    update on=PayInvoce\n")).map((d) => [d[1], d[2], d[5]])).toEqual([[8, 14, "PayInvoce is not an imported command. Did you mean PayInvoice?"]]);
    expect(unknown(build("    update on=Whatever\n", "")).map((d) => d[5])).toEqual(["Whatever is not an imported command."]);
  });

  test("a member of a namespace import: one the file does not declare, one through a file that is no command file, and one through a name import", () => {
    const events = { "billing/invoice-paid.mesh.mx": PAID };
    const miss = build("    update on=pay.PayInvoce\n", `import * as pay from "./pay-invoice.mesh.mx"\n`);
    expect(unknown(miss).map((d) => [d[1], d[2], d[5]])).toEqual([[8, 18,
      "pay.PayInvoce is not an imported command: ./pay-invoice.mesh.mx declares `PayInvoice`. Did you mean pay.PayInvoice?"]]);
    const wrongKind = build("    update on=ev.InvoicePaid\n", `import * as ev from "./invoice-paid.mesh.mx"\n`, events);
    expect(unknown(wrongKind).map((d) => d[5])).toEqual(["ev.InvoicePaid is not an imported command: ev is a namespace import of ./invoice-paid.mesh.mx, which is not a command file"]);
    const byName = build("    update on=PayInvoice.Other\n");
    expect(unknown(byName).map((d) => d[5])).toEqual([expect.stringContaining("PayInvoice.Other is not an imported command: PayInvoice is imported by name")]);
  });

  test("a helper import is no command: on= naming a function or a helper namespace", () => {
    const helper = { "billing/helpers.ts": "export const isStaff = () => true;\n" };
    const byName = build("    update on=isStaff\n", `${IMPORT}import { isStaff } from "./helpers"\n`, helper);
    expect(unknown(byName).map((d) => [d[1], d[2], d[5]])).toEqual([[9, 14, "isStaff is not an imported command."]]);
    const namespaced = build("    update on=h.isStaff\n", `${IMPORT}import * as h from "./helpers"\n`, helper);
    expect(unknown(namespaced).map((d) => [d[1], d[2], d[5]])).toEqual([[9, 14, expect.stringContaining("h.isStaff is not an imported command")]]);
  });

  test("on= naming the namespace import itself says to name the command it declares", () => {
    const result = build("    update on=pay\n", `import * as pay from "./pay-invoice.mesh.mx"\n`);
    expect(unknown(result).map((d) => d[5])).toEqual(["pay is a namespace import of ./pay-invoice.mesh.mx, not a command: name the command it declares, `pay.PayInvoice`"]);
  });

  test.each([
    ["a call", "pay()"],
    ["an atom", ":PayInvoice"],
    ["an element access", "pay[0]"],
    ["an optional access", "pay?.PayInvoice"],
    ["a member", "&pay"],
    ["a member path", "&pay.PayInvoice"],
  ])("a value that is no reference (%s) is refused by the contract, at the option", (_label, value) => {
    const result = build(`    update on=${value}\n`, `${IMPORT}import * as pay from "./pay-invoice.mesh.mx"\n`);
    expect(unknown(result)).toEqual([["billing/invoice.mesh.mx", 9, 11, "error", "MESH_UNKNOWN_COMMAND", "`update`: on must be an imported command (`on=PayInvoice`) or a member of a namespace import (`on=billing.PayInvoice`)", null]]);
  });

  test.each(["(PayInvoice)", "PayInvoice!", "PayInvoice as PayInvoice", "<PayInvoice>PayInvoice"])("a wrapped reference (%s) is refused at the value as written", (value) => {
    const result = build(`    update on=${value}\n`);
    expect(unknown(result)).toEqual([["billing/invoice.mesh.mx", 8, 14, "error", "MESH_UNKNOWN_COMMAND", "`update`: on must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`on=PayInvoice`, `on=billing.PayInvoice`)", null]]);
  });

  test("a string is no expression: MX refuses it before the build looks at it, as it does for entity=", () => {
    const result = build('    update on="PayInvoice"\n');
    expect(brief(result.diagnostics)).toEqual([["billing/invoice.mesh.mx", 8, 11, "error", "MESH_OPTION_VALUE", "`update`: option `on` must be an expression", null]]);
  });

  test("on= on a read is refused by the read's closed contract", () => {
    const result = build("    read :custom on=PayInvoice\n");
    expect(brief(result.diagnostics.filter((d) => d.code === "MESH_UNKNOWN_OPTION"))).toEqual([
      ["billing/invoice.mesh.mx", 8, 17, "error", "MESH_UNKNOWN_OPTION", "`read`: unknown option `on`", null],
    ]);
  });
});

describe("MESH_COMMAND_ANSWERED_TWICE and MESH_COMMAND_UNANSWERED", () => {
  test("two actions of one entity answer one command: reported at the second on=, naming the first", () => {
    const result = build(`${PAY_ACTION}    update :again on=PayInvoice\n      input\n        &paidAt\n`);
    expect(brief(result.diagnostics)).toEqual([
      ["billing/invoice.mesh.mx", 11, 21, "error", "MESH_COMMAND_ANSWERED_TWICE",
        "Command billing.PayInvoice is answered by two actions: billing.Invoice#payInvoice (billing/invoice.mesh.mx:8) and billing.Invoice#again",
        "a command is answered by one action: give the second action a command of its own"],
    ]);
  });

  test("two actions of two entities, in two files, answer one command", () => {
    const other = `${IMPORT}entity :Receipt\n  attributes\n    uuid :id primary-key\n    datetime :paidAt nullable\n  actions\n    update on=PayInvoice\n      input\n        &paidAt\n`;
    const result = build(PAY_ACTION, IMPORT, { "billing/receipt.mesh.mx": other });
    expect(brief(result.diagnostics).map((d) => [d[0], d[1], d[2], d[4], d[5]])).toEqual([
      ["billing/receipt.mesh.mx", 7, 14, "MESH_COMMAND_ANSWERED_TWICE", "Command billing.PayInvoice is answered by two actions: billing.Invoice#payInvoice (billing/invoice.mesh.mx:8) and billing.Receipt#payInvoice"],
    ]);
  });

  test("a third action is reported as well, against the first", () => {
    const answer = (name: string) => `    update :${name} on=PayInvoice\n      input\n        &paidAt\n`;
    const result = build(answer("one") + answer("two") + answer("three"));
    expect(brief(result.diagnostics).map((d) => [d[1], d[5]])).toEqual([
      [11, "Command billing.PayInvoice is answered by two actions: billing.Invoice#one (billing/invoice.mesh.mx:8) and billing.Invoice#two"],
      [14, "Command billing.PayInvoice is answered by two actions: billing.Invoice#one (billing/invoice.mesh.mx:8) and billing.Invoice#three"],
    ]);
  });

  test("a command no action answers is a warning at the command's root line, with the fix; it does not fail the build", () => {
    const result = build("    update :rename\n", "");
    expect(brief(result.diagnostics)).toEqual([
      ["billing/pay-invoice.mesh.mx", 1, 0, "warning", "MESH_COMMAND_UNANSWERED",
        "Command billing.PayInvoice is answered by no action: nothing runs when it is dispatched", "answer it with an action's `on=`, as in `update on=PayInvoice`"],
    ]);
    expect(result.document).not.toBeNull();
  });

  test("with a file that did not parse, \"unanswered\" is not known: the action may be in it", () => {
    const result = build("    update :rename\n", "", { "billing/broken.mesh.mx": "entity :Broken\n  attributes\n    uuid :id primary-key\n  actions\n    update :x on=\n" });
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "MESH_COMMAND_UNANSWERED")).toBe(false);
  });

  test("a command answered through an alias is answered", () => {
    expect(build("    update on=Pay\n      input\n        &paidAt\n", `import { PayInvoice as Pay } from "./pay-invoice.mesh.mx"\n`).diagnostics).toEqual([]);
  });
});

describe("MESH_COMMAND_INPUT", () => {
  const inputs = (result: ReturnType<typeof buildModel>) => brief(result.diagnostics.filter((d) => d.code === "MESH_COMMAND_INPUT")).map((d) => [d[1], d[2], d[5], d[6]]);

  test("a command field that is no input of the action", () => {
    const result = build("    update on=PayInvoice\n");
    expect(inputs(result)).toEqual([[7 + 1, 14,
      "Command billing.PayInvoice has the field `paidAt`, which is no input of billing.Invoice#payInvoice: every field of the command is an input of the action it answers",
      "add `&paidAt` or an argument `paidAt` to the input of the action, or remove the field"]]);
  });

  test("a required input that is no field of the command, the key of an update included", () => {
    const result = build(PAY_ACTION, IMPORT, {}, "command :PayInvoice\n  datetime :paidAt\n");
    expect(inputs(result)).toEqual([[8, 14,
      "billing.Invoice#payInvoice requires the input `id`, the key that selects the row of an update, which is no field of billing.PayInvoice: every required input of the action is a field of the command it answers",
      "add the field `id` to the command, or make the input optional"]]);
  });

  test("the key of a destroy counts as an input, and so does the key of an update: a command with the key and nothing else answers a bare one", () => {
    const result = buildModel(bare(
      `import { VoidInvoice } from "./void-invoice.mesh.mx"\nimport { Touch } from "./touch.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  actions\n    destroy on=VoidInvoice\n    update on=Touch\n`,
      { "billing/void-invoice.mesh.mx": "command :VoidInvoice\n  uuid :id\n", "billing/touch.mesh.mx": "command :Touch\n  uuid :id\n" },
    ));
    expect(result.diagnostics.filter((d) => d.code !== "MESH_COMMAND_UNANSWERED")).toEqual([]);
    const without = buildModel(bare(
      `import { VoidInvoice } from "./void-invoice.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  actions\n    destroy on=VoidInvoice\n`,
      { "billing/void-invoice.mesh.mx": "command :VoidInvoice\n  string :why nullable\n" },
    ));
    expect(inputs(without).map((d) => d[2])).toEqual([
      "Command billing.VoidInvoice has the field `why`, which is no input of billing.Invoice#voidInvoice: every field of the command is an input of the action it answers",
      "billing.Invoice#voidInvoice requires the input `id`, the key that selects the row of a destroy, which is no field of billing.VoidInvoice: every required input of the action is a field of the command it answers",
    ]);
  });

  test("a create's required inputs: a member of a required attribute, an argument, and a belongs-to; the optional ones may be left out", () => {
    const entity = `import { OpenInvoice } from "./open-invoice.mesh.mx"
import { Customer } from "./customer.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    string :title
    string :note nullable
    integer :copies default=1
  relationships
    belongs-to :customer entity=Customer
  actions
    create on=OpenInvoice
      input
        &title
        &note
        &copies
        &customer
        string :reason
        string :aside nullable
`;
    const customer = { "billing/customer.mesh.mx": "entity :Customer\n  attributes\n    uuid :id primary-key\n" };
    const complete = buildModel(bare(entity, { ...customer, "billing/open-invoice.mesh.mx": "command :OpenInvoice\n  string :title\n  uuid :customer\n  string :reason\n" }));
    expect(complete.diagnostics).toEqual([]);
    const missing = buildModel(bare(entity, { ...customer, "billing/open-invoice.mesh.mx": "command :OpenInvoice\n  string :title\n" }));
    expect(inputs(missing).map((d) => d[2])).toEqual([
      "billing.Invoice#openInvoice requires the input `customer`, which is no field of billing.OpenInvoice: every required input of the action is a field of the command it answers",
      "billing.Invoice#openInvoice requires the input `reason`, which is no field of billing.OpenInvoice: every required input of the action is a field of the command it answers",
    ]);
    const optional = buildModel(bare(entity, { ...customer, "billing/open-invoice.mesh.mx": "command :OpenInvoice\n  string :title\n  uuid :customer\n  string :reason\n  string :note nullable\n  integer :copies\n  string :aside nullable\n" }));
    expect(optional.diagnostics).toEqual([]);
  });

  test("the member inputs of an update are all optional: the command carries only the ones it changes, and each must still be an input", () => {
    const entity = `import { Rename } from "./rename.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n    string :title\n    string :note\n  actions\n    update on=Rename\n      input\n        &title\n        &note\n`;
    expect(buildModel(bare(entity, { "billing/rename.mesh.mx": "command :Rename\n  uuid :id\n  string :title\n" })).diagnostics.filter((d) => d.code !== "MESH_COMMAND_UNANSWERED")).toEqual([]);
    const extra = buildModel(bare(entity, { "billing/rename.mesh.mx": "command :Rename\n  uuid :id\n  string :title\n  string :colour\n" }));
    expect(inputs(extra).map((d) => d[2])).toEqual(["Command billing.Rename has the field `colour`, which is no input of billing.Invoice#rename: every field of the command is an input of the action it answers"]);
  });
});

describe("the generated #mesh", () => {
  const golden = async (name: string, actual: string) => {
    const path = resolve(import.meta.dir, "fixtures/commands-golden", name);
    if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
    expect(actual).toBe(await readFile(path, "utf8"));
  };
  const index = (extra: Record<string, string>) => {
    const result = build(PAY_ACTION, IMPORT, extra);
    expect(result.diagnostics).toEqual([]);
    return generateFiles({ document: result.document!, config: configOf("/project", ".mesh") })
      .then((files) => files.find((file) => file.path === ".mesh/index.ts")!.contents);
  };

  test("a project with a command an action answers exports dispatch, DomainCommand and DispatchResult, and no event table: golden", async () => {
    const contents = await index({});
    await golden("commands.index.ts.golden", contents);
    expect(contents.replace(/\s+/g, " ")).toContain("export function dispatch<C extends DomainCommand>( command: C, context: $ActionContext, ): $Promise<DispatchResult<C>> {");
    expect(contents).not.toContain("eventClasses");
  });

  test("with events too, one globals import serves both and the file keeps the event table: golden", async () => {
    const contents = await index({ "billing/invoice-paid.mesh.mx": PAID });
    await golden("events-and-commands.index.ts.golden", contents);
    expect(contents.match(/from "\.\/\$globals"/g)).toHaveLength(1);
  });

  test("a command no action answers is not in DomainCommand, and a project with none has no dispatch", async () => {
    const result = build("    update :rename\n", "");
    const files = await generateFiles({ document: result.document!, config: configOf("/project", ".mesh") });
    const contents = files.find((file) => file.path === ".mesh/index.ts")!.contents;
    expect(contents).not.toContain("dispatch");
    expect(contents).not.toContain("DomainCommand");
  });

  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  /** Builds the project, writes the generated tree under the package (so `@meshfw/runtime` resolves) and type-checks it under the strictest flags. */
  async function typeCheck(command: string) {
    const result = build(PAY_ACTION, IMPORT, {}, command);
    expect(result.diagnostics).toEqual([]);
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-commands-"));
    roots.push(root);
    const config = configOf(root);
    const generated = await generateFiles({ document: result.document!, config });
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    return await checkTypes(root, [...generated.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts")]);
  }

  test("a command field of the action's input type type-checks: dispatch builds the input from the fields, with no cast", async () => {
    expect(await typeCheck(PAY)).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("a command field of another type than the action's input fails the project's type check, at the generated index.ts", async () => {
    // `paidAt` is a datetime in the command's and the action's declarations alike; here the command declares a string
    const checked = await typeCheck(PAY.replace("datetime :paidAt", "string :paidAt"));
    expect(checked.code).toBe(1);
    expect(checked.output).toContain("generated/index.ts");
    expect(checked.output).toContain("Type 'string' is not assignable to type 'Date");
  }, 30_000);

  test("the generated dispatch builds each input from the command's fields and imports the classes as types", async () => {
    const contents = await index({});
    expect(contents.replace(/\s+/g, " ")).toContain("run: (command: $billing$PayInvoice$class, context) => $billing$Invoice$value.payInvoice({ id: command.id, paidAt: command.paidAt }, context)");
    expect(contents).toContain('import type { PayInvoice as $billing$PayInvoice$class } from "./domain/billing/payInvoice.command";');
    expect(contents).not.toContain("as never");
  });
});
