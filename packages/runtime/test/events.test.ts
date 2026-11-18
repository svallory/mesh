import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CORE_TABLES, CORE_TABLE_NAMES, CursorAheadError, DECLARATION, EventUndeclaredError, EventsDeletedError, FrameworkError, MeshError, bindDomain, loadEvents,
  OUTBOX_STATE_TABLE, OUTBOX_TABLE, FAILURES_TABLE, HANDLER_PROGRESS_TABLE, SUBSCRIPTION_PROGRESS_TABLE, coreTablesFor, publishEvent, published, readEvents, rows,
  subscribe, Mesh, HANDLER_KIND, EventsConfigError, NO_FRAME, entity, mergeHandlers, retryFailed, runAction, declaredEvents, type EventRecord, type HandlerKind,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { notifyPublished, onPublished } from "../src/events.ts";
import type {
  DataLayer, DataOperations, Declaration, DelivererClaim, DeliveryOperations, EventsConfig, EventsModule, HandlerProgressRow, OutboxRow, SubscriptionProgressRow,
} from "@meshfw/runtime";

/** An event class shaped as `mesh build` generates one: a private brand, the declaration under DECLARATION, frozen instances. */
class InvoicePaid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<InvoicePaid> = {
    kind: "event",
    fqn: "billing.InvoicePaid",
    is: (value: unknown): value is InvoicePaid => typeof value === "object" && value !== null && #brand in value,
    dates: ["paidAt"],
  };
  readonly invoiceId: string;
  readonly paidAt: Date;
  constructor(fields: { invoiceId: string; paidAt: Date }) {
    if (!(fields.paidAt instanceof Date)) throw new Error("paidAt must be a date");
    this.invoiceId = fields.invoiceId;
    this.paidAt = fields.paidAt;
    Object.freeze(this);
  }
}
class InvoiceVoided {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<InvoiceVoided> = {
    kind: "event",
    fqn: "billing.InvoiceVoided",
    is: (value: unknown): value is InvoiceVoided => typeof value === "object" && value !== null && #brand in value,
  };
  readonly invoiceId: string;
  constructor(fields: { invoiceId: string }) { this.invoiceId = fields.invoiceId; Object.freeze(this); }
}
class PayInvoice {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<PayInvoice> = {
    kind: "command",
    fqn: "billing.PayInvoice",
    is: (value: unknown): value is PayInvoice => typeof value === "object" && value !== null && #brand in value,
  };
}

/**
 * An in-memory layer with the outbox operations: one transaction at a time, joined by nested calls, rolled back on a throw.
 * `state.settled` (undefined: `highest`) withholds the rows above it, as a server dialect does while an append is open;
 * `appended` gives the layer `onAppended`, whose listeners the test calls through `state.listeners`.
 */
function memoryLayer(options: { outbox?: boolean; appended?: boolean; delivery?: boolean } = {}) {
  const state = { rows: [] as OutboxRow[], deletedThrough: 0, highest: 0, settled: undefined as number | undefined, listeners: new Set<() => void>() };
  let open = false;
  const refuse = async (): Promise<never> => { throw new Error("not used by these tests"); };
  const ops: DataOperations = {
    insert: refuse, selectByKey: refuse, selectByKeyForUpdate: refuse, select: refuse, updateByKey: refuse, deleteByKey: refuse, max: refuse, count: refuse, rollup: refuse,
    ...(options.outbox === false ? {} : {
      appendEvent: async (row) => { const position = ++state.highest; state.rows.push({ ...row, position }); return position; },
      deleteOutboxThrough: async (position) => {
        const before = state.rows.length;
        state.rows = state.rows.filter((row) => row.position > position);
        state.deletedThrough = Math.max(state.deletedThrough, position);
        return before - state.rows.length;
      },
    }),
    ...(options.delivery ? memoryDelivery(state) : {}),
  };
  const layer: DataLayer = {
    ...(options.delivery ? { database: `memory #${Math.random()}` } : {}),
    refuseIfFailed: () => open,
    async transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T> {
      if (open) return run(ops);
      open = true;
      const saved = { rows: [...state.rows], deletedThrough: state.deletedThrough };
      try { return await run(ops); } catch (error) { state.rows = saved.rows; state.deletedThrough = saved.deletedThrough; throw error; } finally { open = false; }
    },
    close: async () => {},
    ...(options.outbox === false ? {} : {
      readOutbox: async (after: number, limit: number) => {
        if (open) throw new FrameworkError("The outbox cannot be read inside a transaction: a transaction's own events come from published() (from #mesh)");
        const settled = state.settled ?? state.highest;
        return { rows: state.rows.filter((row) => row.position > after && row.position <= settled).slice(0, limit), deletedThrough: state.deletedThrough, highest: state.highest, settled };
      },
    }),
    ...(options.appended ? { onAppended: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; } } : {}),
  };
  return { layer, state, ops };
}

/**
 * The delivery operations (`DeliveryOperations`) over `memoryLayer`'s rows, kept in memory and never rolled back: enough
 * for `deliver()` to claim, register its handlers and run them through the real deliverer.
 */
function memoryDelivery(outbox: { rows: OutboxRow[]; deletedThrough: number; highest: number }): DeliveryOperations {
  let generation = 0;
  let claim: DelivererClaim | null = null;
  const handlers = new Map<string, HandlerProgressRow>();
  const subscriptions = new Map<string, SubscriptionProgressRow>();
  const holds = (runId: string, held: number) => claim?.runId === runId && claim.generation === held;
  return {
    readDeliveryState: async () => ({ deletedThrough: outbox.deletedThrough, highest: outbox.highest, generation, claim, now: new Date() }),
    writeClaim: async (next) => {
      generation = next.generation;
      claim = { runId: next.runId, generation: next.generation, renewedAt: new Date(), host: next.host ?? null, pid: next.pid, startedAt: next.startedAt };
    },
    renewClaim: async (runId, held) => { if (!holds(runId, held)) return false; claim = { ...claim!, renewedAt: new Date() }; return true; },
    releaseClaim: async (runId, held) => { if (!holds(runId, held)) return false; claim = null; return true; },
    readHandlerProgress: async () => [...handlers.values()],
    writeHandlerProgress: async (row) => { handlers.set(row.name, row); },
    deleteHandlerProgress: async (name) => handlers.delete(name),
    readSubscriptionProgress: async () => [...subscriptions.values()],
    writeSubscriptionProgress: async (row) => { subscriptions.set(row.name, { ...row, seenAt: row.seenAt ?? new Date() }); },
    deleteSubscriptionProgress: async (name) => subscriptions.delete(name),
    firstOutboxRow: async (after, before, listed, declared) =>
      outbox.rows.find((row) => row.position > after && row.position < before && (listed.includes(row.name) || !declared.includes(row.name)))?.position ?? null,
  };
}

const at = new Date("2026-10-18T12:00:00.000Z");
const clock = () => new Date(at.getTime());
const target = { entity: "billing.Invoice", action: "pay", key: { id: "i1" }, at: "billing/invoice.mesh.mx:22:17" };
const paid = (invoiceId = "i1") => new InvoicePaid({ invoiceId, paidAt: new Date("2026-10-01T00:00:00.000Z") });

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try { await run(); } catch (error) { return error as Error; }
  throw new Error("expected a rejection");
}

