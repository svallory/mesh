// Core's deletion pass under a per-event keep (`events.keep: { default, events }`) over a data-sqlite layer: each row
// is deleted by its own event's rule once every reader has passed it, rows deleted above a kept one are holes recorded
// per stored name in mesh_outbox_state.holes, a history read or a first subscription open that takes an event from
// below one of its holes is MESH_EVENTS_DELETED, and a registration sees a hole as a deletion (Registration.deletedAny).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import {
  bindDomain, DECLARATION, EventsDeletedError, FrameworkError, HANDLER_KIND, publishEvent, readEvents, subscribe,
  type DataLayer, type DataOperations, type Declaration, type DeliveryOperations, type EventRecord, type EventsModule, type HandlerKind, type PerEventKeep,
  type RetentionOperations, type TableHandle,
} from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";
import { openPolicies } from "./open-policy.ts";

const invoice = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
  actions
    create :open
      do
        publish=() => new InvoicePaid({ n: 1 })
`;
const paid = `event :InvoicePaid
  integer :n
`;

let dir: string;
let tables: Record<string, TableHandle>;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".scratch-keep-per-event-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  ({ tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> });
});
afterAll(async () => { setDeliveryTiming(null); await rm(dir, { recursive: true, force: true }); });

function eventClass(fqn: string) {
  return class {
    readonly #brand = true;
    static readonly [DECLARATION]: Declaration = { kind: "event", fqn, is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
    readonly n: number;
    constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
  };
}
type EventType = ReturnType<typeof eventClass>;
const Kept = eventClass("audit.Kept");
const Gone = eventClass("core.Gone");
const Aged = eventClass("core.Aged");
const domain = { Kept, Gone, Aged };
const DAY = 86_400_000;

/** Publish one event per `[class, age in ms]` (age 0 by default), each stamped `age` before now, in one transaction. */
const publish = (layer: DataLayer, ...events: (EventType | [EventType, number])[]) => layer.transaction(async (tx) => {
  for (const each of events) {
    const [Class, age] = Array.isArray(each) ? each : [each, 0];
    await publishEvent(tx, undefined, { entity: "core.Thing", action: "make", key: { id: "k" }, at: "test" }, new Class({ n: age }), {}, () => new Date(Date.now() - age));
  }
});
const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations & RetentionOperations;
const state = (layer: DataLayer) => layer.transaction(async (tx) => ops(tx).readDeliveryState());
const kept = async (layer: DataLayer) => (await layer.readOutbox!(0, 100)).rows.map((row) => row.position);

/** Every event, listed by one process handler: it passes every row it reads. */
const everything: EventsModule = { handlers: { process: { h: { events: [Kept, Gone, Aged], run: () => {} } } } };
const PER_EVENT: PerEventKeep = { default: "until-delivered", events: { "audit.Kept": "all" } };

async function world(keep: unknown, options: { module?: EventsModule; renamed?: Record<string, string>; layer?: DataLayer } = {}) {
  const layer = options.layer ?? sqlite({ file: ":memory:" });
  if (!options.layer) await createSchema(layer, tables);
  const frame = new AsyncLocalStorage();
  const binding = bindDomain(domain, layer, {
    events: { bus: testBus({ retryDelays: [0, 0] }), keep: keep as never, load: async () => options.module ?? everything, ...(options.renamed ? { renamed: options.renamed } : {}) },
  }, frame as never);
  // The first round registers the handlers at the highest position, so they read every row published after it.
  await binding.deliver();
  return { layer, binding, read: (query: Parameters<typeof readEvents>[2]) => readEvents(frame as never, binding, query) };
}

describe("the deletion pass under a per-event keep", () => {
  test("a row of an event kept \"all\" stays while every passed row of the others goes, above it too: those are holes, recorded per name", async () => {
    const { layer, binding } = await world(PER_EVENT);
    try {
      await publish(layer, Gone, Kept, Gone, Aged, Kept, Gone);
      await binding.deliver();
      expect(await kept(layer)).toEqual([2, 5]);
      const after = await state(layer);
      // the prefix stops below the first kept row; 3, 4 and 6 are deleted above it
      expect(after.deletedThrough).toBe(1);
      expect(after.holes).toEqual({ "core.Gone": 6, "core.Aged": 4 });
      expect((await layer.readOutbox!(0, 10)).holes).toEqual({ "core.Gone": 6, "core.Aged": 4 });
    } finally { await layer.close(); }
  });

  test("a row no reader has passed is kept, whatever its rule: holes are made only at or below the bound", async () => {
    let fail = true;
    const module: EventsModule = { handlers: { process: { h: { events: [Kept, Gone, Aged], run: (event) => { if (fail && event.name === "core.Aged") throw new Error("down"); } } } } };
    const { layer, binding } = await world(PER_EVENT, { module });
    try {
      await publish(layer, Kept, Gone, Aged, Gone);
      await expect(binding.deliver()).rejects.toThrow();
      expect(await kept(layer)).toEqual([1, 3, 4]);
      expect((await state(layer)).holes).toEqual({ "core.Gone": 2 });
      fail = false;
      await binding.deliver();
      expect(await kept(layer)).toEqual([1]);
      expect((await state(layer)).holes).toEqual({ "core.Gone": 4, "core.Aged": 3 });
    } finally { await layer.close(); }
  });

  test("a period rule keeps that event's young rows and deletes its old ones as holes; the default's rows go once passed", async () => {
    const { layer, binding } = await world({ default: "until-delivered", events: { "core.Aged": { days: 30 } } });
    try {
      await publish(layer, Gone, [Aged, 40 * DAY], [Aged, 60_000], Gone, [Aged, 40 * DAY], Gone);
      await binding.deliver();
      // 1, 2 form the prefix; 3 is young; 4, 5, 6 go above it
      expect(await kept(layer)).toEqual([3]);
      expect((await state(layer)).deletedThrough).toBe(2);
      expect((await state(layer)).holes).toEqual({ "core.Gone": 6, "core.Aged": 5 });
    } finally { await layer.close(); }
  });

  test("an \"all\" default keeps every other row, and an event's own rule deletes its rows", async () => {
    const { layer, binding } = await world({ default: "all", events: { "core.Gone": "until-delivered" } });
    try {
      await publish(layer, Gone, Kept, Gone, Aged, Gone);
      await binding.deliver();
      expect(await kept(layer)).toEqual([2, 4]);
      expect((await state(layer)).deletedThrough).toBe(1);
      expect((await state(layer)).holes).toEqual({ "core.Gone": 5 });
    } finally { await layer.close(); }
  });

  test("no statement deletes more than a batch: a hole range larger than the batch takes several batches of one pass", async () => {
    const deletes: number[] = [];
    const inner = sqlite({ file: ":memory:" });
    await createSchema(inner, tables);
    const view: Record<string, unknown> = {};
    for (const key of Object.keys(inner)) {
      const value = (inner as unknown as Record<string, unknown>)[key];
      view[key] = typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
    }
    view.transaction = <T>(run: (tx: DataOperations) => Promise<T>) => inner.transaction((tx) => run(new Proxy(tx, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "deleteOutboxRows")
          return async (...args: unknown[]) => { const result = await (value as (...a: unknown[]) => Promise<{ deleted: number }>).apply(target, args); deletes.push(result.deleted); return result; };
        if (key === "deleteOutboxThrough")
          return async (position: number) => { const count = await (value as (p: number) => Promise<number>).call(target, position); deletes.push(count); return count; };
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    })));
    const { layer, binding } = await world(PER_EVENT, { layer: view as unknown as DataLayer });
    try {
      setDeliveryTiming({ batch: 2 });
      await publish(layer, Kept, Gone, Gone, Gone, Gone, Gone, Gone, Gone);
      deletes.length = 0;
      await binding.deliver();
      expect(await kept(layer)).toEqual([1]);
      expect((await state(layer)).holes).toEqual({ "core.Gone": 8 });
      expect(deletes.reduce((a, b) => a + b, 0)).toBe(7);
      expect(Math.max(...deletes)).toBeLessThanOrEqual(2);
    } finally { setDeliveryTiming(null); await inner.close(); }
  });

  test("the record shrinks as the prefix passes its holes, and is {} once it has passed all of them", async () => {
    const { layer, binding } = await world({ default: "until-delivered", events: { "audit.Kept": { days: 30 } } });
    try {
      // 1 a young Kept row holds the prefix; 2 to 4 go above it
      await publish(layer, Kept, Gone, Gone, Aged);
      await binding.deliver();
      expect((await state(layer)).holes).toEqual({ "core.Gone": 3, "core.Aged": 4 });
      // the Kept row is now old: aged in place through the database's clock is not possible, so its row is deleted by
      // hand below the bound, as an aged row would be, and the next pass moves the prefix past every hole
      await layer.transaction((tx) => ops(tx).deleteOutboxRows(0, 1, ["audit.Kept"], null, 10));
      await binding.deliver();
      expect((await state(layer)).deletedThrough).toBe(4);
      expect((await state(layer)).holes).toEqual({});
    } finally { await layer.close(); }
  });

  test("a rule given by a former FQN of events.renamed covers the event's old and new stored rows", async () => {
    const { layer, binding } = await world({ default: "until-delivered", events: { "old.Kept": "all" } }, { renamed: { "old.Kept": "audit.Kept" } });
    try {
      // a row stored under the former FQN, then rows under the current one
      await layer.transaction((tx) => ops(tx).appendEvent!({ id: "00000000-0000-7000-8000-000000000001", name: "old.Kept", entity: "core.Thing", action: "make", key: { id: "k" }, causedBy: null, metadata: {}, occurredAt: new Date(), payload: { n: 0 } }));
      await publish(layer, Gone, Kept, Gone);
      await binding.deliver();
      expect(await kept(layer)).toEqual([1, 3]);
      expect((await state(layer)).holes).toEqual({ "core.Gone": 4 });
    } finally { await layer.close(); }
  });

  test("legal neighbours: under a single rule nothing is a hole, and a record left by an earlier per-event keep is still pruned", async () => {
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, tables);
    try {
      const before = await world(PER_EVENT, { layer });
      await publish(layer, Kept, Gone, Gone);
      await before.binding.deliver();
      expect((await state(layer)).holes).toEqual({ "core.Gone": 3 });
      // a later deliverer runs with keep "all": nothing is deleted, the record of holes that still exist stays
      const all = await world("all", { layer });
      await publish(layer, Gone);
      await all.binding.deliver();
      expect((await state(layer)).holes).toEqual({ "core.Gone": 3 });
      expect(await kept(layer)).toEqual([1, 4]);
      // then "until-delivered": the prefix passes everything, and the record is pruned
      const plain = await world("until-delivered", { layer });
      await plain.binding.deliver();
      expect(await kept(layer)).toEqual([]);
      expect((await state(layer)).holes).toEqual({});
    } finally { await layer.close(); }
  });
});

describe("reads below a hole (rule KE3)", () => {
  test("readEvents from below a hole fails naming the event; names that leave it out, and a cursor at the hole, read", async () => {
    const { layer, binding, read } = await world(PER_EVENT);
    try {
      await publish(layer, Kept, Gone, Kept, Gone);
      await binding.deliver();
      expect(await kept(layer)).toEqual([1, 3]);
      const error = await read({ after: 0 }).then(() => undefined, (thrown: unknown) => thrown) as EventsDeletedError;
      expect(error).toBeInstanceOf(EventsDeletedError);
      expect([error.eventName, error.after, error.oldestKept]).toEqual(["core.Gone", 0, 5]);
      expect((await read({ after: 0, names: ["audit.Kept"] })).events.map((event) => event.position)).toEqual([1, 3]);
      expect((await read({ after: 4 })).events).toEqual([]);
      await expect(read({ after: 2, names: ["core.Gone"] })).rejects.toThrow(EventsDeletedError);
    } finally { await layer.close(); }
  });

  test("a first subscription open below a hole of an event its filter takes fails and writes no row; one that leaves it out is fed past the hole", async () => {
    const { layer, binding } = await world(PER_EVENT);
    try {
      await publish(layer, Kept, Gone, Kept, Gone);
      await binding.deliver();
      await expect(subscribe(binding, { name: "all", after: 0 }, () => {})).rejects.toThrow(EventsDeletedError);
      await expect(subscribe(binding, { name: "gone", after: 1, names: ["core.Gone"] }, () => {})).rejects.toThrow("takes the event core.Gone");
      const rows = await layer.transaction(async (tx) => ops(tx).readSubscriptionProgress());
      expect(rows.map((row) => row.name)).toEqual([]);
      const seen: EventRecord[] = [];
      const subscription = await subscribe(binding, { name: "kept", after: 0, names: ["audit.Kept"] }, (event) => { seen.push(event); });
      await binding.deliver();
      expect(seen.map((event) => event.position)).toEqual([1, 3]);
      subscription.ack(3);
      await subscription.close();
      // a reopen never meets a hole: its stored row is part of every later bound
      await publish(layer, Gone, Kept);
      await binding.deliver();
      const again = await subscribe(binding, { name: "kept", names: ["audit.Kept"] }, () => {});
      await again.close();
    } finally { await layer.close(); }
  });
});

describe("a registration sees a hole as a deletion", () => {
  test("Registration.deletedAny is true when only holes were deleted (deleted-through position 0)", async () => {
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, tables);
    try {
      // The first row is kept, so the prefix never moves: the deleted-through position stays 0.
      const first = await world(PER_EVENT, { layer });
      await publish(layer, Kept, Gone, Gone);
      await first.binding.deliver();
      expect((await state(layer)).deletedThrough).toBe(0);
      const seen: boolean[] = [];
      const kind: HandlerKind = {
        name: "probe", owner: "test",
        check: () => {},
        start: async (_handler, registration) => { seen.push(registration.deletedAny); return registration.highest; },
        adopt: async () => {},
        stored: () => "probe",
      };
      const module: EventsModule = { handlers: { ...everything.handlers, probe: { late: { events: [Gone], run: () => {}, [HANDLER_KIND]: kind } as never } } };
      await world(PER_EVENT, { layer, module });
      expect(seen).toEqual([true]);
    } finally { await layer.close(); }
  });
});

describe("a database without the holes column", () => {
  test("reads no hole, a per-event keep refuses to start, naming mesh db push, and a later push is seen without a restart", async () => {
    const file = join(dir, "no-holes.db");
    const onDisk = sqlite({ file });
    await createSchema(onDisk, tables);
    await onDisk.close();
    const { Database } = await import("bun:sqlite");
    const db = new Database(file);
    db.run("ALTER TABLE mesh_outbox_state DROP COLUMN holes");
    db.close();
    const old = sqlite({ file });
    try {
      expect(Object.hasOwn(await old.readOutbox!(0, 10), "holes")).toBe(false);
      expect(Object.hasOwn(await state(old), "holes")).toBe(false);
      const frame = new AsyncLocalStorage();
      const binding = bindDomain(domain, old, { events: { bus: testBus(), keep: PER_EVENT, load: async () => everything } }, frame as never);
      const error = await binding.deliver().then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe("A per-event events.keep needs mesh_outbox_state.holes, which this database does not have: run mesh db push");
      // a single rule still delivers on it
      const plain = bindDomain(domain, old, { events: { bus: testBus(), keep: "until-delivered", load: async () => everything } }, new AsyncLocalStorage() as never);
      await plain.deliver();
      // the column added by a push from another connection: the same layer sees it, since a missing column is asked again
      const pusher = new Database(file);
      pusher.run("ALTER TABLE mesh_outbox_state ADD COLUMN holes text");
      pusher.close();
      expect((await old.readOutbox!(0, 10)).holes).toEqual({});
      expect((await state(old)).holes).toEqual({});
      await bindDomain(domain, old, { events: { bus: testBus(), keep: PER_EVENT, load: async () => everything } }, new AsyncLocalStorage() as never).deliver();
    } finally { await old.close(); }
  });
});
