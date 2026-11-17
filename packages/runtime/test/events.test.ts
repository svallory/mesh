import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CORE_TABLES, CORE_TABLE_NAMES, CursorAheadError, DECLARATION, EventUndeclaredError, EventsDeletedError, FrameworkError, MeshError, bindDomain, loadEvents,
  OUTBOX_STATE_TABLE, OUTBOX_TABLE, HANDLER_PROGRESS_TABLE, SUBSCRIPTION_PROGRESS_TABLE, coreTablesFor, publishEvent, published, readEvents, rows,
  subscribe, Mesh, HANDLER_KIND, EventsConfigError, type HandlerKind,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { notifyPublished, onPublished } from "../src/events.ts";
import type { DataLayer, DataOperations, Declaration, EventsConfig, OutboxRow } from "@meshfw/runtime";

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
function memoryLayer(options: { outbox?: boolean; appended?: boolean } = {}) {
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
  };
  const layer: DataLayer = {
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
  test("the outbox, its state table and the two progress tables, declared once, needed only when the project declares an event", () => {
    expect(CORE_TABLES.map((table) => table.name)).toEqual([OUTBOX_TABLE, OUTBOX_STATE_TABLE, HANDLER_PROGRESS_TABLE, SUBSCRIPTION_PROGRESS_TABLE]);
    expect([...CORE_TABLE_NAMES]).toEqual(["mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
    expect(coreTablesFor({})).toEqual([]);
    expect(coreTablesFor({ events: [] })).toEqual([]);
    expect(coreTablesFor({ events: [{}] }).map((table) => table.name)).toEqual(["mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
    const [outbox, state, handlers, subscriptions] = CORE_TABLES;
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
    ]);
    expect(handlers!.columns.map(({ name, type, primaryKey }) => [name, type, primaryKey])).toEqual([
      ["name", "string", true], ["kind", "string", false], ["position", "integer", false], ["events", "json", false], ["generation", "integer", false],
    ]);
    expect(subscriptions!.columns.map(({ name, type, primaryKey }) => [name, type, primaryKey])).toEqual([
      ["name", "string", true], ["position", "integer", false], ["filter", "json", false], ["seen_at", "timestamp", false], ["open", "integer", false],
      ["generation", "integer", false],
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
