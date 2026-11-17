// Upcasting (event-sourcing design, rules R17 and R18) in a project built by the real `mesh` command on data-sqlite
// (fixture: `fixtures/project`, the same as project.test.ts). An "old" row is one appended by hand with the payload
// InvoicePaid had when first published, `{ invoice }`, which today's class (`{ invoiceId }`, a uuid) refuses. Each test
// binds a fresh in-memory database; the events module is the object the test's `load` resolves with.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { FrameworkError, HandlerStoppedError, Mesh, retryFailed, subscribe, type DataLayer, type DataOperations, type DeliveryOperations, type EventRecord, type OutboxRow } from "@meshfw/runtime";
import { project } from "../src/index.ts";
import "./capabilities.ts";

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "event-sourcing-upcast", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

type Layer = DataLayer & { close(): Promise<void> };
type Binding = { run<T>(fn: () => Promise<T>): Promise<T>; deliver(): Promise<void> };
type Paid = { invoiceId: string };
type Module = { handlers?: Record<string, Record<string, object>>; upcast?: (stored: OutboxRow) => unknown };
let root: string;
let app: { bind(layer: DataLayer, options: object): Binding; tables: Record<string, object> };
let Invoice: { open(input: object, context: object): Promise<{ id: string }>; pay(input: { id: string }, context: object): Promise<unknown> };
let PaidInvoice: { record(input: Paid, context: object): Promise<unknown>; read(input: object, context: object): Promise<Paid[]> };
let InvoicePaid: new (fields: Paid) => Paid;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-event-sourcing-upcast-"));
  await cp(join(import.meta.dir, "fixtures/project"), root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite", "bus-local", "event-sourcing"]) await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  const built = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), "build"], { cwd: root });
  expect({ code: built.exitCode, stderr: built.stderr.toString() }).toEqual({ code: 0, stderr: "0 errors, 0 warnings\n" });
  app = await import(join(root, ".mesh/index.ts"));
  ({ Invoice, PaidInvoice, InvoicePaid } = await import(join(root, ".mesh/domain/billing/index.ts")));
}, 30_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const SYSTEM = { system: true };
const OLD_ID = "0190f0a0-0000-7000-8000-000000000001";
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

async function database(): Promise<Layer> {
  const layer = sqlite({ file: ":memory:" }) as Layer;
  await createSchema(layer, app.tables);
  return layer;
}
function bind(layer: Layer, module: Module | (() => Promise<Module>), options: { renamed?: Record<string, string> } = {}): Binding {
  const load = typeof module === "function" ? module : async () => module;
  return app.bind(layer, { events: { bus: localBus({ retryDelays: [] }), keep: "all", load, ...(options.renamed ? { renamed: options.renamed } : {}) } });
}
/** Append one InvoicePaid row as first published, `{ invoice }`, under `name` (a former FQN, for the rename map). */
async function appendOld(layer: Layer, name = "billing.InvoicePaid"): Promise<void> {
  await layer.transaction((tx) => (tx as DataOperations & DeliveryOperations).appendEvent!({
    id: Bun.randomUUIDv7(), name, entity: "billing.Invoice", action: "pay", key: { id: OLD_ID }, causedBy: null, metadata: {},
    occurredAt: new Date("2026-09-01T00:00:00.000Z"), payload: { invoice: OLD_ID },
  }));
}
/** Pay one new invoice: one InvoicePaid row in today's shape. */
async function payOne(layer: Layer): Promise<string> {
  return bind(layer, {}).run(async () => { const invoice = await Invoice.open({}, {}); await Invoice.pay({ id: invoice.id }, {}); return invoice.id; });
}
/** The upcast a project writes by hand: `{ invoice }` becomes `{ invoiceId }`; today's shape passes through. */
const byHand = (seen: string[] = []) => (stored: OutboxRow) => {
  seen.push(`${stored.position}:${stored.name}`);
  const payload = stored.payload as Record<string, unknown>;
  return "invoice" in payload ? { invoiceId: payload.invoice } : payload;
};
const readModel = (layer: Layer) => bind(layer, {}).run(() => PaidInvoice.read({}, SYSTEM));

