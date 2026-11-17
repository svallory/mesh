// The `handlers` section of an entity or an aggregate file: `notes/architecture/handlers-design.md`, PR 1 (rules H1 to
// H15, ruling D44). A line declares a handler of core's two kinds, `process` or `listen`, keyed `<owner FQN>.<name>`, with
// the events its `on=` names and a body that is plain code of `{ event, context }`. Nothing is generated from it yet: the
// project shell reports each line `MESH_NOT_IMPLEMENTED` until the handlers are generated and registered.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Diagnostic, Entity } from "@meshfw/model";
import type { EventBus } from "@meshfw/runtime";
import { eventsDiagnostics } from "../src/capabilities.ts";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { loadConfig, loadProject } from "../src/index.ts";
import { handlersNotGenerated } from "../src/model/handlers.ts";
import { explainAction, explainHandler } from "../src/typescript/explain.ts";

/** The fixture project, on disk so that the helper import (`./mailer`) resolves: `billing/` holds every file. */
const ROOT = new URL("./fixtures/handlers/", import.meta.url).pathname;
const FIXTURES: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(`${ROOT}billing`).filter((name) => name.endsWith(".mesh.mx")).map((name) => [`billing/${name}`, readFileSync(`${ROOT}billing/${name}`, "utf8")]),
);
const INVOICE = FIXTURES["billing/invoice.mesh.mx"]!;
/** The fixture project with some files replaced (`null` leaves one out). */
const build = (replace: Record<string, string | null> = {}) =>
  buildModel({
    root: ROOT,
    files: Object.entries({ ...FIXTURES, ...replace }).flatMap(([file, source]) => (source === null ? [] : [{ file, source }])),
  });
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
const errors = (result: ReturnType<typeof buildModel>) => brief(result.diagnostics.filter((d) => d.severity === "error"));
const entityOf = (result: ReturnType<typeof buildModel>, name: string): Entity => result.document!.entities.find((e) => e.name === name)!;
/** The invoice with its `handlers` section replaced by `lines` (each indented four spaces, as a section's lines are). */
const withHandlers = (lines: string, source = INVOICE) => source.slice(0, source.indexOf("  handlers\n")) + `  handlers\n${lines}`;
/** One handler of the invoice: `listen :h [on=InvoicePaid] <body>`, an arrow written after `=`, as the default option is. */
const body = (written: string, head = "listen :h [on=InvoicePaid]") =>
  withHandlers(`    ${head} ${/^(async\s*)?\([^)]*\)\s*=>/.test(written) ? "=" : ""}${written}\n`);