describe("the run-time errors of the outbox", () => {
  test("each carries its code, its fields and retryable false", () => {
    const deleted = new EventsDeletedError(3, 8);
    expect([deleted.code, deleted.after, deleted.oldestKept, deleted.retryable]).toEqual(["MESH_EVENTS_DELETED", 3, 8, false]);
    expect(deleted.message).toContain("the oldest kept position is 8");
    const ahead = new CursorAheadError(9, 4);
    expect([ahead.code, ahead.after, ahead.highest, ahead.retryable]).toEqual(["MESH_CURSOR_AHEAD", 9, 4, false]);
    const undeclared = new EventUndeclaredError("billing.Old", 5);
    expect([undeclared.code, undeclared.eventName, undeclared.position, undeclared.retryable]).toEqual(["MESH_EVENT_UNDECLARED", "billing.Old", 5, false]);
    for (const error of [deleted, ahead, undeclared]) expect(error).toBeInstanceOf(MeshError);
  });
});

describe("rows", () => {
  test("reads the page, and checks the cursor against the same read", async () => {
    const { layer, state } = memoryLayer();
    await layer.transaction(async (tx) => { for (const id of ["a", "b", "c", "d"]) await publishEvent(tx, undefined, target, paid(id), {}, clock); });
    expect((await rows(layer, 0, 2)).rows.map((row) => row.position)).toEqual([1, 2]);
    await layer.transaction(async (tx) => tx.deleteOutboxThrough!(2));
    expect(state.deletedThrough).toBe(2);
    // A cursor at the deleted-through position misses nothing.
    expect((await rows(layer, 2, 10)).rows.map((row) => row.position)).toEqual([3, 4]);
    const deleted = await rejection(() => rows(layer, 1, 10));
    expect(deleted).toBeInstanceOf(EventsDeletedError);
    expect((deleted as EventsDeletedError).oldestKept).toBe(3);
    expect((await rows(layer, 4, 10)).rows).toEqual([]);
    const ahead = await rejection(() => rows(layer, 5, 10));
    expect(ahead).toBeInstanceOf(CursorAheadError);
    expect((ahead as CursorAheadError).highest).toBe(4);
  });

  test("refuses a bad cursor or limit, and a layer without readOutbox", async () => {
    const { layer } = memoryLayer();
    for (const [after, limit] of [[-1, 1], [1.5, 1], [Number.NaN, 1], [0, 0], [0, 2.5], ["0" as unknown as number, 1]] as const)
      expect(await rejection(() => rows(layer, after, limit))).toBeInstanceOf(FrameworkError);
    const bare = memoryLayer({ outbox: false }).layer;
    expect((await rejection(() => rows(bare, 0, 1))).message).toContain("has no readOutbox");
  });
});

describe("publishEvent", () => {
  test("appends the record in the transaction: a uuidv7 id, the clock's instant, the key, a JSON payload and {} metadata", async () => {
    const { layer, state } = memoryLayer();
    const record = await layer.transaction((tx) => publishEvent(tx, undefined, target, paid(), { actor: { id: "u" } }, clock));
    expect(record.position).toBe(1);
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(record.occurredAt).toEqual(at);
    expect(record.payload).toBeInstanceOf(InvoicePaid);
    expect([record.name, record.entity, record.action, record.causedBy]).toEqual(["billing.InvoicePaid", "billing.Invoice", "pay", null]);
    expect(record.metadata).toEqual({});
    expect(Object.isFrozen(record)).toBe(true);
    const [row] = state.rows;
    expect(row!.payload).toEqual({ invoiceId: "i1", paidAt: "2026-10-01T00:00:00.000Z" });
    expect(row!.key).toEqual({ id: "i1" });
    expect(row!.id).toBe(record.id);
  });

  test.each([
    ["null", null, "returned null"],
    ["undefined", undefined, "returned undefined"],
    ["a plain object shaped like the event", { invoiceId: "i1", paidAt: new Date() }, "returned a plain object"],
    ["a command", new PayInvoice(), "an instance of the command billing.PayInvoice"],
    ["an object posing as the event", Object.assign(Object.create(InvoicePaid.prototype), { invoiceId: "x" }), "not an instance of the event billing.InvoicePaid"],
    ["an instance of another class", new Date(), "an instance of Date, not of a declared event"],
    ["a string", "billing.InvoicePaid", "returned a string"],
  ])("refuses %s, naming the entity, the action and the line, and appends nothing", async (_label, value, wording) => {
    const { layer, state } = memoryLayer();
    const error = await rejection(() => layer.transaction((tx) => publishEvent(tx, undefined, target, value, {}, clock)));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toContain("The publish step of billing.Invoice#pay (billing/invoice.mesh.mx:22:17) must return an instance of a declared event");
    expect(error.message).toContain(wording);
    expect(state.rows).toEqual([]);
  });

  test("refuses a data layer without appendEvent", async () => {
    const { layer } = memoryLayer({ outbox: false });
    const error = await rejection(() => layer.transaction((tx) => publishEvent(tx, undefined, target, paid(), {}, clock)));
    expect(error.message).toContain("the data layer has no appendEvent");
  });

  test("stores what the events module's metadata returns, given the record so far and the call's context; the module loads once", async () => {
    const { layer, state } = memoryLayer();
    let loads = 0;
    const seen: unknown[] = [];
    const events: EventsConfig = {
      load: async () => {
        loads++;
        return { metadata: ({ event, context }: { event: { name: string; payload: object; position?: unknown }; context: { requestId?: string } }) => {
          seen.push([event.name, event.payload instanceof InvoicePaid, "position" in event]);
          return { requestId: context.requestId ?? null, at: new Date(0) };
        } } as never;
      },
    };
    const first = await layer.transaction((tx) => publishEvent(tx, events, target, paid(), { requestId: "r-1" }, clock));
    await layer.transaction((tx) => publishEvent(tx, events, target, paid(), undefined, clock));
    expect(loads).toBe(1);
    expect(seen).toEqual([["billing.InvoicePaid", true, false], ["billing.InvoicePaid", true, false]]);
    // Stored as JSON: a date becomes its text.
    expect(first.metadata).toEqual({ requestId: "r-1", at: "1970-01-01T00:00:00.000Z" });
    expect(Object.isFrozen(first.metadata)).toBe(true);
    expect(state.rows.map((row) => row.metadata)).toEqual([{ requestId: "r-1", at: "1970-01-01T00:00:00.000Z" }, { requestId: null, at: "1970-01-01T00:00:00.000Z" }]);
  });

  test.each([["null", null], ["an array", []], ["a number", 3], ["undefined", undefined]])("a metadata function that returns %s rolls back", async (_label, value) => {
    const { layer, state } = memoryLayer();
    const events: EventsConfig = { load: async () => ({ metadata: () => value as never }) };
    const error = await rejection(() => layer.transaction((tx) => publishEvent(tx, events, target, paid(), {}, clock)));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toContain("metadata function returned");
    expect(state.rows).toEqual([]);
  });

  test("a metadata function that throws rolls back with its own error", async () => {
    const { layer, state } = memoryLayer();
    const boom = new Error("boom");
    const events: EventsConfig = { load: async () => ({ metadata: () => { throw boom; } }) };
    expect(await rejection(() => layer.transaction((tx) => publishEvent(tx, events, target, paid(), {}, clock)))).toBe(boom);
    expect(state.rows).toEqual([]);
  });
});