describe("the events module's upcast, at every reader of stored rows", () => {
  test("a project handler replays old rows in today's shape, and a process handler is handed new old-shaped rows so", async () => {
    const layer = await database();
    await appendOld(layer);
    const handled: unknown[] = [];
    const binding = bind(layer, {
      upcast: byHand(),
      handlers: {
        project: { paidInvoices: project({ events: [InvoicePaid], run: async (event, { context }) => { await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context); } }) },
        process: { log: Mesh.handler({ events: [InvoicePaid], run: (event: EventRecord<Paid>) => { handled.push(event.payload); } }) },
      },
    });
    // The project handler starts at 0 and replays the old row; the process handler starts from now (position 1).
    await binding.deliver();
    expect(handled).toEqual([]);
    const current = await payOne(layer);
    await appendOld(layer);
    await binding.deliver();
    expect(handled.map((payload) => (payload as Paid).invoiceId)).toEqual([current, OLD_ID]);
    expect(handled.every((payload) => payload instanceof InvoicePaid)).toBe(true);
    expect((await readModel(layer)).map((row) => row.invoiceId).sort()).toEqual([OLD_ID, OLD_ID, current].sort());
    await layer.close();
  });

  test("without upcast the old row stops the handler with the FrameworkError that points to upcast", async () => {
    const layer = await database();
    await appendOld(layer);
    const stop = await rejection(bind(layer, { handlers: { project: { paidInvoices: project({ events: [InvoicePaid], run: () => undefined }) } } }).deliver());
    expect(stop).toBeInstanceOf(HandlerStoppedError);
    const cause = (stop as HandlerStoppedError).stopped[0]!.cause as Error;
    expect(cause).toBeInstanceOf(FrameworkError);
    expect(cause.message).toStartWith("The outbox row at position 1 holds a billing.InvoicePaid that its class no longer accepts");
    expect(cause.message).toEndWith("Export upcast from the events module to turn old payloads into today's fields (upcasters() of @meshfw/event-sourcing)");
    await layer.close();
  });

  test("the rename map runs before upcast: a row stored under a former FQN, in the old shape, reaches the handler upcast and under the new FQN", async () => {
    const layer = await database();
    await appendOld(layer, "billing.InvoiceSettled");
    const seen: string[] = [];
    const handed: [string, unknown][] = [];
    await bind(layer, {
      upcast: byHand(seen),
      handlers: { project: { names: project({ events: [InvoicePaid], run: (event) => { handed.push([event.name, event.payload]); } }) } },
    }, { renamed: { "billing.InvoiceSettled": "billing.InvoicePaid" } }).deliver();
    expect(seen).toEqual(["1:billing.InvoicePaid"]);
    expect(handed).toHaveLength(1);
    expect(handed[0]![0]).toBe("billing.InvoicePaid");
    expect(handed[0]![1]).toBeInstanceOf(InvoicePaid);
    expect((handed[0]![1] as Paid).invoiceId).toBe(OLD_ID);
    await layer.close();
  });

  test("a subscription opened before anything loaded the events module still gets today's shape", async () => {
    const layer = await database();
    await appendOld(layer);
    let loaded = 0;
    const binding = bind(layer, async () => { loaded++; return { upcast: byHand() }; });
    const received: unknown[] = [];
    const subscription = await subscribe(binding as never, { name: "feed", after: 0 }, (event) => { received.push(event.payload); });
    expect(loaded).toBe(1);
    await binding.deliver();
    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(InvoicePaid);
    expect((received[0] as Paid).invoiceId).toBe(OLD_ID);
    await subscription.close();
    await layer.close();
  });

  test("retryFailed replays a set-aside old row in today's shape", async () => {
    const layer = await database();
    await payOne(layer);
    let fail = true;
    const handed: unknown[] = [];
    const handlers = { process: { flaky: Mesh.handler({ events: [InvoicePaid], onFailure: "skip" as never, run: (event: EventRecord<Paid>) => { if (fail) throw new Error("down"); handed.push(event.payload); } }) } };
    const binding = bind(layer, { upcast: byHand(), handlers });
    await binding.deliver(); // registers at the highest position, 1
    await appendOld(layer);
    const warn = console.warn;
    console.warn = () => {};
    try { await binding.deliver(); } finally { console.warn = warn; }
    fail = false;
    expect(await retryFailed(binding as never, "flaky")).toMatchObject({ handled: 1 });
    expect(handed).toHaveLength(1);
    expect(handed[0]).toBeInstanceOf(InvoicePaid);
    expect((handed[0] as Paid).invoiceId).toBe(OLD_ID);
    await layer.close();
  });
});
