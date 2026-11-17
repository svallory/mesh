// Contributed handler kinds (ADR-0094) in a project built by the real `mesh` command on data-sqlite (fixture:
// `fixtures/kinds`, the Invoice of `fixtures/project` plus `settle`, which pays through a nested call, `refund`
// answering the command `RefundInvoice`, and the read model `PaidInvoice`). The kind under test is `model` from the
// fixture's `kind.ts`, which stands in for `project` of @meshfw/event-sourcing: the tests set what its `check`, `start`,
// `adopt` and `stored` do and read what core asked it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FrameworkError, HandlerOptionError, HandlerStoppedError, Mesh, type DataLayer, type DataOperations, type DeliveryOperations, type EventRecord, type HandlerKind } from "@meshfw/runtime";
import { localBus } from "../src/index.ts";
import { buildSchema } from "./schema.ts";

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "bus-local-kinds", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

type Layer = DataLayer & { close(): Promise<void> };
type Binding = { run<T>(fn: () => Promise<T>): Promise<T>; transaction<T>(fn: () => Promise<T>): Promise<T>; deliver(): Promise<void>; startDelivery(): Promise<{ stop(): Promise<void> }> };
type Handlers = Record<string, Record<string, object>>;
let root: string;
let app: {
  bind(layer: DataLayer, options: object): Binding;
  connect(options?: { deliver?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  dispatch(command: object, context: object): Promise<unknown>;
  resumeHandler(name: string): Promise<void>;
  tables: Record<string, object>;
};
type Id = { id: string };
let Invoice: { open(input: object, context: object): Promise<Id>; pay(input: Id, context: object): Promise<unknown>; settle(input: Id, context: object): Promise<unknown>; refund(input: Id, context: object): Promise<unknown> };
let PaidInvoice: { record(input: { invoiceId: string }, context: object): Promise<Id>; read(input: object, context: object): Promise<{ invoiceId: string }[]> };
let InvoicePaid: new (fields: { invoiceId: string }) => object;
let RefundIssued: new (fields: { invoiceId: string }) => object;
let RefundInvoice: new (fields: { id: string }) => object;
let kind: { MODEL: HandlerKind; calls: string[]; control: Pick<HandlerKind, "check" | "start" | "adopt" | "stored">; resetKind(): void; model(options: object): object };
let config: { default: { data: Layer } };
/** Core's tables for delivery from several processes, which the fixture (built for a single-process bus) lacks. */
let multiCore: Record<string, object> = {};
let removeMulti: (() => Promise<void>) | undefined;
let data: { sqlite(options: { file: string }): Layer; createSchema(layer: DataLayer, tables: object): Promise<void> };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-bus-local-kinds-"));
  await cp(join(import.meta.dir, "fixtures/kinds"), root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite", "bus-local"]) await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  const built = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), "build"], { cwd: root });
  expect({ code: built.exitCode, stderr: built.stderr.toString() }).toEqual({ code: 0, stderr: "0 errors, 0 warnings\n" });
  app = await import(join(root, ".mesh/index.ts"));
  ({ Invoice, PaidInvoice, InvoicePaid, RefundIssued, RefundInvoice } = await import(join(root, ".mesh/domain/billing/index.ts")));
  kind = await import(join(root, "kind.ts"));
  config = await import(join(root, "mesh.config.ts"));
  data = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
  const multi = await buildSchema({ processes: "many" });
  removeMulti = multi.remove;
  multiCore = Object.fromEntries(Object.entries(multi.tables).filter(([name]) => name.startsWith("mesh_")));
}, 30_000);
afterAll(async () => {
  await removeMulti?.();
  await app?.disconnect();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => kind.resetKind());

const SYSTEM = { system: true };
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;

/** A fresh in-memory database with the project's tables. */
async function database(options: { multiProcess?: boolean } = {}): Promise<Layer> {
  const layer = data.sqlite({ file: ":memory:" });
  await data.createSchema(layer, options.multiProcess ? { ...app.tables, ...multiCore } : app.tables);
  return layer;
}
/** A binding over `layer` with `handlers` as its events module. */
function bind(layer: Layer, handlers: Handlers, options: { keep?: "until-delivered" | "all"; bus?: object; seams?: object } = {}): Binding {
  return app.bind(layer, { ...(options.seams ? { seams: options.seams } : {}), events: { bus: options.bus ?? localBus({ retryDelays: [] }), keep: options.keep ?? "all", load: async () => ({ handlers }) } });
}
/** Pay `count` invoices through a binding that registers no handler; resolves with their ids. */
async function paid(layer: Layer, count: number): Promise<string[]> {
  return bind(layer, {}).run(async () => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) { const invoice = await Invoice.open({}, {}); await Invoice.pay({ id: invoice.id }, {}); ids.push(invoice.id); }
    return ids;
  });
}
/** The delivery state (without the database's clock) and every progress row. */
const state = (layer: Layer) => layer.transaction(async (tx) => {
  const { now: _now, ...delivery } = await ops(tx).readDeliveryState();
  return { state: delivery, handlers: await ops(tx).readHandlerProgress() };
});
const readModel = (layer: Layer) => bind(layer, {}).run(() => PaidInvoice.read({}, SYSTEM));
const outboxNames = async (layer: Layer) => (await layer.readOutbox!(0, 100)).rows.map((row) => `${row.position}:${row.name}`);
/** A `model` handler that records the positions it is handed under `seen`. */
function recorder(seen: number[], run: (event: EventRecord<{ invoiceId: string }>, tools: { context: object }) => Promise<unknown> = async () => undefined) {
  return kind.model({ events: [InvoicePaid], run: async (event: EventRecord<{ invoiceId: string }>, tools: { context: object }) => { seen.push(event.position); await run(event, tools); } });
}

