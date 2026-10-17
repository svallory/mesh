// End to end for M6 PR 1: an event and a command in files of their own, `publish` under `do` and under `when`, built by
// the real `mesh` command on the SQLite adapter. The fixture (`fixtures/events/domain`) holds `billing/invoice-paid.mesh.mx`
// (an event with every field option), `billing/pay-invoice.mesh.mx` (a command), `sales/refunds/refund-issued.mesh.mx` (an
// event declared as `:refundIssued`, imported through a namespace) and `billing/invoice.mesh.mx`, whose `pay` publishes
// `InvoicePaid` and whose `refund` publishes `refunds.RefundIssued` inside a `when`. Everything the PR builds is checked
// through the specifiers an application uses: the classes of each module's barrel, `DomainEvent` and the table `events` of
// `#mesh`, and `Mesh.fqnOf`. A `publish` runs after the write and then fails naming M6, until PR 2 writes the outbox.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FrameworkError, InvalidInputError, Mesh } from "@meshfw/runtime";
import { freeGlobals } from "../../compiler/test/free-globals.ts";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/events/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
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
import { events, type DomainEvent } from "#mesh";
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
export const table: typeof InvoicePaid = events["billing.InvoicePaid"];
export const tableRefund: typeof RefundIssued = events["sales.refunds.RefundIssued"];
// @ts-expect-error a command is in no event table
export const none = events["billing.PayInvoice"];
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

function mesh(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("events and commands in files of their own", () => {
  test("build writes one class file per declaration, a barrel export for each, and DomainEvent and the table in #mesh", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).sort();
    expect(files).toEqual([
      "$globals.ts", "binding.ts", "domain/billing/index.ts", "domain/billing/invoice.actions.ts", "domain/billing/invoice.expressions.ts",
      "domain/billing/invoice.types.ts", "domain/billing/invoice.validators.ts", "domain/billing/invoicePaid.event.ts",
      "domain/billing/payInvoice.command.ts", "domain/billing/promise.event.ts", "domain/index.ts", "domain/sales/index.ts", "domain/sales/refunds/index.ts",
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
    expect(index.replace(/\s+/g, " ")).toContain("export type DomainEvent = | $billing$InvoicePaid$class | $billing$Promise$class | $sales$refunds$RefundIssued$class;");
    expect(index).toContain('"billing.InvoicePaid": $billing$InvoicePaid$class,');
    expect(index).toContain('"sales.refunds.RefundIssued": $sales$refunds$RefundIssued$class,');
    expect(index).not.toContain("PayInvoice");
  });

  test("mesh build --check finds the committed tree current, and mesh inspect shows the declarations in the model", () => {
    expect(mesh(root, "build", "--check")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
    const model = JSON.parse(mesh(root, "inspect").stdout) as { events: { fqn: string; module: string; fields: { name: string; type: string }[] }[]; commands: { fqn: string }[] };
    expect(model.events.map((event) => [event.fqn, event.module])).toEqual([["billing.InvoicePaid", "billing"], ["billing.Promise", "billing"], ["sales.refunds.RefundIssued", "sales/refunds"]]);
    expect(model.events[0]!.fields.map((field) => [field.name, field.type])).toEqual([
      ["invoiceId", "uuid"], ["amount", "decimal"], ["reference", "string"], ["method", "enum"], ["paidAt", "datetime"], ["extra", "json"],
    ]);
    expect(model.commands.map((command) => command.fqn)).toEqual(["billing.PayInvoice"]);
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
    expect(Object.keys(app.events)).toEqual(["billing.InvoicePaid", "billing.Promise", "sales.refunds.RefundIssued"]);
    expect(app.events["billing.InvoicePaid"]).toBe(InvoicePaid);
    expect(Object.isFrozen(app.events)).toBe(true);
    for (const [fqn, declared] of Object.entries(app.events as Record<string, never>)) expect(Mesh.fqnOf(declared)).toBe(fqn);
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

  test("mesh explain lists a publish step as plain code with the reason publish-step, after the write", () => {
    const pay = mesh(root, "explain", "billing.Invoice", "pay");
    expect(pay.code).toBe(0);
    expect(pay.stdout).toContain("  steps        set &paid = true\n");
    expect(pay.stdout).toMatch(/  after write {2}self is the stored record\n {15}publish \(\) => new InvoicePaid\(\{ invoiceId: &id, .* \}\) \(plain, publish-step: it raises the event after the write\)\n/);
    // inside a `when`, the condition is read before the write and the publish runs after it
    const refund = mesh(root, "explain", "billing.Invoice", "refund");
    expect(refund.stdout).toContain("when () => &paid (as it held before the write)\n");
    expect(refund.stdout).toContain("publish async () =>");
  }, 30_000);

  test("a publish runs after the write, inside the transaction, and fails naming M6: nothing is stored", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const written: string[] = [];
    const binding = app.bind(layer, { seams: { afterWrite: (_db: unknown, write: { entity: string; action: string }) => { written.push(`${write.entity}#${write.action}`); } } });
    try {
      await binding.run(async () => {
        const invoice = await domain.billing.Invoice.open({}, {});
        expect(invoice).toMatchObject({ paid: false });
        const failure = await domain.billing.Invoice.pay({ id: invoice.id }, {}).then(() => undefined, (cause: unknown) => cause);
        expect(failure).toBeInstanceOf(FrameworkError);
        expect((failure as Error).message).toBe("billing.Invoice#pay cannot run in this version: its publish step writes the event to the outbox, which arrives in M6");
        // the write happened (the seam saw it, the function ran after it), and the transaction rolled back
        expect(written).toEqual(["billing.Invoice#open", "billing.Invoice#pay"]);
        expect(await domain.billing.Invoice.read({}, {})).toEqual([invoice]);
        // `refund` publishes only when the condition held before the write: it did not, so the action succeeds
        expect(await domain.billing.Invoice.refund({ id: invoice.id }, {})).toEqual(invoice);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
