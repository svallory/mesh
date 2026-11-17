// Per-event keep (`events.keep: { default, events }`), the parts that need no database: the shape check, the names
// check against the declared events, bind's checks, the start check of the retention operations and the hole record's
// column, what the bus is told, the hole check of a history read and the MESH_EVENTS_DELETED variant it throws. What
// needs a database (the deletion pass, the hole record, the reads below a hole) is data-sqlite's
// test/keep-per-event.test.ts.
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DECLARATION, EventsConfigError, EventsDeletedError, FrameworkError, bindDomain, keepEventsProblems, keepProblem, readEvents,
  type DataLayer, type Declaration, type EventBus, type OutboxPage, type PerEventKeep,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";

function eventClass(fqn: string) {
  return class {
    readonly #brand = true;
    static readonly [DECLARATION]: Declaration = { kind: "event", fqn, is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
    constructor(_fields: Record<string, never>) { void this.#brand; Object.freeze(this); }
  };
}
const Paid = eventClass("billing.Paid");
const Viewed = eventClass("audit.Viewed");
const OtherViewed = eventClass("web.Viewed");
const FQNS = ["billing.Paid", "audit.Viewed", "web.Viewed"];

const MULTI = { manifest: { adapter: "local", capabilities: ["ordered-delivery", "multi-process"] }, create: () => ({}) };

describe("keepProblem: the per-event form", () => {
  test("legal: each single rule as default and as an event's rule, and an empty events", () => {
    for (const rule of ["until-delivered", "all", { days: 1 }, { days: 100_000 }])
      expect(keepProblem({ default: rule, events: { "audit.Viewed": rule } })).toBeNull();
    expect(keepProblem({ default: "all", events: {} })).toBeNull();
    expect(keepProblem({ default: "all", events: Object.create(null) })).toBeNull();
    expect(keepProblem({ default: "until-delivered", events: { Viewed: "all" } }, testBus())).toBeNull();
  });

  test("an object with days is a period even beside other fields, so default and events next to days name the extra field", () => {
    expect(keepProblem({ days: 3, default: "all" })?.message).toBe("`events.keep` { days } takes no other field, and has \"default\"");
  });

  test("a missing field, an extra field, a bad default, a nested per-event form, a bad events and a bad rule are refused, each naming the place", () => {
    expect(keepProblem({ events: {} })?.message).toBe("`events.keep` { default, events } needs both fields, and has no default");
    expect(keepProblem({ default: "all" })?.message).toBe("`events.keep` { default, events } needs both fields, and has no events");
    expect(keepProblem({ default: "all", events: {}, keep: "all" })?.message).toBe("`events.keep` { default, events } takes no other field, and has \"keep\"");
    expect(keepProblem({ default: "never", events: {} })).toEqual({
      message: "`events.keep.default` must be \"until-delivered\", \"all\" or { days }, and is \"never\"", fix: "Set default to \"until-delivered\", \"all\" or { days: 30 }",
    });
    expect(keepProblem({ default: { default: "all", events: {} }, events: {} })?.message).toBe("`events.keep.default` must be \"until-delivered\", \"all\" or { days }, and is {\"default\":\"all\",\"events\":{}}");
    expect(keepProblem({ default: { days: 2, hours: 1 }, events: {} })?.message).toBe("`events.keep.default` { days } takes no other field, and has \"hours\"");
    for (const [events, shown] of [[[], "[]"], [null, "null"], ["all", "\"all\""], [new Map(), "{}"]] as const)
      expect(keepProblem({ default: "all", events })?.message).toBe(`\`events.keep.events\` must be an object from an event's FQN to its rule, such as { "audit.Viewed": "all" }, and is ${shown}`);
    expect(keepProblem({ default: "all", events: { " ": "all" } })?.message).toBe("`events.keep.events` has an empty key: each key names a declared event");
    expect(keepProblem({ default: "all", events: { "audit.Viewed": { days: -1 } } })).toEqual({
      message: "`events.keep.events[\"audit.Viewed\"].days` must be a whole number of days, from 1 to 100000, and is -1", fix: "Set days to a whole number, such as 30",
    });
    expect(keepProblem({ default: "all", events: { "audit.Viewed": { default: "all", events: {} } } })).toEqual({
      message: "`events.keep.events[\"audit.Viewed\"]` must be \"until-delivered\", \"all\" or { days }, and is {\"default\":\"all\",\"events\":{}}",
      fix: "Set the event's rule to \"until-delivered\", \"all\" or { days: 30 }",
    });
  });

  test("the per-event form on a multi-process bus is refused, even with string rules: a process without it would delete what it keeps", () => {
    expect(keepProblem({ default: "all", events: { X: "all" } }, MULTI)).toEqual({
      message: "`events.keep` sets a rule per event ({ default, events }), and the bus local delivers from several processes (multi-process), whose recorded keep is \"until-delivered\" or \"all\": a process without the rule would delete the rows this one keeps",
      fix: "Set keep: \"until-delivered\" or keep: \"all\", or deliver from one process",
    });
    // a shape problem is reported before the bus
    expect(keepProblem({ default: "never", events: {} }, MULTI)?.message).toStartWith("`events.keep.default` must be");
  });
});

describe("keepEventsProblems", () => {
  const keep = (events: Record<string, unknown>): PerEventKeep => ({ default: "until-delivered", events: events as never });

  test("a single rule, and a per-event keep that names declared events exactly or shortened, have no problem", () => {
    for (const single of ["all", "until-delivered", { days: 3 }, undefined]) expect(keepEventsProblems(single, FQNS)).toEqual([]);
    expect(keepEventsProblems(keep({ "billing.Paid": "all", Paid: undefined } as never), FQNS)).toEqual([
      { message: "`events.keep.events` names billing.Paid twice (as \"billing.Paid\" and \"Paid\")", fix: "Remove the second one" },
    ]);
    expect(keepEventsProblems(keep({ Paid: "all", "audit.Viewed": { days: 1 }, "web.Viewed": "all" }), FQNS)).toEqual([]);
  });

  test("unknown, ambiguous, a former FQN, and no event declared", () => {
    expect(keepEventsProblems(keep({ Viewd: "all", Viewed: "all" }), FQNS)).toEqual([
      { message: "`events.keep.events` names \"Viewd\", which is no declared event; the project declares audit.Viewed, billing.Paid, web.Viewed", fix: "Correct the name" },
      { message: "`events.keep.events` names \"Viewed\", which is ambiguous: audit.Viewed or web.Viewed", fix: "Write more of the name" },
    ]);
    const renamed = new Map([["old.Paid", "billing.Paid"]]);
    expect(keepEventsProblems(keep({ "old.Paid": "all" }), FQNS, renamed)).toEqual([]);
    expect(keepEventsProblems(keep({ "old.Paid": "all" }), FQNS)).toHaveLength(1);
    expect(keepEventsProblems(keep({ "old.Paid": "all", "billing.Paid": "all" }), FQNS, renamed)[0]!.message).toBe("`events.keep.events` names billing.Paid twice (as \"old.Paid\" and \"billing.Paid\")");
    expect(keepEventsProblems(keep({ Paid: "all" }), [])).toEqual([
      { message: "`events.keep.events` names \"Paid\", and the project declares no event: each key names a declared event", fix: "Remove the entry, or declare the event" },
    ]);
    expect(keepEventsProblems(keep({}), [])).toEqual([]);
  });
});

/** A layer whose transactions have the delivery operations, the retention operations named in `retention`, and a state with or without `holes`. */
function fakeLayer(retention: readonly string[], holes: boolean) {
  const calls: string[] = [];
  const state = { deletedThrough: 0, highest: 0, generation: 0, claim: null, now: new Date(), ...(holes ? { holes: {} } : {}) };
  const tx: Record<string, unknown> = {};
  const names = ["readDeliveryState", "writeClaim", "renewClaim", "releaseClaim", "readHandlerProgress", "writeHandlerProgress", "deleteHandlerProgress",
    "readSubscriptionProgress", "writeSubscriptionProgress", "deleteSubscriptionProgress", "firstOutboxRow", ...retention];
  for (const name of names) {
    tx[name] = async () => {
      calls.push(name);
      if (name === "readDeliveryState") return state;
      if (name.startsWith("read")) return [];
      if (name === "deleteOutboxRows") return { deleted: 0, highest: {} };
      return name.startsWith("firstOutboxRow") ? null : true;
    };
  }
  const layer = {
    database: `fake #${Math.random()}`,
    transaction: async <T>(run: (ops: never) => Promise<T>) => run(tx as never),
    refuseIfFailed: () => false,
    readOutbox: async () => ({ rows: [], deletedThrough: 0, highest: 0, settled: 0 }),
    close: async () => {},
  } as unknown as DataLayer;
  return { layer, calls };
}
const ALL_RETENTION = ["firstOutboxRowSince", "deleteOutboxRows", "writeHoles"];

const module = { handlers: { process: { receipts: { events: [Paid], run: () => {} } } } } as never;
const bind = (layer: DataLayer, keep: unknown, bus: EventBus = testBus(), renamed?: Record<string, string>, frame = new AsyncLocalStorage()) =>
  bindDomain({ Paid, Viewed, OtherViewed }, layer, { events: { bus, keep: keep as never, load: async () => module, ...(renamed ? { renamed } : {}) } }, frame as never);

describe("bind's checks of a per-event keep", () => {
  test("a name the domain does not declare, an ambiguous one, and one event named twice are MESH_EVENTS_CONFIG at bind", () => {
    const { layer } = fakeLayer(ALL_RETENTION, true);
    for (const [events, message] of [
      [{ "billing.Payd": "all" }, "`events.keep.events` names \"billing.Payd\", which is no declared event; the project declares audit.Viewed, billing.Paid, web.Viewed"],
      [{ Viewed: "all" }, "`events.keep.events` names \"Viewed\", which is ambiguous: audit.Viewed or web.Viewed"],
      [{ Paid: "all", "billing.Paid": "until-delivered" }, "`events.keep.events` names billing.Paid twice (as \"Paid\" and \"billing.Paid\")"],
    ] as const) {
      const error = (() => { try { bind(layer, { default: "until-delivered", events }); } catch (thrown) { return thrown; } })();
      expect(error).toBeInstanceOf(EventsConfigError);
      expect((error as Error).message).toBe(message);
    }
  });

  test("a bad shape and a multi-process bus are refused at bind as at the build", () => {
    const { layer } = fakeLayer(ALL_RETENTION, true);
    expect(() => bind(layer, { default: "all" })).toThrow("needs both fields, and has no events");
    expect(() => bind(layer, { default: "all", events: {} }, MULTI as never)).toThrow("sets a rule per event ({ default, events })");
  });

  test("full, shortened and former names bind", () => {
    const { layer } = fakeLayer(ALL_RETENTION, true);
    expect(() => bind(layer, { default: "all", events: { "billing.Paid": "until-delivered", "audit.Viewed": { days: 3 } } })).not.toThrow();
    expect(() => bind(layer, { default: "all", events: { Paid: "until-delivered" } })).not.toThrow();
    expect(() => bind(layer, { default: "all", events: { "old.Paid": "until-delivered" } }, testBus(), { "old.Paid": "Paid" })).not.toThrow();
  });
});

describe("the start check of a per-event keep", () => {
  for (const missing of ALL_RETENTION) {
    test(`a layer without ${missing} fails the start with a FrameworkError naming it, before anything is written`, async () => {
      const { layer, calls } = fakeLayer(ALL_RETENTION.filter((name) => name !== missing), true);
      const error = await bind(layer, { default: "until-delivered", events: { Paid: "all" } }).deliver().then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe(`The data layer's transactions have no ${missing}: events.keep sets a rule per event ({ default, events }), which needs a data adapter with the retention operations (RetentionOperations in @meshfw/runtime)`);
      expect(calls).not.toContain("writeClaim");
    });
  }

  test("a database whose state has no hole record (no holes column) fails the start, naming mesh db push", async () => {
    const { layer, calls } = fakeLayer(ALL_RETENTION, false);
    const error = await bind(layer, { default: "until-delivered", events: { Paid: "all" } }).deliver().then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("A per-event events.keep needs mesh_outbox_state.holes, which this database does not have: run mesh db push");
    expect(calls).not.toContain("writeClaim");
  });

  test("a single rule on a layer without the per-event operations and the column claims", async () => {
    for (const keep of ["until-delivered", "all"]) {
      const { layer, calls } = fakeLayer([], false);
      await bind(layer, keep).deliver().catch(() => undefined);
      expect(calls).toContain("writeClaim");
    }
  });

  test("a per-event keep on a layer with everything claims", async () => {
    const { layer, calls } = fakeLayer(ALL_RETENTION, true);
    await bind(layer, { default: "until-delivered", events: { Paid: "all" } }).deliver().catch(() => undefined);
    expect(calls).toContain("writeClaim");
  });
});

describe("what the bus is told under a per-event keep", () => {
  const told = (seen: unknown[]): EventBus => {
    const inner = testBus();
    return { manifest: inner.manifest, create(core, options) { seen.push(options); return inner.create(core, options); } };
  };
  for (const [keep, expected] of [
    [{ default: "all", events: { Paid: "all", "audit.Viewed": "all" } }, "all"],
    [{ default: "all", events: {} }, "all"],
    [{ default: "all", events: { Paid: "until-delivered" } }, "until-delivered"],
    [{ default: "until-delivered", events: { Paid: "all" } }, "until-delivered"],
    [{ default: "all", events: { Paid: { days: 3 } } }, "until-delivered"],
  ] as const) {
    test(`${JSON.stringify(keep)} creates the bus instance with keep "${expected}": "all" only when every rule is`, async () => {
      const seen: unknown[] = [];
      await bind(fakeLayer(ALL_RETENTION, true).layer, keep, told(seen)).deliver().catch(() => undefined);
      expect(seen).toEqual([{ keep: expected }]);
    });
  }
});

describe("a history read below a hole (MESH_EVENTS_DELETED, rule KE3)", () => {
  /** A binding over a layer whose readOutbox answers `page`. */
  function reader(page: OutboxPage, renamed?: Record<string, string>) {
    const { layer } = fakeLayer(ALL_RETENTION, true);
    const view = { ...layer, readOutbox: async () => page } as unknown as DataLayer;
    const frame = new AsyncLocalStorage();
    const binding = bind(view, "all", testBus(), renamed, frame);
    return { readEvents: (query: Parameters<typeof readEvents>[2]) => readEvents(frame as never, binding, query) };
  }
  const page = (holes: Record<string, number>): OutboxPage => ({ rows: [], deletedThrough: 0, highest: 500, settled: 500, holes });

  test("a read that takes the event is refused, naming it and the position to read from; the error carries eventName", async () => {
    const error = await reader(page({ "audit.Viewed": 480 })).readEvents({ after: 120 }).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EventsDeletedError);
    const deleted = error as EventsDeletedError;
    expect(deleted.code).toBe("MESH_EVENTS_DELETED");
    expect(deleted.message).toBe("The read from position 120 takes the event audit.Viewed, whose rows above it were deleted through position 480 (events.keep sets that event apart). Read with names that leave it out, or from position 480");
    expect([deleted.after, deleted.oldestKept, deleted.eventName]).toEqual([120, 481, "audit.Viewed"]);
  });

  test("a read whose names leave the event out, and a read from at or above the hole, are not", async () => {
    const binding = reader(page({ "audit.Viewed": 480 }));
    await expect(binding.readEvents({ after: 120, names: ["billing.Paid"] })).resolves.toMatchObject({ events: [] });
    await expect(binding.readEvents({ after: 480 })).resolves.toMatchObject({ events: [] });
    await expect(binding.readEvents({ after: 120, names: ["audit.Viewed"] })).rejects.toThrow(EventsDeletedError);
  });

  test("of several holes the read takes, the highest is named; a hole stored under a former FQN names the event it now is", async () => {
    const error = await reader(page({ "audit.Viewed": 300, "old.Paid": 450, "web.Viewed": 200 }), { "old.Paid": "Paid" }).readEvents({ after: 10 })
      .then(() => undefined, (thrown: unknown) => thrown) as EventsDeletedError;
    expect([error.eventName, error.oldestKept]).toEqual(["billing.Paid", 451]);
  });

  test("the plain variant keeps its message and has no eventName", () => {
    const error = new EventsDeletedError(3, 10);
    expect(error.message).toStartWith("Cannot read the outbox after position 3: the rows up to position 9 were deleted");
    expect(Object.hasOwn(error, "eventName")).toBe(false);
  });
});
