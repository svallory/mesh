// Keep periods (`events.keep: { days }`), the parts that need no database: the shared check of the value, bind's check,
// the start check of the retention operation, and what the bus is told. What needs a database (the deletion pass under a
// period) is data-sqlite's test/keep-period.test.ts.
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DECLARATION, EventsConfigError, FrameworkError, bindDomain, keepProblem, type BusCapability, type DataLayer, type Declaration, type EventBus, type Keep,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";

class Paid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<Paid> = {
    kind: "event", fqn: "billing.Paid", is: (value: unknown): value is Paid => typeof value === "object" && value !== null && #brand in value,
  };
  constructor(_fields: Record<string, never>) { void this.#brand; Object.freeze(this); }
}

const MULTI = { manifest: { adapter: "local", capabilities: ["ordered-delivery", "multi-process"] }, create: () => ({}) };

describe("keepProblem", () => {
  test("the two strings, and a whole number of days from 1 to 100,000, are legal", () => {
    for (const keep of ["until-delivered", "all", { days: 1 }, { days: 30 }, { days: 36_500 }, { days: 100_000 }]) expect(keepProblem(keep)).toBeNull();
  });

  test("a period on a bus that delivers from one process is legal, and the strings are legal on a multi-process bus", () => {
    expect(keepProblem({ days: 30 }, testBus())).toBeNull();
    expect(keepProblem("all", MULTI)).toBeNull();
    expect(keepProblem("until-delivered", MULTI)).toBeNull();
  });

  test.each([
    [0, "0"], [-1, "-1"], [0.5, "0.5"], [Number.NaN, "null"], [Number.POSITIVE_INFINITY, "null"], ["30", "\"30\""], [null, "null"], [2 ** 53, "9007199254740992"],
    // past 100,000 days the period starts before a date every adapter stores (Postgres refuses a year before 1)
    [100_001, "100001"], [800_000, "800000"], [1e9, "1000000000"],
  ])("days %p is refused, naming the value", (days, shown) => {
    expect(keepProblem({ days })).toEqual({
      message: `\`events.keep.days\` must be a whole number of days, from 1 to 100000, and is ${shown}`,
      fix: "Set days to a whole number, such as 30",
    });
  });

  test.each([["forever", "\"forever\""], [30, "30"], [{}, "{}"], [{ hours: 1 }, "{\"hours\":1}"], [[], "[]"], [null, "null"], [true, "true"]])("%p is refused with the three forms", (keep, shown) => {
    expect(keepProblem(keep)).toEqual({
      message: `\`events.keep\` must be "until-delivered", "all" or { days }, and is ${shown}`,
      fix: "Set keep: \"until-delivered\" (the default: a row is deleted once delivered), keep: \"all\" (every row is kept) or keep: { days: 30 } (a delivered row is kept 30 days)",
    });
  });

  test("a period with another field is refused, naming it", () => {
    expect(keepProblem({ days: 30, hours: 2 })?.message).toBe("`events.keep` { days } takes no other field, and has \"hours\"");
  });

  test("a period on a bus that declares multi-process is refused: the recorded keep holds only the two strings", () => {
    expect(keepProblem({ days: 30 }, MULTI)).toEqual({
      message: "`events.keep` is { days: 30 }, and the bus local delivers from several processes (multi-process), whose recorded keep is \"until-delivered\" or \"all\": a process without the period would delete the rows this one keeps",
      fix: "Set keep: \"until-delivered\" or keep: \"all\", or deliver from one process",
    });
  });
});

