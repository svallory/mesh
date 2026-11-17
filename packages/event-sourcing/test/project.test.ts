// Project handlers (event-sourcing design, rules R8 to R16a and R22) in a project built by the real `mesh` command on
// data-sqlite (fixture: `fixtures/project`, an Invoice whose `pay` publishes InvoicePaid and whose `void` publishes
// InvoiceVoided, and the read model `PaidInvoice`). Each test binds a fresh in-memory database with the handlers it
// needs; the last one connects through the fixture's own events module.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { HANDLER_KIND, HandlerOptionError, HandlerStoppedError, Mesh, forgetByName, type DataLayer, type DataOperations, type DeliveryOperations, type EventBus, type EventRecord } from "@meshfw/runtime";
import { HandlerHistoryError, PROJECT, project } from "../src/index.ts";
import "./capabilities.ts";

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "event-sourcing-project", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

type Layer = DataLayer & { close(): Promise<void> };
type Binding = { run<T>(fn: () => Promise<T>): Promise<T>; deliver(): Promise<void>; startDelivery(): Promise<{ stop(): Promise<void> }> };
type Handlers = Record<string, Record<string, object>>;
type Id = { id: string };
type Paid = { invoiceId: string };
let root: string;
let app: { bind(layer: DataLayer, options: object): Binding; connect(options?: { deliver?: boolean }): Promise<void>; disconnect(): Promise<void>; tables: Record<string, object> };
let Invoice: { open(input: object, context: object): Promise<Id>; pay(input: Id, context: object): Promise<unknown>; void(input: Id, context: object): Promise<unknown> };
let PaidInvoice: { record(input: Paid, context: object): Promise<Id>; read(input: object, context: object): Promise<Paid[]> };
let InvoicePaid: new (fields: Paid) => Paid;
let InvoiceVoided: new (fields: Paid) => Paid;
let config: { default: { data: Layer } };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-event-sourcing-"));
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
  ({ Invoice, PaidInvoice, InvoicePaid, InvoiceVoided } = await import(join(root, ".mesh/domain/billing/index.ts")));
  config = await import(join(root, "mesh.config.ts"));
}, 30_000);
afterAll(async () => {
  await app?.disconnect();
  await rm(root, { recursive: true, force: true });
});

const SYSTEM = { system: true };
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;

async function database(): Promise<Layer> {
  const layer = sqlite({ file: ":memory:" }) as Layer;
  await createSchema(layer, app.tables);
  return layer;
}
type Keep = "until-delivered" | "all";
function bind(layer: Layer, handlers: Handlers, options: { keep?: Keep; bus?: EventBus } = {}): Binding {
  return app.bind(layer, { events: { bus: options.bus ?? localBus({ retryDelays: [] }), keep: options.keep ?? "all", load: async () => ({ handlers }) } });
}
/** Pay `count` new invoices (one InvoicePaid row each) through a binding that registers no handler. */
async function pay(layer: Layer, count: number): Promise<void> {
  await bind(layer, {}).run(async () => {
    for (let i = 0; i < count; i++) { const invoice = await Invoice.open({}, {}); await Invoice.pay({ id: invoice.id }, {}); }
  });
}
/** Void one new invoice: one InvoiceVoided row. */
const voidOne = (layer: Layer) => bind(layer, {}).run(async () => { const invoice = await Invoice.open({}, {}); await Invoice.void({ id: invoice.id }, {}); });
/** Deliver under `until-delivered` until the deletion pass has deleted every delivered row. */
async function deleteDelivered(layer: Layer): Promise<void> {
  await bind(layer, { process: { drain: processHandler() } }, { keep: "until-delivered" }).deliver();
  await bind(layer, {}, { keep: "until-delivered" }).deliver();
  await forgetByName(layer, "drain");
  expect((await state(layer)).state.deletedThrough).toBeGreaterThan(0);
}
const state = (layer: Layer) => layer.transaction(async (tx) => {
  const { now: _now, ...delivery } = await ops(tx).readDeliveryState();
  return { state: delivery, handlers: await ops(tx).readHandlerProgress() };
});
const rows = async (layer: Layer) => (await state(layer)).handlers.map((row) => [row.name, row.kind, row.position, row.events.join(",")]);
const readModel = (layer: Layer) => bind(layer, {}).run(() => PaidInvoice.read({}, SYSTEM));

