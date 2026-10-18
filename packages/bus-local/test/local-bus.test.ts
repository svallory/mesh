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
  FrameworkError, HandlerStoppedError, resumeHandler, subscribe, SubscriptionOverflowError,
  type BusCore, type DataLayer, type DeliveryOperations, type EventBus, type TableHandle,
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
function countingTimers(): { live: Set<unknown>; timers: LocalBusTimers; made: () => number } {
  const live = new Set<unknown>();
  let made = 0;
  const timers: LocalBusTimers = {
    setTimeout(run, ms) {
      made++;
      const timer = setTimeout(() => { live.delete(timer); run(); }, ms);
      live.add(timer);
      return timer;
    },
    clearTimeout(timer) { live.delete(timer); clearTimeout(timer as ReturnType<typeof setTimeout>); },
    setInterval(run, ms) { made++; const timer = setInterval(run, ms); live.add(timer); return timer; },
    clearInterval(timer) { live.delete(timer); clearInterval(timer as ReturnType<typeof setInterval>); },
  };
  return { live, timers, made: () => made };
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
  test("its manifest names the adapter and its three capabilities; dead-letters is not one", () => {
    expect(localBus().manifest).toEqual({ adapter: "local", capabilities: ["ordered-delivery", "replay", "subscribe"] });
    expect(Object.isFrozen(localBus())).toBe(true);
    expect(Object.isFrozen(localBus().manifest.capabilities)).toBe(true);
  });

  test.each([
    [{ pollInterval: 0 }, "pollInterval"], [{ pollInterval: -1 }, "pollInterval"], [{ pollInterval: Number.NaN }, "pollInterval"],
    [{ pollInterval: Number.POSITIVE_INFINITY }, "pollInterval"], [{ pollInterval: "1000" }, "pollInterval"],
    [{ retryDelays: [-1] }, "retryDelays"], [{ retryDelays: "100" }, "retryDelays"], [{ retryDelays: [Number.NaN] }, "retryDelays"], [{ retryDelays: [100, "x"] }, "retryDelays"],
    [{ maxQueue: 0 }, "maxQueue"], [{ maxQueue: 1.5 }, "maxQueue"], [{ maxQueue: "10" }, "maxQueue"],
    [{ poll: 10 }, '"poll"'], [null, "takes"], [[], "takes"], ["fast", "takes"],
  ])("a wrong option %p is a FrameworkError naming it", (options, named) => {
    let thrown: unknown;
    try { localBus(options as never); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FrameworkError);
    expect((thrown as Error).message).toContain(named);
  });

  test("an empty retryDelays and the edges of each option are accepted", () => {
    expect(() => localBus({ retryDelays: [], pollInterval: 0.5, maxQueue: 1 })).not.toThrow();
    expect(() => localBus({})).not.toThrow();
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
    const bus = createLocalBus({ pollInterval: 20 }, { report: (error) => { reports.push(error); } });
    const { layer, binding } = await open(bus, { process: {
      a: recorder(a, () => { if (broken) throw Object.assign(new Error("refused"), { retryable: false }); }),
      b: recorder(b),
    } });
    const delivery = await binding.startDelivery();
    try {
      await sleep(30);
      const published = Date.now();
      await publish(binding);
      await until(() => reports.length === 1, "the stop is reported");
      // well under the first default delay, 100 ms
      expect(Date.now() - published).toBeLessThan(90);
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

  test("resumeHandler is a FrameworkError on a started bus whose instance cannot resume", async () => {
    const { layer, binding } = await open(testBus({ pollMs: 20 }), { process: { h: recorder([]) } });
    const delivery = await binding.startDelivery();
    try {
      const refused = await rejection(resumeHandler(binding as never, "h"));
      expect(refused).toBeInstanceOf(FrameworkError);
      expect((refused as Error).message).toContain("the bus test cannot resume a handler");
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