describe("loadEvents", () => {
  test("{} without a configuration or a load", async () => {
    expect(await loadEvents(undefined)).toEqual({});
    expect(await loadEvents({ keep: "all" })).toEqual({});
  });

  test("a load that rejects is a FrameworkError, and is tried again on the next call", async () => {
    let calls = 0;
    const config: EventsConfig = { load: async () => { if (++calls === 1) throw new Error("no such file"); return {}; } };
    const error = await rejection(() => loadEvents(config));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toBe("events.load() rejected: no such file");
    expect(await loadEvents(config)).toEqual({});
    expect(calls).toBe(2);
  });

  test("refuses a load that is no function, a module that is no object and a metadata that is no function", async () => {
    expect((await rejection(() => loadEvents({ load: "./src/events.ts" as never }))).message).toContain("events.load must be a function");
    expect((await rejection(() => loadEvents({ load: async () => null as never }))).message).toContain("must resolve with the events module, and resolved with null");
    expect((await rejection(() => loadEvents({ load: async () => ({ metadata: { a: 1 } }) as never }))).message).toContain("exports metadata as a plain object");
  });
});

describe("loadEvents and the kinds of handlers (ADR-0094)", () => {
  const kind = (name: string, owner = "@meshfw/test-kind"): HandlerKind => ({ name, owner, check() {}, start: async (_h, at) => at.highest, adopt: async () => {}, stored: () => name });
  const MODEL = kind("model");
  const plain = () => Mesh.handler({ events: [InvoicePaid], run: () => undefined });
  const carrying = (k: unknown) => ({ ...plain(), [HANDLER_KIND]: k });
  const load = (handlers: object) => loadEvents({ bus: testBus(), load: async () => ({ handlers }) as never });
  const message = async (handlers: object) => {
    const error = await rejection(() => load(handlers));
    expect(error).toBeInstanceOf(FrameworkError);
    return error.message;
  };

  test("a contributed kind's handlers load under its own key, beside process and listen, empty core groups included", async () => {
    const handlers = { process: {}, listen: {}, model: { totals: carrying(MODEL), counts: carrying(MODEL) } };
    expect((await load(handlers)).handlers).toBe(handlers as never);
  });

  test("a handler with no kind under a key that is not a core kind is refused, naming the key and the handler", async () => {
    expect(await message({ projects: { totals: plain() } })).toBe('The events module\'s handlers has the kind "projects", and its handler "totals" is not one an extension made for that kind: the kinds are process, listen and those an extension\'s handlers carry, such as project from @meshfw/event-sourcing');
    expect(await message({ model: { totals: carrying(MODEL), other: plain() } })).toContain('its handler "other" is not one an extension made');
  });

  test("an empty group, or an undefined one, under a key no handler's kind names is refused, the contributed kind's own key included", async () => {
    for (const handlers of [{ proces: {} }, { proces: undefined }, { model: {} }, { process: {}, model: {} }])
      expect(await message(handlers)).toBe('The events module\'s handlers has the kind ' + JSON.stringify(Object.keys(handlers).at(-1)) + ', with no handler under it and none of that kind anywhere in the module: the kinds are process, listen and those an extension\'s handlers carry. Check the spelling, or remove the empty group');
  });

  test("a handler listed under another kind's key is refused, naming where it belongs", async () => {
    expect(await message({ process: { totals: carrying(MODEL) } })).toBe("The events module lists the model handler \"totals\" under handlers.process: list it under handlers.model");
    expect(await message({ listen: { totals: carrying(MODEL) } })).toContain("under handlers.listen: list it under handlers.model");
    expect(await message({ other: { totals: carrying(MODEL) } })).toContain("under handlers.other: list it under handlers.model");
  });

  test("a kind named like a core kind, or not one lowercase word, is refused naming the handler, the name and the owner", async () => {
    expect(await message({ listen: { totals: carrying(kind("listen", "@meshfw/x")) } })).toBe('The handler "totals" carries a kind named "listen" from @meshfw/x: an extension\'s kind cannot take the name of a core kind, and its name is one lowercase word');
    for (const name of ["Model", "read-model", "model2", ""]) expect(await message({ [name]: { totals: carrying(kind(name)) } })).toContain(`carries a kind named ${JSON.stringify(name)}`);
  });

  test("a kind that is not a handler kind object is refused", async () => {
    for (const bad of [null, "model", { name: "model", owner: "x" }, { ...MODEL, owner: 1 }])
      expect(await message({ model: { totals: carrying(bad) } })).toContain('The handler "totals" carries ');
  });

  test("handlers of a contributed kind count as handlers for the bus check", async () => {
    const error = await rejection(() => loadEvents({ load: async () => ({ handlers: { model: { totals: carrying(MODEL) } } }) as never }));
    expect(error).toBeInstanceOf(EventsConfigError);
  });
});