/** A project handler over `events` that records the positions it is handed in `seen`. */
function recorder(seen: number[], options: { events?: readonly (new (fields: Paid) => Paid)[]; from?: "beginning" | "now"; renamedFrom?: string } = {}) {
  return project({
    events: options.events ?? [InvoicePaid],
    run: (event: EventRecord<Paid>) => { seen.push(event.position); },
    ...(options.from ? { from: options.from } : {}),
    ...(options.renamedFrom ? { renamedFrom: options.renamedFrom } : {}),
  });
}
const processHandler = (renamedFrom?: string) => Mesh.handler({ events: [InvoicePaid], run: () => undefined, ...(renamedFrom ? { renamedFrom } : {}) });

/** Asserts a HandlerHistoryError's fields and returns its message. */
function history(error: unknown, expected: { handler: string; events: string[]; reason: HandlerHistoryError["reason"] }): string {
  expect(error).toBeInstanceOf(HandlerHistoryError);
  const failure = error as HandlerHistoryError;
  expect({ code: failure.code, retryable: failure.retryable, handler: failure.handler, events: [...failure.events], reason: failure.reason })
    .toEqual({ code: "MESH_HANDLER_HISTORY", retryable: false, ...expected });
  return failure.message;
}
/** A start must leave the claim's generation and every progress row as they were. */
async function unchangedBy(layer: Layer, start: () => Promise<unknown>): Promise<unknown> {
  const before = await state(layer);
  const error = await rejection(start());
  expect(await state(layer)).toEqual(before);
  return error;
}

describe("project()", () => {
  test("makes a frozen handler of the project kind, from the beginning by default", () => {
    const made = project({ events: [InvoicePaid], run: () => undefined });
    expect(Object.isFrozen(made)).toBe(true);
    expect(made.from).toBe("beginning");
    expect(made[HANDLER_KIND]).toBe(PROJECT);
    expect(project({ events: [InvoicePaid], from: "now", run: () => undefined }).from).toBe("now");
    expect({ name: PROJECT.name, owner: PROJECT.owner }).toEqual({ name: "project", owner: "@meshfw/event-sourcing" });
  });
});

describe("starting a new project handler", () => {
  test("from the beginning, on a database that never deleted a row, it is handed every kept row from 0 and its read model is built", async () => {
    const layer = await database();
    try {
      await pay(layer, 3);
      const handlers = { project: { paidInvoices: project({ events: [InvoicePaid], run: async (event, { context }) => { await PaidInvoice.record({ invoiceId: (event.payload as Paid).invoiceId }, context); } }) } };
      await bind(layer, handlers).deliver();
      expect(await rows(layer)).toEqual([["paidInvoices", "project", 3, "billing.InvoicePaid"]]);
      expect((await readModel(layer)).length).toBe(3);
    } finally { await layer.close(); }
  });

  test("under keep until-delivered, it starts at 0 while nothing has been deleted yet", async () => {
    const layer = await database();
    try {
      await pay(layer, 2);
      const seen: number[] = [];
      await bind(layer, { project: { totals: recorder(seen) } }, { keep: "until-delivered" }).deliver();
      expect(seen).toEqual([1, 2]);
    } finally { await layer.close(); }
  });

  test("from now, it starts at the highest position and its row stores project:now", async () => {
    const layer = await database();
    try {
      await pay(layer, 2);
      const seen: number[] = [];
      const binding = bind(layer, { project: { totals: recorder(seen, { from: "now" }) } });
      await binding.deliver();
      await pay(layer, 1);
      await binding.deliver();
      expect(seen).toEqual([3]);
      expect(await rows(layer)).toEqual([["totals", "project:now", 3, "billing.InvoicePaid"]]);
    } finally { await layer.close(); }
  });

  test("once a row has been deleted, from the beginning fails with MESH_HANDLER_HISTORY and claims nothing; it still fails after a switch to keep all", async () => {
    const layer = await database();
    try {
      await pay(layer, 2);
      await deleteDelivered(layer);
      const totals = recorder([], { events: [InvoiceVoided, InvoicePaid] });
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals } }, { keep: "until-delivered" }).deliver());
      expect(history(error, { handler: "totals", events: ["billing.InvoicePaid", "billing.InvoiceVoided"], reason: "deleted" })).toBe(
        'The project handler "totals" starts from the beginning of history, and outbox rows have been deleted on this database (up to position 2; keep is "until-delivered"), so its read model would be built from part of the history of billing.InvoicePaid, billing.InvoiceVoided. Set from: "now" and backfill the read model from current rows. If these events are new and none has been published yet, from: "now" misses nothing');
      // keep: "all" from now on cannot bring back what was deleted, so it is neither accepted nor offered as a remedy
      const later = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([]) } }, { keep: "all" }).deliver());
      const message = history(later, { handler: "totals", events: ["billing.InvoicePaid"], reason: "deleted" });
      expect(message).toContain('(up to position 2; keep is "all")');
      expect(message).toContain("If this event is new");
      expect(message).not.toContain('keep: "all"');
      // the neighbour that works: from now
      await bind(layer, { project: { totals: recorder([], { from: "now" }) } }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project:now", 2, "billing.InvoicePaid"]]);
    } finally { await layer.close(); }
  });

  test("startDelivery() is refused the same way", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await deleteDelivered(layer);
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([]) } }).startDelivery());
      history(error, { handler: "totals", events: ["billing.InvoicePaid"], reason: "deleted" });
    } finally { await layer.close(); }
  });
});