describe("the contract", () => {
  const parse = (lines: string) =>
    parseEntitySource(withHandlers(lines), `${ROOT}billing/invoice.mesh.mx`).diagnostics.map((d) => [d.line, d.column, d.code, d.message]);
  test("the written forms lower with no diagnostic: method form, `value=` arrow, options over several lines, a namespace member, comments and a trailing comma in a list", () => {
    expect(parse([
      "    process :a [on=InvoicePaid] ({ event, context }) {\n      return 1\n    }",
      "    listen :b [on=[InvoicePaid, pay.PaymentRecorded] renamed-from=:old] async ({ event }) {\n      await 1\n    }",
      "    listen :c on=InvoicePaid value=async ({ event }) => { await 1 }",
      "    listen :d [\n      on=[InvoicePaid, /* paid, recorded */ pay.PaymentRecorded, // last\n      ]\n    ] async ({ event }) {\n      await 1\n    }",
      "    listen :e [on=pay.PaymentRecorded] ({ event }) {}",
    ].join("\n") + "\n")).toEqual([]);
  });
  test("an empty section, and one beside every other section in any order, lower", () => {
    expect(parse("")).toEqual([]);
    const first = INVOICE.replace("  attributes\n", "  handlers\n    listen :x [on=InvoicePaid] ({ event }) {}\n  attributes\n").replace(/  handlers\n    listen :receipt[\s\S]*$/, "");
    expect(parseEntitySource(first, `${ROOT}billing/invoice.mesh.mx`).diagnostics).toEqual([]);
  });
  test("the section once, its two kinds only, and its lines nowhere else", () => {
    expect(parse("    listen :a [on=InvoicePaid] ({ event }) {}\n  handlers\n")).toEqual([[26, 2, "MESH_REPEATED_CHILD", "`entity`: `handlers` may not be repeated"]]);
    expect(parse("    check :a\n")).toEqual([[25, 4, "MESH_TAG_NOT_ALLOWED", "`handlers`: `check` is not allowed here; allowed children: `process`, `listen`"]]);
    // `project` is the event-sourcing extension's kind, not core's.
    expect(parse("    project :a [on=InvoicePaid] ({ event }) {}\n")).toEqual([[25, 4, "MESH_UNKNOWN_TAG", "`project` is not a known tag in the `mesh` dialect"]]);
    const misplaced = INVOICE.replace("  policies\n", "    listen :a [on=InvoicePaid] ({ event }) {}\n  policies\n");
    expect(parseEntitySource(misplaced, `${ROOT}billing/invoice.mesh.mx`).diagnostics.map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });
  test("the name, `on=` and the body are required, each MX's message", () => {
    expect(parse("    listen [on=InvoicePaid] ({ event }) {}\n")).toEqual([[25, 4, "MESH_MISSING_OPTION", "`listen`: missing required option `name`"]]);
    expect(parse("    process :a ({ event }) {}\n")).toEqual([[25, 4, "MESH_MISSING_OPTION", "`process`: missing required option `on`"]]);
    expect(parse("    listen :a [on=InvoicePaid]\n")).toEqual([[25, 4, "MESH_MISSING_OPTION", "`listen`: missing required option `value`"]]);
  });
  test("a name that is no atom, a tag parameter, a body that is no function, a string `on=` or `renamed-from=`, options after the parameters", () => {
    expect(parse('    listen name="x" [on=InvoicePaid] ({ event }) {}\n')).toEqual([[25, 11, "MESH_NAME", "`listen`: a declaration needs one atom name"]]);
    expect(parse("    listen|x| :a [on=InvoicePaid] ({ event }) {}\n")).toEqual([[25, 4, "MESH_SYNTAX", "`listen`: tag parameters and variable bindings are not entity declarations"]]);
    expect(parse("    listen :a on=InvoicePaid value=foo\n")).toEqual([[25, 29, "MESH_EXPRESSION", "`listen`: value must be a function as written"]]);
    expect(parse('    listen :a [on="InvoicePaid"] ({ event }) {}\n')).toEqual([[25, 15, "MESH_OPTION_VALUE", "`listen`: option `on` must be an expression"]]);
    expect(parse('    listen :a [on=InvoicePaid renamed-from="x"] ({ event }) {}\n')).toEqual([[25, 43, "MESH_OPTION_VALUE", "`listen`: option `renamed-from` must be atom, got string"]]);
    expect(parse("    listen :a on=InvoicePaid ({ event }) {}\n").map((d) => d[2])).toEqual(["MESH_EXPECTED_SINGLE_EXPRESSION"]);
  });
  const SHAPE = "`listen`: on must be an event in scope (`on=InvoicePaid`), a member of a namespace import (`on=billing.InvoicePaid`), or a list of them (`on=[InvoicePaid, billing.PaymentRecorded]`)";
  const WRAPPED = "`listen`: on must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`on=InvoicePaid`, `on=billing.InvoicePaid`)";
  test("`on=` is one reference or a non-empty list of them, at the item that is not", () => {
    const on = (value: string) => parse(`    listen :a [on=${value}] ({ event }) {}\n`);
    expect(on("[]")).toEqual([[25, 15, "MESH_UNKNOWN_EVENT", "`listen`: on must list at least one event: `on=[InvoicePaid]`"]]);
    expect(on("[&id]")).toEqual([[25, 19, "MESH_UNKNOWN_EVENT", SHAPE]]);
    expect(on("[InvoicePaid, :paid]")).toEqual([[25, 32, "MESH_UNKNOWN_EVENT", SHAPE]]);
    expect(on("getEvent()")).toEqual([[25, 15, "MESH_UNKNOWN_EVENT", SHAPE]]);
    expect(on("[pay?.PaymentRecorded]")).toEqual([[25, 19, "MESH_UNKNOWN_EVENT", SHAPE]]);
    // One diagnostic per line: MX's `ctx.fail` ends the pass, so the first bad item is reported (`mesh-contract-fail-stops-pass`).
    expect(on("[1, 2]")).toEqual([[25, 19, "MESH_UNKNOWN_EVENT", SHAPE]]);
  });
  test("a reference written inside a wrapper is refused at the item, as a whole value and inside a list", () => {
    const on = (value: string) => parse(`    listen :a [on=${value}] ({ event }) {}\n`);
    expect(on("(InvoicePaid)")).toEqual([[25, 18, "MESH_UNKNOWN_EVENT", WRAPPED]]);
    expect(on("[InvoicePaid!]")).toEqual([[25, 19, "MESH_UNKNOWN_EVENT", WRAPPED]]);
    expect(on("[(InvoicePaid)]")).toEqual([[25, 20, "MESH_UNKNOWN_EVENT", WRAPPED]]);
    expect(on("[pay.PaymentRecorded, (InvoicePaid)]")).toEqual([[25, 41, "MESH_UNKNOWN_EVENT", WRAPPED]]);
    expect(on("[InvoicePaid as any, pay.PaymentRecorded]")).toEqual([[25, 19, "MESH_UNKNOWN_EVENT", WRAPPED]]);
    expect(on("[InvoicePaid satisfies unknown]")).toEqual([[25, 19, "MESH_UNKNOWN_EVENT", WRAPPED]]);
    // Whitespace and comments around an item, and inside a namespace member, are no wrapper.
    expect(on("[ InvoicePaid ,pay. PaymentRecorded /* x */ ]")).toEqual([]);
  });
});

describe("the model", () => {
  test("each line is a handler keyed by its owner's FQN, with the events `on=` names resolved to FQNs, in written order", () => {
    const result = build();
    expect(errors(result)).toEqual([]);
    const invoice = entityOf(result, "Invoice");
    expect(invoice.handlers!.map(({ kind, name, key, renamedFrom }) => ({ kind, name, key, renamedFrom }))).toEqual([
      { kind: "listen", name: "receipt", key: "billing.Invoice.receipt", renamedFrom: "billing.Invoice.mailReceipt" },
      { kind: "process", name: "voided", key: "billing.Invoice.voided", renamedFrom: undefined },
    ]);
    // A named import's event and one the file declares inline in its `events` section, named without an import (R7).
    expect(invoice.handlers![1]!.events.map(({ identifier, from, fqn, position }) => [identifier, from, fqn, position.line, position.column])).toEqual([
      ["InvoiceVoided", "./invoice.mesh.mx", "billing.InvoiceVoided", 29, 25],
      ["InvoicePaid", "./invoice-paid.mesh.mx", "billing.InvoicePaid", 29, 40],
    ]);
    expect(Object.hasOwn(invoice.handlers![1]!, "renamedFrom")).toBe(false);
    expect(invoice.handlers![0]!.position).toMatchObject({ line: 25, column: 4 });
  });
  test("a namespace member names an event; an entity with no `actions` section takes a section; one name in two entities is two keys", () => {
    const ledger = entityOf(build(), "Ledger");
    expect(ledger.handlers!.map((handler) => [handler.key, handler.events.map((event) => [event.identifier, event.fqn])])).toEqual([
      ["billing.Ledger.receipt", [["paid.InvoicePaid", "billing.InvoicePaid"], ["recorded.PaymentRecorded", "billing.PaymentRecorded"]]],
    ]);
  });
  test("an aggregate's handlers are keyed by the aggregate's FQN, and name its inline events", () => {
    const [billing] = build().document!.aggregates!;
    expect(billing!.handlers!.map((handler) => [handler.key, handler.events.map((event) => event.fqn)])).toEqual([
      ["billing.Billing.close", ["billing.InvoicePaid", "billing.BillingClosed"]],
    ]);
  });
  test("the body is plain code with the reason `handler`, and no `MESH_EXPR_PLAIN` warning", () => {
    const result = build();
    expect(result.diagnostics).toEqual([]);
    const [receipt, voided] = entityOf(result, "Invoice").handlers!;
    expect(receipt!.run.source).toStartWith("async ({ event, context }) {");
    expect(receipt!.run.plain).toMatchObject({ why: "handler", helpers: ["sendReceipt"], entities: ["Invoice"], acts: true });
    expect(voided!.run.plain?.why).toBe("handler");
    // Even a body Mesh could translate as an expression stays plain.
    const simple = build({ "billing/invoice.mesh.mx": body("({ event }) => event.payload.invoiceId !== null") });
    expect(simple.diagnostics).toEqual([]);
    expect(entityOf(simple, "Invoice").handlers![0]!.run.plain?.why).toBe("handler");
  });
  test("an empty section and an entity with none leave no `handlers` key, so model.json is unchanged", () => {
    const empty = entityOf(build({ "billing/invoice.mesh.mx": withHandlers("") }), "Invoice");
    expect(Object.hasOwn(empty, "handlers")).toBe(false);
    const none = entityOf(build({ "billing/invoice.mesh.mx": INVOICE.slice(0, INVOICE.indexOf("  handlers\n")) }), "Invoice");
    expect(Object.hasOwn(none, "handlers")).toBe(false);
    const aggregate = build({ "billing/billing.mesh.mx": FIXTURES["billing/billing.mesh.mx"]!.slice(0, FIXTURES["billing/billing.mesh.mx"]!.indexOf("  handlers\n")) });
    expect(Object.hasOwn(aggregate.document!.aggregates![0]!, "handlers")).toBe(false);
  });
});

describe("names", () => {
  test("two lines of one name are a duplicate, whatever their kinds, at the second", () => {
    expect(errors(build({ "billing/invoice.mesh.mx": withHandlers("    listen :a [on=InvoicePaid] ({ event }) {}\n    process :a [on=InvoicePaid] ({ event }) {}\n") }))).toEqual([
      ["billing/invoice.mesh.mx", 26, 4, "error", "MESH_DUPLICATE_MEMBER", "Duplicate handler :a in the handlers section of billing.Invoice: a handler's name is unique across process and listen", "rename one"],
    ]);
  });
  test("a handler may share a name with an attribute, an action, a policy or an inline event's entity member: a separate scope (Q10)", () => {
    const lines = ["id", "receiptSent", "markReceiptSent", "payInvoice", "read", "system"].map((name) => `    listen :${name} [on=InvoicePaid] ({ event }) {}\n`).join("");
    expect(build({ "billing/invoice.mesh.mx": withHandlers(lines) }).diagnostics).toEqual([]);
  });
  test("`renamed-from` never names a handler the section still declares, and two lines never name one former name", () => {
    expect(errors(build({ "billing/invoice.mesh.mx": withHandlers("    listen :a [on=InvoicePaid] ({ event }) {}\n    listen :b [on=InvoicePaid renamed-from=:a] ({ event }) {}\n") }))).toEqual([
      ["billing/invoice.mesh.mx", 26, 43, "error", "MESH_OPTION_VALUE", "renamed-from=:a names a handler this section still declares: a running handler's progress is never taken over", "remove renamed-from, or rename :a"],
    ]);
    expect(errors(build({ "billing/invoice.mesh.mx": withHandlers("    listen :a [on=InvoicePaid renamed-from=:old] ({ event }) {}\n    listen :b [on=InvoicePaid renamed-from=:old] ({ event }) {}\n") }))).toEqual([
      ["billing/invoice.mesh.mx", 26, 43, "error", "MESH_OPTION_VALUE", ":a and :b both have renamed-from=:old: one progress row cannot move to two names", "keep renamed-from on one of them"],
    ]);
    // A former name nothing declares, and a handler renamed from its own entity's other kind of member, are legal.
    expect(build({ "billing/invoice.mesh.mx": withHandlers("    listen :a [on=InvoicePaid renamed-from=:gone] ({ event }) {}\n    process :b [on=InvoicePaid renamed-from=:markReceiptSent] ({ event }) {}\n") }).diagnostics).toEqual([]);
  });
});

describe("the events `on=` names", () => {
  const on = (value: string, imports = "") =>
    errors(build({ "billing/invoice.mesh.mx": imports + withHandlers(`    listen :a [on=${value}] ({ event }) {}\n`) }));
  test("a name that is no event in scope, with the nearest event; an entity; a command", () => {
    expect(on("InvoicePayd")).toEqual([
      ["billing/invoice.mesh.mx", 25, 18, "error", "MESH_UNKNOWN_EVENT", "InvoicePayd is not an imported event. Did you mean InvoicePaid?", null],
    ]);
    expect(on("Invoice")).toEqual([
      ["billing/invoice.mesh.mx", 25, 18, "error", "MESH_UNKNOWN_EVENT", "Invoice is not an imported event: the file declares Invoice as an entity.", null],
    ]);
    expect(on("PayInvoice")).toEqual([
      ["billing/invoice.mesh.mx", 25, 18, "error", "MESH_UNKNOWN_EVENT", "PayInvoice is not an imported event.", null],
    ]);
  });
  test("a namespace member the file does not declare, and an item of a list, at the item", () => {
    expect(on("[InvoicePaid, recorded.PaymentRecordd]", 'import * as recorded from "./payment-recorded.mesh.mx"\n')).toEqual([
      ["billing/invoice.mesh.mx", 26, 41, "error", "MESH_UNKNOWN_EVENT", "recorded.PaymentRecordd is not an imported event: ./payment-recorded.mesh.mx declares `PaymentRecorded`. Did you mean recorded.PaymentRecorded?", "write `recorded.PaymentRecorded`"],
    ]);
  });
  test("one event listed twice, under one name or through an alias, at the second; the same event in two handlers is legal", () => {
    expect(on("[InvoicePaid, InvoiceVoided, InvoicePaid]")).toEqual([
      ["billing/invoice.mesh.mx", 25, 47, "error", "MESH_OPTION_VALUE", "on lists InvoicePaid twice; remove one", null],
    ]);
    expect(on("[InvoicePaid, paid.InvoicePaid]", 'import * as paid from "./invoice-paid.mesh.mx"\n')).toEqual([
      ["billing/invoice.mesh.mx", 26, 32, "error", "MESH_OPTION_VALUE", "on lists paid.InvoicePaid twice; remove one", null],
    ]);
    expect(build({ "billing/invoice.mesh.mx": withHandlers("    listen :a [on=InvoicePaid] ({ event }) {}\n    listen :b [on=[InvoicePaid]] ({ event }) {}\n") }).diagnostics).toEqual([]);
  });
});

describe("the body's scope", () => {
  const scope = (written: string) => brief(build({ "billing/invoice.mesh.mx": body(written) }).diagnostics);
  const out = (name: string, column: number, fix = "read the event's payload (`event.payload`), or call an action of the entity") =>
    ["billing/invoice.mesh.mx", 25, column, "error", "MESH_HANDLER_SCOPE", `a handler runs for an event, with no record, no input and no transaction value: \`${name}\` is not in its scope; it reads \`event\` and \`context\``, fix];
  test("`self`, `input`, `actor` and `before`, read free or destructured, are out of its scope, at the name", () => {
    expect(scope("({ event }) => self")).toEqual([out("self", 47)]);
    expect(scope("({ event }) => input")).toEqual([out("input", 47)]);
    expect(scope("({ event }) => actor")).toEqual([out("actor", 47, "read `context.actor`")]);
    expect(scope("({ event }) => before")).toEqual([out("before", 47)]);
    expect(scope("({ event, self, before }) => event")).toEqual([out("self", 42), out("before", 48)]);
    expect(scope("({ actor }) => 1")).toEqual([out("actor", 35, "read `context.actor`")]);
  });
  test("a member and the transaction's values are out of its scope, read or written", () => {
    expect(scope("({ event }) => &receiptSent")).toEqual([
      ["billing/invoice.mesh.mx", 25, 47, "error", "MESH_HANDLER_SCOPE", "`&receiptSent` reads a record, and a handler has none: it reads `event` and `context`", "read the event's payload (`event.payload`), or call an action of the entity"],
    ]);
    expect(scope("({ event }) => { &receiptSent = true }").map((d) => [d[2], d[4]])).toEqual([[49, "MESH_HANDLER_SCOPE"]]);
    expect(scope("({ event }) => [%.now, %.today]")).toEqual([
      out("%.now", 48, "read when the event happened as `event.occurredAt`"),
      out("%.today", 55, "read when the event happened as `event.occurredAt`"),
    ]);
    // An unknown member of `%` keeps its own error.
    expect(scope("({ event }) => %.later").map((d) => d[4])).toEqual(["MESH_UNKNOWN_TRANSACTION_MEMBER"]);
  });
  test("`event` and `context` are its roots, free or destructured; helpers, entities, `Mesh` and its own locals are in scope", () => {
    expect(scope("({ event, context }) => [event.id, context]")).toEqual([]);
    const free = build({ "billing/invoice.mesh.mx": body("() => [event.payload.invoiceId, context]") });
    expect(free.diagnostics).toEqual([]);
    expect(entityOf(free, "Invoice").handlers![0]!.run.plain?.roots).toEqual(["event", "context"]);
    expect(scope("async ({ event, context }) { const self = 1; await sendReceipt({ idempotencyKey: event.id, invoiceId: String(self) }); return Mesh.privileged(Invoice).read({}, context) }")).toEqual([]);
    expect(scope("({ context }) => Mesh.isSystem(context) && Invoice.markReceiptSent({ id: \"x\" }, context)")).toEqual([]);
    // A nested function's own `input` is its parameter, not the root.
    expect(scope("({ event }) => [1].map((input) => input + 1)")).toEqual([]);
  });
  test("a root shadows an import of the same name inside the body, which stays the import outside it", () => {
    const source = body("() => event.id").replace('import { sendReceipt } from "./mailer"', 'import { sendReceipt as event } from "./mailer"')
      .replace("authorize-if=({ context }) => Mesh.isSystem(context)", "authorize-if=async ({ context }) => { await event({ idempotencyKey: \"k\", invoiceId: \"i\" }); return Mesh.isSystem(context) }");
    const result = build({ "billing/invoice.mesh.mx": source });
    expect(result.diagnostics).toEqual([]);
    const invoice = entityOf(result, "Invoice");
    expect(invoice.handlers![0]!.run.plain).toMatchObject({ why: "handler", roots: ["event"] });
    expect(invoice.handlers![0]!.run.plain).not.toHaveProperty("helpers");
    expect(invoice.policies[0]!.authorizeIf[0]!.plain?.helpers).toEqual(["event"]);
  });
  test("every other name rule of a function applies: a free variable, `tx`, `Mesh.privileged` of no entity, an event constructed", () => {
    expect(scope("({ event }) => nope").map((d) => d[4])).toEqual(["MESH_EXPR_FREE_VARIABLE"]);
    expect(scope("({ event, tx }) => event").map((d) => d[4])).toEqual(["MESH_REMOVED_SCOPE_NAME"]);
    expect(scope("({ event }) => Mesh.privileged(event)").map((d) => d[4])).toEqual(["MESH_PRIVILEGED_ENTITY"]);
    expect(scope("({ event }) => new InvoicePaid({ invoiceId: event.payload.invoiceId })").map((d) => [d[3], d[4]])).toEqual([["warning", "MESH_EVENT_NOT_PUBLISHED"]]);
  });
  test("an aggregate's body has the same scope", () => {
    const aggregate = FIXTURES["billing/billing.mesh.mx"]!.replace("return Invoice.markReceiptSent", "return &id && self && Invoice.markReceiptSent");
    expect(build({ "billing/billing.mesh.mx": aggregate }).diagnostics.map((d) => [d.position.line, d.code])).toEqual([[11, "MESH_HANDLER_SCOPE"], [11, "MESH_HANDLER_SCOPE"]]);
  });
});

describe("the configuration", () => {
  const at = { file: "mesh.config.ts", line: 1, column: 0, offset: 0 };
  const data = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: {} } as const;
  const bus = (capabilities: string[]) => ({ manifest: { adapter: "probe", capabilities }, create: () => ({}) }) as unknown as EventBus;
  test("a bus that does not declare ordered-delivery is `MESH_CAPABILITY` at each handler line, an aggregate's included", () => {
    const document = build().document!;
    expect(brief(eventsDiagnostics(document, { data: data as never, events: { bus: bus(["replay"]) } }, at))).toEqual([
      ["billing/ledger.mesh.mx", 8, 4, "error", "MESH_CAPABILITY", "Handler billing.Ledger.receipt needs the bus's ordered-delivery, since a handler's progress is kept by position only, and the event bus \"probe\" does not declare it", "Use a bus that declares ordered-delivery, such as localBus()"],
      ["billing/invoice.mesh.mx", 25, 4, "error", "MESH_CAPABILITY", "Handler billing.Invoice.receipt needs the bus's ordered-delivery, since a handler's progress is kept by position only, and the event bus \"probe\" does not declare it", "Use a bus that declares ordered-delivery, such as localBus()"],
      ["billing/invoice.mesh.mx", 29, 4, "error", "MESH_CAPABILITY", "Handler billing.Invoice.voided needs the bus's ordered-delivery, since a handler's progress is kept by position only, and the event bus \"probe\" does not declare it", "Use a bus that declares ordered-delivery, such as localBus()"],
      ["billing/billing.mesh.mx", 10, 4, "error", "MESH_CAPABILITY", "Handler billing.Billing.close needs the bus's ordered-delivery, since a handler's progress is kept by position only, and the event bus \"probe\" does not declare it", "Use a bus that declares ordered-delivery, such as localBus()"],
    ]);
    expect(eventsDiagnostics(document, { data: data as never, events: { bus: bus(["ordered-delivery", "replay"]) } }, at)).toEqual([]);
    // No handler, no requirement on the bus.
    const none = build({ "billing/invoice.mesh.mx": withHandlers(""), "billing/ledger.mesh.mx": null, "billing/billing.mesh.mx": null }).document!;
    expect(eventsDiagnostics(none, { data: data as never, events: { bus: bus([]) } }, at)).toEqual([]);
  });
  test("until handlers are generated, each line is `MESH_NOT_IMPLEMENTED`, so the build fails instead of building handlers that never run", () => {
    expect(brief(handlersNotGenerated(build({ "billing/billing.mesh.mx": null, "billing/ledger.mesh.mx": null }).document!))).toEqual([
      ["billing/invoice.mesh.mx", 25, 4, "error", "MESH_NOT_IMPLEMENTED", "handlers are not generated yet: listen :receipt would build and never run; they arrive with the next release", "register the handler in the events module (`src/events.ts`) for now"],
      ["billing/invoice.mesh.mx", 29, 4, "error", "MESH_NOT_IMPLEMENTED", "handlers are not generated yet: process :voided would build and never run; they arrive with the next release", "register the handler in the events module (`src/events.ts`) for now"],
    ]);
    expect(handlersNotGenerated(build({ "billing/invoice.mesh.mx": withHandlers(""), "billing/ledger.mesh.mx": null, "billing/billing.mesh.mx": null }).document!)).toEqual([]);
  });

  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  test("the project shell reports both, and gives no document", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mesh-handlers-"));
    roots.push(root);
    await mkdir(resolve(root, "src/domain/billing"), { recursive: true });
    for (const name of ["invoice-paid.mesh.mx", "ledger.mesh.mx", "payment-recorded.mesh.mx"])
      await writeFile(resolve(root, "src/domain/billing", name), FIXTURES[`billing/${name}`]!);
    const config = { domain: "src/domain", output: ".mesh", data, events: { bus: { manifest: { adapter: "probe", capabilities: [] }, create: "() => ({})" } } };
    await writeFile(resolve(root, "mesh.config.ts"), `export default ${JSON.stringify(config).replace('"() => ({})"', "() => ({})")}`);
    const loaded = await loadConfig(root);
    expect(loaded.diagnostics).toEqual([]);
    const built = await loadProject(loaded.config!);
    expect(built.document).toBeNull();
    expect(built.diagnostics.map((d) => [d.position.file, d.position.line, d.code])).toEqual([
      ["src/domain/billing/ledger.mesh.mx", 8, "MESH_CAPABILITY"],
      ["src/domain/billing/ledger.mesh.mx", 8, "MESH_NOT_IMPLEMENTED"],
    ]);
  });
});