describe("published() and readEvents through a binding", () => {
  const domain = { InvoicePaid, InvoiceVoided, notAClass: 1 };
  const setup = () => {
    const memory = memoryLayer();
    const frame = new AsyncLocalStorage<unknown>();
    const binding = bindDomain(domain, memory.layer, {}, frame);
    const publish = (event: object, key = { id: "i1" }, entity = "billing.Invoice") =>
      memory.layer.transaction((tx) => publishEvent(tx, undefined, { ...target, key, entity }, event, {}, clock));
    return { ...memory, frame, binding, publish };
  };

  test("declaredEvents lists the domain's event FQNs, sorted and frozen; a value bind() did not make is refused", () => {
    const { binding } = setup();
    expect(declaredEvents(binding)).toEqual(["billing.InvoicePaid", "billing.InvoiceVoided"]);
    expect(Object.isFrozen(declaredEvents(binding))).toBe(true);
    expect(declaredEvents(bindDomain({}, memoryLayer().layer, {}, new AsyncLocalStorage<unknown>()))).toEqual([]);
    expect(() => declaredEvents({} as never)).toThrow(new FrameworkError("Not a binding made by bind()"));
  });

  test("published() returns the transaction's own events in order, scoped to it, and throws outside one", async () => {
    const { frame, binding, publish } = setup();
    expect(() => published(frame)).toThrow("published() was called outside a transaction");
    const seen = await binding.transaction(async () => {
      expect(published(frame)).toEqual([]);
      await publish(paid("a"));
      await publish(new InvoiceVoided({ invoiceId: "b" }));
      const list = published(frame);
      expect(Object.isFrozen(list)).toBe(true);
      return list.map((record) => [record.position, record.name]);
    });
    expect(seen).toEqual([[1, "billing.InvoicePaid"], [2, "billing.InvoiceVoided"]]);
    await binding.transaction(async () => { expect(published(frame)).toEqual([]); });
    await expect(binding.run(async () => published(frame))).rejects.toThrow("outside a transaction");
  });

  test("a rolled-back transaction's events are gone, and the next transaction starts empty", async () => {
    const { frame, binding, publish, state } = setup();
    await expect(binding.transaction(async () => { await publish(paid()); throw new Error("roll back"); })).rejects.toThrow("roll back");
    expect(state.rows).toEqual([]);
    await binding.transaction(async () => { expect(published(frame)).toEqual([]); });
  });

  test("readEvents reports highest on empty, written, limited, filtered and deleted logs", async () => {
    const { frame, binding, publish, layer } = setup();
    const read = (query = {}) => binding.run(() => readEvents(frame, undefined, query));
    expect(await read()).toEqual({ events: [], cursor: 0, highest: 0 });
    await publish(paid("a"));
    await publish(paid("b"));
    await publish(paid("c"));
    expect((await read()).highest).toBe(3);
    const first = await read({ limit: 1 });
    expect([first.cursor, first.highest]).toEqual([1, 3]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(await read({ names: ["billing.InvoiceVoided"], limit: 1 })).toEqual({ events: [], cursor: 1, highest: 3 });
    expect(await read({ after: 3 })).toEqual({ events: [], cursor: 3, highest: 3 });
    await layer.transaction(async (tx) => { await tx.deleteOutboxThrough!(3); });
    expect(await read({ after: 3 })).toEqual({ events: [], cursor: 3, highest: 3 });
  });

  test("readEvents' cursor on a short page is the settled position when no row reaches it, and the last row on a full page", async () => {
    const { frame, binding, publish, state } = setup();
    const read = (query = {}) => binding.run(() => readEvents(frame, undefined, query));
    await publish(paid("a"));
    await publish(paid("b"));
    await publish(paid("c"));
    // A rolled-back append at the tail: position 4 was taken and will never commit, so 4 is settled with no row.
    state.highest = 4;
    expect(await read()).toMatchObject({ cursor: 4, highest: 4 });
    expect((await read()).events.map((record) => record.position)).toEqual([1, 2, 3]);
    expect(await read({ after: 4 })).toEqual({ events: [], cursor: 4, highest: 4 });
    // A full page ends at its last row, never at settled.
    expect(await read({ limit: 2 })).toMatchObject({ cursor: 2, highest: 4 });
    expect(await read({ limit: 3 })).toMatchObject({ cursor: 3, highest: 4 });
    // An append still open at 2 withholds 2 and 3: the cursor stops at settled, below highest.
    state.settled = 1;
    expect(await read()).toMatchObject({ cursor: 1, highest: 4 });
    expect((await read()).events.map((record) => record.position)).toEqual([1]);
    // A cursor already above settled stays where it is.
    expect(await read({ after: 3 })).toEqual({ events: [], cursor: 3, highest: 4 });
  });

  test("readEvents rebuilds each event as an instance of its class, its dates revived, and moves the cursor over filtered rows", async () => {
    const { frame, binding, publish } = setup();
    await binding.transaction(async () => {
      await publish(paid("a"), { id: "a" });
      await publish(new InvoiceVoided({ invoiceId: "b" }), { id: "b" });
      await publish(paid("c"), { id: "c" }, "billing.Other");
    });
    const all = await binding.run(() => readEvents(frame, undefined, {}));
    expect(all.cursor).toBe(3);
    expect(all.events.map((record) => record.position)).toEqual([1, 2, 3]);
    const first = all.events[0]!;
    expect(first.payload).toBeInstanceOf(InvoicePaid);
    expect((first.payload as InvoicePaid).paidAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(first.occurredAt).toEqual(at);
    expect(Object.isFrozen(first)).toBe(true);
    const voided = await binding.run(() => readEvents(frame, undefined, { names: ["billing.InvoiceVoided"] }));
    expect([voided.events.map((record) => record.position), voided.cursor]).toEqual([[2], 3]);
    const byEntity = await binding.run(() => readEvents(frame, undefined, { entity: "billing.Other" }));
    expect(byEntity.events.map((record) => record.position)).toEqual([3]);
    const byKey = await binding.run(() => readEvents(frame, undefined, { key: { id: "a" } }));
    expect(byKey.events.map((record) => record.position)).toEqual([1]);
    const paged = await binding.run(() => readEvents(frame, undefined, { after: 1, limit: 1, names: ["billing.InvoicePaid"] }));
    expect([paged.events, paged.cursor]).toEqual([[], 2]);
    const empty = await binding.run(() => readEvents(frame, undefined, { after: 3 }));
    expect([empty.events, empty.cursor]).toEqual([[], 3]);
  });

  test("readEvents runs on the connected binding outside run, and is refused when not connected or inside a transaction", async () => {
    const { frame, binding, publish } = setup();
    await publish(paid());
    expect((await readEvents(frame, binding)).events).toHaveLength(1);
    expect((await rejection(() => readEvents(frame, undefined))).message).toContain("readEvents was called while not connected");
    const inside = await rejection(() => binding.transaction(() => readEvents(frame, undefined)));
    expect(inside).toBeInstanceOf(FrameworkError);
    expect(inside.message).toContain("a transaction's own events come from published()");
  });

  test("a row naming no declared event is MESH_EVENT_UNDECLARED, filtered or not; a name that is not declared is refused", async () => {
    const { frame, binding, state, publish } = setup();
    await publish(paid());
    state.rows.push({ ...state.rows[0]!, position: 2, name: "billing.Renamed" });
    state.highest = 2;
    for (const query of [{}, { names: ["billing.InvoicePaid"] }]) {
      const error = await rejection(() => binding.run(() => readEvents(frame, undefined, query)));
      expect(error).toBeInstanceOf(EventUndeclaredError);
      expect([(error as EventUndeclaredError).eventName, (error as EventUndeclaredError).position]).toEqual(["billing.Renamed", 2]);
    }
    expect((await rejection(() => binding.run(() => readEvents(frame, undefined, { names: ["billing.Nope"] })))).message).toContain("not a declared event");
  });

  test("a stored payload its class no longer accepts is a FrameworkError naming the position", async () => {
    const { frame, binding, state, publish } = setup();
    await publish(paid());
    state.rows[0] = { ...state.rows[0]!, payload: { invoiceId: "i1" } };
    expect((await rejection(() => binding.run(() => readEvents(frame, undefined))))).toBeInstanceOf(FrameworkError);
  });

  test("two event classes with one FQN cannot be bound", () => {
    class Twin { static readonly [DECLARATION] = { ...InvoicePaid[DECLARATION] }; }
    expect(() => bindDomain({ InvoicePaid, Twin }, memoryLayer().layer, {}, new AsyncLocalStorage())).toThrow("Two event classes in the domain have the FQN billing.InvoicePaid");
  });

  test("bind refuses a data layer without the outbox when the domain declares an event, and accepts one without events", () => {
    const { readOutbox: _readOutbox, ...noOutbox } = memoryLayer().layer;
    expect(() => bindDomain({ InvoiceVoided, InvoicePaid }, noOutbox as DataLayer, {}, new AsyncLocalStorage())).toThrow(
      "The project declares the event billing.InvoicePaid, and the data layer has no outbox (no readOutbox): a project that declares an event needs a data adapter with the outbox operations appendEvent, readOutbox and deleteOutboxThrough",
    );
    expect(() => bindDomain({ notAClass: 1 }, noOutbox as DataLayer, {}, new AsyncLocalStorage())).not.toThrow();
  });
});

/** `billing.InvoicePaid` after its declaration moved to `finance` (events.renamed): the same fields, a new FQN. */
class FinancePaid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<FinancePaid> = {
    kind: "event",
    fqn: "finance.InvoicePaid",
    is: (value: unknown): value is FinancePaid => typeof value === "object" && value !== null && #brand in value,
    dates: ["paidAt"],
  };
  readonly invoiceId: string;
  readonly paidAt: Date;
  constructor(fields: { invoiceId: string; paidAt: Date }) {
    if (!(fields.paidAt instanceof Date)) throw new Error("paidAt must be a date");
    this.invoiceId = fields.invoiceId;
    this.paidAt = fields.paidAt;
    Object.freeze(this);
  }
}

describe("the rename map (events.renamed) at bind and in readEvents", () => {
  const moved = { FinancePaid, InvoiceVoided };
  const renamed = { "billing.InvoicePaid": "finance.InvoicePaid" };
  /** Rows 1 and 3 stored as billing.InvoicePaid by the build before the move, row 2 a voided, row 4 the moved event. */
  const setup = async (events?: EventsConfig) => {
    const memory = memoryLayer();
    const publish = (event: object) => memory.layer.transaction((tx) => publishEvent(tx, undefined, target, event, {}, clock));
    await publish(paid("a"));
    await publish(new InvoiceVoided({ invoiceId: "b" }));
    await publish(paid("c"));
    await publish(new FinancePaid({ invoiceId: "d", paidAt: new Date("2026-10-02T00:00:00.000Z") }));
    const frame = new AsyncLocalStorage<unknown>();
    const binding = bindDomain(moved, memory.layer, events === undefined ? {} : { events }, frame);
    const read = (query = {}) => binding.run(() => readEvents(frame, undefined, query));
    return { ...memory, binding, read };
  };

  test("readEvents from 0 reads old and new rows as the declared event, instances of its class; the stored rows keep their names", async () => {
    const { read, state } = await setup({ renamed });
    const page = await read();
    expect(page.events.map((record) => [record.position, record.name])).toEqual([
      [1, "finance.InvoicePaid"], [2, "billing.InvoiceVoided"], [3, "finance.InvoicePaid"], [4, "finance.InvoicePaid"],
    ]);
    expect(page.events[0]!.payload).toBeInstanceOf(FinancePaid);
    expect((page.events[0]!.payload as FinancePaid).paidAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(Object.isFrozen(page.events[0])).toBe(true);
    expect(state.rows.map((row) => row.name)).toEqual(["billing.InvoicePaid", "billing.InvoiceVoided", "billing.InvoicePaid", "finance.InvoicePaid"]);
  });

  test("names lists the new FQN and takes the old rows; the old FQN is refused, saying what it was renamed to; a shortened name is refused", async () => {
    const { read } = await setup({ renamed });
    expect((await read({ names: ["finance.InvoicePaid"] })).events.map((record) => record.position)).toEqual([1, 3, 4]);
    const old = await rejection(() => read({ names: ["billing.InvoicePaid"] }));
    expect(old.message).toContain("readEvents: names lists \"billing.InvoicePaid\", which is not a declared event; it was renamed to finance.InvoicePaid (events.renamed)");
    expect((await rejection(() => read({ names: ["InvoicePaid"] }))).message).toContain("readEvents: names lists \"InvoicePaid\", which is not a declared event; the project declares");
  });

  test("a shortened value and an empty map work; without the map the old row is still MESH_EVENT_UNDECLARED", async () => {
    expect((await (await setup({ renamed: { "billing.InvoicePaid": "InvoicePaid" } })).read()).events).toHaveLength(4);
    const empty = await rejection(async () => (await setup({ renamed: {} })).read());
    expect(empty).toBeInstanceOf(EventUndeclaredError);
    const none = await rejection(async () => (await setup()).read());
    expect([(none as EventUndeclaredError).eventName, (none as EventUndeclaredError).position]).toEqual(["billing.InvoicePaid", 1]);
  });

  test("an old payload the new class refuses is the FrameworkError naming the position and the new name", async () => {
    const { read, state } = await setup({ renamed });
    state.rows[0] = { ...state.rows[0]!, payload: { invoiceId: "a" } };
    const error = await rejection(() => read());
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toContain("The outbox row at position 1 holds a finance.InvoicePaid that its class no longer accepts");
  });

  test("bind refuses a bad map with MESH_EVENTS_CONFIG; a domain with no event is not checked", () => {
    const layer = memoryLayer().layer;
    const bindWith = (map: unknown, domain: object = moved) => () => bindDomain(domain, layer, { events: { renamed: map as Record<string, string> } }, new AsyncLocalStorage());
    for (const [map, message] of [
      [{ "finance.InvoicePaid": "billing.InvoiceVoided" }, "`events.renamed` maps \"finance.InvoicePaid\", which is a declared event"],
      [{ "billing.InvoicePaid": "finance.InvoicePayed" }, "which is no declared event; the project declares billing.InvoiceVoided, finance.InvoicePaid"],
      [{ "billing.InvoicePaid": 1 }, "to a number"],
      [[], "`events.renamed` must be an object"],
    ] as const) {
      let thrown: unknown;
      try { bindWith(map)(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(EventsConfigError);
      expect((thrown as EventsConfigError).code).toBe("MESH_EVENTS_CONFIG");
      expect((thrown as Error).message).toContain(message);
    }
    expect(bindWith({ "billing.InvoicePaid": "finance.InvoicePayed" }, { notAClass: 1 })).not.toThrow();
  });
});

describe("the upcast point (EventsModule.upcast, ADR-0094)", () => {
  /** InvoicePaid as first published: `{ invoice, paid }`, its date as text under another name. */
  const v1 = { invoice: "a", paid: "2026-09-01T00:00:00.000Z" };
  const today = (payload: Readonly<Record<string, unknown>>) =>
    "invoiceId" in payload ? payload : { invoiceId: payload.invoice, paidAt: payload.paid };
  /** Row 1 stored in the old shape, row 2 a voided, row 3 in today's shape; `module` is what events.load resolves with. */
  const setup = async (module: EventsModule | (() => Promise<EventsModule>), options: { domain?: object; renamed?: Record<string, string> } = {}) => {
    const memory = memoryLayer();
    const publish = (event: object) => memory.layer.transaction((tx) => publishEvent(tx, undefined, target, event, {}, clock));
    await publish(paid("x"));
    memory.state.rows[0] = { ...memory.state.rows[0]!, payload: v1 };
    await publish(new InvoiceVoided({ invoiceId: "b" }));
    await publish(paid("c"));
    const frame = new AsyncLocalStorage<unknown>();
    const load = typeof module === "function" ? module : async () => module;
    const events: EventsConfig = { load, ...(options.renamed ? { renamed: options.renamed } : {}) };
    const binding = bindDomain(options.domain ?? { InvoicePaid, InvoiceVoided }, memory.layer, { events }, frame);
    const read = (query = {}) => binding.run(() => readEvents(frame, undefined, query));
    return { ...memory, frame, binding, read };
  };

  test("loadEvents refuses an upcast that is not a function, and keeps one that is", async () => {
    for (const [upcast, what] of [[{ a: 1 }, "a plain object"], ["today", "a string"], [null, "null"]] as const) {
      const error = await rejection(() => loadEvents({ load: async () => ({ upcast }) as never }));
      expect(error).toBeInstanceOf(FrameworkError);
      expect(error.message).toBe(`The events module exports upcast as ${what}: it must be a function (stored) => payload, which turns a stored row's payload into its event's current fields`);
    }
    const upcast = (row: OutboxRow) => row.payload;
    expect((await loadEvents({ load: async () => ({ upcast }) })).upcast).toBe(upcast);
  });

  test("readEvents hands every row to upcast before its dates are revived and its class is constructed; the stored rows are untouched", async () => {
    const seen: [number, string][] = [];
    const { read, state } = await setup({ upcast: (row: OutboxRow) => { seen.push([row.position, row.name]); return row.name === "billing.InvoicePaid" ? today(row.payload as Record<string, unknown>) : row.payload; } });
    const page = await read();
    expect(seen).toEqual([[1, "billing.InvoicePaid"], [2, "billing.InvoiceVoided"], [3, "billing.InvoicePaid"]]);
    const first = page.events[0]!.payload as InvoicePaid;
    expect(first).toBeInstanceOf(InvoicePaid);
    expect([first.invoiceId, first.paidAt]).toEqual(["a", new Date("2026-09-01T00:00:00.000Z")]);
    // A payload already in today's shape passes through, its date revived as before.
    expect((page.events[2]!.payload as InvoicePaid).paidAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(page.events[1]!.payload).toBeInstanceOf(InvoiceVoided);
    expect(state.rows[0]!.payload).toEqual(v1);
  });

  test("published() is not upcast: a transaction's own events are already instances", async () => {
    let calls = 0;
    const { frame, binding, layer } = await setup({ upcast: (row: OutboxRow) => { calls++; return row.payload; } });
    const own = await binding.transaction(async () => {
      await layer.transaction((tx) => publishEvent(tx, undefined, target, paid("d"), {}, clock));
      return published(frame);
    });
    expect(own.map((record) => (record.payload as InvoicePaid).invoiceId)).toEqual(["d"]);
    expect(calls).toBe(0);
  });

  test("an upcast that throws is a FrameworkError naming the event and the position, the throw as its cause", async () => {
    const thrown = new Error("no invoice field");
    const { read } = await setup({ upcast: () => { throw thrown; } });
    const error = await rejection(() => read());
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toBe("The events module's upcast threw on the billing.InvoicePaid at position 1: no invoice field");
    expect(error.cause).toBe(thrown);
    expect((error as FrameworkError).retryable).toBe(false);
  });

  test("an upcast that returns no object, or a promise, is a FrameworkError naming what it returned", async () => {
    for (const [value, what] of [[7, "a number"], [null, "null"], [undefined, "undefined"], [["a"], "an array"], ["{}", "a string"]] as const) {
      const { read } = await setup({ upcast: () => value });
      expect((await rejection(() => read())).message).toBe(`The events module's upcast returned ${what} for the billing.InvoicePaid at position 1: it must return the event's fields, an object`);
    }
    const { read } = await setup({ upcast: async (row: OutboxRow) => row.payload });
    expect((await rejection(() => read())).message).toBe("The events module's upcast returned a promise for the billing.InvoicePaid at position 1: it must return the event's fields, an object, without awaiting");
  });

  test("an async upcast that rejects is refused as a promise and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", listen);
    try {
      const { read } = await setup({ upcast: async () => { throw new Error("boom"); } });
      expect((await rejection(() => read())).message).toBe("The events module's upcast returned a promise for the billing.InvoicePaid at position 1: it must return the event's fields, an object, without awaiting");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", listen);
    }
    expect(unhandled).toEqual([]);
  });

  test("a payload its class refuses points to upcast: to export one when there is none, to its step when there is", async () => {
    const without = await rejection(async () => (await setup({})).read());
    expect(without).toBeInstanceOf(FrameworkError);
    expect(without.message).toStartWith("The outbox row at position 1 holds a billing.InvoicePaid that its class no longer accepts (its fields changed since it was published): paidAt must be a date. ");
    expect(without.message).toEndWith("Export upcast from the events module to turn old payloads into today's fields (upcasters() of @meshfw/event-sourcing)");
    const unchanged = await rejection(async () => (await setup({ upcast: (row: OutboxRow) => row.payload })).read());
    expect(unchanged.message).toEndWith("The events module's upcast left it in a shape the class refuses: give billing.InvoicePaid a step that turns this payload into today's fields");
  });

  test("a row whose stored name matches no declared event stays MESH_EVENT_UNDECLARED, and upcast never sees it", async () => {
    const seen: string[] = [];
    const { read, state } = await setup({ upcast: (row: OutboxRow) => { seen.push(row.name); return today(row.payload as Record<string, unknown>); } });
    state.rows[1] = { ...state.rows[1]!, name: "billing.InvoiceCancelled" };
    const error = await rejection(() => read());
    expect(error).toBeInstanceOf(EventUndeclaredError);
    expect([(error as EventUndeclaredError).eventName, (error as EventUndeclaredError).position]).toEqual(["billing.InvoiceCancelled", 2]);
    expect(seen).toEqual(["billing.InvoicePaid"]);
  });

  test("the rename map runs first: upcast sees a row stored under a former FQN under the event's current one", async () => {
    const seen: string[] = [];
    const upcast = (row: OutboxRow) => { seen.push(row.name); return row.name === "finance.InvoicePaid" ? today(row.payload as Record<string, unknown>) : row.payload; };
    const { read } = await setup({ upcast }, { domain: { FinancePaid, InvoiceVoided }, renamed: { "billing.InvoicePaid": "finance.InvoicePaid" } });
    const page = await read();
    expect(seen).toEqual(["finance.InvoicePaid", "billing.InvoiceVoided", "finance.InvoicePaid"]);
    expect(page.events[0]!.payload).toBeInstanceOf(FinancePaid);
    expect((page.events[0]!.payload as FinancePaid).invoiceId).toBe("a");
  });

  test("readEvents loads the events module: one without upcast reads as before, and a load that rejects fails the read", async () => {
    const memory = memoryLayer();
    await memory.layer.transaction((tx) => publishEvent(tx, undefined, target, paid("a"), {}, clock));
    const frame = new AsyncLocalStorage<unknown>();
    const plain = bindDomain({ InvoicePaid }, memory.layer, {}, frame);
    const expected = await plain.run(() => readEvents(frame, undefined));
    let loaded = 0;
    const withModule = bindDomain({ InvoicePaid }, memory.layer, { events: { load: async () => { loaded++; return { metadata: () => ({}) }; } } }, frame);
    expect(await withModule.run(() => readEvents(frame, undefined))).toEqual(expected);
    await withModule.run(() => readEvents(frame, undefined));
    expect(loaded).toBe(1);
    const failing = bindDomain({ InvoicePaid }, memory.layer, { events: { load: async () => { throw new Error("no such file"); } } }, frame);
    const error = await rejection(() => failing.run(() => readEvents(frame, undefined)));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toBe("events.load() rejected: no such file");
  });
});

describe("onPublished", () => {
  test("on a layer with onAppended, a listener is registered there too, and the unsubscribe removes both", async () => {
    const { layer, state } = memoryLayer({ appended: true });
    const named = Object.assign(layer, { database: "memory #appended" });
    let calls = 0;
    const stop = onPublished(named, () => { calls++; });
    expect(state.listeners.size).toBe(1);
    for (const listener of state.listeners) listener();
    expect(calls).toBe(1);
    // A commit that published in this process still wakes the listener through core.
    notifyPublished(named);
    expect(calls).toBe(2);
    stop();
    expect(state.listeners.size).toBe(0);
    notifyPublished(named);
    expect(calls).toBe(2);
  });

  test("a listener that throws when the layer calls it through onAppended is reported, and the throw never reaches the layer", () => {
    const { layer, state } = memoryLayer({ appended: true });
    const named = Object.assign(layer, { database: "memory #appended-throws" });
    let after = 0;
    const stopThrowing = onPublished(named, () => { throw new Error("listener broke"); });
    const stopAfter = onPublished(named, () => { after++; });
    const reported: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { reported.push(args); };
    try {
      for (const listener of [...state.listeners]) expect(() => listener()).not.toThrow();
    } finally { console.error = original; }
    expect(after).toBe(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.[0]).toBe("A bus's onPublished listener threw:");
    expect((reported[0]?.[1] as Error).message).toBe("listener broke");
    stopThrowing();
    stopAfter();
    expect(state.listeners.size).toBe(0);
  });

  test("on a layer without onAppended, only commits in this process wake the listener", async () => {
    const { layer } = memoryLayer();
    const named = Object.assign(layer, { database: "memory #plain" });
    let calls = 0;
    const stop = onPublished(named, () => { calls++; });
    notifyPublished(named);
    expect(calls).toBe(1);
    stop();
    notifyPublished(named);
    expect(calls).toBe(1);
  });
});

describe("core's tables", () => {
  test("the outbox, its state table, the two progress tables and the failures table, declared once, needed only when the project declares an event", () => {
    expect(CORE_TABLES.map((table) => table.name)).toEqual([OUTBOX_TABLE, OUTBOX_STATE_TABLE, HANDLER_PROGRESS_TABLE, SUBSCRIPTION_PROGRESS_TABLE, FAILURES_TABLE]);
    expect([...CORE_TABLE_NAMES]).toEqual(["mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures"]);
    expect(coreTablesFor({})).toEqual([]);
    expect(coreTablesFor({ events: [] })).toEqual([]);
    expect(coreTablesFor({ events: [{}] }).map((table) => table.name)).toEqual(["mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures"]);
    const [outbox, state, handlers, subscriptions, failures] = CORE_TABLES;
    expect(outbox!.columns.map(({ name, type, nullable, primaryKey, neverReuse }) => [name, type, nullable, primaryKey, neverReuse])).toEqual([
      ["position", "integer", false, true, true],
      ["id", "uuid", false, false, false],
      ["name", "string", false, false, false],
      ["entity", "string", false, false, false],
      ["action", "string", false, false, false],
      ["key", "json", false, false, false],
      ["caused_by", "uuid", true, false, false],
      ["metadata", "json", false, false, false],
      ["occurred_at", "timestamp", false, false, false],
      ["payload", "json", false, false, false],
    ]);
    expect(state!.columns.map(({ name, type, nullable, primaryKey }) => [name, type, nullable, primaryKey])).toEqual([
      ["id", "integer", false, true],
      ["deleted_through", "integer", false, false],
      ["run_id", "uuid", true, false],
      ["generation", "integer", true, false],
      ["renewed_at", "timestamp", true, false],
      ["host", "string", true, false],
      ["pid", "integer", true, false],
      ["started_at", "timestamp", true, false],
      ["holes", "json", true, false],
    ]);
    expect(handlers!.columns.map(({ name, type, primaryKey }) => [name, type, primaryKey])).toEqual([
      ["name", "string", true], ["kind", "string", false], ["position", "integer", false], ["events", "json", false], ["generation", "integer", false],
    ]);
    expect(subscriptions!.columns.map(({ name, type, primaryKey }) => [name, type, primaryKey])).toEqual([
      ["name", "string", true], ["position", "integer", false], ["filter", "json", false], ["seen_at", "timestamp", false], ["open", "integer", false],
      ["generation", "integer", false],
    ]);
    // A set-aside event: the outbox row copied whole beside the handler, the error and when, under an id never reused.
    expect(failures!.needs).toBe("events");
    expect(failures!.columns.map(({ name, type, nullable, primaryKey, neverReuse }) => [name, type, nullable, primaryKey, neverReuse])).toEqual([
      ["failure", "integer", false, true, true],
      ["handler", "string", false, false, false],
      ...outbox!.columns.map(({ name, type, nullable }) => [name, type, nullable, false, false]),
      ["error", "json", false, false, false],
      ["failed_at", "timestamp", false, false, false],
    ]);
    expect(Object.isFrozen(CORE_TABLES) && Object.isFrozen(outbox) && Object.isFrozen(outbox!.columns) && Object.isFrozen(outbox!.columns[0])).toBe(true);
  });
});

describe("delivery needs the layer to name its database", () => {
  test("deliver(), startDelivery() and subscribe refuse a layer without DataLayer.database, before they load the events module or write a row", async () => {
    const memory = memoryLayer();
    expect(memory.layer.database).toBeUndefined();
    let loaded = 0;
    const config: EventsConfig = { bus: testBus(), load: async () => { loaded++; return {}; } };
    const binding = bindDomain({ InvoicePaid }, memory.layer, { events: config }, new AsyncLocalStorage());
    for (const [what, run] of [
      ["deliver()", () => binding.deliver()],
      ["startDelivery()", () => binding.startDelivery()],
      ["subscribe", () => subscribe(binding, { name: "s" }, () => {})],
    ] as const) {
      const error = await rejection(run);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith(`${what} was called on a data layer that does not name its database (DataLayer.database)`);
    }
    expect(loaded).toBe(0);
  });
});

describe("testBus's round loop", () => {
  test("a wake-up that comes as a round ends starts another round at once, whichever microtask it lands in", async () => {
    for (let depth = 0; depth < 12; depth++) {
      let listener: (() => void) | undefined;
      let passes = 0;
      const core = {
        handlers: [],
        subscriptions: () => [],
        deletionPass: async () => {
          passes++;
          if (passes !== 1) return;
          let later = Promise.resolve();
          for (let i = 0; i < depth; i++) later = later.then(() => undefined);
          void later.then(() => listener?.());
        },
        onPublished: (wake: () => void) => { listener = wake; return () => { listener = undefined; }; },
        onClaimLost: () => () => undefined,
      };
      const instance = testBus({ pollMs: 60_000 }).create(core as never, { keep: "until-delivered" });
      await instance.start();
      const end = Date.now() + 1000;
      while (passes < 2 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2));
      await instance.stop();
      expect({ depth, passes }).toEqual({ depth, passes: 2 });
    }
  });
});

describe("the async context a metadata function runs in (trace context in metadata)", () => {
  // The docs' trace-context recipe ("The events module and metadata", "Trace context") rests on two properties of the
  // code, pinned here with an AsyncLocalStorage store standing for OpenTelemetry's active context: the metadata function
  // runs in the async context of the call that published, and a handler's run body's async context reaches the metadata
  // of every event its calls publish.
  const Invoice = entity("billing.Invoice", (layer, options, frame = NO_FRAME) => Object.freeze({
    // As `mesh build` writes an action that publishes: runAction, the binding's frame, and publishEvent with the binding's events.
    async pay(input: { readonly id: string }, context?: object) {
      const clock = frame.clock(options.clock);
      return runAction(layer, options.seams, { entity: "billing.Invoice", action: "pay" }, input, context, (tx) =>
        frame.within(tx, clock, "billing.Invoice#pay", () =>
          frame.plain(() => publishEvent(tx, options.events, { ...target, key: { id: input.id } }, paid(input.id), context ?? {}, clock))));
    },
  }), null, (call) => ({
    pay(input: { readonly id: string }, ...context: [context?: object]): Promise<EventRecord> {
      return call("pay", input, context);
    },
  }));
  const trace = new AsyncLocalStorage<string>();
  const metadata = () => ({ trace: trace.getStore() ?? null });
  // An entity value is bound through one async frame, as a project's own bind() passes it.
  const frame = new AsyncLocalStorage<unknown>();

  test("a store set around an action call is what the metadata function sees", async () => {
    const { layer, state } = memoryLayer();
    const binding = bindDomain({ Invoice, InvoicePaid }, layer, { events: { load: async () => ({ metadata }) }, clock }, frame);
    await binding.run(() => trace.run("caller-a", () => Invoice.pay({ id: "a" })));
    await trace.run("caller-b", () => binding.run(() => Invoice.pay({ id: "b" })));
    await binding.run(() => Invoice.pay({ id: "c" }));
    expect(state.rows.map((row) => row.metadata)).toEqual([{ trace: "caller-a" }, { trace: "caller-b" }, { trace: null }]);
  });

  test("a store set inside a handler's run is what the metadata function sees for the events its action publishes", async () => {
    const { layer, state } = memoryLayer({ delivery: true });
    const module: EventsModule = {
      metadata,
      handlers: {
        // Each acts on the first event only, so the events their own calls publish end the chain.
        process: {
          repay: Mesh.handler({
            events: [InvoicePaid],
            run: async (event, { context }) => {
              if (event.payload.invoiceId === "a") await trace.run(`handled ${event.position}`, () => Invoice.pay({ id: "from-handler" }, context));
            },
          }),
        },
        listen: {
          mails: Mesh.handler({
            events: [InvoicePaid],
            run: async (event) => {
              if (event.payload.invoiceId === "a") await trace.run(`mailed ${event.position}`, () => Invoice.pay({ id: "from-listener" }));
            },
          }),
        },
      },
    };
    const binding = bindDomain({ Invoice, InvoicePaid }, layer, { events: { bus: testBus(), keep: "all", load: async () => module }, clock }, frame);
    await binding.deliver();
    await trace.run("caller", () => binding.run(() => Invoice.pay({ id: "a" })));
    await binding.deliver();
    // keep: "all" holds the delivered row; the two handlers run in no fixed order, so the rows are compared by key.
    expect(Object.fromEntries(state.rows.map((row) => [(row.key as { id: string }).id, row.metadata]))).toEqual({
      a: { trace: "caller" },
      "from-handler": { trace: "handled 1" },
      "from-listener": { trace: "mailed 1" },
    });
  });
});

describe("section handlers, handed to bindDomain (handlers design, H17 to H19)", () => {
  // As the generated `bind` hands them: `mergeHandlers` of each owner's `$handlers`, keyed `<owner FQN>.<name>`.
  // Both owners name their handler `receipt`: the keys differ, so the merge keeps both.
  const Invoice = entity("billing.Invoice", (layer, options, frame = NO_FRAME) => Object.freeze({
    async pay(input: { readonly id: string }, context?: object) {
      const clock = frame.clock(options.clock);
      return runAction(layer, options.seams, { entity: "billing.Invoice", action: "pay" }, input, context, (tx) =>
        frame.within(tx, clock, "billing.Invoice#pay", () =>
          frame.plain(() => publishEvent(tx, options.events, { ...target, key: { id: input.id } }, paid(input.id), context ?? {}, clock))));
    },
  }), null, (call) => ({
    pay(input: { readonly id: string }, ...context: [context?: object]): Promise<EventRecord> {
      return call("pay", input, context);
    },
  }));
  const frame = new AsyncLocalStorage<unknown>();
  const seen: string[] = [];
  const section = (renamed?: string) => mergeHandlers([
    {
      listen: { [renamed ?? "billing.Invoice.receipt"]: { events: [InvoicePaid], run: (event: EventRecord<InvoicePaid>, { context }: { context: object }) => { seen.push(`receipt ${event.payload.invoiceId} ${JSON.stringify(context)}`); }, ...(renamed ? { renamedFrom: "billing.Invoice.receipt" } : {}) } },
      at: { [renamed ?? "billing.Invoice.receipt"]: "billing/invoice.mesh.mx:19:5" },
    },
    {
      process: { "billing.Ledger.receipt": { events: [InvoicePaid], run: (event: EventRecord<InvoicePaid>) => { seen.push(`ledger ${event.payload.invoiceId} ${event.causedBy}`); } } },
      at: { "billing.Ledger.receipt": "billing/ledger.mesh.mx:7:5" },
    },
  ] as never);

  test("with no events.load, every binding that delivers registers them by key and runs each from now, the two owners' in one round", async () => {
    const { layer, state } = memoryLayer({ delivery: true });
    seen.length = 0;
    const binding = bindDomain({ Invoice, InvoicePaid }, layer, { events: { bus: testBus(), keep: "all" }, clock }, frame, section());
    await binding.run(() => Invoice.pay({ id: "before" }));
    await binding.deliver();
    expect(seen).toEqual([]);
    await binding.run(() => Invoice.pay({ id: "a" }));
    await binding.deliver();
    expect(seen.sort()).toEqual(["ledger a null", 'receipt a {"system":true}']);
    expect(state.rows.map((row) => row.name)).toEqual(["billing.InvoicePaid", "billing.InvoicePaid"]);
  });

  test("beside the events module's handlers, and a module handler with a section handler's key is MESH_HANDLER_OPTION at deliver()", async () => {
    const { layer } = memoryLayer({ delivery: true });
    seen.length = 0;
    const module: EventsModule = { handlers: { listen: { log: Mesh.handler({ events: [InvoicePaid], run: (event) => { seen.push(`log ${event.payload.invoiceId}`); } }) } } };
    const binding = bindDomain({ Invoice, InvoicePaid }, layer, { events: { bus: testBus(), load: async () => module }, clock }, frame, section());
    await binding.deliver();
    await binding.run(() => Invoice.pay({ id: "b" }));
    await binding.deliver();
    expect(seen.sort()).toEqual(["ledger b null", "log b", 'receipt b {"system":true}']);
    const clash: EventsModule = { handlers: { process: { "billing.Ledger.receipt": Mesh.handler({ events: [InvoicePaid], run: () => undefined }) } } };
    const other = bindDomain({ Invoice, InvoicePaid }, memoryLayer({ delivery: true }).layer, { events: { bus: testBus(), load: async () => clash }, clock }, frame, section());
    const error = await rejection(() => other.deliver());
    expect((error as MeshError).code).toBe("MESH_HANDLER_OPTION");
    expect(error.message).toBe('The process handler "billing.Ledger.receipt" has the name of a process handler: a handler\'s name is unique across every kind, since it keys the handler\'s progress row (one in the events module, one in billing/ledger.mesh.mx:7:5)');
  });

  test("renamed-from moves a section handler's progress row to its new key: events published between the two runs are handled", async () => {
    const { layer } = memoryLayer({ delivery: true });
    seen.length = 0;
    const first = bindDomain({ Invoice, InvoicePaid }, layer, { events: { bus: testBus() }, clock }, frame, section());
    await first.deliver();
    await first.run(() => Invoice.pay({ id: "c" }));
    // Renamed before the row is handled: the new key takes the old row over, so it handles `c` (never from now).
    seen.length = 0;
    const renamed = bindDomain({ Invoice, InvoicePaid }, layer, { events: { bus: testBus() }, clock }, frame, section("billing.Invoice.mailReceipt"));
    await renamed.deliver();
    expect(seen.sort()).toEqual(["ledger c null", 'receipt c {"system":true}']);
  });

  test("retryFailed takes a section handler's key before any delivery is started; an unknown name lists both sources' keys", async () => {
    const { layer } = memoryLayer({ delivery: true });
    // The dead-letter operations, with nothing set aside.
    const transaction = layer.transaction.bind(layer);
    const failures = { writeFailure: async () => true, readFailures: async () => [], deleteFailure: async () => true, renameFailures: async () => 0 };
    const withFailures = { ...layer, transaction: <T>(run: (tx: DataOperations) => Promise<T>) => transaction((tx) => run({ ...tx, ...failures } as never)) } as DataLayer;
    const module: EventsModule = { handlers: { listen: { log: Mesh.handler({ events: [InvoicePaid], run: () => undefined }) } } };
    const binding = bindDomain({ Invoice, InvoicePaid }, withFailures, { events: { bus: testBus({ capabilities: ["ordered-delivery", "dead-letters"] }), load: async () => module }, clock }, frame, section());
    expect(await retryFailed(binding, "billing.Invoice.receipt")).toEqual({ handled: 0, failed: null });
    const error = await rejection(() => retryFailed(binding, "billing.Invoice.mailReceipt"));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toBe('retryFailed("billing.Invoice.mailReceipt"): no handler named "billing.Invoice.mailReceipt" is registered (by the events module or a handlers section); the handlers are billing.Invoice.receipt, billing.Ledger.receipt, log');
  });
});

describe("EventsModule", () => {
  test("a module whose handlers are typed by Mesh.handler is an EventsModule, so `load: () => import(...)` type-checks", () => {
    const module = {
      handlers: {
        process: { refund: Mesh.handler({ events: [InvoicePaid], run: async (event) => { void event.payload.invoiceId; } }) },
        listen: { log: Mesh.handler({ events: [InvoicePaid, InvoiceVoided], run: () => undefined }) },
      },
    };
    const config: EventsConfig = { bus: testBus(), load: async () => module };
    expect(typeof config.load).toBe("function");
  });
});