describe("the options a project handler is checked for at start", () => {
  const withCapabilities = (capabilities: string[]): EventBus => {
    const bus = localBus({ retryDelays: [] });
    return { manifest: { adapter: "custom", capabilities: capabilities as EventBus["manifest"]["capabilities"] }, create: (core, options) => bus.create(core, options) };
  };

  test("a from other than beginning or now is MESH_HANDLER_OPTION", async () => {
    const layer = await database();
    try {
      for (const [from, shown] of [["later", '"later"'], [3, "3"], [null, "null"]] as const) {
        const handler = { ...recorder([]), from };
        const error = await unchangedBy(layer, () => bind(layer, { project: { totals: handler } }).deliver());
        expect(error).toBeInstanceOf(HandlerOptionError);
        expect((error as HandlerOptionError).handler).toBe("totals");
        expect((error as Error).message).toBe(`The project handler "totals" has from ${shown}: it is "beginning" (the default) or "now"`);
      }
    } finally { await layer.close(); }
  });

  test("onFailure skip is refused by the kind's own message, also on a bus that declares dead-letters; stop is accepted", async () => {
    const layer = await database();
    try {
      const skipping = { ...recorder([]), onFailure: "skip" };
      for (const bus of [localBus({ retryDelays: [] }), withCapabilities(["ordered-delivery", "replay", "dead-letters"])]) {
        const error = await unchangedBy(layer, () => bind(layer, { project: { totals: skipping } }, { bus }).deliver());
        expect(error).toBeInstanceOf(HandlerOptionError);
        expect((error as Error).message).toBe('The project handler "totals" has onFailure "skip": a project handler never skips an event, since a read model built without one is wrong. Leave onFailure out (it defaults to "stop")');
      }
      await bind(layer, { project: { totals: { ...recorder([]), onFailure: "stop" } } }).deliver();
      expect((await rows(layer)).length).toBe(1);
    } finally { await layer.close(); }
  });

  test("from the beginning needs the bus's replay; from now does not", async () => {
    const layer = await database();
    try {
      const bus = withCapabilities(["ordered-delivery"]);
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([]) } }, { bus }).deliver());
      expect(error).toBeInstanceOf(HandlerOptionError);
      expect((error as Error).message).toBe('The project handler "totals" starts from the beginning of history (from: "beginning", the default), which needs the bus\'s replay, and the bus custom does not declare it. Set from: "now" and backfill the read model from current rows');
      await bind(layer, { project: { totals: recorder([], { from: "now" }) } }, { bus }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project:now", 0, "billing.InvoicePaid"]]);
    } finally { await layer.close(); }
  });
});

