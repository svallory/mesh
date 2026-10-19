// End to end for M6 PR 1 and PR 2: an event and a command in files of their own, `publish` under `do` and under `when`,
// built by the real `mesh` command on the SQLite adapter, and the outbox that a publish writes. The fixture
// (`fixtures/events/domain`) holds `billing/invoice-paid.mesh.mx` (an event with every field option),
// `billing/pay-invoice.mesh.mx` (a command), `sales/refunds/refund-issued.mesh.mx` (an event declared as `:refundIssued`,
// imported through a namespace), `billing/probe.ts` (helpers that call back into the test) and `billing/invoice.mesh.mx`,
// whose `pay` publishes `InvoicePaid`, whose `refund` publishes `refunds.RefundIssued` inside a `when`, whose
// `publishMade` publishes whatever the test hands it and whose `chain` publishes, calls back into the test, and publishes
// again. Everything is checked through the specifiers an application uses: the classes of each module's barrel,
// `DomainEvent`, `eventClasses`, `published` and `readEvents` of `#mesh`, and `Mesh.fqnOf`; the outbox rows through the
// data layer's own `readOutbox` too.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CursorAheadError, dispatchCommand, EventsDeletedError, FrameworkError, HandlerStoppedError, InvalidInputError, Mesh, NotFoundError } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { runCli } from "../src/cli.ts";
import { freeGlobals } from "../../compiler/test/free-globals.ts";
import { closeTypeServer } from "../../compiler/test/type-server.ts";

afterAll(closeTypeServer);

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/events/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
const testing: string = "@meshfw/runtime/testing";
const { testBus } = (await import(testing)) as { testBus(): import("@meshfw/runtime").EventBus };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }), events: { bus: testBus() } };
`;
const PACKAGE = {
  name: "events", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};
const TSCONFIG = {
  compilerOptions: { noEmit: true, strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true, allowImportingTsExtensions: true, types: ["bun"] },
  include: [".mesh/**/*.ts", "mesh.config.ts"],
};
/** Type-level checks through the specifiers: a class is its instance type, nominal, and `DomainEvent` holds the events and no command. */
const CHECK = `import { InvoicePaid, PayInvoice } from "#mesh/domain/billing";
import { RefundIssued } from "#mesh/domain/sales/refunds";
import * as domain from "#mesh/domain";
import { dispatch, eventClasses, published, readEvents, type DispatchResult, type DomainCommand, type DomainEvent, type EventRecord, type MetadataFunction } from "#mesh";
import { Mesh } from "meshfw";

const paid = new InvoicePaid({ invoiceId: "0190a000-0000-7000-8000-000000000000", amount: 1, method: "card", paidAt: new Date(), extra: null });
export const event: DomainEvent = paid;
export const refund: DomainEvent = new RefundIssued({ invoiceId: "0190a000-0000-7000-8000-000000000000", cents: 1 });
// @ts-expect-error a command is not a domain event
export const notAnEvent: DomainEvent = new PayInvoice({ id: "0190a000-0000-7000-8000-000000000000", paidAt: new Date() });
// @ts-expect-error an object literal shaped like an event is not one: the class has a private field
export const literal: InvoicePaid = { invoiceId: "x", amount: 1, reference: null, method: "card", paidAt: new Date(), extra: null };
// @ts-expect-error a required field is required
export const missing = new InvoicePaid({ invoiceId: "x", amount: 1, method: "card" });
// @ts-expect-error an enum field takes its values
export const wrong = new InvoicePaid({ invoiceId: "x", amount: 1, method: "cash", paidAt: new Date(), extra: null });
// @ts-expect-error a field the declaration does not have
export const extra = new InvoicePaid({ invoiceId: "x", amount: 1, method: "card", paidAt: new Date(), extra: null, more: 1 });
// @ts-expect-error a field is read-only
paid.amount = 2;
export const reference: string | null = paid.reference;
export const namespaced: typeof RefundIssued = domain.sales.refunds.RefundIssued;
export const fqn: string = Mesh.fqnOf(InvoicePaid);
export const table: typeof InvoicePaid = eventClasses["billing.InvoicePaid"];
export const tableRefund: typeof RefundIssued = eventClasses["sales.refunds.RefundIssued"];
// @ts-expect-error a command is in no event table
export const none = eventClasses["billing.PayInvoice"];
export const metadata: MetadataFunction = ({ event, context }) => ({ name: event.name, system: context.system === true });
export function own(): readonly EventRecord[] { return published(); }
export async function amounts(): Promise<number[]> {
  const page = await readEvents({ after: 0, limit: 10, names: ["billing.InvoicePaid"] });
  const next: number = page.cursor;
  void next;
  return page.events.flatMap((record) => record.payload instanceof InvoicePaid ? [record.payload.amount] : []);
}
export const paidRecord = (record: EventRecord<InvoicePaid>): Date => record.payload.paidAt;
const command = new PayInvoice({ id: "0190a000-0000-7000-8000-000000000000", paidAt: new Date() });
export const answered: DomainCommand = command;
// @ts-expect-error an event is no command
export const eventAsCommand: DomainCommand = paid;
export const dispatched: Promise<{ readonly id: string; readonly paid: boolean }> = dispatch(command, {});
export const result: DispatchResult<PayInvoice> extends { readonly paid: boolean } ? true : false = true;
// @ts-expect-error dispatch takes a command and not an event
export const dispatchedEvent = dispatch(paid, {});
// @ts-expect-error dispatch takes a context
export const noContext = dispatch(command);
// @ts-expect-error a command is no event record's payload
export const commandRecord = (record: EventRecord<PayInvoice>) => record;
`;

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh-events-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await writeFile(join(root, "check.ts"), CHECK);
  await writeFile(join(root, "tsconfig.json"), `${JSON.stringify(TSCONFIG)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite"]) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  await symlink(await realpath(join(repo, "node_modules/@types/bun")), join(root, "node_modules/@types/bun"));
  return root;
}

/** In-process: the same `mesh` entry the binary runs, with captured streams. The CLI's
 * contract is "run from the project root" and a config may hold cwd-relative paths
 * (`file: "app.db"`), so the call runs with the project as the working directory. */
