// localBus on its own terms (spec, Events and commands, "`localBus`, the first adapter"): its options and manifest, the
// two retry schedules (inline in `deliver()`, on the handler's own timer after `start()`), stopping and resuming a
// handler, `MESH_DATABASE_BUSY` that is not a try, `maxQueue`, and no timer left after `stop()`, `deliver()` or a lost
// claim. The project is one entity whose `open` publishes `InvoicePaid`, built by the compiler into a scratch folder.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseBusyError, DelivererLostError, EventUndeclaredError, FrameworkError, HandlerLostError, HandlerStoppedError, resumeHandler, retryFailed, subscribe, SubscriptionOverflowError,
  type BusCore, type FailureOperations, type DataLayer, type DeliveryOperations, type EventBus, type TableHandle,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { sqliteWith } from "../../data-sqlite/src/layer.ts";
import { localBus } from "../src/index.ts";
import { createLocalBus, type LocalBusTimers } from "../src/local-bus.ts";
import { buildSchema } from "./schema.ts";

type Binding = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  deliver(): Promise<void>;
  startDelivery(): Promise<{ stop(): Promise<void> }>;
};
type Record_ = { position: number; name: string };
type Handler = { events: readonly unknown[]; run(event: Record_): unknown };

let tables: Record<string, TableHandle>;
let remove: () => Promise<void>;
let app: { bind(layer: DataLayer, options: { events: { bus: EventBus; load: () => Promise<object>; keep?: "until-delivered" | "all" } }): Binding };
let Invoice: { open(input: object, context: object): Promise<unknown> };
let InvoicePaid: unknown;
const scratch = mkdtempSync(join(tmpdir(), "mesh-bus-local-"));

beforeAll(async () => {
  const built = await buildSchema();
  ({ tables, remove } = built);
  app = await import(join(built.dir, ".mesh/index.ts"));
  ({ Invoice, InvoicePaid } = await import(join(built.dir, ".mesh/domain/index.ts")));
});
afterAll(async () => {
  await remove();
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    await sleep(5);
  }
}
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

/** Timers that keep the set of those still live, so a test can say none is left. */
function countingTimers(): { live: Set<unknown>; timers: LocalBusTimers; made: () => number; timeouts: () => number; polls: () => number } {
  const live = new Set<unknown>();
  let made = 0;
  let timeouts = 0;
  let polls = 0;
  const timers: LocalBusTimers = {
    setTimeout(run, ms) {
      made++;
      timeouts++;
      const timer = setTimeout(() => { live.delete(timer); run(); }, ms);
      live.add(timer);
      return timer;
    },
    clearTimeout(timer) { live.delete(timer); clearTimeout(timer as ReturnType<typeof setTimeout>); },
    setInterval(run, ms) { made++; const timer = setInterval(() => { polls++; run(); }, ms); live.add(timer); return timer; },
    clearInterval(timer) { live.delete(timer); clearInterval(timer as ReturnType<typeof setInterval>); },
  };
  return { live, timers, made: () => made, timeouts: () => timeouts, polls: () => polls };
}

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** A core with only what a test names, for the round loop's own behaviour; any other member throws when called. */
function fakeCore(members: Partial<Record<keyof BusCore, unknown>>): BusCore {
  const base: Partial<Record<keyof BusCore, unknown>> = {
    handlers: [], subscriptions: () => [], deletionPass: async () => undefined,
    onPublished: () => () => undefined, onClaimLost: () => () => undefined,
  };
  const all = { ...base, ...members };
  return new Proxy({} as BusCore, {
    get: (_target, key) => key in all ? all[key as keyof BusCore] : () => { throw new Error(`core.${String(key)} was called`); },
  });
}

/** A handler that records the positions it is handed, then runs `body`. */
function recorder(seen: number[], body: (event: Record_) => unknown = () => undefined): Handler {
  return { events: [InvoicePaid], run: (event) => { seen.push(event.position); return body(event); } };
}

/** A fresh database with the project's tables and a binding on it with `bus` and these handlers. */
async function open(bus: EventBus, handlers: { process?: Record<string, Handler>; listen?: Record<string, Handler> }, layer?: DataLayer) {
  const db = layer ?? sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const binding = app.bind(db, { events: { bus, load: async () => ({ handlers }) } });
  return { layer: db, binding };
}
/** One `Invoice.open` in its own transaction: one `InvoicePaid` row. */
const publish = (binding: Binding) => binding.run(() => Invoice.open({}, { system: true }));
const outbox = async (layer: DataLayer) => (await layer.readOutbox!(0, 100)).rows.map((row) => row.position);