describe("restarting a project handler that has a progress row", () => {
  test("an unchanged list keeps registering after rows were deleted, round after round and across restarts", async () => {
    const layer = await database();
    try {
      const seen: number[] = [];
      await pay(layer, 1);
      const binding = bind(layer, { project: { totals: recorder(seen) } }, { keep: "until-delivered" });
      await binding.deliver();
      expect((await state(layer)).state.deletedThrough).toBe(1);
      await pay(layer, 1);
      await binding.deliver();
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder(seen) } }, { keep: "until-delivered" }).deliver();
      expect(seen).toEqual([1, 2, 3]);
      expect(await rows(layer)).toEqual([["totals", "project", 3, "billing.InvoicePaid"]]);
    } finally { await layer.close(); }
  });

  test("an event added once rows were deleted is MESH_HANDLER_HISTORY; losing an event is not", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder([], { events: [InvoicePaid, InvoiceVoided] }) } }, { keep: "until-delivered" }).deliver();
      await bind(layer, { project: { totals: recorder([]) } }, { keep: "until-delivered" }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project", 1, "billing.InvoicePaid"]]);
      const grown = recorder([], { events: [InvoicePaid, InvoiceVoided] });
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: grown } }).deliver());
      expect(history(error, { handler: "totals", events: ["billing.InvoiceVoided"], reason: "deleted" })).toBe(
        'The project handler "totals" now lists billing.InvoiceVoided, and outbox rows have been deleted on this database (up to position 1), so it would miss part of that event\'s history. Set from: "now" (the handler keeps its position for the events it already lists) and backfill the read model for billing.InvoiceVoided from current rows');
    } finally { await layer.close(); }
  });

  test("an added event with a kept row at or below the handler's position is MESH_HANDLER_HISTORY naming the row", async () => {
    const layer = await database();
    try {
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      await voidOne(layer);
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project", 2, "billing.InvoicePaid"]]);
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([], { events: [InvoicePaid, InvoiceVoided] }) } }).deliver());
      expect(history(error, { handler: "totals", events: ["billing.InvoiceVoided"], reason: "kept-below" })).toBe(
        'The project handler "totals" now lists billing.InvoiceVoided, and the kept row at position 1 (of an added event, or of a name no event declares) lies at or below its position, 2, so it would never be handled. Clear its read model and forget it (mesh events forget totals) to build it again, register it under a new name, or set from: "now" and backfill');
    } finally { await layer.close(); }
  });

  test("a kept row of an added event at exactly the handler's position is kept-below too", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await voidOne(layer);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project", 2, "billing.InvoicePaid"]]);
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([], { events: [InvoicePaid, InvoiceVoided] }) } }).deliver());
      expect(history(error, { handler: "totals", events: ["billing.InvoiceVoided"], reason: "kept-below" })).toContain(
        "the kept row at position 2 (of an added event, or of a name no event declares) lies at or below its position, 2,");
    } finally { await layer.close(); }
  });

  test("a kept row of a name no event declares, below the position, is kept-below when the list grows", async () => {
    const file = join(root, "undeclared.db");
    const layer = sqlite({ file }) as Layer;
    await createSchema(layer, app.tables);
    try {
      // a row passed while its event was declared, whose declaration has since gone (here: renamed in place)
      await voidOne(layer);
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project", 2, "billing.InvoicePaid"]]);
      const raw = new Database(file);
      try { raw.run("UPDATE mesh_outbox SET name = 'billing.InvoiceGone' WHERE position = 1"); } finally { raw.close(); }
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([], { events: [InvoicePaid, InvoiceVoided] }) } }).deliver());
      expect(history(error, { handler: "totals", events: ["billing.InvoiceVoided"], reason: "kept-below" })).toContain("the kept row at position 1 ");
    } finally { await layer.close(); }
  });

  test("through renamedFrom, kept-below names the former row and offers leaving renamedFrom out", async () => {
    const layer = await database();
    try {
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      await voidOne(layer);
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      const error = await unchangedBy(layer, () => bind(layer, { project: { paid: recorder([], { events: [InvoicePaid, InvoiceVoided], renamedFrom: "totals" }) } }).deliver());
      expect(history(error, { handler: "paid", events: ["billing.InvoiceVoided"], reason: "kept-below" })).toBe(
        'The project handler "paid" now lists billing.InvoiceVoided, and the kept row at position 1 (of an added event, or of a name no event declares) lies at or below its position, 2, so it would never be handled. Clear its read model and forget the former row (mesh events forget totals) to build it again, leave out renamedFrom so that it starts as a new handler, or set from: "now" and backfill');
    } finally { await layer.close(); }
  });

  test("an added event with no kept row at or below the position is taken on, and its later rows are handled", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      const seen: number[] = [];
      await bind(layer, { project: { totals: recorder(seen) } }).deliver();
      await voidOne(layer); // above the position: the handler has not passed it
      await bind(layer, { project: { totals: recorder(seen, { events: [InvoicePaid, InvoiceVoided] }) } }).deliver();
      expect(seen).toEqual([1, 2]);
      expect(await rows(layer)).toEqual([["totals", "project", 2, "billing.InvoicePaid,billing.InvoiceVoided"]]);
    } finally { await layer.close(); }
  });

  test("a process row reused by name, or taken over through renamedFrom, is refused (reason kind)", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await bind(layer, { process: { totals: processHandler(), notify: processHandler() } }).deliver();
      const byName = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([]) }, process: { notify: processHandler() } }).deliver());
      expect(history(byName, { handler: "totals", events: ["billing.InvoicePaid"], reason: "kind" })).toBe(
        'The handler "totals" was registered as a process handler and is now a project handler that starts from the beginning of history: its progress, at position 1, says nothing of the rows before it. Clear its read model and forget it (mesh events forget totals) to build it again, or register it under a new name');
      const renamed = await unchangedBy(layer, () => bind(layer, { project: { model: recorder([], { renamedFrom: "notify" }) }, process: { totals: processHandler() } }).deliver());
      expect(history(renamed, { handler: "model", events: ["billing.InvoicePaid"], reason: "kind" })).toBe(
        'The handler "model" (it takes over the progress of "notify", renamedFrom) was registered as a process handler and is now a project handler that starts from the beginning of history: its progress, at position 1, says nothing of the rows before it. Clear its read model and forget the former row (mesh events forget notify) to build it again, or leave out renamedFrom so that it starts as a new handler');
      // from now takes a process row over, and records that its history is not complete
      await bind(layer, { project: { totals: recorder([], { from: "now" }) }, process: { notify: processHandler() } }).deliver();
      expect((await rows(layer)).find((row) => row[0] === "totals")).toEqual(["totals", "project:now", 1, "billing.InvoicePaid"]);
    } finally { await layer.close(); }
  });

  test("a row started from now is refused from the beginning (reason from), by name and through renamedFrom", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder([], { from: "now" }), early: recorder([], { from: "now" }) } }).deliver();
      const byName = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([]), early: recorder([], { from: "now" }) } }).deliver());
      expect(history(byName, { handler: "totals", events: ["billing.InvoicePaid"], reason: "from" })).toBe(
        'The project handler "totals" starts from the beginning of history (from: "beginning", the default), and its progress row started from now (from: "now"), so Mesh cannot tell whether its read model has every event before that start. Clear its read model and forget it (mesh events forget totals) to build it again, or register it under a new name');
      const renamed = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([], { from: "now" }), late: recorder([], { renamedFrom: "early" }) } }).deliver());
      expect(history(renamed, { handler: "late", events: ["billing.InvoicePaid"], reason: "from" })).toBe(
        'The project handler "late" starts from the beginning of history (from: "beginning", the default) (it takes over the progress of "early", renamedFrom), and its progress row started from now (from: "now"), so Mesh cannot tell whether its read model has every event before that start. Clear its read model and forget the former row (mesh events forget early) to build it again, or leave out renamedFrom so that it starts as a new handler');
    } finally { await layer.close(); }
  });

  test("once a row was deleted, a refused row's remedy is from now, never a rebuild", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await bind(layer, { project: { now: recorder([], { from: "now" }) }, process: { totals: processHandler() } }, { keep: "until-delivered" }).deliver();
      expect((await state(layer)).state.deletedThrough).toBe(1);
      const kind = history(await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([]), now: recorder([], { from: "now" }) } }).deliver()), { handler: "totals", events: ["billing.InvoicePaid"], reason: "kind" });
      expect(kind).toEndWith('says nothing of the rows before it. Set from: "now" (rows have been deleted, so the history cannot be rebuilt)');
      const from = history(await unchangedBy(layer, () => bind(layer, { project: { now: recorder([]) }, process: { totals: processHandler() } }).deliver()), { handler: "now", events: ["billing.InvoicePaid"], reason: "from" });
      expect(from).toEndWith('has every event before that start. Keep from: "now" (rows have been deleted, so the history cannot be rebuilt)');
    } finally { await layer.close(); }
  });

  test("a complete row run under from now with an unchanged list stays project and may go back to the beginning; one that grew under from now may not", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      await bind(layer, { project: { totals: recorder([], { from: "now" }) } }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project", 1, "billing.InvoicePaid"]]);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      await bind(layer, { project: { totals: recorder([], { from: "now", events: [InvoicePaid, InvoiceVoided] }) } }).deliver();
      expect(await rows(layer)).toEqual([["totals", "project:now", 1, "billing.InvoicePaid,billing.InvoiceVoided"]]);
      const error = await unchangedBy(layer, () => bind(layer, { project: { totals: recorder([], { events: [InvoicePaid, InvoiceVoided] }) } }).deliver());
      history(error, { handler: "totals", events: ["billing.InvoiceVoided", "billing.InvoicePaid"].sort(), reason: "from" });
    } finally { await layer.close(); }
  });

  test("renamedFrom from a project row keeps its position and its complete history", async () => {
    const layer = await database();
    try {
      await pay(layer, 2);
      await bind(layer, { project: { totals: recorder([]) } }).deliver();
      await pay(layer, 1);
      const seen: number[] = [];
      await bind(layer, { project: { paid: recorder(seen, { renamedFrom: "totals" }) } }).deliver();
      expect(seen).toEqual([3]);
      expect(await rows(layer)).toEqual([["paid", "project", 3, "billing.InvoicePaid"]]);
    } finally { await layer.close(); }
  });

  test("a read model is rebuilt by forgetting its handler and starting again, which replays from 0", async () => {
    const layer = await database();
    try {
      await pay(layer, 2);
      const first: number[] = [];
      await bind(layer, { project: { totals: recorder(first) } }).deliver();
      expect((await forgetByName(layer, "totals")).kind).toBe("handler");
      const again: number[] = [];
      await bind(layer, { project: { totals: recorder(again) } }).deliver();
      expect({ first, again }).toEqual({ first: [1, 2], again: [1, 2] });
    } finally { await layer.close(); }
  });
});