async function mesh(root: string, ...args: string[]) {
  let stdout = "", stderr = "";
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const code = await runCli(args, root, {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    return { code, stdout, stderr };
  } finally { process.chdir(cwd); }
}

/** A real process running the source entry: the smoke test for the binary wrapper. */
function meshSpawn(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(await mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("events and commands in files of their own", () => {
// The binary wrapper (src/bin.ts) over runCli: one real process, so the thin wrapper stays covered.
test("the binary wrapper builds the project in a real process", async () => {
  expect(meshSpawn(root, "build", "--check")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);


  test("build writes one class file per declaration, a barrel export for each, and DomainEvent and the table in #mesh", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).sort();
    expect(files).toEqual([
      "$globals.ts", "binding.ts", "domain/billing/index.ts", "domain/billing/invoice.actions.ts", "domain/billing/invoice.expressions.ts",
      "domain/billing/invoice.types.ts", "domain/billing/invoice.validators.ts", "domain/billing/invoicePaid.event.ts",
      "domain/billing/invoice_opened.event.ts", "domain/billing/invoice_voided.event.ts", "domain/billing/openInvoice.command.ts", "domain/billing/payInvoice.command.ts", "domain/billing/promise.event.ts", "domain/billing/voidInvoice.command.ts", "domain/index.ts", "domain/sales/index.ts", "domain/sales/refunds/index.ts",
      "domain/sales/refunds/refundIssued.event.ts", "index.ts", "schema.ts",
    ]);
    const billing = await readFile(join(root, ".mesh/domain/billing/index.ts"), "utf8");
    expect(billing).toContain('export { InvoicePaid } from "./invoicePaid.event";');
    expect(billing).toContain('export { PayInvoice } from "./payInvoice.command";');
    // an event named after a global is exported under its own name; its file reaches the globals as `$Date`, `$Object` and `$RegExp`
    expect(billing).toContain('export { Promise } from "./promise.event";');
    // `event :refundIssued` makes the class `RefundIssued`, in the module `sales/refunds`; a folder holding only a declaration gets a barrel.
    expect(await readFile(join(root, ".mesh/domain/sales/refunds/index.ts"), "utf8")).toContain('export { RefundIssued } from "./refundIssued.event";');
    expect(await readFile(join(root, ".mesh/domain/sales/index.ts"), "utf8")).toContain('export * as refunds from "./refunds/index";');
    const index = await readFile(join(root, ".mesh/index.ts"), "utf8");
    expect(index.replace(/\s+/g, " ")).toContain("export type DomainEvent = | $billing$InvoicePaid$class | $billing$InvoiceOpened$class | $billing$InvoiceVoided$class | $billing$Promise$class | $sales$refunds$RefundIssued$class;");
    expect(index).toContain('"billing.InvoicePaid": $billing$InvoicePaid$class,');
    expect(index).toContain('"sales.refunds.RefundIssued": $sales$refunds$RefundIssued$class,');
    // a command is no event: `DomainEvent` and the event table hold none, and `DomainCommand` holds the command an action answers
    expect(index).not.toContain('"billing.PayInvoice": $billing$PayInvoice$class');
    expect(index.replace(/\s+/g, " ")).toContain("export type DomainCommand = | $billing$OpenInvoice$class | $billing$PayInvoice$class | $billing$VoidInvoice$class;");
  });

  test("mesh build --check finds the committed tree current, and mesh inspect shows the declarations in the model", async () => {
    expect(await mesh(root, "build", "--check")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
    const model = JSON.parse((await mesh(root, "inspect")).stdout) as { events: { fqn: string; module: string; fields: { name: string; type: string }[] }[]; commands: { fqn: string }[] };
    expect(model.events.map((event) => [event.fqn, event.module])).toEqual([["billing.InvoicePaid", "billing"], ["billing.InvoiceOpened", "billing"], ["billing.InvoiceVoided", "billing"], ["billing.Promise", "billing"], ["sales.refunds.RefundIssued", "sales/refunds"]]);
    expect(model.events[0]!.fields.map((field) => [field.name, field.type])).toEqual([
      ["invoiceId", "uuid"], ["amount", "decimal"], ["reference", "string"], ["method", "enum"], ["paidAt", "datetime"], ["extra", "json"],
    ]);
    expect(model.commands.map((command) => command.fqn)).toEqual(["billing.OpenInvoice", "billing.PayInvoice", "billing.VoidInvoice"]);
  }, 30_000);

  test("no generated file but $globals.ts reads a global by its own name, an event named Promise included", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(root, ".mesh", name));
    expect(await freeGlobals(join(root, "tsconfig.json"), files)).toEqual([]);
  }, 60_000);

  test("an event named Promise is a class of that name and checks its fields", async () => {
    const { Promise: Kept } = await import(join(root, ".mesh/domain/billing/index.ts"));
    expect(Mesh.fqnOf(Kept)).toBe("billing.Promise");
    expect({ ...new Kept({ at: new Date(0), why: "abc", kept: true }) }).toEqual({ at: new Date(0), why: "abc", kept: true });
    expect(() => new Kept({ at: new Date(0), why: "ABC", kept: true })).toThrow(InvalidInputError);
  });

  test("tsc type-checks the generated tree and the specifiers under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "check.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 30_000);

  test("a constructor checks every field against the declaration and freezes the instance", async () => {
    const { InvoicePaid, PayInvoice } = await import(join(root, ".mesh/domain/billing/index.ts"));
    const valid = { invoiceId: "0190a000-0000-7000-8000-000000000000", amount: 12.5, reference: "INV-1", method: "wire", paidAt: new Date(0), extra: { a: [1] } };
    const paid = new InvoicePaid(valid);
    expect({ ...paid }).toEqual(valid);
    expect(Object.isFrozen(paid)).toBe(true);
    expect(() => { (paid as { amount: number }).amount = 1; }).toThrow(TypeError);
    // a nullable field may be left out or null, and holds null
    expect(new InvoicePaid({ ...valid, reference: undefined }).reference).toBeNull();
    expect(new InvoicePaid({ ...valid, reference: null }).reference).toBeNull();
    // every other rule fails with every issue found, naming the event
    const issues = (fields: object) => {
      try { new InvoicePaid(fields); } catch (cause) { expect(cause).toBeInstanceOf(InvalidInputError); return (cause as InvalidInputError).issues.map((issue) => [issue.path.join("."), issue.message]); }
      throw new Error("expected the constructor to throw");
    };
    expect(issues({ ...valid, amount: -1 })).toEqual([["amount", "Too small: expected number to be >=0 (event billing.InvoicePaid)"]]);
    expect(issues({ ...valid, amount: "1" }).map(([path]) => path)).toEqual(["amount"]);
    expect(issues({ ...valid, invoiceId: "nope" }).map(([path]) => path)).toEqual(["invoiceId"]);
    // "no" is too short and does not match the pattern: both are reported
    expect(issues({ ...valid, reference: "no" }).map(([path]) => path)).toEqual(["reference", "reference"]);
    expect(issues({ ...valid, reference: "INV-1234567890" }).map(([path]) => path)).toEqual(["reference"]);
    expect(issues({ ...valid, reference: "ref-1234" }).map(([path]) => path)).toEqual(["reference"]);
    expect(issues({ ...valid, method: "cash" }).map(([path]) => path)).toEqual(["method"]);
    expect(issues({ ...valid, paidAt: "2024-01-01" }).map(([path]) => path)).toEqual(["paidAt"]);
    expect(issues({ ...valid, invoiceId: undefined }).map(([path]) => path)).toEqual(["invoiceId"]);
    expect(issues({ ...valid, more: 1 }).map(([path]) => path)).toEqual([""]);
    expect(issues({ ...valid, amount: -1, method: "cash" }).map(([path]) => path)).toEqual(["amount", "method"]);
    expect(issues(null as unknown as object).length).toBe(1);
    // a command is checked the same way
    const pay = new PayInvoice({ id: "0190a000-0000-7000-8000-000000000000", paidAt: new Date(0) });
    expect(Object.isFrozen(pay)).toBe(true);
    expect(() => new PayInvoice({ id: "x", paidAt: new Date(0) })).toThrow(InvalidInputError);
  });

  test("the class is nominal at run time, carries its FQN under the runtime's symbol and sits in the table by it", async () => {
    const { InvoicePaid, PayInvoice } = await import(join(root, ".mesh/domain/billing/index.ts"));
    const { RefundIssued } = await import(join(root, ".mesh/domain/sales/refunds/index.ts"));
    const app = await import(join(root, ".mesh/index.ts"));
    expect(Mesh.fqnOf(InvoicePaid)).toBe("billing.InvoicePaid");
    expect(Mesh.fqnOf(PayInvoice)).toBe("billing.PayInvoice");
    expect(Mesh.fqnOf(RefundIssued)).toBe("sales.refunds.RefundIssued");
    expect(() => Mesh.fqnOf(class {} as never)).toThrow(FrameworkError);
    expect(Object.keys(app.eventClasses)).toEqual(["billing.InvoicePaid", "billing.InvoiceOpened", "billing.InvoiceVoided", "billing.Promise", "sales.refunds.RefundIssued"]);
    expect(app.eventClasses["billing.InvoicePaid"]).toBe(InvoicePaid);
    expect(Object.isFrozen(app.eventClasses)).toBe(true);
    for (const [fqn, declared] of Object.entries(app.eventClasses as Record<string, never>)) expect(Mesh.fqnOf(declared)).toBe(fqn);
    const fields = { invoiceId: "0190a000-0000-7000-8000-000000000000", amount: 1, method: "card", paidAt: new Date(0), extra: null };
    const instance = new InvoicePaid(fields);
    const symbol = Object.getOwnPropertySymbols(InvoicePaid)[0]!;
    const declaration = InvoicePaid[symbol] as { kind: string; fqn: string; is(value: unknown): boolean };
    expect([declaration.kind, declaration.fqn]).toEqual(["event", "billing.InvoicePaid"]);
    expect(declaration.is(instance)).toBe(true);
    expect(declaration.is({ ...instance })).toBe(false);
    expect(declaration.is(Object.create(InvoicePaid.prototype))).toBe(false);
    expect(declaration.is(null)).toBe(false);
    expect(declaration.is(new PayInvoice({ id: "0190a000-0000-7000-8000-000000000000", paidAt: new Date(0) }))).toBe(false);
    expect(instance instanceof InvoicePaid).toBe(true);
  });

  test("mesh explain lists a publish step as plain code with the reason publish-step, after the write", async () => {
    const pay = await mesh(root, "explain", "billing.Invoice", "pay");
    expect(pay.code).toBe(0);
    expect(pay.stdout).toContain("  steps        set &paid = true\n");
    expect(pay.stdout).toMatch(/  after write {2}self is the stored record\n {15}publish \(\) => new InvoicePaid\(\{ invoiceId: &id, .* \}\) \(plain, publish-step: it raises the event after the write\)\n/);
    // inside a `when`, the condition is read before the write and the publish runs after it
    const refund = await mesh(root, "explain", "billing.Invoice", "refund");
    expect(refund.stdout).toContain("when () => &paid (as it held before the write)\n");
    expect(refund.stdout).toContain("publish async () =>");
  }, 30_000);

});

describe("the outbox", () => {
  type Layer = {
    transaction<T>(fn: (tx: { insert(table: unknown, row: unknown): Promise<unknown>; deleteOutboxThrough(position: number): Promise<number> }) => Promise<T>): Promise<T>;
    readOutbox(after: number, limit: number): Promise<{ rows: { position: number; name: string; entity: string; action: string; key: unknown; causedBy: string | null; metadata: unknown; payload: unknown; occurredAt: Date; id: string }[]; deletedThrough: number; highest: number }>;
    refuseIfFailed(): boolean;
    close(): Promise<void>;
  };
  const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (cause: unknown) => cause);
  let app: Record<string, any>;
  let billing: Record<string, any>;
  let refunds: Record<string, any>;
  let probe: { hooks: { made: (() => unknown) | undefined; step: ((kind: string, id: string) => Promise<unknown>) | undefined } };
  let data: { sqlite(options: { file: string }): Layer; createSchema(layer: Layer, tables: unknown): Promise<void> };
  beforeAll(async () => {
    app = await import(join(root, ".mesh/index.ts"));
    billing = (await import(join(root, ".mesh/domain/index.ts"))).billing;
    refunds = await import(join(root, ".mesh/domain/sales/refunds/index.ts"));
    probe = await import(join(root, "domain/billing/probe.ts"));
    data = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
  });
  /** A fresh in-memory database with the project's tables, the outbox's included, and a binding on it. */
  async function open(options: Record<string, unknown> = {}) {
    const layer = data.sqlite({ file: ":memory:" });
    await data.createSchema(layer, app.tables);
    const binding = app.bind(layer, options) as { run<T>(fn: () => Promise<T>): Promise<T>; transaction<T>(fn: () => Promise<T>): Promise<T> };
    return { layer, binding };
  }
  const rows = async (layer: Layer) => (await layer.readOutbox(0, 100)).rows;
  const names = async (layer: Layer) => (await rows(layer)).map((row) => row.name);
  /** A stored invoice to update, written without an action, so no event comes with it. */
  async function stored(layer: Layer, id: string, row: Record<string, unknown> = {}) {
    const table = (app.tables as Record<string, unknown>).invoice;
    await layer.transaction(async (tx) => { await tx.insert(table, { id, paid: false, total: 10, title: "untitled", ...row }); });
    return id;
  }
  const ID = "00000000-0000-4000-8000-000000000001";
  const ID2 = "00000000-0000-4000-8000-000000000002";
  afterEach(() => { probe.hooks.made = undefined; probe.hooks.step = undefined; });

  test("the schema creates the outbox and its state table, both empty", async () => {
    expect(Object.keys(app.tables)).toEqual(["invoice", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
    const { layer } = await open();
    try {
      expect(await layer.readOutbox(0, 10)).toEqual({ rows: [], deletedThrough: 0, highest: 0 });
    } finally { await layer.close(); }
  });

  test("a committed publish is one outbox row: the envelope, the key, {} as metadata and the event as JSON", async () => {
    const { layer, binding } = await open();
    try {
      await stored(layer, ID);
      const before = Date.now();
      await binding.run(() => billing.Invoice.pay({ id: ID }, {}));
      const [row, ...rest] = await rows(layer);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        position: 1, name: "billing.InvoicePaid", entity: "billing.Invoice", action: "pay", key: { id: ID }, causedBy: null, metadata: {},
        payload: { invoiceId: ID, amount: 10, reference: null, method: "card", extra: { by: "test" } },
      });
      expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(row!.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1);
      // the payload is the event as JSON: the date is its ISO text, and readEvents turns it back into a Date
      expect((row!.payload as { paidAt: string }).paidAt).toBe(row!.occurredAt.toISOString());
    } finally { await layer.close(); }
  });

  test("a create publishes with the new key, a destroy with the deleted row's, both committed", async () => {
    const { layer, binding } = await open();
    try {
      const created = await binding.run(() => billing.Invoice.open({}, {})) as { id: string };
      await binding.run(() => billing.Invoice.void({ id: created.id }, {}));
      const [opened, voided] = await rows(layer);
      expect([opened!.name, opened!.action, opened!.key, opened!.payload]).toEqual(["billing.InvoiceOpened", "open", { id: created.id }, { invoiceId: created.id }]);
      expect([voided!.name, voided!.action, voided!.key, voided!.payload]).toEqual(["billing.InvoiceVoided", "void", { id: created.id }, { invoiceId: created.id, total: 10 }]);
      expect(await binding.run<unknown>(() => billing.Invoice.read({}, {}))).toEqual([]);
    } finally { await layer.close(); }
  });

  test("a publish inside a when writes only when the condition held before the write, and a failed when= writes nothing", async () => {
    const { layer, binding } = await open();
    try {
      await stored(layer, ID);
      await stored(layer, ID2, { paid: true, total: 3 });
      expect(await binding.run(() => billing.Invoice.refund({ id: ID }, {}))).toMatchObject({ id: ID, paid: false });
      expect(await rows(layer)).toEqual([]);
      await binding.run(() => billing.Invoice.refund({ id: ID2 }, {}));
      expect((await rows(layer)).map((row) => [row.name, row.payload])).toEqual([["sales.refunds.RefundIssued", { invoiceId: ID2, cents: 1 }]]);
    } finally { await layer.close(); }
  });

  test("acceptance 8: an event exists if and only if its transaction commits", async () => {
    // The afterWrite seam runs before a write's own after-write steps, so it is made to throw on a nested write that comes
    // after `chain`'s first publish has appended its row.
    let seamFails = false;
    const { layer, binding } = await open({ seams: { afterWrite: (_db: unknown, write: { action: string }) => {
      if (seamFails && write.action === "open") throw new Error("the seam fails");
    } } });
    try {
      await stored(layer, ID);
      // a later step throws, after the publish
      probe.hooks.step = async () => { throw new Error("a later step fails"); };
      expect(((await failure(binding.run(() => billing.Invoice.chain({ id: ID }, {})))) as Error).message).toBe("a later step fails");
      expect(await rows(layer)).toEqual([]);
      // a joined call fails, and the step catches it: the transaction fails all the same
      probe.hooks.step = async () => { await billing.Invoice.pay({ id: "00000000-0000-4000-8000-0000000000ff" }, {}).catch(() => undefined); };
      const joined = await failure(binding.run(() => billing.Invoice.chain({ id: ID }, {})));
      expect(joined).toBeInstanceOf(FrameworkError);
      expect((joined as Error).cause).toBeInstanceOf(NotFoundError);
      expect(await rows(layer)).toEqual([]);
      // the afterWrite seam throws on a nested write, after the publish appended its row
      let seen: string[] = [];
      seamFails = true;
      probe.hooks.step = async () => {
        seen = (app.published() as { name: string }[]).map((record) => record.name);
        await billing.Invoice.open({}, {});
      };
      const seam = await failure(binding.run(() => billing.Invoice.chain({ id: ID }, {}))) as Error;
      expect(seam.message).toBe("the seam fails");
      expect(seen).toEqual(["billing.InvoicePaid"]);
      expect(await rows(layer)).toEqual([]);
      seamFails = false;
      // the application's transaction throws after the action returned
      expect(((await failure(binding.transaction(async () => { await billing.Invoice.pay({ id: ID }, {}); throw new Error("the application fails"); }))) as Error).message).toBe("the application fails");
      expect(await rows(layer)).toEqual([]);
      expect(await binding.run<unknown>(() => billing.Invoice.read({}, {}))).toEqual([expect.objectContaining({ id: ID, paid: false })]);
      // and the same calls commit their events once nothing fails
      probe.hooks.step = async () => undefined;
      await binding.run(() => billing.Invoice.chain({ id: ID }, {}));
      await binding.transaction(async () => { await billing.Invoice.pay({ id: ID }, {}); });
      // positions have no gap after the failed transactions
      expect((await rows(layer)).map((row) => [row.position, row.name])).toEqual([
        [1, "billing.InvoicePaid"], [2, "sales.refunds.RefundIssued"], [3, "billing.InvoicePaid"],
      ]);
    } finally { await layer.close(); }
  });

  test("a publish that returns no instance of a declared event, or whose constructor throws, fails the action and writes nothing", async () => {
    const { layer, binding } = await open();
    try {
      await stored(layer, ID);
      const { InvoicePaid, PayInvoice } = await import(join(root, ".mesh/domain/billing/index.ts"));
      const refused = (returned: string) => `The publish step of billing.Invoice#publishMade (domain/billing/invoice.mesh.mx:46:17) must return an instance of a declared event, such as new InvoicePaid({ ... }), and returned ${returned}. A publish that should sometimes raise nothing is written inside a when=`;
      const cases: [() => unknown, string][] = [
        [() => null, "null"],
        [() => undefined, "undefined"],
        [() => "InvoicePaid", "a string"],
        [() => [new InvoicePaid({ invoiceId: ID, amount: 1, method: "card", paidAt: new Date(), extra: null })], "an array"],
        [() => ({ invoiceId: ID, amount: 1, method: "card", paidAt: new Date(), extra: null }), "a plain object"],
        [() => new PayInvoice({ id: ID, paidAt: new Date() }), "an instance of the command billing.PayInvoice"],
        [() => Object.create(InvoicePaid.prototype), "an object that is not an instance of the event billing.InvoicePaid, though its constructor is that class"],
        [() => new Date(0), "an instance of Date, not of a declared event"],
      ];
      for (const [made, returned] of cases) {
        probe.hooks.made = made;
        const cause = await failure(binding.run(() => billing.Invoice.publishMade({ id: ID }, {})));
        expect(cause).toBeInstanceOf(FrameworkError);
        expect((cause as Error).message).toBe(refused(returned));
      }
      probe.hooks.made = () => new InvoicePaid({ invoiceId: ID, amount: -1, method: "card", paidAt: new Date(), extra: null });
      expect(await failure(binding.run(() => billing.Invoice.publishMade({ id: ID }, {})))).toBeInstanceOf(InvalidInputError);
      expect(await rows(layer)).toEqual([]);
      probe.hooks.made = () => new InvoicePaid({ invoiceId: ID, amount: 2, method: "card", paidAt: new Date(0), extra: [1, "two"] });
      await binding.run(() => billing.Invoice.publishMade({ id: ID }, {}));
      expect((await rows(layer)).map((row) => [row.position, row.name, row.action, row.payload])).toEqual([
        [1, "billing.InvoicePaid", "publishMade", { invoiceId: ID, amount: 2, reference: null, method: "card", paidAt: new Date(0).toISOString(), extra: [1, "two"] }],
      ]);
    } finally { await layer.close(); }
  });

  test("a nested call's events take their place in written order; published() is the transaction's own, so far, with positions", async () => {
    const seen: string[][] = [];
    const { layer, binding } = await open();
    try {
      await stored(layer, ID);
      probe.hooks.step = async () => {
        seen.push((app.published() as { name: string }[]).map((record) => record.name));
        await billing.Invoice.open({}, {});
        seen.push((app.published() as { name: string; position: number }[]).map((record) => `${record.position} ${record.name}`));
      };
      let atEnd: unknown[] = [];
      await binding.transaction(async () => {
        await billing.Invoice.chain({ id: ID }, {});
        atEnd = app.published() as unknown[];
      });
      expect(seen).toEqual([["billing.InvoicePaid"], ["1 billing.InvoicePaid", "2 billing.InvoiceOpened"]]);
      expect(await names(layer)).toEqual(["billing.InvoicePaid", "billing.InvoiceOpened", "sales.refunds.RefundIssued"]);
      const stored_ = await rows(layer);
      expect(atEnd).toHaveLength(3);
      const [first] = atEnd as { id: string; position: number; payload: unknown; metadata: unknown }[];
      expect([first!.id, first!.position]).toEqual([stored_[0]!.id, 1]);
      expect(first!.payload).toBeInstanceOf((await import(join(root, ".mesh/domain/billing/index.ts"))).InvoicePaid);
      expect(Object.isFrozen(first)).toBe(true);
      // a new transaction starts with none; outside one, published() throws
      expect(await binding.transaction(async () => app.published())).toEqual([]);
      expect(() => app.published()).toThrow(FrameworkError);
      expect(() => app.published()).toThrow("published() was called outside a transaction");
    } finally { await layer.close(); }
  });

  test("the events module's metadata function gets each publishing call's own context, a nested call's included", async () => {
    let loads = 0;
    const events = { load: async () => { loads++; return { metadata: ({ event, context }: { event: { name: string; action: string }; context: Record<string, unknown> }) => ({ requestId: context.requestId ?? null, by: `${event.action}:${event.name}` }) }; } };
    const { layer, binding } = await open({ events });
    try {
      await stored(layer, ID);
      probe.hooks.step = async () => { await billing.Invoice.open({}, { requestId: "nested" }); };
      await binding.run(() => billing.Invoice.chain({ id: ID }, { requestId: "outer" }));
      expect((await rows(layer)).map((row) => row.metadata)).toEqual([
        { requestId: "outer", by: "chain:billing.InvoicePaid" }, { requestId: "nested", by: "open:billing.InvoiceOpened" }, { requestId: "outer", by: "chain:sales.refunds.RefundIssued" },
      ]);
      expect(loads).toBe(1);
      // a metadata function that returns no object fails the action
      const bad = await open({ events: { load: async () => ({ metadata: () => "no" }) } });
      try {
        await stored(bad.layer, ID);
        const cause = await failure(bad.binding.run(() => billing.Invoice.pay({ id: ID }, {})));
        expect(cause).toBeInstanceOf(FrameworkError);
        expect((cause as Error).message).toStartWith("The events module's metadata function returned");
        expect(await rows(bad.layer)).toEqual([]);
      } finally { await bad.layer.close(); }
    } finally { await layer.close(); }
  });

  test("readEvents pages the kept events as instances, filters them, and refuses a deleted or a future cursor", async () => {
    const { layer, binding } = await open();
    try {
      await stored(layer, ID);
      await stored(layer, ID2, { paid: true });
      await binding.run(() => billing.Invoice.pay({ id: ID }, {}));
      await binding.run(() => billing.Invoice.refund({ id: ID2 }, {}));
      await binding.run(() => billing.Invoice.pay({ id: ID2 }, {}));
      const read = (query?: Record<string, unknown>) => binding.run(() => app.readEvents(query)) as Promise<{ events: { position: number; name: string; key: unknown; payload: any }[]; cursor: number; highest: number }>;
      const all = await read();
      expect(all.events.map((record) => [record.position, record.name, record.key])).toEqual([
        [1, "billing.InvoicePaid", { id: ID }], [2, "sales.refunds.RefundIssued", { id: ID2 }], [3, "billing.InvoicePaid", { id: ID2 }],
      ]);
      expect([all.cursor, all.highest]).toEqual([3, 3]);
      const { InvoicePaid } = await import(join(root, ".mesh/domain/billing/index.ts"));
      expect(all.events[0]!.payload).toBeInstanceOf(InvoicePaid);
      expect(all.events[0]!.payload.paidAt).toBeInstanceOf(Date);
      expect(all.events[1]!.payload).toBeInstanceOf(refunds.RefundIssued);
      const limited = await read({ after: 1, limit: 1 });
      expect(limited.events.map((record) => record.position)).toEqual([2]);
      expect([limited.cursor, limited.highest]).toEqual([2, 3]);
      expect((await read({ names: ["billing.InvoicePaid"] })).events.map((record) => record.position)).toEqual([1, 3]);
      expect((await read({ entity: "billing.Invoice", key: { id: ID2 } })).events.map((record) => record.position)).toEqual([2, 3]);
      expect(await read({ after: 3 })).toEqual({ events: [], cursor: 3, highest: 3 });
      // inside a transaction it is refused: the transaction's own events come from published()
      expect(((await failure(binding.transaction(() => app.readEvents()))) as Error).message).toContain("published()");
      // a cursor past the highest position
      const ahead = await failure(read({ after: 9 }));
      expect(ahead).toBeInstanceOf(CursorAheadError);
      expect(ahead).toMatchObject({ code: "MESH_CURSOR_AHEAD", retryable: false });
      // rows deleted between two reads: a cursor behind them is refused, one at them reads on
      await layer.transaction(async (tx) => tx.deleteOutboxThrough(2));
      const deleted = await failure(read({ after: 1 }));
      expect(deleted).toBeInstanceOf(EventsDeletedError);
      expect(deleted).toMatchObject({ code: "MESH_EVENTS_DELETED", retryable: false });
      expect((await read({ after: 2 })).events.map((record) => record.position)).toEqual([3]);
      // the next publish takes the next position, never a deleted one
      await binding.run(() => billing.Invoice.pay({ id: ID }, {}));
      expect((await read({ after: 2 })).events.map((record) => record.position)).toEqual([3, 4]);
    } finally { await layer.close(); }
  });

  test("acceptance 9: the bus delivers to process and listen handlers; a process handler's writes and progress commit together", async () => {
    const seen: string[] = [];
    const records: { id: string; causedBy: string | null }[] = [];
    let failPay = false;
    const module = {
      handlers: {
        process: {
          // in the handler's transaction: the refund it runs publishes an event caused by the one it handles
          refundOnPay: Mesh.handler({
            events: [billing.InvoicePaid],
            run: async (event: { payload: { invoiceId: string } }, { context }: { context: object }) => {
              await billing.Invoice.refund({ id: event.payload.invoiceId }, context);
              if (failPay) throw new Error("the refund is refused");
            },
          }),
        },
        listen: {
          log: Mesh.handler({
            events: [billing.InvoicePaid, refunds.RefundIssued],
            run: (event: { id: string; causedBy: string | null; name: string; position: number }) => {
              seen.push(`${event.position} ${event.name}`);
              records.push({ id: event.id, causedBy: event.causedBy });
            },
          }),
        },
      },
    };
    const { layer, binding } = await open({ events: { bus: testBus(), load: async () => module } });
    const deliver = () => (binding as unknown as { deliver(): Promise<void> }).deliver();
    try {
      // the first round registers both handlers at the highest position, 0
      await deliver();
      await stored(layer, ID);
      await binding.run(() => billing.Invoice.pay({ id: ID }, {}));
      await deliver();
      // a round hands each handler the rows there were when it reached it: the refund's event, published by the process
      // handler after the listen handler's turn, reaches the listen handler in the next round
      await deliver();
      // the listen handler got both events in position order; the process handler's publish carries the handled event's id
      expect(seen).toEqual(["1 billing.InvoicePaid", "2 sales.refunds.RefundIssued"]);
      expect(records.map((record) => record.causedBy)).toEqual([null, records[0]!.id]);
      // every handler is past both rows under keep "until-delivered", so the deletion pass removed them
      expect(await layer.readOutbox(0, 10)).toEqual({ rows: [], deletedThrough: 2, highest: 2 });
      const progress = await layer.transaction(async (tx) => (tx as unknown as { readHandlerProgress(): Promise<unknown> }).readHandlerProgress());
      expect(progress).toEqual([
        { name: "log", kind: "listen", position: 2, events: ["billing.InvoicePaid", "sales.refunds.RefundIssued"], generation: 3 },
        { name: "refundOnPay", kind: "process", position: 2, events: ["billing.InvoicePaid"], generation: 3 },
      ]);
      // a process handler that fails rolls back what it wrote and stops at the event; the listen handler still gets it
      failPay = true;
      await stored(layer, ID2);
      await binding.run(() => billing.Invoice.pay({ id: ID2 }, {}));
      const stopped = await failure(deliver());
      expect(stopped).toBeInstanceOf(HandlerStoppedError);
      expect(stopped).toMatchObject({ code: "MESH_HANDLER_STOPPED", retryable: false, stopped: [{ handler: "refundOnPay", position: 3, event: "billing.InvoicePaid" }] });
      expect(seen.slice(2)).toEqual(["3 billing.InvoicePaid"]);
      expect(await names(layer)).toEqual(["billing.InvoicePaid"]);
      // the next round retries it, and once it succeeds the rows go
      failPay = false;
      await deliver();
      await deliver();
      expect(seen.slice(3)).toEqual(["4 sales.refunds.RefundIssued"]);
      expect(await layer.readOutbox(0, 10)).toEqual({ rows: [], deletedThrough: 4, highest: 4 });
    } finally { await layer.close(); }
  });

  test("a listen handler's action runs in a transaction of its own, and what it publishes carries the handled event's id as causedBy", async () => {
    const handled: { id: string; inside: boolean }[] = [];
    const module = {
      handlers: {
        listen: {
          refundOnPay: Mesh.handler({
            events: [billing.InvoicePaid],
            run: async (event: { id: string; payload: { invoiceId: string } }, { context }: { context: object }) => {
              handled.push({ id: event.id, inside: layer.refuseIfFailed() });
              await billing.Invoice.refund({ id: event.payload.invoiceId }, context);
            },
          }),
        },
      },
    };
    const { layer, binding } = await open({ events: { bus: testBus(), keep: "all", load: async () => module } });
    const deliver = () => (binding as unknown as { deliver(): Promise<void> }).deliver();
    try {
      await deliver();
      await stored(layer, ID);
      await binding.run(() => billing.Invoice.pay({ id: ID }, {}));
      await deliver();
      // the listen handler ran outside any transaction; the refund it called committed on its own
      expect(handled.map((each) => each.inside)).toEqual([false]);
      const [paid, refund] = await rows(layer);
      expect([paid!.position, paid!.name, paid!.causedBy]).toEqual([1, "billing.InvoicePaid", null]);
      expect([refund!.position, refund!.name, refund!.causedBy]).toEqual([2, "sales.refunds.RefundIssued", paid!.id]);
      expect(handled[0]!.id).toBe(paid!.id);
    } finally { await layer.close(); }
  });

  test("listSubscriptions uses the binding in scope without started delivery and keeps closed rows until forgotten", async () => {
    const { layer, binding } = await open({ events: { bus: testBus() } });
    const elsewhere = await open();
    const list = () => app.listSubscriptions() as Promise<readonly { name: string; position: number }[]>;
    try {
      expect(await binding.run(list)).toEqual([]);
      const s = await binding.run(() => app.subscribe({ name: "client" }, () => {})) as { close(): Promise<void> };
      expect(await binding.run(list)).toEqual([{ name: "client", position: 0 }]);
      expect(await elsewhere.binding.run(list)).toEqual([]);
      await s.close();
      expect(await binding.run(list)).toEqual([{ name: "client", position: 0 }]);
      await expect(binding.transaction(async () => {
        expect(await list()).toEqual([{ name: "client", position: 0 }]);
        await app.forgetSubscription("client");
        expect(await list()).toEqual([]); // Joins and sees the uncommitted deletion.
        throw new Error("roll listing back");
      })).rejects.toThrow("roll listing back");
      expect(await binding.run(list)).toEqual([{ name: "client", position: 0 }]);
      await binding.run(() => app.forgetSubscription("client"));
      expect(await binding.run(list)).toEqual([]);
      expect(() => app.listSubscriptions()).toThrow("listSubscriptions was called while not connected");
    } finally { await layer.close(); await elsewhere.layer.close(); }
  });

  test("readEvents with no binding in scope and none connected throws", async () => {
    expect(await failure(app.readEvents())).toBeInstanceOf(FrameworkError);
  });

  test("dispatch runs the action whose on= names the command's class, with the command's fields as its input", async () => {
    const { layer, binding } = await open();
    const { PayInvoice } = billing;
    try {
      await stored(layer, ID);
      const paidAt = new Date("2026-01-02T03:04:05.000Z");
      const result = await binding.run(() => app.dispatch(new PayInvoice({ id: ID, paidAt }), {}));
      // what the action returns, as a direct call returns it
      expect(result).toMatchObject({ id: ID, paid: true, paidAt });
      const [row, ...rest] = await rows(layer);
      expect(rest).toEqual([]);
      // the action is `payInvoice` (named after the command), and it set `paidAt` from the command's field
      expect(row).toMatchObject({ name: "billing.InvoicePaid", entity: "billing.Invoice", action: "payInvoice", key: { id: ID }, payload: { invoiceId: ID, method: "wire" } });
      // the same call by name does the same thing
      await stored(layer, ID2);
      expect(await binding.run(() => billing.Invoice.payInvoice({ id: ID2, paidAt }, {}))).toMatchObject({ id: ID2, paid: true, paidAt });
    } finally { await layer.close(); }
  });

  test.each([false, true])("dispatch leaves an omitted update field out of the input (explicit undefined: %p)", async (explicit) => {
    const seen: unknown[] = [];
    const { layer, binding } = await open({ seams: { beforeTransaction: ({ input }: { input: unknown }) => { seen.push(input); } } });
    try {
      const paidAt = new Date("2026-01-02T03:04:05.000Z");
      await stored(layer, ID, { paidAt });
      const command = new billing.PayInvoice(explicit ? { id: ID, paidAt: undefined } : { id: ID });
      expect(command.paidAt).toBeUndefined();
      const result = await binding.run(() => app.dispatch(command, {}));
      expect(result).toMatchObject({ id: ID, paidAt });
      expect(seen).toEqual([{ id: ID }]);
      expect(Object.hasOwn(seen[0] as object, "paidAt")).toBe(false);
    } finally { await layer.close(); }
  });

  test.each([false, true])("dispatch keeps an omitted non-nullable optional title (explicit undefined: %p) and applies a sent title", async (explicit) => {
    const seen: unknown[] = [];
    const { layer, binding } = await open({ seams: { beforeTransaction: ({ input }: { input: unknown }) => { seen.push(input); } } });
    try {
      await stored(layer, ID, { title: "original" });
      const command = new billing.PayInvoice(explicit ? { id: ID, title: undefined } : { id: ID });
      expect(command.title).toBeUndefined();
      expect(await binding.run(() => app.dispatch(command, {}))).toMatchObject({ id: ID, title: "original" });
      expect(seen).toEqual([{ id: ID }]);
      expect(Object.hasOwn(seen[0] as object, "title")).toBe(false);
      expect(await binding.run(() => app.dispatch(new billing.PayInvoice({ id: ID, title: "renamed" }), {}))).toMatchObject({ id: ID, title: "renamed" });
      expect(seen[1]).toEqual({ id: ID, title: "renamed" });
      expect(await binding.run<{ id: string; title: string }[]>(() => billing.Invoice.read({}, {}))).toEqual([expect.objectContaining({ id: ID, title: "renamed" })]);
    } finally { await layer.close(); }
  });

  test("an optional command field refuses null in the constructor", () => {
    expect(() => new billing.PayInvoice({ id: ID, title: null })).toThrow(InvalidInputError);
  });

  test("optional together with nullable accepts null and preserves undefined", () => {
    expect(new billing.OpenInvoice({}).note).toBeUndefined();
    expect(new billing.OpenInvoice({ note: undefined }).note).toBeUndefined();
    expect(new billing.OpenInvoice({ note: null }).note).toBeNull();
    expect(new billing.OpenInvoice({ note: "sent" }).note).toBe("sent");
  });

  test("dispatch sends an explicit null update field and clears the attribute", async () => {
    const seen: unknown[] = [];
    const { layer, binding } = await open({ seams: { beforeTransaction: ({ input }: { input: unknown }) => { seen.push(input); } } });
    try {
      await stored(layer, ID, { paidAt: new Date(0) });
      const command = new billing.PayInvoice({ id: ID, paidAt: null });
      expect(command.paidAt).toBeNull();
      expect(await binding.run(() => app.dispatch(command, {}))).toMatchObject({ id: ID, paidAt: null });
      expect(seen).toEqual([{ id: ID, paidAt: null }]);
      expect(Object.hasOwn(seen[0] as object, "paidAt")).toBe(true);
    } finally { await layer.close(); }
  });

  test("dispatch leaves an omitted optional create field out of the input", async () => {
    const seen: unknown[] = [];
    const { layer, binding } = await open({ seams: { beforeTransaction: ({ input }: { input: unknown }) => { seen.push(input); } } });
    try {
      const command = new billing.OpenInvoice({});
      expect(command.note).toBeUndefined();
      expect(await binding.run(() => app.dispatch(command, {}))).toMatchObject({ paid: false });
      expect(seen).toEqual([{}]);
      expect(Object.hasOwn(seen[0] as object, "note")).toBe(false);
    } finally { await layer.close(); }
  });

  test("dispatch joins the running transaction: its events show in published(), and a rollback undoes the action and its event", async () => {
    const { layer, binding } = await open();
    const { PayInvoice } = billing;
    try {
      await stored(layer, ID);
      const paidAt = new Date(0);
      const seen = await binding.transaction(async () => {
        await app.dispatch(new PayInvoice({ id: ID, paidAt }), {});
        // one transaction: the event the action published is this transaction's own, before anything committed
        return app.published().map((record: { name: string }) => record.name);
      });
      expect(seen).toEqual(["billing.InvoicePaid"]);
      expect(await names(layer)).toEqual(["billing.InvoicePaid"]);
      // a failure after the dispatch rolls back the action's write and its event with the transaction
      await stored(layer, ID2);
      const cause = await failure(binding.transaction(async () => {
        await app.dispatch(new PayInvoice({ id: ID2, paidAt }), {});
        throw new Error("after the dispatch");
      }));
      expect(cause).toMatchObject({ message: "after the dispatch" });
      expect(await names(layer)).toEqual(["billing.InvoicePaid"]);
      const stored2 = await binding.run<{ id: string; paid: boolean }[]>(() => billing.Invoice.read({}, {}));
      expect(stored2.map((invoice) => [invoice.id, invoice.paid])).toEqual([[ID, true], [ID2, false]]);
    } finally { await layer.close(); }
  });

  test("dispatch passes the action's own failures through: an unknown row is NotFoundError, and nothing is published", async () => {
    const { layer, binding } = await open();
    try {
      const cause = await failure(binding.run(() => app.dispatch(new billing.PayInvoice({ id: ID, paidAt: new Date(0) }), {})));
      expect(cause).toBeInstanceOf(NotFoundError);
      expect(await rows(layer)).toEqual([]);
    } finally { await layer.close(); }
  });

  test("dispatch refuses what is not an instance of a generated command class", async () => {
    const { layer, binding } = await open();
    try {
      const paid = new billing.InvoicePaid({ invoiceId: ID, amount: 1, method: "card", paidAt: new Date(0), extra: null });
      const lookalike = { id: ID, paidAt: new Date(0) };
      for (const value of [paid, lookalike, billing.PayInvoice, null, undefined, "billing.PayInvoice"]) {
        const cause = await failure(binding.run(() => app.dispatch(value, {})));
        expect(cause).toBeInstanceOf(FrameworkError);
        expect((cause as Error).message).toContain("dispatch takes an instance of a command class that `mesh build` generated");
      }
      // a command no action of the build answers (a stale `.mesh/`) is a FrameworkError naming it
      const stale = await failure(dispatchCommand({}, new billing.PayInvoice({ id: ID, paidAt: new Date(0) }), {} as never));
      expect(stale).toBeInstanceOf(FrameworkError);
      expect((stale as Error).message).toContain("dispatch: no action answers the command billing.PayInvoice");
      expect(await rows(layer)).toEqual([]);
    } finally { await layer.close(); }
  });

  test("a process handler's dispatch runs in the handler's transaction: the event it publishes is caused by the handled one, and a failure rolls the action back", async () => {
    const paidAt = new Date(0);
    const logged: { id: string; name: string; causedBy: string | null }[] = [];
    let failAfter = false;
    const module = {
      handlers: {
        process: {
          payOnOpen: Mesh.handler({
            events: [billing.InvoiceOpened],
            run: async (event: { payload: { invoiceId: string } }, { context }: { context: object }) => {
              await app.dispatch(new billing.PayInvoice({ id: event.payload.invoiceId, paidAt }), context);
              if (failAfter) throw new Error("after the dispatch");
            },
          }),
        },
        listen: {
          log: Mesh.handler({
            events: [billing.InvoiceOpened, billing.InvoicePaid],
            run: (event: { id: string; name: string; causedBy: string | null }) => { logged.push({ id: event.id, name: event.name, causedBy: event.causedBy }); },
          }),
        },
      },
    };
    const { layer, binding } = await open({ events: { bus: testBus(), load: async () => module } });
    const deliver = () => (binding as unknown as { deliver(): Promise<void> }).deliver();
    const invoices = () => binding.run<{ id: string; paid: boolean }[]>(() => billing.Invoice.read({}, {}));
    try {
      await deliver();
      // a handler that fails after its dispatch: the action's write and its event are rolled back with the handler's transaction
      failAfter = true;
      const failed = await binding.run(() => billing.Invoice.open({}, {})) as { id: string };
      expect(await failure(deliver())).toBeInstanceOf(HandlerStoppedError);
      expect((await invoices()).map((invoice) => [invoice.id, invoice.paid])).toEqual([[failed.id, false]]);
      expect(logged.map((event) => event.name)).toEqual(["billing.InvoiceOpened"]);
      // once it succeeds, the dispatched action's event carries the handled event's id
      failAfter = false;
      await deliver();
      await deliver();
      expect((await invoices()).map((invoice) => [invoice.id, invoice.paid])).toEqual([[failed.id, true]]);
      const [opened, paid] = [logged.find((event) => event.name === "billing.InvoiceOpened")!, logged.find((event) => event.name === "billing.InvoicePaid")!];
      expect(paid.causedBy).toBe(opened.id);
    } finally { await layer.close(); }
  });

  test("dispatch of a create resolves with the new row, and of a destroy with nothing", async () => {
    const { layer, binding } = await open();
    try {
      const created = await binding.run(() => app.dispatch(new billing.OpenInvoice({ note: "n" }), {})) as { id: string; paid: boolean };
      expect(created).toMatchObject({ paid: false });
      expect(await rows(layer).then((all) => all.map((row) => [row.name, row.action, row.key]))).toEqual([["billing.InvoiceOpened", "openInvoice", { id: created.id }]]);
      expect(await binding.run(() => app.dispatch(new billing.VoidInvoice({ id: created.id }), {}))).toBeUndefined();
      expect(await binding.run<unknown>(() => billing.Invoice.read({}, {}))).toEqual([]);
      expect(await names(layer)).toEqual(["billing.InvoiceOpened", "billing.InvoiceVoided"]);
    } finally { await layer.close(); }
  });

  test("a listen handler's dispatch runs in a transaction of its own: its writes commit even when the handler fails afterwards", async () => {
    const paidAt = new Date(0);
    const module = {
      handlers: {
        listen: {
          payOnOpen: Mesh.handler({
            events: [billing.InvoiceOpened],
            run: async (event: { payload: { invoiceId: string } }, { context }: { context: object }) => {
              await app.dispatch(new billing.PayInvoice({ id: event.payload.invoiceId, paidAt }), context);
              throw new Error("after the dispatch");
            },
          }),
        },
      },
    };
    const { layer, binding } = await open({ events: { bus: testBus(), load: async () => module } });
    const deliver = () => (binding as unknown as { deliver(): Promise<void> }).deliver();
    try {
      await deliver();
      const created = await binding.run(() => billing.Invoice.open({}, {})) as { id: string };
      expect(await failure(deliver())).toBeInstanceOf(HandlerStoppedError);
      // the action committed on its own, though the handler failed: nothing rolled it back
      expect(await binding.run<{ id: string; paid: boolean }[]>(() => billing.Invoice.read({}, {}))).toMatchObject([{ id: created.id, paid: true }]);
    } finally { await layer.close(); }
  });

  test("mesh explain shows the command an action answers, and mesh inspect records its FQN", async () => {
    const explained = await mesh(root, "explain", "billing.Invoice", "payInvoice");
    expect(explained.code).toBe(0);
    expect(explained.stdout).toContain("  answers      command billing.PayInvoice (on=PayInvoice): `dispatch` of an instance runs this action with the command's fields as its input\n");
    const model = JSON.parse((await mesh(root, "inspect", "billing.Invoice")).stdout) as { actions: { name: string; command?: { fqn: string; identifier: string } }[] };
    expect(model.actions.filter((action) => action.command).map((action) => [action.name, action.command!.fqn, action.command!.identifier])).toEqual([["payInvoice", "billing.PayInvoice", "PayInvoice"], ["openInvoice", "billing.OpenInvoice", "OpenInvoice"], ["voidInvoice", "billing.VoidInvoice", "VoidInvoice"]]);
  }, 30_000);

});

describe("mesh events forget", () => {
  const CONFIG_FILE = CONFIG.replace('sqlite({ file: ":memory:" })', 'sqlite({ file: "app.db" })');
  type Ops = Record<string, (...args: unknown[]) => Promise<unknown>>;
  type FileLayer = { transaction<T>(fn: (tx: Ops) => Promise<T>): Promise<T>; close(): Promise<void> };

  /** A project on a file database holding the given handler and subscription rows, and a live claim at generation 3. */
  async function withRows(): Promise<{ dir: string; rows(): Promise<{ handlers: string[]; subscriptions: string[] }> }> {
    const dir = await project();
    await writeFile(join(dir, "mesh.config.ts"), CONFIG_FILE);
    const app = await import(join(root, ".mesh/index.ts"));
    const data = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const open = async () => {
      const layer = data.sqlite({ file: join(dir, "app.db") }) as FileLayer;
      return layer;
    };
    const layer = await open();
    await data.createSchema(layer, app.tables);
    await layer.transaction(async (tx) => {
      await tx.writeClaim!({ runId: "live", generation: 3, pid: 1, startedAt: null });
      await tx.writeHandlerProgress!({ name: "running", kind: "process", position: 4, events: ["billing.InvoicePaid"], generation: 3 });
      await tx.writeHandlerProgress!({ name: "removed", kind: "listen", position: 2, events: ["billing.InvoicePaid"], generation: 2 });
      await tx.writeHandlerProgress!({ name: "both", kind: "listen", position: 1, events: ["billing.InvoicePaid"], generation: 2 });
      await tx.writeSubscriptionProgress!({ name: "open", position: 5, filter: {}, open: true, generation: 3 });
      await tx.writeSubscriptionProgress!({ name: "crashed", position: 6, filter: {}, open: true, generation: 1 });
      await tx.writeSubscriptionProgress!({ name: "closed", position: 7, filter: {}, open: false, generation: 3 });
      await tx.writeSubscriptionProgress!({ name: "both", position: 1, filter: {}, open: false, generation: 2 });
    });
    await layer.close();
    return {
      dir,
      async rows() {
        const reader = await open();
        try {
          return await reader.transaction(async (tx) => ({
            handlers: ((await tx.readHandlerProgress!()) as { name: string }[]).map((row) => row.name),
            subscriptions: ((await tx.readSubscriptionProgress!()) as { name: string }[]).map((row) => row.name),
          }));
        } finally { await reader.close(); }
      },
    };
  }

  test("drops a removed handler's row, a closed subscription's and one a crash left open; refuses the live deliverer's", async () => {
    const { dir, rows } = await withRows();
    expect(await mesh(dir, "events", "forget", "removed")).toEqual({ code: 0, stdout: "forgot the handler removed, which was at position 2\n", stderr: "" });
    expect(await mesh(dir, "events", "forget", "closed")).toEqual({ code: 0, stdout: "forgot the subscription closed, which was at position 7\n", stderr: "" });
    // open under generation 1, while the live claim is at 3: a crash's leftover
    expect(await mesh(dir, "events", "forget", "crashed")).toEqual({ code: 0, stdout: "forgot the subscription crashed, which was at position 6\n", stderr: "" });
    const running = await mesh(dir, "events", "forget", "running");
    expect(running.code).toBe(1);
    expect(running.stderr).toContain('events forget failed: The handler "running" is registered by the live deliverer (generation 3), so its progress is not dropped');
    const open = await mesh(dir, "events", "forget", "open");
    expect(open.code).toBe(1);
    expect(open.stderr).toContain('events forget failed: The subscription "open" is open in the deliverer\'s process (generation 3); close it there first');
    const both = await mesh(dir, "events", "forget", "both");
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('The name "both" is held by a handler\'s progress row and by a subscription\'s row');
    const unknown = await mesh(dir, "events", "forget", "nobody");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No handler and no subscription named "nobody" has a row in this database');
    expect(await rows()).toEqual({ handlers: ["both", "running"], subscriptions: ["both", "open"] });
  }, 60_000);

  test("a usage mistake is exit 2 and touches nothing", async () => {
    const dir = await project();
    expect(await mesh(dir, "events")).toEqual({ code: 2, stdout: "", stderr: "Missing events command; use mesh events forget <name>\n" });
    expect(await mesh(dir, "events", "drop", "x")).toEqual({ code: 2, stdout: "", stderr: 'Unknown events command "drop"; use mesh events forget <name>\n' });
    expect(await mesh(dir, "events", "forget")).toEqual({ code: 2, stdout: "", stderr: "Missing name for mesh events forget; use mesh events forget <name>\n" });
    expect(await mesh(dir, "events", "forget", "a", "b")).toEqual({ code: 2, stdout: "", stderr: "Extra argument for mesh events forget; use mesh events forget <name>\n" });
    expect((await mesh(dir, "--help")).stdout).toContain("events forget <name>");
  }, 30_000);
});