describe("localBus(options)", () => {
  test("its manifest names the adapter and its four capabilities, dead-letters included", () => {
    expect(localBus().manifest).toEqual({ adapter: "local", capabilities: ["ordered-delivery", "replay", "subscribe", "dead-letters"] });
    expect(Object.isFrozen(localBus())).toBe(true);
    expect(Object.isFrozen(localBus().manifest.capabilities)).toBe(true);
  });

  test.each([
    [{ pollInterval: 0 }, "pollInterval"], [{ pollInterval: -1 }, "pollInterval"], [{ pollInterval: Number.NaN }, "pollInterval"],
    [{ pollInterval: Number.POSITIVE_INFINITY }, "pollInterval"], [{ pollInterval: "1000" }, "pollInterval"],
    [{ retryDelays: [-1] }, "retryDelays"], [{ retryDelays: "100" }, "retryDelays"], [{ retryDelays: [Number.NaN] }, "retryDelays"], [{ retryDelays: [100, "x"] }, "retryDelays"],
    [{ pollInterval: 0.5 }, "pollInterval"], [{ pollInterval: 2_147_483_648 }, "pollInterval"],
    [{ retryDelays: [1.5] }, "retryDelays"], [{ retryDelays: [2_147_483_648] }, "retryDelays"],
    [{ maxQueue: 0 }, "maxQueue"], [{ maxQueue: 1.5 }, "maxQueue"], [{ maxQueue: "10" }, "maxQueue"],
    [{ onStopped: "log" }, "onStopped"], [{ onStopped: null }, "onStopped"], [{ onStopped: { error() {} } }, "onStopped"], [{ onStopped: true }, "onStopped"],
    [{ poll: 10 }, '"poll"'], [{ onStop: () => undefined }, '"onStop"'], [null, "takes"], [[], "takes"], ["fast", "takes"],
  ])("a wrong option %p is a FrameworkError naming it", (options, named) => {
    let thrown: unknown;
    try { localBus(options as never); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FrameworkError);
    expect((thrown as Error).message).toContain(named);
  });

  test("an empty retryDelays and the edges of each option are accepted", () => {
    expect(() => localBus({ retryDelays: [], pollInterval: 1, maxQueue: 1 })).not.toThrow();
    expect(() => localBus({ retryDelays: [0, 2_147_483_647], pollInterval: 2_147_483_647 })).not.toThrow();
    expect(() => localBus({})).not.toThrow();
    // onStopped is any function, an async one included; undefined is the option left out
    expect(() => localBus({ onStopped: () => undefined })).not.toThrow();
    expect(() => localBus({ onStopped: async () => undefined })).not.toThrow();
    expect(() => localBus({ onStopped: undefined } as never)).not.toThrow();
  });

  test("the messages name onStopped among the options, and say what it is", () => {
    const message = (options: unknown): string => {
      try { localBus(options as never); } catch (error) { return (error as Error).message; }
      return "(accepted)";
    };
    expect(message("fast")).toBe('localBus takes { pollInterval, retryDelays, maxQueue, onStopped, processes }, and was given "fast"');
    expect(message({ onStop: () => undefined })).toBe('localBus has no option "onStop"; its options are pollInterval, retryDelays, maxQueue, onStopped and processes');
    expect(message({ onStopped: "log" })).toBe('localBus: onStopped is the function called with the HandlerStoppedError when a handler stops after start(), and is "log"');
    expect(message({ onStopped: {} })).toBe("localBus: onStopped is the function called with the HandlerStoppedError when a handler stops after start(), and is a value of type object");
  });

  test("processes: \"one\" (the default) keeps the manifest object; \"many\" declares multi-process; anything else is a FrameworkError", () => {
    const one = localBus().manifest;
    expect(localBus({ processes: "one" }).manifest).toBe(one);
    expect(localBus({}).manifest).toBe(one);
    expect(localBus({ processes: undefined } as never).manifest).toBe(one);
    const many = localBus({ processes: "many" }).manifest;
    expect(many).toEqual({ adapter: "local", capabilities: ["ordered-delivery", "replay", "subscribe", "dead-letters", "multi-process"] });
    expect(localBus({ processes: "many", pollInterval: 5 }).manifest).toBe(many);
    expect(Object.isFrozen(many) && Object.isFrozen(many.capabilities)).toBe(true);
    for (const [value, shown] of [[3, "3"], ["several", '"several"'], [null, "null"], [true, "true"], ["Many", '"Many"']] as const) {
      let thrown: unknown;
      try { localBus({ processes: value } as never); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(FrameworkError);
      expect((thrown as Error).message).toBe(`localBus: processes is how many processes may deliver the database, "one" or "many", and is ${shown}`);
    }
  });

  test("the descriptor starts nothing, and create calls nothing on core but onClaimLost, and sets no timer", () => {
    const { timers, made } = countingTimers();
    const calls: string[] = [];
    const core = new Proxy({} as BusCore, {
      get: (_target, key) => {
        calls.push(String(key));
        return key === "onClaimLost" ? () => () => undefined : () => { throw new Error(`core.${String(key)} was called`); };
      },
    });
    const bus = createLocalBus({}, { timers });
    const instance = bus.create(core, { keep: "until-delivered" });
    expect(calls).toEqual(["onClaimLost"]);
    expect(made()).toBe(0);
    expect(typeof instance.resumeHandler).toBe("function");
  });
});

describe("deliver() rounds", () => {
  test("a handler that always throws fails deliver() with its error after [0, 0, 0], well within bun test's timeout", async () => {
    const seen: number[] = [];
    const { layer, binding } = await open(localBus(), { process: { broken: recorder(seen, () => { throw new Error("the card was declined"); }) } });
    try {
      await binding.deliver();
      await publish(binding);
      const started = Date.now();
      const error = await rejection(binding.deliver());
      expect(Date.now() - started).toBeLessThan(1000);
      expect(error).toBeInstanceOf(HandlerStoppedError);
      expect(error).toMatchObject({ code: "MESH_HANDLER_STOPPED", retryable: false, stopped: [{ handler: "broken", position: 1, event: "InvoicePaid" }] });
      expect(((error as HandlerStoppedError).stopped[0]!.cause as Error).message).toBe("the card was declined");
      // one try and three retries
      expect(seen).toEqual([1, 1, 1, 1]);
      expect(await outbox(layer)).toEqual([1]);
    } finally { await layer.close(); }
  });

  test("an explicit retryDelays applies to deliver() rounds too", async () => {
    const seen: number[] = [];
    const { layer, binding } = await open(localBus({ retryDelays: [5] }), { process: { broken: recorder(seen, () => { throw new Error("down"); }) } });
    try {
      await binding.deliver();
      await publish(binding);
      expect(await rejection(binding.deliver())).toBeInstanceOf(HandlerStoppedError);
      expect(seen).toEqual([1, 1]);
    } finally { await layer.close(); }
  });

  test("retryable: false fails deliver() after one try; the next round tries the stopped handler again", async () => {
    const seen: number[] = [];
    let broken = true;
    const { layer, binding } = await open(localBus(), { process: { final: recorder(seen, () => { if (broken) throw Object.assign(new Error("final"), { retryable: false }); }) } });
    try {
      await binding.deliver();
      await publish(binding);
      expect(await rejection(binding.deliver())).toBeInstanceOf(HandlerStoppedError);
      expect(seen).toEqual([1]);
      broken = false;
      await binding.deliver();
      expect(seen).toEqual([1, 1]);
      expect(await outbox(layer)).toEqual([]);
    } finally { await layer.close(); }
  });

  test("a deliver() round leaves no timer of the bus's, and sets none", async () => {
    const counting = countingTimers();
    const seen: number[] = [];
    let fail = 2;
    const { layer, binding } = await open(createLocalBus({}, { timers: counting.timers }), { listen: { flaky: recorder(seen, () => { if (fail-- > 0) throw new Error("again"); }) } });
    try {
      await binding.deliver();
      await publish(binding);
      await binding.deliver();
      expect(seen).toEqual([1, 1, 1]);
      expect(counting.made()).toBe(0);
    } finally { await layer.close(); }
  });
});

describe("started delivery", () => {
  test("retryable: false stops the handler at once under the started defaults, with no delay; the other handler goes on", async () => {
    const reports: unknown[] = [];
    const a: number[] = [];
    const b: number[] = [];
    let broken = true;
    const counting = countingTimers();
    const bus = createLocalBus({ pollInterval: 20 }, { timers: counting.timers, report: (error) => { reports.push(error); } });
    const { layer, binding } = await open(bus, { process: {
      a: recorder(a, () => { if (broken) throw Object.assign(new Error("refused"), { retryable: false }); }),
      b: recorder(b),
    } });
    const delivery = await binding.startDelivery();
    try {
      await sleep(30);
      await publish(binding);
      await until(() => reports.length === 1, "the stop is reported");
      // stopped at once: no back-off timer was ever set
      expect(counting.timeouts()).toBe(0);
      expect(a).toEqual([1]);
      const report = reports[0] as HandlerStoppedError;
      expect(report).toBeInstanceOf(HandlerStoppedError);
      expect(report.stopped).toMatchObject([{ handler: "a", position: 1, event: "InvoicePaid" }]);
      expect(report.message).toContain("the outbox keeps every row");
      // a stopped handler is fed no more, holds deletion, and the other handler goes on
      await publish(binding);
      await until(() => b.length === 2, "b handles both events");
      await sleep(60);
      expect(a).toEqual([1]);
      expect(await outbox(layer)).toEqual([1, 2]);
      // resumeHandler feeds it again from its progress row
      broken = false;
      await resumeHandler(binding as never, "a");
      await until(() => a.length === 3, "a handles both events after resumeHandler");
      expect(a).toEqual([1, 1, 2]);
      expect(reports).toHaveLength(1);
    } finally {
      await delivery.stop();
      await layer.close();
    }
  });

  test("the first started retry waits the first default delay, 100 ms, and a retry that passes reports nothing", async () => {
    const reports: unknown[] = [];
    const tries: number[] = [];
    const { layer, binding } = await open(createLocalBus({ pollInterval: 1000 }, { report: (error) => { reports.push(error); } }), {
      process: { flaky: { events: [InvoicePaid], run: () => { tries.push(Date.now()); if (tries.length === 1) throw new Error("once"); } } },
    });
    const delivery = await binding.startDelivery();
    try {
      await sleep(20);
      await publish(binding);
      await until(() => tries.length === 2, "the retry");
      expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(95);
      expect(tries[1]! - tries[0]!).toBeLessThan(900);
      expect(reports).toEqual([]);
    } finally {
      await delivery.stop();
      await layer.close();
    }
  });

  test("a handler backing off delays no other handler's round, and stop() clears its retry timer and the poll", async () => {
    const counting = countingTimers();
    const a: number[] = [];
    const b: number[] = [];
    const { layer, binding } = await open(createLocalBus({ retryDelays: [10_000], pollInterval: 20 }, { timers: counting.timers, report: () => undefined }), {
      process: { a: recorder(a, () => { throw new Error("busy upstream"); }), b: recorder(b) },
    });
    const delivery = await binding.startDelivery();
    try {
      await sleep(30);
      await publish(binding);
      await until(() => a.length === 1 && b.length === 1, "both handlers get the first event");
      const published = Date.now();
      await publish(binding);
      await until(() => b.length === 2, "b gets the second event while a backs off");
      expect(Date.now() - published).toBeLessThan(500);
      expect(a).toEqual([1]);
      // the poll and a's retry timer
      expect(counting.live.size).toBe(2);
    } finally {
      await delivery.stop();
      await layer.close();
    }
    expect(counting.live.size).toBe(0);
  });

  test("a handler whose retries run out stops, is reported once, and resumes at the next start", async () => {
    const reports: unknown[] = [];
    const seen: number[] = [];
    let broken = true;
    const layer = sqlite({ file: ":memory:" });
    const bus = createLocalBus({ retryDelays: [10, 10], pollInterval: 20 }, { report: (error) => { reports.push(error); } });
    const handlers = { listen: { h: recorder(seen, () => { if (broken) throw new Error("down"); }) } };
    const { binding } = await open(bus, handlers, layer);
    let delivery = await binding.startDelivery();
    try {
      await sleep(30);
      await publish(binding);
      await until(() => reports.length === 1, "the stop is reported");
      expect(seen).toEqual([1, 1, 1]);
      await sleep(80);
      expect(seen).toHaveLength(3);
      expect(reports).toHaveLength(1);
      await delivery.stop();
      broken = false;
      delivery = await binding.startDelivery();
      await until(() => seen.length === 4, "the next start feeds the stopped handler again");
    } finally {
      await delivery.stop();
      await layer.close();
    }
  });

  test("resumeHandler is a FrameworkError without a started delivery or for an unknown name, and leaves a running handler as it is", async () => {
    const seen: number[] = [];
    const { layer, binding } = await open(localBus({ pollInterval: 20 }), { process: { h: recorder(seen) } });
    try {
      const idle = await rejection(resumeHandler(binding as never, "h"));
      expect(idle).toBeInstanceOf(FrameworkError);
      expect((idle as Error).message).toContain("next deliver() round");
      expect(await rejection(resumeHandler(binding as never, ""))).toBeInstanceOf(FrameworkError);
      const delivery = await binding.startDelivery();
      try {
        const unknown = await rejection(resumeHandler(binding as never, "nope"));
        expect(unknown).toBeInstanceOf(FrameworkError);
        expect((unknown as Error).message).toContain('registers "h"');
        await resumeHandler(binding as never, "h");
        await publish(binding);
        await until(() => seen.length === 1, "h handles the event");
      } finally { await delivery.stop(); }
    } finally { await layer.close(); }
  });

  test("stop() waits for the round in flight, and a retryable failure that ends after it sets no timer and reports nothing", async () => {
    const counting = countingTimers();
    const reports: unknown[] = [];
    const entered = gate();
    const release = gate();
    const { layer, binding } = await open(createLocalBus({ pollInterval: 60_000 }, { timers: counting.timers, report: (error) => { reports.push(error); } }), {
      listen: { slow: { events: [InvoicePaid], run: async () => { entered.open(); await release.promise; throw new Error("upstream down"); } } },
    });
    const delivery = await binding.startDelivery();
    try {
      await publish(binding);
      await entered.promise;
      let stopped = false;
      const stopping = delivery.stop().then(() => { stopped = true; });
      await sleep(30);
      expect(stopped).toBe(false);
      release.open();
      await stopping;
      expect(counting.timeouts()).toBe(0);
      expect(counting.live.size).toBe(0);
      expect(reports).toEqual([]);
    } finally {
      release.open();
      await layer.close();
    }
  });

  test("a wake-up that comes as a round ends starts another round at once, whichever microtask it lands in", async () => {
    for (let depth = 0; depth < 12; depth++) {
      const counting = countingTimers();
      let listener: (() => void) | undefined;
      let passes = 0;
      const core = fakeCore({
        deletionPass: async () => {
          passes++;
          if (passes !== 1) return;
          let later = Promise.resolve();
          for (let i = 0; i < depth; i++) later = later.then(() => undefined);
          void later.then(() => listener?.());
        },
        onPublished: (wake: () => void) => { listener = wake; return () => { listener = undefined; }; },
      });
      const instance = createLocalBus({ pollInterval: 60_000 }, { timers: counting.timers }).create(core, { keep: "until-delivered" });
      await instance.start();
      await until(() => passes === 2, `a second round for the wake-up ${depth} microtasks after the first round's deletion pass`, 1000);
      await instance.stop();
      expect(counting.polls()).toBe(0);
      expect(counting.live.size).toBe(0);
    }
  });

  test("a commit while a round runs is delivered by the next round, not by the poll", async () => {
    const counting = countingTimers();
    const seen: number[] = [];
    const entered = gate();
    const release = gate();
    const { layer, binding } = await open(createLocalBus({ pollInterval: 60_000 }, { timers: counting.timers }), {
      listen: { h: recorder(seen, async (event) => { if (event.position === 1) { entered.open(); await release.promise; } }) },
    });
    const delivery = await binding.startDelivery();
    try {
      await publish(binding);
      await entered.promise;
      await publish(binding);
      release.open();
      await until(() => seen.length === 2, "the event committed during the round");
      expect(seen).toEqual([1, 2]);
      expect(counting.polls()).toBe(0);
    } finally {
      release.open();
      await delivery.stop();
      await layer.close();
    }
  });

  test("a handler whose cursor cannot be read stops alone: the other handler, the subscriptions and the deletion pass go on", async () => {
    const reports: unknown[] = [];
    const reads: string[] = [];
    let passes = 0;
    const deleted = Object.assign(new Error("the events after 0 were deleted"), { code: "MESH_EVENTS_DELETED" });
    const handlers = [{ name: "a" }, { name: "b" }];
    const core = fakeCore({
      handlers,
      position: async (handler: { name: string }) => { reads.push(handler.name); return handler.name === "a" ? 0 : 5; },
      rows: async (after: number) => { if (after === 0) throw deleted; return { rows: [], deletedThrough: 5, highest: 5, settled: 5 }; },
      deletionPass: async () => { passes++; },
      onPublished: (wake: () => void) => { listener = wake; return () => { listener = undefined; }; },
    });
    let listener: (() => void) | undefined;
    const counting = countingTimers();
    const started = createLocalBus({ pollInterval: 60_000 }, { timers: counting.timers, report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
    await started.start();
    await until(() => passes === 1, "the first round's deletion pass");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toBeInstanceOf(HandlerStoppedError);
    expect((reports[0] as HandlerStoppedError).stopped).toMatchObject([{ handler: "a", position: 1, cause: deleted }]);
    expect(reads).toEqual(["a", "b"]);
    // the next round skips the stopped handler; the next start feeds it again
    listener!();
    await until(() => passes === 2, "the next round");
    expect(reads).toEqual(["a", "b", "b"]);
    await started.stop();
    await started.start();
    await until(() => passes === 3, "the round after the restart");
    expect(reads).toEqual(["a", "b", "b", "a", "b"]);
    expect(reports).toHaveLength(2);
    await started.stop();
    expect(counting.live.size).toBe(0);

    passes = 0;
    const once = createLocalBus({}, { timers: counting.timers }).create(core, { keep: "until-delivered" });
    const error = await rejection(once.deliver());
    expect(error).toBeInstanceOf(HandlerStoppedError);
    expect((error as HandlerStoppedError).stopped).toMatchObject([{ handler: "a", position: 1, cause: deleted }]);
    expect(passes).toBe(1);
  });

  test("a reporter that throws ends nothing: the next round still runs", async () => {
    let passes = 0;
    let listener: (() => void) | undefined;
    const core = fakeCore({
      deletionPass: async () => { passes++; throw new Error("deletion failed"); },
      onPublished: (wake: () => void) => { listener = wake; return () => { listener = undefined; }; },
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const instance = createLocalBus({ pollInterval: 60_000 }, { report: () => { throw new Error("reporter broke"); } }).create(core, { keep: "until-delivered" });
      await instance.start();
      await until(() => passes === 1, "the first round");
      await sleep(5);
      listener!();
      await until(() => passes === 2, "the next round");
      await instance.stop();
      expect(errors.length).toBeGreaterThanOrEqual(1);
    } finally { console.error = original; }
  });

  test("onStopped is handed the HandlerStoppedError of each stop, in place of the stderr line; the other handler goes on", async () => {
    const stops: HandlerStoppedError[] = [];
    const a: number[] = [];
    const b: number[] = [];
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      // the public factory, with the options an application writes: no internal reporter stands in
      const bus = localBus({ pollInterval: 20, retryDelays: [5], onStopped: (error) => { stops.push(error); } });
      const { layer, binding } = await open(bus, { process: {
        a: recorder(a, () => { throw Object.assign(new Error("refused"), { retryable: false }); }),
        b: recorder(b, (event) => { if (event.position === 2) throw new Error("down"); }),
      } });
      const delivery = await binding.startDelivery();
      try {
        await sleep(30);
        await publish(binding);
        await until(() => stops.length === 1, "onStopped is called for a");
        expect(stops[0]).toBeInstanceOf(HandlerStoppedError);
        expect(stops[0]).toMatchObject({ code: "MESH_HANDLER_STOPPED", stopped: [{ handler: "a", position: 1, event: "InvoicePaid" }] });
        expect((stops[0]!.stopped[0]!.cause as Error).message).toBe("refused");
        await until(() => b.length === 1, "b handles the first event");
        // a handler that stays stopped is reported once, however many rounds follow
        await sleep(60);
        expect(stops).toHaveLength(1);
        // a handler whose retries run out is the other way to stop: its own call, with its own error
        await publish(binding);
        await until(() => stops.length === 2, "onStopped is called for b");
        expect(stops[1]!.stopped).toMatchObject([{ handler: "b", position: 2, event: "InvoicePaid" }]);
        expect((stops[1]!.stopped[0]!.cause as Error).message).toBe("down");
        expect(b).toEqual([1, 2, 2]);
        // each stop is one call: resumed while its cause stands, a stops again at the same event
        await resumeHandler(binding as never, "a");
        await until(() => stops.length === 3, "onStopped is called for a again");
        expect(stops[2]!.stopped).toMatchObject([{ handler: "a", position: 1 }]);
        expect(a).toEqual([1, 1]);
      } finally {
        await delivery.stop();
        await layer.close();
      }
      // the callback took every report: the bus wrote nothing to stderr
      expect(logged.filter(([first]) => String(first).startsWith("Mesh (localBus)"))).toEqual([]);
    } finally { console.error = original; }
  });

  /** A core with one handler, `a`, whose cursor cannot be read: every started round stops it, with no database. */
  function coreWithBrokenCursor() {
    const state = { passes: 0, wake: undefined as (() => void) | undefined };
    const deleted = Object.assign(new Error("the events after 0 were deleted"), { code: "MESH_EVENTS_DELETED" });
    const core = fakeCore({
      handlers: [{ name: "a" }],
      position: async () => 0,
      rows: async () => { throw deleted; },
      deletionPass: async () => { state.passes++; },
      onPublished: (wake: () => void) => { state.wake = wake; return () => { state.wake = undefined; }; },
    });
    return { core, state, deleted };
  }
  const STOPPED_LINE = "Mesh (localBus): a handler stopped. Fix the cause, then call resumeHandler(name), or restart delivery:";

  test.each([
    ["no options", undefined], ["no onStopped", { pollInterval: 60_000 }], ["onStopped: undefined", { pollInterval: 60_000, onStopped: undefined }],
  ])("with %s a stop goes to stderr, as the one line it always was", async (_what, options) => {
    const { core, state, deleted } = coreWithBrokenCursor();
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const instance = localBus(options as never).create(core, { keep: "until-delivered" });
      await instance.start();
      await until(() => state.passes === 1, "the first round");
      await instance.stop();
      expect(logged).toHaveLength(1);
      expect(logged[0]![0]).toBe(STOPPED_LINE);
      expect(logged[0]![1]).toBeInstanceOf(HandlerStoppedError);
      expect((logged[0]![1] as HandlerStoppedError).stopped).toMatchObject([{ handler: "a", position: 1, cause: deleted }]);
    } finally { console.error = original; }
  });

  test.each([
    ["throws", () => { throw new Error("the pager is down"); }],
    ["returns a promise that rejects", async () => { throw new Error("the pager is down"); }],
  ])("an onStopped that %s ends nothing: its error and the stop go to stderr, and the next round runs", async (_what, onStopped) => {
    const { core, state } = coreWithBrokenCursor();
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const instance = localBus({ pollInterval: 60_000, onStopped }).create(core, { keep: "until-delivered" });
      await instance.start();
      await until(() => state.passes === 1, "the first round");
      await until(() => logged.length === 2, "the failure and the stop are logged", 1000);
      expect(logged[0]![0]).toBe("Mesh (localBus): onStopped threw:");
      expect((logged[0]![1] as Error).message).toBe("the pager is down");
      // the stop is not lost with the callback: it is reported as it is without one
      expect(logged[1]![0]).toBe(STOPPED_LINE);
      expect(logged[1]![1]).toBeInstanceOf(HandlerStoppedError);
      state.wake!();
      await until(() => state.passes === 2, "the next round");
      await instance.stop();
      // the stopped handler is skipped by the next round, so nothing more is reported
      expect(logged).toHaveLength(2);
    } finally { console.error = original; }
  });

  test("a deliver() round does not call onStopped: its rejection is the HandlerStoppedError", async () => {
    const stops: unknown[] = [];
    const { layer, binding } = await open(localBus({ onStopped: (error) => { stops.push(error); } }), {
      process: { broken: recorder([], () => { throw new Error("the card was declined"); }) },
    });
    try {
      await binding.deliver();
      await publish(binding);
      const error = await rejection(binding.deliver());
      expect(error).toBeInstanceOf(HandlerStoppedError);
      expect(error).toMatchObject({ stopped: [{ handler: "broken", position: 1 }] });
      expect(stops).toEqual([]);
    } finally { await layer.close(); }
  });

  test("resumeHandler is a FrameworkError on a started bus whose instance cannot resume", async () => {
    const { layer, binding } = await open(testBus({ pollMs: 20 }), { process: { h: recorder([]) } });
    const delivery = await binding.startDelivery();
    try {
      const refused = await rejection(resumeHandler(binding as never, "h"));
      expect(refused).toBeInstanceOf(FrameworkError);
      expect((refused as Error).message).toContain("the bus \"test\" cannot resume a handler");
    } finally {
      await delivery.stop();
      await layer.close();
    }
  });

  test("MESH_DATABASE_BUSY is not a try: a handler with one retry left survives rounds a held lock ends, and handles the event", async () => {
    const reports: unknown[] = [];
    const seen: number[] = [];
    const file = join(scratch, "busy.db");
    const layer = sqliteWith({ file }, { waitMs: 20 });
    const { binding } = await open(createLocalBus({ retryDelays: [40], pollInterval: 15 }, { report: (error) => { reports.push(error); } }), {
      process: { h: recorder(seen, () => { if (seen.length === 1) throw new Error("once"); }) },
    }, layer);
    const other = new Database(file);
    const delivery = await binding.startDelivery();
    try {
      await sleep(30);
      await publish(binding);
      await until(() => seen.length === 1, "the first try");
      // hold the write lock past the retry's due time: several rounds meet it and end
      other.run("BEGIN IMMEDIATE");
      await sleep(200);
      // the retry fell due at 40 ms; every round since met the lock and ended
      expect(seen).toEqual([1]);
      other.run("COMMIT");
      await until(() => seen.length === 2, "the retry once the lock is free");
      expect(seen).toEqual([1, 1]);
      expect(reports).toEqual([]);
    } finally {
      if (other.inTransaction) other.run("ROLLBACK");
      other.close();
      await delivery.stop();
      await layer.close();
    }
  });

  // Spec, Events and commands: a subscription's errors end only that subscription, and MESH_DATABASE_BUSY ends the
  // round, which the next one retries. A busy or lost read of a subscription's rows is the round's, never the reader's.
  test("a busy database or a lost claim while a subscription's rows are read ends the round, not the subscription; a failed read ends it", async () => {
    const live = (name: string) => {
      const state = { name, cursor: 0, filter: {}, ended: false, endedWith: undefined as unknown, fed: 0 };
      return Object.assign(state, {
        feed: async () => { state.fed++; },
        end: (error: unknown) => { state.ended = true; state.endedWith = error; },
      });
    };
    const page = { rows: [], deletedThrough: 0, highest: 0, settled: 0 };
    const busy = new DatabaseBusyError("db", 0);
    const lostClaim = new DelivererLostError("db", "another process claimed the database");
    const deleted = Object.assign(new Error("the events after 0 were deleted"), { code: "MESH_EVENTS_DELETED" });
    for (const failure of [busy, lostClaim]) {
      const subscription = live("s");
      let passes = 0;
      const core = fakeCore({ subscriptions: () => [subscription], rows: async () => { throw failure; }, deletionPass: async () => { passes++; } });
      expect(await rejection(createLocalBus(undefined).create(core, { keep: "until-delivered" }).deliver())).toBe(failure);
      expect([subscription.ended, passes]).toEqual([false, 0]);
    }
    // The legal neighbour: a read that fails for the reader ends that subscription with its error, and the round goes on.
    const failing = live("gone");
    const fine = live("fine");
    let passes = 0;
    const core = fakeCore({
      subscriptions: () => [failing, fine],
      rows: async () => { if (!failing.ended) throw deleted; return page; },
      deletionPass: async () => { passes++; },
    });
    await createLocalBus(undefined).create(core, { keep: "until-delivered" }).deliver();
    expect([failing.ended, failing.endedWith, fine.ended, fine.fed, passes]).toEqual([true, deleted, false, 1, 1]);
  });

  test("a subscription whose queue passes maxQueue ends with MESH_SUBSCRIPTION_OVERFLOW", async () => {
    const { layer, binding } = await open(localBus({ maxQueue: 2, pollInterval: 20 }), {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivery = await binding.startDelivery();
    try {
      const subscription = await subscribe(binding as never, { name: "slow" }, () => gate);
      for (let i = 0; i < 5; i++) await publish(binding);
      const ended = await Promise.race([subscription.done, sleep(3000).then(() => "timed out")]);
      expect(ended).toBeInstanceOf(SubscriptionOverflowError);
      expect(ended).toMatchObject({ code: "MESH_SUBSCRIPTION_OVERFLOW", retryable: true, subscription: "slow", maxQueue: 2 });
    } finally {
      release();
      await delivery.stop();
      await layer.close();
    }
  });

  test("stop() leaves no timer of the bus's, and a lost claim clears them at once with no report", async () => {
    const counting = countingTimers();
    const reports: unknown[] = [];
    const seen: number[] = [];
    const bus = createLocalBus({ pollInterval: 20 }, { timers: counting.timers, report: (error) => { reports.push(error); } });
    const { layer, binding } = await open(bus, { process: { h: recorder(seen) } });
    let delivery = await binding.startDelivery();
    try {
      expect(counting.live.size).toBe(1);
      await delivery.stop();
      expect(counting.live.size).toBe(0);
      delivery = await binding.startDelivery();
      await publish(binding);
      await until(() => seen.length === 1, "h handles the event");
      // another process takes the claim over: the next round's transaction sees it and the instance ends
      await layer.transaction(async (tx) => {
        const ops = tx as unknown as DeliveryOperations;
        const { generation } = await ops.readDeliveryState();
        await ops.writeClaim({ runId: "00000000-0000-4000-8000-0000000000bb", generation: generation + 1, host: null, pid: null, startedAt: null });
      });
      await publish(binding);
      await until(() => counting.live.size === 0, "the lost instance clears its timers");
      await sleep(60);
      expect(seen).toEqual([1]);
      expect(reports).toEqual([]);
    } finally {
      await delivery.stop().catch(() => undefined);
      await layer.close();
    }
  });
});

describe("localBus and handlers another process holds (MESH_HANDLER_LOST)", () => {
  const lostError = (name: string, position: number) => new HandlerLostError(name, "taken", position, `the handler ${name} was taken over`);
  const page = (positions: number[]) => ({ rows: positions.map((position) => ({ position, name: "x.E" })), deletedThrough: 0, highest: positions.at(-1) ?? 0, settled: positions.at(-1) ?? 0 });

  test("a lost handler in a started round is reported nowhere, schedules no back-off, and the other handlers and the deletion pass go on", async () => {
    const reports: unknown[] = [];
    const ran: string[] = [];
    let passes = 0;
    let listener: (() => void) | undefined;
    const core = fakeCore({
      handlers: [{ name: "a" }, { name: "b" }],
      position: async () => 0,
      rows: async (after: number) => page(after === 0 ? [1] : []),
      lists: () => true,
      runHandler: async (handler: { name: string }, row: { position: number }) => { ran.push(`${handler.name}@${row.position}`); if (handler.name === "a") throw lostError("a", row.position); },
      isRetryable: () => true,
      deletionPass: async () => { passes++; },
      onPublished: (wake: () => void) => { listener = wake; return () => { listener = undefined; }; },
    });
    const counting = countingTimers();
    const instance = createLocalBus({ pollInterval: 60_000, retryDelays: [5] }, { timers: counting.timers, report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
    await instance.start();
    await until(() => passes === 1, "the first round's deletion pass");
    expect(ran).toEqual(["a@1", "b@1"]);
    expect(reports).toEqual([]);
    // no back-off timer was set for the lost handler: only the poll is live
    expect(counting.timeouts()).toBe(0);
    // the next round feeds it again from its cursor while it is still listed
    listener!();
    await until(() => passes === 2, "the next round");
    expect(ran).toEqual(["a@1", "b@1", "a@1", "b@1"]);
    await instance.stop();
    expect(counting.live.size).toBe(0);
  });

  test("a lost handler's position read ends it for the round unreported, in a started round and in deliver()", async () => {
    for (const mode of ["started", "deliver"] as const) {
      const reports: unknown[] = [];
      const read: string[] = [];
      let passes = 0;
      const core = fakeCore({
        handlers: [{ name: "a" }, { name: "b" }],
        position: async (handler: { name: string }) => { read.push(handler.name); if (handler.name === "a") throw lostError("a", 0); return 0; },
        rows: async () => page([]),
        deletionPass: async () => { passes++; },
      });
      const counting = countingTimers();
      const instance = createLocalBus({ pollInterval: 60_000 }, { timers: counting.timers, report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
      if (mode === "started") {
        await instance.start();
        await until(() => passes === 1, "the round's deletion pass");
        await instance.stop();
      } else {
        await instance.deliver();
      }
      expect(read).toEqual(["a", "b"]);
      expect(reports).toEqual([]);
      expect(passes).toBe(1);
      expect(counting.live.size).toBe(0);
    }
  });

  test("in deliver(), core.retry's MESH_HANDLER_LOST is no stop: the round resolves and the other handler is fed", async () => {
    const fed: string[] = [];
    const core = fakeCore({
      handlers: [{ name: "a" }, { name: "b" }],
      position: async () => 0,
      rows: async (after: number) => page(after === 0 ? [1, 2] : []),
      lists: () => true,
      retry: async (handler: { name: string }, row: { position: number }) => { fed.push(`${handler.name}@${row.position}`); if (handler.name === "a") throw lostError("a", row.position); return null; },
    });
    const instance = createLocalBus(undefined).create(core, { keep: "until-delivered" });
    await instance.deliver();
    expect(fed).toEqual(["a@1", "b@1", "b@2"]);
  });

  test("a handler that leaves core.handlers loses its lane: its pending back-off timer is cleared, and it is fed afresh once it is back", async () => {
    const reports: unknown[] = [];
    let handlers = [{ name: "a" }, { name: "b" }];
    let fail = true;
    let passes = 0;
    let listener: (() => void) | undefined;
    const ran: string[] = [];
    const base = fakeCore({
      position: async () => 0,
      rows: async (after: number) => page(after === 0 ? [1] : []),
      lists: () => true,
      runHandler: async (handler: { name: string }) => { ran.push(handler.name); if (handler.name === "a" && fail) throw new Error("flaky"); },
      isRetryable: () => true,
      deletionPass: async () => { passes++; },
      onPublished: (wake: () => void) => { listener = wake; return () => { listener = undefined; }; },
    });
    // core.handlers is read afresh each round
    const core = new Proxy(base, { get: (target, key) => key === "handlers" ? handlers : target[key as keyof BusCore] });
    const counting = countingTimers();
    const instance = createLocalBus({ pollInterval: 60_000, retryDelays: [60_000] }, { timers: counting.timers, report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
    await instance.start();
    await until(() => passes === 1, "the first round");
    // a backs off on its own timer
    expect(counting.live.size).toBe(2);
    handlers = [{ name: "b" }];
    listener!();
    await until(() => passes === 2, "the round after a left");
    expect(counting.live.size).toBe(1);
    // a comes back with no back-off left over: it is fed in the next round, not after the 60 s delay
    fail = false;
    handlers = [{ name: "a" }, { name: "b" }];
    listener!();
    await until(() => passes === 3, "the round after a came back");
    expect(ran.filter((name) => name === "a")).toHaveLength(2);
    expect(reports).toEqual([]);
    await instance.stop();
    expect(counting.live.size).toBe(0);
  });
});

describe("localBus and dead letters (onFailure: \"skip\")", () => {
  const skipper = (seen: number[], broken: Set<number>, retryable?: boolean): Handler & { onFailure: "skip" } => ({
    ...recorder(seen, (event) => { if (broken.has(event.position)) throw Object.assign(new Error(`down at ${event.position}`), retryable === undefined ? {} : { retryable }); }),
    onFailure: "skip",
  });
  const failures = (layer: DataLayer) => layer.transaction((tx) => (tx as unknown as FailureOperations).readFailures("h", null, 100));

  test("started: a skip handler whose retries run out has the event set aside, reports no stop, and handles the next row", async () => {
    const reports: unknown[] = [];
    const seen: number[] = [];
    const counting = countingTimers();
    const bus = createLocalBus({ pollInterval: 20, retryDelays: [5, 5] }, { timers: counting.timers, report: (error) => { reports.push(error); } });
    const { layer, binding } = await open(bus, { process: { h: skipper(seen, new Set([1])) } });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    const delivery = await binding.startDelivery();
    try {
      await sleep(30);
      await publish(binding);
      await publish(binding);
      await until(() => seen.includes(2), "the row after the set-aside one is handled");
      // the first try and both retries on the handler's own timer, then the set-aside
      expect(seen).toEqual([1, 1, 1, 2]);
      expect(counting.timeouts()).toBe(2);
      expect(reports).toEqual([]);
      expect((await failures(layer)).map((row) => [row.position, row.error.message])).toEqual([[1, "down at 1"]]);
      expect(warned.filter((line) => line.includes("set aside"))).toHaveLength(1);
    } finally {
      console.warn = warn;
      await delivery.stop();
      await layer.close();
    }
  });

  test("deliver(): a skip handler's set-aside event is in no HandlerStoppedError, and retryFailed replays it once fixed", async () => {
    const seen: number[] = [];
    const broken = new Set([1]);
    const { layer, binding } = await open(localBus(), { listen: { h: skipper(seen, broken, false) } });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await binding.deliver();
      await publish(binding);
      await publish(binding);
      await binding.deliver();
      expect(seen).toEqual([1, 2]);
      expect((await failures(layer)).map((row) => row.position)).toEqual([1]);
      broken.clear();
      expect(await retryFailed(binding as never, "h")).toEqual({ handled: 1, failed: null });
      expect(seen).toEqual([1, 2, 1]);
      expect(await failures(layer)).toEqual([]);
    } finally {
      console.warn = warn;
      await layer.close();
    }
  });

  /** A core with one skip handler that always fails with retryable: false, whose setAside does `setAside`. */
  function skipCore(setAside: () => Promise<void>, passes: { n: number }, wake: { listener?: () => void }) {
    const ran: number[] = [];
    const core = fakeCore({
      handlers: [{ name: "h", onFailure: "skip" }],
      position: async () => 0,
      rows: async (after: number) => ({ rows: after === 0 ? [{ position: 1, name: "x.E" }] : [], deletedThrough: 0, highest: 1, settled: 1 }),
      lists: () => true,
      runHandler: async (_handler: unknown, row: { position: number }) => { ran.push(row.position); throw Object.assign(new Error("down"), { retryable: false }); },
      isRetryable: (error: { retryable?: boolean }) => error.retryable !== false,
      setAside,
      deletionPass: async () => { passes.n++; },
      onPublished: (listener: () => void) => { wake.listener = listener; return () => { wake.listener = undefined; }; },
    });
    return { core, ran };
  }

  test("started: a set-aside that meets a busy database or a lost claim ends the round, is no stop and reports nothing; the next round tries again", async () => {
    for (const refusal of [new DatabaseBusyError("db", 0), new DelivererLostError("db", "test")]) {
      const reports: unknown[] = [];
      const passes = { n: 0 };
      const wake: { listener?: () => void } = {};
      let calls = 0;
      const { core, ran } = skipCore(async () => { calls++; throw refusal; }, passes, wake);
      const instance = createLocalBus({ pollInterval: 60_000 }, { report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
      await instance.start();
      await until(() => calls === 1, "the first set-aside");
      await sleep(20);
      // the round ended at the set-aside: no deletion pass, nothing reported
      expect(passes.n).toBe(0);
      expect(reports).toEqual([]);
      wake.listener!();
      await until(() => calls === 2, "the next round sets aside again");
      expect(ran).toEqual([1, 1]);
      await instance.stop();
    }
  });

  test("started: a set-aside refused for another reason stops the handler, reported once with the refusal as its cause", async () => {
    const reports: unknown[] = [];
    const passes = { n: 0 };
    const refused = new FrameworkError("core.setAside refused it");
    const { core } = skipCore(async () => { throw refused; }, passes, {});
    const instance = createLocalBus({ pollInterval: 60_000 }, { report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
    await instance.start();
    await until(() => reports.length === 1, "the stop is reported");
    expect((reports[0] as HandlerStoppedError).stopped).toMatchObject([{ handler: "h", position: 1, cause: refused }]);
    await instance.stop();
  });

  test("started: a set-aside refused with MESH_HANDLER_LOST (another process took the handler) is no stop and reports nothing", async () => {
    const reports: unknown[] = [];
    let calls = 0;
    const { core } = skipCore(async () => { calls++; throw new HandlerLostError("h", "taken", 1, "test"); }, { n: 0 }, {});
    const instance = createLocalBus({ pollInterval: 60_000 }, { report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
    await instance.start();
    await until(() => calls === 1, "the set-aside");
    await sleep(20);
    expect(reports).toEqual([]);
    await instance.stop();
  });

  test("started: a skip handler at a row no declared event matches is never set aside: it stops, reported once", async () => {
    const reports: unknown[] = [];
    let calls = 0;
    const undeclared = new EventUndeclaredError("x.Gone", 1);
    const core = fakeCore({
      handlers: [{ name: "h", onFailure: "skip" }], position: async () => 0,
      rows: async (after: number) => ({ rows: after === 0 ? [{ position: 1, name: "x.Gone" }] : [], deletedThrough: 0, highest: 1, settled: 1 }),
      lists: () => true, isRetryable: () => false, setAside: async () => { calls++; },
      runHandler: async () => { throw undeclared; },
      deletionPass: async () => {}, onPublished: () => () => {},
    });
    const instance = createLocalBus({ pollInterval: 60_000 }, { report: (error) => { reports.push(error); } }).create(core, { keep: "until-delivered" });
    await instance.start();
    await until(() => reports.length === 1, "the stop is reported");
    await sleep(20);
    expect(reports).toHaveLength(1);
    expect((reports[0] as HandlerStoppedError).stopped).toMatchObject([{ handler: "h", position: 1, cause: undeclared }]);
    expect(calls).toBe(0);
    await instance.stop();
  });

  test("deliver(): a refused set-aside is the stop, with the refusal as its cause; a busy one rejects the round", async () => {
    const refused = new FrameworkError("core.setAside refused it");
    const { core } = skipCore(async () => { throw refused; }, { n: 0 }, {});
    const retrying = fakeCore({ ...Object.fromEntries(["handlers", "position", "rows", "lists", "isRetryable", "setAside", "deletionPass", "onPublished", "onClaimLost", "subscriptions"].map((key) => [key, (core as unknown as Record<string, unknown>)[key]])),
      retry: async () => ({ handler: "h", position: 1, event: "x.E", cause: new Error("down") }) });
    const error = await rejection(createLocalBus(undefined).create(retrying, { keep: "until-delivered" }).deliver());
    expect((error as HandlerStoppedError).stopped).toMatchObject([{ handler: "h", position: 1, cause: refused }]);
    const busy = new DatabaseBusyError("db", 0);
    const { core: busyCore } = skipCore(async () => { throw busy; }, { n: 0 }, {});
    const busyRetrying = fakeCore({ ...Object.fromEntries(["handlers", "position", "rows", "lists", "isRetryable", "setAside", "deletionPass", "onPublished", "onClaimLost", "subscriptions"].map((key) => [key, (busyCore as unknown as Record<string, unknown>)[key]])),
      retry: async () => ({ handler: "h", position: 1, event: "x.E", cause: new Error("down") }) });
    expect(await rejection(createLocalBus(undefined).create(busyRetrying, { keep: "until-delivered" }).deliver())).toBe(busy);
  });

  test("a skip handler's stop at a row no declared event matches is never set aside: it stops and is reported", async () => {
    let calls = 0;
    const undeclared = new EventUndeclaredError("x.Gone", 1);
    const core = fakeCore({
      handlers: [{ name: "h", onFailure: "skip" }], position: async () => 0,
      rows: async (after: number) => ({ rows: after === 0 ? [{ position: 1, name: "x.Gone" }] : [], deletedThrough: 0, highest: 1, settled: 1 }),
      lists: () => true, setAside: async () => { calls++; },
      retry: async () => ({ handler: "h", position: 1, event: "x.Gone", cause: undeclared }),
    });
    const error = await rejection(createLocalBus(undefined).create(core, { keep: "until-delivered" }).deliver());
    expect((error as HandlerStoppedError).stopped).toMatchObject([{ handler: "h", position: 1, cause: undeclared }]);
    expect(calls).toBe(0);
  });
});