describe("registering a handler of a contributed kind", () => {
  test("a new handler starts where its kind's start says: from 0 it is handed every kept row in order, and its row stores the kind's name", async () => {
    const layer = await database();
    try {
      await paid(layer, 3);
      const seen: number[] = [];
      await bind(layer, { model: { totals: recorder(seen) } }).deliver();
      expect(seen).toEqual([1, 2, 3]);
      expect(kind.calls).toEqual(["check totals", "start totals"]);
      const { handlers } = await state(layer);
      expect(handlers).toEqual([{ name: "totals", kind: "model", position: 3, events: ["billing.InvoicePaid"], generation: 1 }]);
    } finally { await layer.close(); }
  });

  test("a start in the middle hands only the rows after it; the kind reads the registration it is given", async () => {
    const layer = await database();
    try {
      await paid(layer, 3);
      let seenRegistration: object | undefined;
      kind.control.start = async (_handler, registration) => { seenRegistration = { deletedThrough: registration.deletedThrough, deletedAny: registration.deletedAny, highest: registration.highest, keep: registration.keep }; return 2; };
      const seen: number[] = [];
      await bind(layer, { model: { totals: recorder(seen) } }).deliver();
      expect(seen).toEqual([3]);
      expect(seenRegistration).toEqual({ deletedThrough: 0, deletedAny: false, highest: 3, keep: "all" });
    } finally { await layer.close(); }
  });

  test("once rows were deleted, the registration says so, and a start below the deleted-through position is refused", async () => {
    const layer = await database();
    try {
      await paid(layer, 2);
      await bind(layer, { process: { drain: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) } }, { keep: "until-delivered" }).deliver();
      await bind(layer, {}, { keep: "until-delivered" }).deliver();
      expect((await state(layer)).state.deletedThrough).toBe(2);
      let deletedAny: boolean | undefined;
      kind.control.start = async (_handler, registration) => { deletedAny = registration.deletedAny; return 0; };
      const error = await rejection(bind(layer, { model: { totals: recorder([]) } }, { keep: "until-delivered" }).deliver());
      expect(deletedAny).toBe(true);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe('The model kind of @meshfw/test-kind started the handler "totals" at 0: a start is a position from the deleted-through position, 2, to the highest, 2');
    } finally { await layer.close(); }
  });

  test("a known row goes to adopt with what the list gained; stored names the kind it is rewritten with", async () => {
    const layer = await database();
    try {
      await bind(layer, { model: { totals: recorder([]) } }).deliver();
      kind.calls.length = 0;
      kind.control.stored = (_handler, row, added) => (row?.kind === "model" && added.length > 0 ? "model:grown" : "model");
      const grown = kind.model({ events: [InvoicePaid, RefundIssued], run: () => undefined });
      await bind(layer, { model: { totals: grown } }).deliver();
      expect(kind.calls).toEqual(["check totals", "adopt totals model [billing.RefundIssued]"]);
      expect((await state(layer)).handlers[0]!.kind).toBe("model:grown");
    } finally { await layer.close(); }
  });

  test("a refusal from adopt fails deliver(), startDelivery() and connect() alike, and leaves the claim and every row as they were", async () => {
    const layer = await database();
    try {
      await bind(layer, { model: { totals: recorder([]) }, process: { other: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) } }).deliver();
      const before = await state(layer);
      const refused = new Error("the kind refuses this start");
      kind.control.adopt = async () => { throw refused; };
      const binding = bind(layer, { model: { totals: recorder([]) }, process: { other: Mesh.handler({ events: [InvoicePaid], run: () => undefined }), fresh: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) } });
      expect(await rejection(binding.deliver())).toBe(refused);
      expect(await rejection(binding.startDelivery())).toBe(refused);
      expect(await state(layer)).toEqual(before);
      // a later start that the kind accepts claims as usual: nothing was left half-claimed
      kind.control.adopt = async () => {};
      await binding.deliver();
      expect((await state(layer)).state.generation).toBe(before.state.generation + 1);
    } finally { await layer.close(); }
    // connect() reads the project's own events module, whose handler is of the kind `model`
    const file = config.default.data;
    await data.createSchema(file, app.tables);
    await app.connect({ deliver: true });
    await app.disconnect();
    const generation = (await state(file)).state.generation;
    kind.control.adopt = async () => { throw new Error("refused at connect"); };
    const error = await rejection(app.connect());
    expect((error as Error).message).toBe("refused at connect");
    expect((await state(file)).state.generation).toBe(generation);
    await app.disconnect();
    await file.close();
  });

  test("the kind's check runs before core's option checks, so its own message wins, and nothing is claimed", async () => {
    const layer = await database();
    try {
      kind.control.check = (handler) => { throw new HandlerOptionError(handler.name, `The model handler ${JSON.stringify(handler.name)} is refused by its kind`); };
      const skipping = { ...recorder([]), onFailure: "skip" };
      const error = await rejection(bind(layer, { model: { totals: skipping } }).deliver());
      expect(error).toBeInstanceOf(HandlerOptionError);
      expect((error as Error).message).toBe('The model handler "totals" is refused by its kind');
      expect((await state(layer)).state.generation).toBe(0);
    } finally { await layer.close(); }
  });

  test("names are unique across every kind", async () => {
    const layer = await database();
    try {
      const error = await rejection(bind(layer, { process: { totals: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) }, model: { totals: recorder([]) } }).deliver());
      expect(error).toBeInstanceOf(HandlerOptionError);
      expect((error as Error).message).toBe('The model handler "totals" has the name of a process handler: a handler\'s name is unique across every kind, since it keys the handler\'s progress row');
    } finally { await layer.close(); }
  });

  test("core's kinds still store process and listen, beside a contributed one", async () => {
    const layer = await database();
    try {
      await bind(layer, {
        process: { p: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) },
        listen: { l: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) },
        model: { m: recorder([]) },
      }).deliver();
      expect((await state(layer)).handlers.map((row) => `${row.name}:${row.kind}`)).toEqual(["l:listen", "m:model", "p:process"]);
    } finally { await layer.close(); }
  });

  test("delivered from several processes, a new handler starts where its kind says and a refusal from adopt rolls the registration back", async () => {
    const layer = await database({ multiProcess: true });
    try {
      await paid(layer, 2);
      const many = () => localBus({ processes: "many", retryDelays: [] });
      const seen: number[] = [];
      await bind(layer, { model: { totals: recorder(seen) } }, { bus: many() }).deliver();
      expect(seen).toEqual([1, 2]);
      expect((await state(layer)).handlers.map((row) => [row.name, row.kind, row.position])).toEqual([["totals", "model", 2]]);
      const before = await state(layer);
      kind.control.adopt = async (_handler, row, added) => { if (added.length > 0 || row.kind === "model") throw new Error(`adopt refused at ${row.position}`); };
      const error = await rejection(bind(layer, { model: { totals: recorder([]) }, process: { fresh: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) } }, { bus: many() }).deliver());
      expect((error as Error).message).toBe("adopt refused at 2");
      expect((await state(layer)).handlers).toEqual(before.handlers);
    } finally { await layer.close(); }
  });
});