describe("mesh explain", () => {
  test("a handler is explained by its name: its events, its key, where it runs and its body, plain for the reason handler", () => {
    const document = build().document!;
    const invoice = document.entities.find((entity) => entity.name === "Invoice")!;
    expect(explainAction(invoice, "receipt", document)).toEqual([
      "billing.Invoice.receipt (listen handler)",
      "  on           billing.InvoicePaid (InvoicePaid)",
      "  progress     stored under billing.Invoice.receipt in mesh_handler_progress; a new handler starts at the highest position, so it handles the events published from then on",
      "               renamed from billing.Invoice.mailReceipt: that handler's progress row moves to this one",
      "  runs         outside any transaction, then its progress moves past the event: at least once, so a failure between the two runs it again",
      "  body         async ({ event, context }) { await sendReceipt({ idempotencyKey: event.id, invoiceId: event.payload.invoiceId }) await Invoice.markReceiptSent({ id: event.payload.invoiceId }, context) } (plain, handler: it gets { event, context })",
    ]);
    expect(explainHandler(invoice, "voided")!.find((line) => line.startsWith("  runs"))).toBe("  runs         inside the handler transaction, with its progress row: what it writes and its move past the event commit together, once per event");
    // An action of the same name is the one explained; a name that is neither is unknown.
    expect(explainAction(invoice, "markReceiptSent", document)![0]).toBe("billing.Invoice#markReceiptSent (update)");
    expect(explainAction(invoice, "nothing", document)).toBeUndefined();
  });
});