describe("a project body", () => {
  test("a body that fails stops at the event: its writes and its progress roll back together", async () => {
    const layer = await database();
    try {
      await pay(layer, 1);
      const failing = project({ events: [InvoicePaid], run: async (event, { context }) => { await PaidInvoice.record({ invoiceId: (event.payload as Paid).invoiceId }, context); throw new Error("after the write"); } });
      const error = await rejection(bind(layer, { project: { totals: failing } }).deliver());
      expect(error).toBeInstanceOf(HandlerStoppedError);
      expect(await readModel(layer)).toEqual([]);
      expect(await rows(layer)).toEqual([["totals", "project", 0, "billing.InvoicePaid"]]);
    } finally { await layer.close(); }
  });
});

test("connect() registers the project handler of the project's own events module and builds the read model from history", async () => {
  const file = config.default.data;
  await createSchema(file, app.tables);
  await bind(file, {}).run(async () => { const invoice = await Invoice.open({}, {}); await Invoice.pay({ id: invoice.id }, {}); });
  await app.connect({ deliver: true });
  try {
    const deadline = Date.now() + 5_000;
    while ((await rows(file)).length === 0 || (await rows(file))[0]![2] !== 1) {
      if (Date.now() > deadline) throw new Error("the project handler was not delivered within 5 s");
      await Bun.sleep(25);
    }
    expect(await rows(file)).toEqual([["paidInvoices", "project", 1, "billing.InvoicePaid"]]);
  } finally {
    await app.disconnect();
  }
  expect((await readModel(file)).length).toBe(1);
  await file.close();
});