describe("running a handler of a contributed kind", () => {
  test("its body runs in the handler transaction: a write through an entity value commits with its progress, and a throw after the write leaves neither", async () => {
    const layer = await database();
    try {
      await paid(layer, 1);
      let fail = true;
      const totals = recorder([], async (event, { context }) => {
        await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context);
        if (fail) throw Object.assign(new Error("after the write"), { retryable: false });
      });
      const error = await rejection(bind(layer, { model: { totals } }).deliver());
      expect(error).toBeInstanceOf(HandlerStoppedError);
      expect(await readModel(layer)).toEqual([]);
      expect((await state(layer)).handlers[0]!.position).toBe(0);
      fail = false;
      await bind(layer, { model: { totals } }).deliver();
      expect((await readModel(layer)).length).toBe(1);
      expect((await state(layer)).handlers[0]!.position).toBe(1);
    } finally { await layer.close(); }
  });
});

describe("a contributed kind's call chain is quiet until the handler call settles", () => {
  const D5 = (action: string, at: string) => `The publish step of billing.Invoice#${action} (domain/billing/invoice.mesh.mx:${at}) ran inside the model handler totals, or in an action it or a seam started while it ran, and a model handler may not publish: a handler of a kind @meshfw/test-kind contributes is run again over history to rebuild what it writes, and a rebuild must never re-raise events. Publish from the action the event records, or from a process handler`;
  const D6 = "dispatch(billing.RefundInvoice) was called inside the model handler totals, or in code it or a seam started while it ran, and a model handler may not dispatch: a handler of a kind @meshfw/test-kind contributes is run again over history to rebuild what it writes, and a rebuild must never re-issue commands. Dispatch from a process handler";
  /** Run `totals` over one paid invoice under deliver() with an explicit retry schedule; resolves with the stop's error. */
  async function stopOf(layer: Layer, body: (event: EventRecord<{ invoiceId: string }>, tools: { context: object }) => Promise<unknown>, options: { seams?: object } = {}) {
    let calls = 0;
    const totals = recorder([], async (event, tools) => { calls++; await body(event, tools); });
    const error = await rejection(bind(layer, { model: { totals } }, { bus: localBus({ retryDelays: [10, 10] }), ...options }).deliver());
    expect(error).toBeInstanceOf(HandlerStoppedError);
    const cause = (error as HandlerStoppedError).stopped[0]!.cause as Error & { retryable?: boolean };
    return { cause, calls };
  }

  test("a publish from the body's own call, or from an action two calls deep, is refused, rolls the handler transaction back and stops the handler at once", async () => {
    for (const [name, call, action, at] of [
      ["direct", (id: string, context: object) => Invoice.pay({ id }, context), "pay", "15:17"],
      ["nested", (id: string, context: object) => Invoice.settle({ id }, context), "pay", "15:17"],
    ] as const) {
      const layer = await database();
      try {
        await paid(layer, 1);
        const before = await outboxNames(layer);
        const { cause, calls } = await stopOf(layer, async (_event, { context }) => {
          await PaidInvoice.record({ invoiceId: "00000000-0000-4000-8000-000000000001" }, context);
          const other = await Invoice.open({}, context);
          await call(other.id, context);
        });
        expect([name, cause]).toEqual([name, expect.any(FrameworkError)]);
        expect(cause.message).toBe(D5(action, at));
        expect(cause.retryable).toBe(false);
        expect(calls).toBe(1);
        expect(await outboxNames(layer)).toEqual(before);
        expect(await readModel(layer)).toEqual([]);
        expect((await state(layer)).handlers[0]!.position).toBe(0);
      } finally { await layer.close(); }
    }
  });

  test("a dispatch from the body is refused before the answering action runs", async () => {
    const layer = await database();
    try {
      const [id] = await paid(layer, 1);
      let refunded = 0;
      const { cause, calls } = await stopOf(layer, async (_event, { context }) => {
        const pending = app.dispatch(new RefundInvoice({ id: id! }), context).then(() => { refunded++; });
        await pending;
      });
      expect(cause).toBeInstanceOf(FrameworkError);
      expect(cause.message).toBe(D6);
      expect(cause.retryable).toBe(false);
      expect({ calls, refunded }).toEqual({ calls: 1, refunded: 0 });
      expect(await outboxNames(layer)).toEqual(["1:billing.InvoicePaid"]);
    } finally { await layer.close(); }
  });

  test("entity writes that publish nothing run, a publish under a when= that is false included", async () => {
    const layer = await database();
    try {
      await paid(layer, 2);
      const totals = recorder([], async (event, { context }) => {
        await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context);
        const unpaid = await Invoice.open({}, context);
        await Invoice.refund({ id: unpaid.id }, context);
      });
      await bind(layer, { model: { totals } }).deliver();
      expect((await readModel(layer)).length).toBe(2);
      expect(await outboxNames(layer)).toEqual(["1:billing.InvoicePaid", "2:billing.InvoicePaid"]);
    } finally { await layer.close(); }
  });

  test("an afterCommit seam that reacts to the read-model write is refused its publish and its dispatch; the handler's own work commits", async () => {
    const layer = await database();
    try {
      const [id] = await paid(layer, 1);
      const seen: string[] = [];
      const seams = {
        afterCommit: async ({ changes }: { changes: readonly { entity: string }[] }) => {
          if (!changes.some((change) => change.entity === "billing.PaidInvoice")) return;
          const other = await Invoice.open({}, {}).catch((error: Error) => { seen.push(`open: ${error.message}`); return undefined; });
          if (other) await Invoice.pay({ id: other.id }, {}).then(() => seen.push("pay ran"), (error: Error) => seen.push(`pay: ${error.message}`));
          try { await app.dispatch(new RefundInvoice({ id: id! }), {}); seen.push("dispatch ran"); } catch (error) { seen.push(`dispatch: ${(error as Error).message}`); }
        },
      };
      const totals = recorder([], async (event, { context }) => { await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context); });
      await bind(layer, { model: { totals } }, { seams }).deliver();
      expect(seen).toEqual([`pay: ${D5("pay", "15:17")}`, `dispatch: ${D6}`]);
      expect(await outboxNames(layer)).toEqual(["1:billing.InvoicePaid"]);
      expect((await readModel(layer)).length).toBe(1);
      expect((await state(layer)).handlers[0]!.position).toBe(1);
    } finally { await layer.close(); }
  });

  test("a write a policy refuses stops the handler at once, and resumeHandler sends it on once the cause is fixed", async () => {
    const layer = await database();
    try {
      await paid(layer, 1);
      let context: object = {};
      const totals = recorder([], async (event) => { await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context); });
      const stops: HandlerStoppedError[] = [];
      const binding = bind(layer, { model: { totals } }, { bus: localBus({ retryDelays: [10, 10], pollInterval: 10, onStopped: (error) => { stops.push(error); } }) });
      const delivery = await binding.startDelivery();
      try {
        const end = Date.now() + 3000;
        while (stops.length === 0 && Date.now() < end) await new Promise((done) => setTimeout(done, 5));
        expect((stops[0]!.stopped[0]!.cause as { code?: string }).code).toBe("forbidden");
        context = SYSTEM;
        const { resumeHandler } = await import("@meshfw/runtime");
        await resumeHandler(binding as never, "totals");
        while ((await readModel(layer)).length === 0 && Date.now() < end) await new Promise((done) => setTimeout(done, 5));
        expect((await readModel(layer)).length).toBe(1);
        expect(stops.length).toBe(1);
      } finally { await delivery.stop(); }
    } finally { await layer.close(); }
  });

  test("a call started after the handler call settled (a timer) begins a new chain, which may publish and dispatch", async () => {
    const layer = await database();
    try {
      const [id] = await paid(layer, 1);
      let later: Promise<unknown> | undefined;
      // The timer fires outside the handler transaction, which has ended by then, so it runs its calls in a `run` of
      // the binding; the chain the body began has settled, so they begin a new one.
      const totals = recorder([], async () => {
        later = new Promise((done, fail) => setTimeout(() => {
          binding.run(async () => {
            const other = await Invoice.open({}, {});
            await Invoice.pay({ id: other.id }, {});
            await app.dispatch(new RefundInvoice({ id: id! }), {});
          }).then(done, fail);
        }, 20));
      });
      const binding: Binding = bind(layer, { model: { totals } });
      await binding.deliver();
      await binding.run(async () => { await later; });
      expect(await outboxNames(layer)).toEqual(["1:billing.InvoicePaid", "2:billing.InvoicePaid", "3:billing.RefundIssued"]);
    } finally { await layer.close(); }
  });

  test("process handlers are unchanged: they publish with causedBy and dispatch, their afterCommit seams publish, and a dispatch after a quiet round runs", async () => {
    const layer = await database();
    try {
      let id: string | undefined;
      const seen: string[] = [];
      const seams = {
        afterCommit: async ({ changes }: { changes: readonly { entity: string; action: string }[] }) => {
          if (!changes.some((change) => change.entity === "billing.PaidInvoice")) return;
          const other = await Invoice.open({}, {});
          await Invoice.pay({ id: other.id }, {});
          seen.push("seam published");
        },
      };
      const handlers = {
        model: { totals: recorder([]) },
        process: {
          refund: Mesh.handler({ events: [InvoicePaid], run: async (event, { context }) => {
            if ((event.payload as { invoiceId: string }).invoiceId !== id) return;
            await PaidInvoice.record({ invoiceId: id! }, context);
            await app.dispatch(new RefundInvoice({ id: id! }), context);
          } }),
        },
      };
      const binding = bind(layer, handlers, { seams });
      // a process handler starts from now: register it before the invoice is paid
      await binding.deliver();
      [id] = await paid(layer, 1);
      await binding.deliver();
      expect(seen).toEqual(["seam published"]);
      const rows = (await layer.readOutbox!(0, 100)).rows;
      expect(rows.map((row) => row.name)).toEqual(["billing.InvoicePaid", "billing.RefundIssued", "billing.InvoicePaid"]);
      expect(rows[1]!.causedBy).toBe(rows[0]!.id);
      // after a round of the quiet handler, a dispatch from a top-level transaction is not refused
      await binding.transaction(async () => { await app.dispatch(new RefundInvoice({ id: id! }), {}); });
      expect((await layer.readOutbox!(0, 100)).rows.at(-1)!.name).toBe("billing.RefundIssued");
    } finally { await layer.close(); }
  });
});