/** A layer whose transactions have the delivery operations and, unless `retention` is false, firstOutboxRowSince; each records its call. */
function fakeLayer(retention: boolean) {
  const calls: string[] = [];
  const state = { deletedThrough: 0, highest: 0, generation: 0, claim: null, now: new Date() };
  const tx: Record<string, unknown> = {};
  const names = ["readDeliveryState", "writeClaim", "renewClaim", "releaseClaim", "readHandlerProgress", "writeHandlerProgress", "deleteHandlerProgress",
    "readSubscriptionProgress", "writeSubscriptionProgress", "deleteSubscriptionProgress", "firstOutboxRow", ...(retention ? ["firstOutboxRowSince"] : [])];
  for (const name of names) {
    tx[name] = async () => {
      calls.push(name);
      if (name === "readDeliveryState") return state;
      if (name.startsWith("read")) return [];
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

const module = { handlers: { process: { receipts: { events: [Paid], run: () => {} } } } } as never;
const bind = (layer: DataLayer, keep: Keep | undefined, bus: EventBus = testBus()) =>
  bindDomain({ Paid }, layer, { events: { bus, ...(keep === undefined ? {} : { keep }), load: async () => module } }, new AsyncLocalStorage() as never);

describe("bind's check of events.keep", () => {
  test("a bad period is MESH_EVENTS_CONFIG at bind, with the build's sentence", () => {
    const { layer } = fakeLayer(true);
    const error = (() => { try { bind(layer, { days: 0.5 }); } catch (thrown) { return thrown; } })();
    expect(error).toBeInstanceOf(EventsConfigError);
    expect((error as EventsConfigError).code).toBe("MESH_EVENTS_CONFIG");
    expect((error as Error).message).toBe("`events.keep.days` must be a whole number of days, from 1 to 100000, and is 0.5");
  });

  test("a string that is no keep value is MESH_EVENTS_CONFIG at bind", () => {
    const { layer } = fakeLayer(true);
    expect(() => bind(layer, "forever" as never)).toThrow(EventsConfigError);
  });

  test("a period on a multi-process bus is MESH_EVENTS_CONFIG at bind", () => {
    const { layer } = fakeLayer(true);
    expect(() => bind(layer, { days: 7 }, MULTI as never)).toThrow("delivers from several processes (multi-process)");
  });

  test("{ days: 1 }, the two strings and an absent keep bind", () => {
    for (const keep of [{ days: 1 }, "until-delivered", "all", undefined] as const) expect(() => bind(fakeLayer(true).layer, keep)).not.toThrow();
  });
});

describe("the start check of the retention operation", () => {
  test("a period on a data layer without firstOutboxRowSince fails the start with a FrameworkError naming it, before anything is written", async () => {
    const { layer, calls } = fakeLayer(false);
    const error = await bind(layer, { days: 30 }).deliver().then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("The data layer's transactions have no firstOutboxRowSince: events.keep is { days: 30 }, which needs a data adapter with the retention operations (RetentionOperations in @meshfw/runtime)");
    expect(calls).toEqual([]);
  });

  for (const keep of ["until-delivered", "all", undefined] as const) {
    test(`keep ${String(keep)} on the same layer claims: an adapter without it delivers every project without a period`, async () => {
      const { layer, calls } = fakeLayer(false);
      // the fake keeps no state, so the round may fail later; only that it claimed matters here
      await bind(layer, keep).deliver().catch(() => undefined);
      expect(calls).toContain("writeClaim");
    });
  }

  test("a period on a layer with it claims", async () => {
    const { layer, calls } = fakeLayer(true);
    await bind(layer, { days: 30 }).deliver().catch(() => undefined);
    expect(calls).toContain("writeClaim");
  });
});

describe("what the bus is told", () => {
  /** testBus, recording the options core creates each instance with. */
  const told = (seen: unknown[]): EventBus => {
    const inner = testBus();
    return { manifest: inner.manifest, create(core, options) { seen.push(options); return inner.create(core, options); } };
  };

  for (const [keep, expected] of [[{ days: 30 }, "until-delivered"], ["all", "all"], ["until-delivered", "until-delivered"], [undefined, "until-delivered"]] as const) {
    test(`keep ${JSON.stringify(keep)} creates the bus instance with keep "${expected}"`, async () => {
      const seen: unknown[] = [];
      await bind(fakeLayer(true).layer, keep, told(seen)).deliver().catch(() => undefined);
      expect(seen).toEqual([{ keep: expected }]);
    });
  }

  test("a bus without dead-letters takes a period: a period needs no capability", async () => {
    const capabilities: readonly BusCapability[] = ["ordered-delivery"];
    const { layer, calls } = fakeLayer(true);
    await bind(layer, { days: 30 }, testBus({ capabilities })).deliver().catch(() => undefined);
    expect(calls).toContain("writeClaim");
  });
});
