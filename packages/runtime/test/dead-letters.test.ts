// Dead letters, the parts that need no database: the start check of the dead-letter operations, testBus's set-aside
// branch, and the argument and capability checks of retryFailed. What needs a database (the set-aside itself,
// retryFailed's replay, renamedFrom moving failure rows) is the "dead letters" group of busConformance.
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DECLARATION, EventUndeclaredError, FrameworkError, bindDomain, retryFailed, type BusCapability, type BusCore, type DataLayer, type Declaration, type StoppedHandler,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";

class Paid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration<Paid> = {
    kind: "event", fqn: "billing.Paid", is: (value: unknown): value is Paid => typeof value === "object" && value !== null && #brand in value,
  };
  constructor(_fields: Record<string, never>) { void this.#brand; Object.freeze(this); }
}

/** A layer whose transactions have the delivery operations and, unless `failures` is false, the dead-letter ones; each records its call. */
function fakeLayer(failures: boolean) {
  const calls: string[] = [];
  const state = { deletedThrough: 0, highest: 0, generation: 0, claim: null, now: new Date() };
  const tx: Record<string, unknown> = {};
  const names = ["readDeliveryState", "writeClaim", "renewClaim", "releaseClaim", "readHandlerProgress", "writeHandlerProgress", "deleteHandlerProgress",
    "readSubscriptionProgress", "writeSubscriptionProgress", "deleteSubscriptionProgress", "firstOutboxRow",
    ...(failures ? ["writeFailure", "readFailures", "deleteFailure", "renameFailures"] : [])];
  for (const name of names) {
    tx[name] = async () => {
      calls.push(name);
      if (name === "readDeliveryState") return state;
      if (name.startsWith("read")) return [];
      return name === "firstOutboxRow" ? null : true;
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

const handlers = (onFailure: "skip" | "stop") => ({ handlers: { process: { receipts: { events: [Paid], onFailure, run: () => {} } } } }) as never;
const bind = (layer: DataLayer, module: never, capabilities: readonly BusCapability[] = ["ordered-delivery", "dead-letters"]) =>
  bindDomain({ Paid }, layer, { events: { bus: testBus({ capabilities }), load: async () => module } }, new AsyncLocalStorage() as never);

describe("the start check of the dead-letter operations", () => {
  test("a skip handler on a data layer without them fails the start with a FrameworkError naming the first, before anything is written", async () => {
    const { layer, calls } = fakeLayer(false);
    const error = await bind(layer, handlers("skip")).deliver().then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe('The data layer\'s transactions have no writeFailure: the handler "receipts" has onFailure "skip", which needs a data adapter with the dead-letter operations (FailureOperations in @meshfw/runtime)');
    expect(calls).toEqual([]);
  });

  test("a stop handler on the same layer starts: an adapter without them delivers every project that never skips", async () => {
    const { layer, calls } = fakeLayer(false);
    // the fake keeps no state, so the round may lose its claim later; only that it claimed matters here
    await bind(layer, handlers("stop")).deliver().catch(() => undefined);
    expect(calls).toContain("writeClaim");
  });

  test("a skip handler on a layer with them claims", async () => {
    const { layer, calls } = fakeLayer(true);
    await bind(layer, handlers("skip")).deliver().catch(() => undefined);
    expect(calls).toContain("writeClaim");
  });
});

describe("testBus's set-aside branch", () => {
  const row = (position: number) => ({ position, id: `id-${position}`, name: "x.E", entity: "x.T", action: "a", key: {}, causedBy: null, metadata: {}, occurredAt: new Date(0), payload: {} });
  /** A core whose retry stops every row in `stops` with the cause it maps to, and whose setAside records its calls or throws `refuse`. */
  function fakeCore(onFailure: "skip" | "stop", stops: Map<number, unknown>, refuse?: unknown) {
    const setAside: [number, unknown][] = [];
    const handled: number[] = [];
    const core = {
      handlers: [{ name: "h", kind: "process", events: ["x.E"], onFailure }],
      position: async () => 0,
      rows: async (after: number) => ({ rows: after === 0 ? [row(1), row(2), row(3)] : [], deletedThrough: 0, highest: 3, settled: 3 }),
      lists: () => true,
      retry: async (_handler: unknown, given: { position: number }): Promise<StoppedHandler | null> => {
        const cause = stops.get(given.position);
        if (cause === undefined) { handled.push(given.position); return null; }
        return { handler: "h", position: given.position, event: "x.E", cause };
      },
      setAside: async (_handler: unknown, given: { position: number }, error: unknown) => {
        if (refuse !== undefined) throw refuse;
        setAside.push([given.position, error]);
      },
      subscriptions: () => [],
      deletionPass: async () => {},
      onClaimLost: () => () => undefined,
      onPublished: () => () => undefined,
    } as unknown as BusCore;
    return { core, setAside, handled };
  }
  const deliver = (core: BusCore) => testBus({ capabilities: ["ordered-delivery", "dead-letters"] }).create(core, { keep: "until-delivered" }).deliver().then(() => undefined, (error: unknown) => error);

  test("a skip handler's stop is set aside with its cause and the handler goes on; no stop is reported", async () => {
    const down = new Error("down");
    const { core, setAside, handled } = fakeCore("skip", new Map([[2, down]]));
    expect(await deliver(core)).toBeUndefined();
    expect(setAside).toEqual([[2, down]]);
    expect(handled).toEqual([1, 3]);
  });

  test("a stop handler's stop, and a skip handler's stop at an undeclared row, are reported and end the handler there", async () => {
    for (const [onFailure, cause] of [["stop", new Error("down")], ["skip", new EventUndeclaredError("x.Gone", 2)]] as const) {
      const { core, setAside, handled } = fakeCore(onFailure, new Map([[2, cause]]));
      const error = await deliver(core) as { stopped?: StoppedHandler[] };
      expect(error?.stopped?.map((stop) => [stop.position, stop.cause])).toEqual([[2, cause]]);
      expect(setAside).toEqual([]);
      expect(handled).toEqual([1]);
    }
  });

  test("a set-aside that is refused stops the handler with the refusal as its cause", async () => {
    const refused = new FrameworkError("refused");
    const { core, handled } = fakeCore("skip", new Map([[2, new Error("down")]]), refused);
    const error = await deliver(core) as { stopped?: StoppedHandler[] };
    expect(error?.stopped?.map((stop) => [stop.position, stop.cause])).toEqual([[2, refused]]);
    expect(handled).toEqual([1]);
  });

  test("testBus declares dead-letters only when its capabilities list it", () => {
    expect(testBus().manifest.capabilities).not.toContain("dead-letters");
    expect(testBus({ capabilities: ["ordered-delivery", "dead-letters"] }).manifest.capabilities).toContain("dead-letters");
  });
});

describe("retryFailed's arguments and capability", () => {
  test("a name that is not a non-empty string is a FrameworkError", async () => {
    const { layer } = fakeLayer(true);
    for (const name of ["", 3, undefined]) {
      const error = await retryFailed(bind(layer, handlers("skip")), name as never).then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith("retryFailed takes a handler's name");
    }
  });

  test("a bus without dead-letters is refused, naming the bus, before the events module is loaded", async () => {
    const { layer, calls } = fakeLayer(true);
    let loaded = 0;
    const binding = bindDomain({ Paid }, layer, { events: { bus: testBus({ capabilities: ["ordered-delivery"] }), load: async () => { loaded++; return handlers("stop"); } } }, new AsyncLocalStorage() as never);
    const error = await retryFailed(binding, "receipts").then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("retryFailed was called, and the bus test does not declare dead-letters: no event is set aside without it");
    expect(loaded).toBe(0);
    expect(calls).toEqual([]);
  });
});
