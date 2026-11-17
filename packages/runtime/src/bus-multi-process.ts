import type { BusCore, EventBus, Handler } from "./bus.ts";
import type { DataLayer, DataOperations, DeliveryOperations, FailureOperations, HandlerLeaseRow, MultiProcessOperations, OutboxRow } from "./data-layer.ts";
import { DECLARATION, type Declaration } from "./declarations.ts";
import { PID, adoptByName, forgetByName, keepByValue, resumeHandler, retryFailed, setDeliveryTiming, subscribe, type Subscription } from "./deliverer.ts";
import { bindDomain, type AsyncFrame, type Binding } from "./entity.ts";
import { DatabaseBusyError, DelivererLostError, DelivererTakenError, EventUndeclaredError, FrameworkError, HandlerLostError, HandlerStoppedError } from "./errors.ts";
import { publishEvent, type EventRecord, type EventsModule } from "./events.ts";

/**
 * The "multi-process" group of the event-bus conformance suite (delivery from several processes, design
 * `notes/architecture/m9-multi-process-design.md`, section 8), and `runMultiProcessWorker`, the body of the second
 * process each adapter's worker script runs. The group runs when the fixture has `multiProcess` and the bus declares
 * `multi-process`. Checks in one process stand for the other processes by writing their rows (a live process row, a
 * lease, a union); the others spawn workers, one OS process each, on a file database.
 */

/** A worker process the suite started on a file database. */
export interface MultiProcessWorker {
  readonly pid: number;
  kill(signal: "SIGKILL" | "SIGTERM" | "SIGSTOP" | "SIGCONT"): void;
  /** What it wrote to stdout so far. */
  output(): string;
  /** Resolves with all it wrote to stdout once it exits. */
  readonly done: Promise<string>;
}

/** What the multi-process group needs from the adapter under test, beside `BusConformanceFixture`. */
export interface MultiProcessFixture {
  /** A fresh file database whose schema was built for a bus that declares `multi-process`, and a layer over it. */
  makeFileLayer(): Promise<{ readonly file: string; readonly layer: DataLayer }>;
  /**
   * Start a worker process on `file` whose script calls `runMultiProcessWorker(scenario, args, bus, layer)` with the bus
   * under test (and a layer over `file`); resolves once it printed `READY`, that is once it has registered.
   */
  spawn(file: string, scenario: string, args?: readonly string[]): Promise<MultiProcessWorker>;
}

/** An event class shaped as `mesh build` generates one. */
function eventClass(fqn: string) {
  const name = fqn.slice(fqn.lastIndexOf(".") + 1);
  const made = {
    [name]: class {
      readonly #brand = true;
      static readonly [DECLARATION]: Declaration = {
        kind: "event", fqn, is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value,
      };
      readonly n: number;
      constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
    },
  };
  return made[name]!;
}
const Alpha = eventClass("multi.Alpha");
const Beta = eventClass("multi.Beta");
const Echo = eventClass("multi.Echo");
const Gone = eventClass("multi.Gone");
type EventType = typeof Alpha;
const FULL = Object.freeze({ Alpha, Beta, Echo });
/** An older build: it does not declare `multi.Beta`. */
const WITHOUT_BETA = Object.freeze({ Alpha, Echo });
/** A build that still declares `multi.Gone`, which the others do not. */
const WITH_GONE = Object.freeze({ Alpha, Beta, Echo, Gone });

const CLOCK = () => new Date();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Ops = DataOperations & DeliveryOperations & MultiProcessOperations & FailureOperations;
const ops = (tx: DataOperations) => tx as Ops;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Bus conformance (multi-process): ${message}`);
}
async function until(test: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`Bus conformance (multi-process): timed out waiting until ${what}`);
    await sleep(10);
  }
}
/**
 * The check's own call `run`, made again while it fails with a serialization failure or a deadlock, for up to 5 s: on a
 * server at `SERIALIZABLE` a check's read or publish beside a working worker can fail so, which Mesh leaves to the
 * caller to repeat. A lock wait (`locked`, `lock-timeout`) is not repeated: it means a transaction held a row longer
 * than it should, and the check fails on it.
 */
async function again<T>(run: () => Promise<T>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    try { return await run(); }
    catch (error) {
      const transient = error instanceof DatabaseBusyError && (error.reason === "serialization" || error.reason === "deadlock");
      if (!transient || Date.now() > end) throw error;
      await sleep(10);
    }
  }
}
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}

/** A process handler that publishes one `Echo` per event it handles, in its own transaction: the record that it ran. */
function echoing(layer: DataLayer, events: readonly EventType[], extra: Partial<Handler<object>> = {}): Handler<object> {
  return {
    events, ...extra,
    run: async (event: EventRecord<object>) => {
      await layer.transaction((tx) => publishEvent(tx, undefined, { entity: "multi.Thing", action: "echo", key: { id: "e" }, at: "multi" }, new Echo({ n: event.position }), {}, CLOCK));
    },
  };
}

/** The handlers and domain of each scenario, shared by the suite and the workers so both build the same handlers. */
function scenario(name: string, layer: DataLayer, print: (line: string) => void): { domain: object; module: EventsModule } {
  const listen = (handler: string, events: readonly EventType[], body?: (event: EventRecord<object>) => Promise<void>): Handler<object> => ({
    events, run: async (event) => { print(`SEEN ${handler} ${event.position}`); await body?.(event); },
  });
  switch (name) {
    // Two handlers of the same build: one that writes in its transaction, one that runs outside any.
    case "basic": return { domain: FULL, module: { handlers: { process: { count: echoing(layer, [Alpha]) }, listen: { log: listen("log", [Alpha]) } } } };
    // A listen body that takes long enough for the test to pause the process inside it.
    case "slow-listen": return { domain: FULL, module: { handlers: { listen: { slow: listen("slow", [Alpha], async (event) => { print(`BODY ${event.position}`); await sleep(400); print(`DONE ${event.position}`); }) } } } };
    // An older build of the handler h, which lists Alpha only.
    case "old-list": return { domain: FULL, module: { handlers: { process: { h: echoing(layer, [Alpha]) } } } };
    case "new-list": return { domain: FULL, module: { handlers: { process: { h: echoing(layer, [Alpha, Beta]) } } } };
    // An older build that does not declare Beta at all, with a second handler that never lists it.
    case "old-build": return { domain: WITHOUT_BETA, module: { handlers: { process: { h: echoing(layer, [Alpha]), h2: echoing(layer, [Alpha]) } } } };
    case "new-build": return { domain: FULL, module: { handlers: { process: { h: echoing(layer, [Alpha, Beta]), h2: echoing(layer, [Alpha]) } } } };
    case "rename-old": return { domain: FULL, module: { handlers: { process: { before: echoing(layer, [Alpha]) } } } };
    case "rename-new": return { domain: FULL, module: { handlers: { process: { after: echoing(layer, [Alpha], { renamedFrom: "before" }) } } } };
    case "empty": return { domain: FULL, module: {} };
    default: throw new FrameworkError(`runMultiProcessWorker: no scenario named ${JSON.stringify(name)}`);
  }
}

/** The bus without `multi-process`: the same adapter, delivering in single mode. */
function singleMode(bus: EventBus): EventBus {
  return Object.freeze({ manifest: Object.freeze({ ...bus.manifest, capabilities: Object.freeze(bus.manifest.capabilities.filter((name) => name !== "multi-process")) }), create: bus.create.bind(bus) });
}

/** `bus` with `onCore` called with the core it is handed, for checks that call core as a bus would. */
function watched(bus: EventBus, onCore: (core: BusCore) => void): EventBus {
  return Object.freeze({ manifest: bus.manifest, create: (core: BusCore, options: { readonly keep: "until-delivered" | "all" }) => { onCore(core); return bus.create(core, options); } });
}

/** `bus` with every `runHandler` rejection and every stop `retry` returns recorded, with the position of the row. */
function rejecting(bus: EventBus, rejected: { position: number; error: unknown }[]): EventBus {
  return Object.freeze({
    manifest: bus.manifest,
    create: (core: BusCore, options: { readonly keep: "until-delivered" | "all" }) => {
      // Core is a frozen object of closures: copy its descriptors (the handlers getter stays live) and replace runHandler.
      const runHandler: BusCore["runHandler"] = async (handler, row) => {
        try { return await core.runHandler(handler, row); } catch (error) { rejected.push({ position: row.position, error }); throw error; }
      };
      const retry: BusCore["retry"] = async (handler, row, delays) => {
        const stop = await core.retry(handler, row, delays);
        if (stop) rejected.push({ position: row.position, error: stop.cause });
        return stop;
      };
      return bus.create(Object.freeze(Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(core),
        runHandler: { value: runHandler, enumerable: true },
        retry: { value: retry, enumerable: true },
      })) as BusCore, options);
    },
  });
}

/** What a worker script hands `runMultiProcessWorker`: the bus under test, a layer over the file, the project's async frame. */
export interface MultiProcessWorkerParts {
  readonly bus: EventBus;
  readonly layer: DataLayer;
  readonly frame: AsyncFrame;
}

/**
 * The body of a worker process of the multi-process group: binds the scenario's handlers with the bus on the layer and
 * starts delivery with the group's timing (renewal every 50 ms, lapse at 300 ms); it prints lines for what it sees
 * (`SEEN <handler> <position>`, `BODY`, `DONE`, `LOST <code>`, `SUBSCRIBED`) to stdout. Resolves once it has registered,
 * with `stop()`, which closes its subscription, stops delivery and closes the layer. The script prints `READY <pid>`
 * then, and calls `stop()` on `SIGTERM` before it prints `STOPPED` and exits. Flags in `args`: `--keep=all`, `--single`
 * (the bus without `multi-process`), `--subscribe=<name>`.
 */
export async function runMultiProcessWorker(name: string, args: readonly string[], parts: MultiProcessWorkerParts): Promise<{ stop(): Promise<void> }> {
  const { bus, layer, frame } = parts;
  const print = (line: string) => { console.log(line); };
  setDeliveryTiming({ renewMs: 50, lapseMs: 300 });
  const keep = args.includes("--keep=all") ? "all" as const : "until-delivered" as const;
  const used = watched(args.includes("--single") ? singleMode(bus) : bus, (core) => { core.onClaimLost((error) => print(`LOST ${(error as { code?: string }).code ?? "?"}`)); });
  const { domain, module } = scenario(name, layer, print);
  const binding = bindDomain(domain, layer, { events: { bus: used, keep, load: async () => module } }, frame);
  const delivery = await binding.startDelivery();
  const subscribeTo = args.find((arg) => arg.startsWith("--subscribe="))?.slice("--subscribe=".length);
  let subscription: Subscription | undefined;
  if (subscribeTo !== undefined) {
    subscription = await subscribe(binding, { name: subscribeTo, after: 0 }, () => {});
    print("SUBSCRIBED");
  }
  return {
    async stop() {
      await subscription?.close();
      await delivery.stop().catch((error: unknown) => print(`STOP-FAILED ${String(error)}`));
      await layer.close().catch(() => undefined);
    },
  };
}

/** The multi-process checks, named and runner-independent like the rest of the suite. */
export function multiProcessChecks(
  fixture: MultiProcessFixture & { makeLayer(): Promise<DataLayer>; frame(): AsyncFrame },
  bus: () => EventBus,
): Record<string, () => Promise<void>> {
  const checks: Record<string, () => Promise<void>> = {};
  const posix = (globalThis as { process?: { platform?: string } }).process?.platform !== "win32";

  /** One check: a layer (a file when `file` is set), the workers it spawns, and every delivery it starts, all ended after it. */
  interface Ctx {
    readonly layer: DataLayer;
    readonly file: string;
    readonly frame: AsyncFrame;
    readonly seen: Map<string, number[]>;
    readonly bus: EventBus;
    bind(domain: object, module: EventsModule, options?: { bus?: EventBus; keep?: "until-delivered" | "all" }): Binding;
    /** The scenario's handlers in this process, with a recorder in front of each body. */
    scenario(name: string, options?: { bus?: EventBus; keep?: "until-delivered" | "all" }): Binding;
    start(binding: Binding): Promise<{ stop(): Promise<void> }>;
    spawn(scenario: string, args?: readonly string[]): Promise<MultiProcessWorker>;
    publish(binding: Binding, ...events: [EventType, number][]): Promise<number[]>;
    leases(): Promise<readonly HandlerLeaseRow[]>;
    lease(name: string): Promise<HandlerLeaseRow | undefined>;
    /** Every row the outbox holds. */
    outbox(): Promise<OutboxRow[]>;
    /** The positions of the events each `Echo` names as its cause, by the cause's position. */
    echoed(): Promise<Map<number, number>>;
    writeFake(runId: string, handlers: Record<string, readonly string[]>, declared: readonly string[], keep?: "until-delivered" | "all"): Promise<void>;
  }
  const add = (name: string, options: { file?: boolean; timing?: { renewMs: number; lapseMs: number } }, run: (ctx: Ctx) => Promise<void>) => {
    checks[`[multi-process] ${name}`] = async () => {
      const made = options.file ? await fixture.makeFileLayer() : { file: "", layer: await fixture.makeLayer() };
      const { layer, file } = made;
      const workers: MultiProcessWorker[] = [];
      const stops: (() => Promise<void>)[] = [];
      const seen = new Map<string, number[]>();
      const frame = fixture.frame();
      const underTest = bus();
      setDeliveryTiming(options.timing ?? { renewMs: 50, lapseMs: 300 });
      const ctx: Ctx = {
        layer, file, frame, seen, bus: underTest,
        bind(domain, module, bindOptions = {}) {
          return bindDomain(domain, layer, { events: { bus: bindOptions.bus ?? underTest, keep: bindOptions.keep ?? "until-delivered", load: async () => module } }, frame);
        },
        scenario(name, bindOptions = {}) {
          const { domain, module } = scenario(name, layer, () => {});
          const recorded: EventsModule = { handlers: {} };
          for (const kind of ["process", "listen"] as const) {
            const entries = Object.entries(module.handlers?.[kind] ?? {});
            if (entries.length === 0) continue;
            (recorded.handlers as Record<string, Record<string, Handler<object>>>)[kind] = Object.fromEntries(entries.map(([handler, value]) => [handler, {
              ...value, run: async (event: EventRecord<object>, tools: { context: object }) => {
                seen.set(handler, [...(seen.get(handler) ?? []), event.position]);
                await (value as Handler<object>).run(event, tools as never);
              },
            }]));
          }
          return ctx.bind(domain, recorded, bindOptions);
        },
        async start(binding) {
          const delivery = await binding.startDelivery();
          stops.push(() => delivery.stop());
          return delivery;
        },
        async spawn(name, args = []) {
          const worker = await fixture.spawn(file, name, args);
          workers.push(worker);
          return worker;
        },
        publish(binding, ...events) {
          return again(() => binding.transaction(() => layer.transaction(async (tx) => {
            const positions: number[] = [];
            for (const [Class, n] of events)
              positions.push((await publishEvent(tx, undefined, { entity: "multi.Thing", action: "make", key: { id: `k${n}` }, at: "multi" }, new Class({ n }), {}, CLOCK)).position);
            return positions;
          })));
        },
        leases: () => again(() => layer.transaction((tx) => ops(tx).readHandlerLeases())),
        lease: async (name) => (await ctx.leases()).find((row) => row.name === name),
        async outbox() {
          const rows: OutboxRow[] = [];
          let after = 0;
          for (;;) {
            const page = await layer.readOutbox!(after, 500);
            rows.push(...page.rows);
            if (page.rows.length < 500) break;
            after = page.rows.at(-1)!.position;
          }
          return rows;
        },
        async echoed() {
          const rows = await ctx.outbox();
          const byId = new Map(rows.map((row) => [row.id, row.position]));
          const counts = new Map<number, number>();
          for (const row of rows) {
            if (row.name !== "multi.Echo" || row.causedBy === null) continue;
            const cause = byId.get(row.causedBy)!;
            counts.set(cause, (counts.get(cause) ?? 0) + 1);
          }
          return counts;
        },
        writeFake: (runId, handlers, declared, keep = "until-delivered") =>
          again(() => layer.transaction((tx) => ops(tx).writeProcess({ runId, host: "elsewhere", pid: 4242, startedAt: null, keep, handlers, declared }))),
      };
      try {
        await run(ctx);
      } finally {
        for (const worker of workers) { worker.kill("SIGCONT"); worker.kill("SIGKILL"); }
        await Promise.all(workers.map((worker) => worker.done.catch(() => undefined)));
        for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
        setDeliveryTiming(null);
        await sleep(5);
        await layer.close();
      }
    };
  };
  const OTHER = "00000000-0000-4000-8000-0000000000e1";
  const IN_PROCESS = { renewMs: 30, lapseMs: 1500 };
  /**
   * Pause `worker` where it holds no transaction: a process paused inside one keeps its locks (on SQLite the write lock;
   * on a server the rows it locked, such as mesh_outbox_state and a progress row), so every other process waits for it.
   * A short transaction that takes the locks a takeover takes tells; until one goes through, resume it and try again. On a
   * server a statement the worker sent before it stopped still runs and may take its locks once the probe ends, so the
   * probe must go through twice.
   */
  const pause = async (ctx: Ctx, worker: MultiProcessWorker) => {
    const free = (tx: DataOperations) => (async () => {
      await ops(tx).lockDeliveryState();
      for (const lease of await ops(tx).readHandlerLeases()) await ops(tx).lockHandlerProgress(lease.name);
      return true;
    })();
    for (let attempt = 0; attempt < 50; attempt++) {
      worker.kill("SIGSTOP");
      await sleep(10);
      const probe = () => ctx.layer.transaction(free, { waitMs: 150 }).catch(() => false);
      if (await probe() && (await sleep(20), await probe())) return;
      worker.kill("SIGCONT");
      await sleep(15 + attempt);
    }
    throw new Error("Bus conformance (multi-process): could not pause the worker outside a transaction");
  };
  const pidOf = async (ctx: Ctx, runId: string | null) => runId === null ? null : (await again(() => ctx.layer.transaction((tx) => ops(tx).readProcesses()))).find((row) => row.runId === runId)?.pid ?? null;
  const ownRunId = async (ctx: Ctx) => (await again(() => ctx.layer.transaction((tx) => ops(tx).readProcesses()))).find((row) => row.pid === PID && row.host !== "elsewhere")?.runId;

  // ---- in one process, the others' rows written by the check ----

  add("a single process in multi mode delivers as single mode does: it writes its process row and the nil claim, takes every lease, and releases them at stop", { timing: IN_PROCESS }, async (ctx) => {
    const binding = ctx.scenario("basic", { keep: "all" });
    const delivery = await ctx.start(binding);
    const state = await ctx.layer.transaction((tx) => ops(tx).lockDeliveryState());
    assert(state.claim?.runId === "00000000-0000-0000-0000-000000000000" && state.claim.pid === null && state.claim.host === null, `the claim is the nil claim, got ${JSON.stringify(state.claim)}`);
    assert(state.keep === "all", "a process with keep: \"all\" records it");
    const runId = await ownRunId(ctx);
    assert(runId !== undefined, "this process wrote its row");
    const [p] = await ctx.publish(binding, [Alpha, 1]);
    await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= p! && ((await ctx.lease("log"))?.position ?? -1) >= p!, "both handlers handled the event");
    for (const name of ["count", "log"]) {
      const lease = await ctx.lease(name);
      assert(lease?.runId === runId && lease.generation === 1, `${name} is held by this process at generation 1, got ${JSON.stringify(lease)}`);
    }
    assert((await ctx.echoed()).get(p!) === 1, "the process handler ran once");
    await delivery.stop();
    const after = await ctx.layer.transaction(async (tx) => ({ state: await ops(tx).readDeliveryState(), processes: await ops(tx).readProcesses(), leases: await ops(tx).readHandlerLeases() }));
    assert(after.state.claim === null && after.processes.length === 0, "the last process to stop clears the nil claim and deletes its row");
    assert(after.leases.every((lease) => lease.runId === null), "stop releases every lease");
  });

  add("a lease another process took over: runHandler and position reject with MESH_HANDLER_LOST (taken), record nothing, and the handler leaves core.handlers", { timing: IN_PROCESS }, async (ctx) => {
    let core: BusCore | undefined;
    const binding = ctx.scenario("old-list", { bus: watched(ctx.bus, (handed) => { core = handed; }), keep: "all" });
    await ctx.start(binding);
    const handler = core!.handlers.find((each) => each.name === "h")!;
    assert(handler !== undefined, "h is held");
    await ctx.writeFake(OTHER, { h: ["multi.Alpha"] }, ["multi.Alpha", "multi.Beta", "multi.Echo"]);
    await ctx.layer.transaction(async (tx) => {
      const lease = (await ops(tx).lockHandlerProgress("h"))!;
      await ops(tx).writeHandlerLease({ ...lease, runId: OTHER, generation: lease.generation + 1 });
    });
    const publisher = ctx.bind(FULL, {});
    const [p] = await ctx.publish(publisher, [Alpha, 1]);
    const row = (await ctx.layer.readOutbox!(p! - 1, 1)).rows[0]!;
    const taken = await rejection(() => core!.runHandler(handler, row));
    assert(taken instanceof HandlerLostError && taken.reason === "taken" && taken.handler === "h" && taken.position === p && !taken.retryable, `runHandler gave ${String(taken)}`);
    assert(!core!.handlers.some((each) => each.name === "h"), "a lost lease leaves core.handlers");
    const again = await rejection(() => core!.runHandler(handler, row));
    assert(again instanceof HandlerLostError && again.reason === "taken", `a registered handler not held gives MESH_HANDLER_LOST, got ${String(again)}`);
    assert(await rejection(() => core!.position(handler)) instanceof HandlerLostError, "position of a handler not held is MESH_HANDLER_LOST");
    const retried = await rejection(() => core!.retry(handler, row, [0, 0]));
    assert(retried instanceof HandlerLostError, `retry rethrows MESH_HANDLER_LOST instead of counting a try, got ${String(retried)}`);
    assert(!(await ctx.echoed()).has(p!), "nothing was handled");
    const lease = await ctx.lease("h");
    assert(lease?.runId === OTHER && lease.position < p!, "the other process's lease and position are untouched");
  });

  if (bus().manifest.capabilities.includes("dead-letters")) add("dead letters: retryFailed for a handler whose lease another live process holds is MESH_HANDLER_LOST, replays nothing and keeps the row; once this process holds it, it replays", { timing: IN_PROCESS }, async (ctx) => {
    const publisher = ctx.bind(FULL, {});
    const [p] = await ctx.publish(publisher, [Alpha, 1]);
    const row = (await ctx.layer.readOutbox!(p! - 1, 1)).rows[0]!;
    await ctx.writeFake(OTHER, { h: ["multi.Alpha"] }, ["multi.Alpha", "multi.Beta", "multi.Echo"]);
    await ctx.layer.transaction(async (tx) => {
      await ops(tx).writeHandlerLease({ name: "h", kind: "process", position: p!, events: ["multi.Alpha"], generation: 1, runId: OTHER });
      await ops(tx).writeFailure({ ...row, handler: "h", error: { code: null, message: "down" } });
    });
    const binding = ctx.scenario("old-list");
    const lost = await rejection(() => retryFailed(binding, "h"));
    assert(lost instanceof HandlerLostError && lost.handler === "h" && lost.message.includes("does not hold the handler's lease"), `got ${String(lost)}`);
    assert(!ctx.seen.has("h"), "the handler ran in a process that does not hold it");
    assert((await ctx.layer.transaction((tx) => ops(tx).readFailures("h", null, 10))).length === 1, "the set-aside event was removed");
    assert((await ctx.lease("h"))?.runId === OTHER, "the other process's lease was taken or cleared");
    // The other process is gone (its row deleted): the call takes the free lease for itself and replays the event.
    await ctx.layer.transaction((tx) => ops(tx).deleteProcess(OTHER));
    const result = await retryFailed(binding, "h");
    assert(result.handled === 1 && result.failed === null && JSON.stringify(ctx.seen.get("h")) === JSON.stringify([p]), `got ${JSON.stringify(result)} and ${JSON.stringify(ctx.seen.get("h"))}`);
    assert((await ctx.lease("h"))?.runId === null, "the call releases the lease it took");
  });

  if (bus().manifest.capabilities.includes("dead-letters")) for (const kind of ["process", "listen"] as const) add(`dead letters: a ${kind} handler replayed by retryFailed whose lease another process takes while its body runs: the call rejects with MESH_HANDLER_LOST naming the event, and keeps the event it had not removed`, { timing: IN_PROCESS }, async (ctx) => {
    const publisher = ctx.bind(FULL, {});
    const published = await ctx.publish(publisher, [Alpha, 1], [Alpha, 2]);
    const rows = (await ctx.layer.readOutbox!(published[0]! - 1, 2)).rows;
    await ctx.writeFake(OTHER, { h: ["multi.Alpha"] }, ["multi.Alpha", "multi.Beta", "multi.Echo"]);
    await ctx.layer.transaction(async (tx) => {
      await ops(tx).writeHandlerLease({ name: "h", kind, position: published[1]!, events: ["multi.Alpha"], generation: 1, runId: null });
      for (const row of rows) await ops(tx).writeFailure({ ...row, handler: "h", error: { code: null, message: "down" } });
    });
    let moved = false;
    const ran: number[] = [];
    const binding = ctx.bind(FULL, { handlers: { [kind]: { h: { events: [Alpha], onFailure: "skip" as never, run: async (event: EventRecord<object>) => {
      ran.push(event.position);
      if (moved) return;
      moved = true;
      await ctx.layer.transaction(async (tx) => {
        const lease = (await ops(tx).lockHandlerProgress("h"))!;
        await ops(tx).writeHandlerLease({ ...lease, runId: OTHER, generation: lease.generation + 1 });
      });
    } } } } });
    const lost = await rejection(() => retryFailed(binding, "h"));
    // A process body commits with the removal it shares a transaction with, and the next event's fence fails; a listen
    // body runs outside, and the transaction that would remove its row is the one fenced.
    const at = kind === "process" ? published[1] : published[0];
    assert(lost instanceof HandlerLostError && lost.handler === "h" && lost.reason === "taken" && lost.position === at, `got ${String(lost)}${lost instanceof HandlerLostError ? ` at ${lost.position}` : ""}`);
    const kept = (await ctx.layer.transaction((tx) => ops(tx).readFailures("h", null, 10))).map((row) => row.position);
    const expected = kind === "process" ? published.slice(1) : published;
    assert(JSON.stringify(kept) === JSON.stringify(expected), `the rows kept were ${JSON.stringify(kept)}, expected ${JSON.stringify(expected)}`);
    assert(JSON.stringify(ran) === JSON.stringify(published.slice(0, 1)), `the handler ran after its lease moved: ${JSON.stringify(ran)}`);
    assert((await ctx.lease("h"))?.runId === OTHER, "the other process's lease was cleared or taken back");
  });

  add("a row of an event in the handler's union and not in its list yields the handler: no row is passed, the lease is cleared, and it is not taken again until resumeHandler", { timing: IN_PROCESS }, async (ctx) => {
    const binding = ctx.scenario("old-list", { keep: "all" });
    await ctx.start(binding);
    const publisher = ctx.bind(FULL, {});
    const [a1] = await ctx.publish(publisher, [Alpha, 1]);
    await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= a1!, "h handled the first Alpha");
    // Another build registers h with [Alpha, Beta]: its process row lives, and the union grows (rule R1).
    await ctx.writeFake(OTHER, { h: ["multi.Alpha", "multi.Beta"] }, ["multi.Alpha", "multi.Beta", "multi.Echo"]);
    await ctx.layer.transaction(async (tx) => {
      const lease = (await ops(tx).lockHandlerProgress("h"))!;
      await ops(tx).writeHandlerLease({ ...lease, events: ["multi.Alpha", "multi.Beta"] });
    });
    // No tick in between: the holder's snapshot predates the union, so the bus passes Beta and hands it Alpha 3.
    const [b2, a3] = await ctx.publish(publisher, [Beta, 2], [Alpha, 3]);
    await until(async () => (await ctx.lease("h"))?.runId === null, "h yielded and cleared its lease");
    const lease = (await ctx.lease("h"))!;
    assert(lease.position >= a1! && lease.position < b2!, `no row was passed: h waits below the Beta row ${b2}, got ${lease.position}`);
    assert(JSON.stringify(ctx.seen.get("h")) === JSON.stringify([a1]), `only the first Alpha was handled here, got ${JSON.stringify(ctx.seen.get("h"))}`);
    await sleep(150);
    assert((await ctx.lease("h"))?.runId === null, "a yielded handler is not taken again while its union is unchanged");
    // The other build handles Beta 2, as its holder would, and stops; then this process resumes h.
    await ctx.layer.transaction(async (tx) => {
      const current = (await ops(tx).lockHandlerProgress("h"))!;
      await ops(tx).writeHandlerLease({ ...current, position: b2!, generation: current.generation + 1 });
      await ops(tx).deleteProcess(OTHER);
    });
    await resumeHandler(binding, "h");
    await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= a3!, "after resumeHandler h is taken and handles Alpha 3");
    assert(JSON.stringify(ctx.seen.get("h")) === JSON.stringify([a1, a3]), `got ${JSON.stringify(ctx.seen.get("h"))}`);
  });

  add("an event only another live build declares is passed, and its row deleted, by a handler whose union lacks it; one no live build declares stops the handler with MESH_EVENT_UNDECLARED and is kept", { timing: IN_PROCESS }, async (ctx) => {
    const binding = ctx.scenario("old-list");
    await binding.deliver();
    const publisher = ctx.bind(WITH_GONE, {});
    // multi.Gone is declared by a live process row of another build: h passes its row (rule R2(d)), and the deletion
    // pass deletes over it (rule K1), since a live build declares it.
    await ctx.writeFake(OTHER, {}, ["multi.Alpha", "multi.Beta", "multi.Echo", "multi.Gone"]);
    const [g1, a2] = await ctx.publish(publisher, [Gone, 1], [Alpha, 2]);
    await binding.deliver();
    assert(JSON.stringify(ctx.seen.get("h")) === JSON.stringify([a2]), `h passed the Gone row and handled Alpha 2, got ${JSON.stringify(ctx.seen.get("h"))}`);
    assert(!(await ctx.outbox()).some((row) => row.position === g1), "the passed Gone row, which a live build declares, was deleted");
    // Once no live build declares it, a Gone row stops the handler there (rule R2(e)) and is never deleted (rule R4).
    await ctx.layer.transaction((tx) => ops(tx).deleteProcess(OTHER));
    const [g3, a4] = await ctx.publish(publisher, [Gone, 3], [Alpha, 4]);
    const error = await rejection(() => binding.deliver());
    assert(error instanceof HandlerStoppedError, `deliver() was to reject with MESH_HANDLER_STOPPED, and ${error === undefined ? "resolved" : `rejected with ${String(error)}`}`);
    const [stop, ...rest] = error.stopped;
    assert(rest.length === 0 && stop?.handler === "h" && stop.position === g3, `h alone stops at the undeclared row ${g3}, got ${JSON.stringify(error.stopped.map(({ handler, position }) => ({ handler, position })))}`);
    assert(stop.cause instanceof EventUndeclaredError && stop.cause.eventName === "multi.Gone" && stop.cause.position === g3, `the stop's cause is MESH_EVENT_UNDECLARED for multi.Gone at ${g3}, got ${String(stop.cause)}`);
    assert(((await ctx.lease("h"))?.position ?? -1) < g3!, "h's position stays below the undeclared row");
    assert((await ctx.outbox()).some((row) => row.position === g3), "the undeclared row was deleted");
    assert(!(ctx.seen.get("h") ?? []).includes(a4!), "the Alpha after it was not handled");
  });

  add("a started handler that meets a row no live build declares stops with MESH_EVENT_UNDECLARED, not a yield, and keeps its lease", { timing: IN_PROCESS }, async (ctx) => {
    const rejected: { position: number; error: unknown }[] = [];
    const binding = ctx.scenario("old-list", { bus: rejecting(ctx.bus, rejected) });
    await ctx.start(binding);
    const runId = await ownRunId(ctx);
    const taken = (await ctx.lease("h"))!;
    assert(taken.runId === runId, "h is held by this process");
    const [g1, a2] = await ctx.publish(ctx.bind(WITH_GONE, {}), [Gone, 1], [Alpha, 2]);
    await until(() => rejected.length > 0, "the bus handed h a row and it was refused");
    await sleep(100);
    const [first] = rejected;
    assert(first!.error instanceof EventUndeclaredError && first!.error.eventName === "multi.Gone" && first!.error.position === g1,
      `the refusal is MESH_EVENT_UNDECLARED for multi.Gone at ${g1}, got ${String(first!.error)}`);
    const lease = (await ctx.lease("h"))!;
    assert(lease.runId === runId && lease.generation === taken.generation && lease.position < g1!, `h stopped, not yielded: it keeps its lease below the Gone row, got ${JSON.stringify(lease)}`);
    assert(!(ctx.seen.get("h") ?? []).includes(a2!), "the Alpha after it was not handled");
  });

  add("a row no live build declares that a stale snapshot passed is met by the fence below the next listed row, and refused as MESH_EVENT_UNDECLARED naming that row", { timing: IN_PROCESS }, async (ctx) => {
    let core: BusCore | undefined;
    // A bus that never delivers, so the check alone hands core its rows.
    const inert: EventBus = Object.freeze({
      manifest: ctx.bus.manifest,
      create: (handed: BusCore) => { core = handed; return { start: async () => {}, stop: async () => {}, deliver: async () => {} }; },
    });
    // The build that declares multi.Gone is live at registration, so this process's snapshot knows Gone (rule R3).
    await ctx.writeFake(OTHER, {}, ["multi.Alpha", "multi.Beta", "multi.Echo", "multi.Gone"]);
    await ctx.start(ctx.scenario("old-list", { bus: inert }));
    const handler = core!.handlers.find((each) => each.name === "h")!;
    assert(handler !== undefined, "h is held");
    const [g1, a2] = await ctx.publish(ctx.bind(WITH_GONE, {}), [Gone, 1], [Alpha, 2]);
    const rows = (await ctx.layer.readOutbox!(g1! - 1, 2)).rows;
    assert(!core!.lists(handler, rows[0]!), "the snapshot knows Gone, so the bus would pass its row");
    await ctx.layer.transaction((tx) => ops(tx).deleteProcess(OTHER));
    const refused = await rejection(() => core!.runHandler(handler, rows[1]!));
    assert(refused instanceof EventUndeclaredError && refused.eventName === "multi.Gone" && refused.position === g1,
      `runHandler for Alpha ${a2} is refused with MESH_EVENT_UNDECLARED for multi.Gone at ${g1}, not the fence's internal marker, got ${String(refused)}`);
    assert(!(await ctx.echoed()).has(a2!), "nothing was handled");
    assert(core!.handlers.some((each) => each.name === "h"), "a stop is not a lost lease: h is still held");
  });

  add("a release that failed leaves leases naming this process; a later deliver() round of the same process takes them again", { timing: IN_PROCESS }, async (ctx) => {
    let runId: string | undefined;
    const module: EventsModule = { handlers: { process: { h: { events: [Alpha], run: async () => { runId = await ownRunId(ctx); } } } } };
    const binding = ctx.bind(FULL, module, { keep: "all" });
    await binding.deliver();
    const publisher = ctx.bind(FULL, {});
    const [p1] = await ctx.publish(publisher, [Alpha, 1]);
    await binding.deliver();
    assert(runId !== undefined && ((await ctx.lease("h"))?.position ?? -1) >= p1!, "the first rounds handled the event");
    // As a release that failed on a lock would: the lease still names this process's run id.
    await ctx.layer.transaction(async (tx) => {
      const lease = (await ops(tx).lockHandlerProgress("h"))!;
      await ops(tx).writeHandlerLease({ ...lease, runId: runId! });
    });
    const [p2] = await ctx.publish(publisher, [Alpha, 2]);
    await binding.deliver();
    const lease = (await ctx.lease("h"))!;
    assert(lease.position === p2 && lease.runId === null, `the round took its own lease again and handled the event, got ${JSON.stringify(lease)}`);
  });

  add("two takes of one free lease that overlap take it once: the generation rises by one and the handler stays held", { timing: { renewMs: 10_000, lapseMs: 30_000 } }, async (ctx) => {
    let core: BusCore | undefined;
    const inert: EventBus = Object.freeze({
      manifest: ctx.bus.manifest,
      create: (handed: BusCore) => { core = handed; return { start: async () => {}, stop: async () => {}, deliver: async () => {} }; },
    });
    // Another live process holds h at registration, so this one does not take it.
    await ctx.writeFake(OTHER, { h: ["multi.Alpha"] }, ["multi.Alpha", "multi.Beta", "multi.Echo"]);
    await ctx.layer.transaction((tx) => ops(tx).writeHandlerLease({ name: "h", kind: "process", position: 0, events: ["multi.Alpha"], generation: 3, runId: OTHER }));
    const binding = ctx.scenario("old-list", { bus: inert });
    await ctx.start(binding);
    assert(!core!.handlers.some((each) => each.name === "h"), "h is held by the other process");
    await ctx.layer.transaction((tx) => ops(tx).deleteProcess(OTHER));
    await Promise.all([resumeHandler(binding, "h"), resumeHandler(binding, "h")]);
    const lease = (await ctx.lease("h"))!;
    assert(lease.runId === (await ownRunId(ctx)) && lease.generation === 4, `h was taken once, at generation 4, got ${JSON.stringify(lease)}`);
    const handler = core!.handlers.find((each) => each.name === "h");
    assert(handler !== undefined, "h is held");
    assert(await core!.position(handler) === 0, "position of a held handler is not MESH_HANDLER_LOST");
  });

  add("a handler the bus stopped after a failure keeps its lease while its process lives, so no other process takes it", { timing: IN_PROCESS }, async (ctx) => {
    const failing: EventsModule = { handlers: { process: { h: { events: [Alpha], run: () => { throw new FrameworkError("not retryable"); } } } } };
    const binding = ctx.bind(FULL, failing);
    await ctx.start(binding);
    const runId = await ownRunId(ctx);
    const taken = (await ctx.lease("h"))!;
    const [p] = await ctx.publish(ctx.bind(FULL, {}), [Alpha, 1]);
    await sleep(300);
    const lease = (await ctx.lease("h"))!;
    assert(lease.position < p!, "the failing event was not passed");
    assert(lease.runId === runId && lease.generation === taken.generation, `the stopped handler keeps its lease, got ${JSON.stringify(lease)}`);
  });

  add("a renewal of a process row that is gone loses the instance with MESH_DELIVERER_LOST", { timing: { renewMs: 30, lapseMs: 1500 } }, async (ctx) => {
    let lost: unknown;
    const binding = ctx.scenario("old-list", { bus: watched(ctx.bus, (core) => { core.onClaimLost((error) => { lost = error; }); }) });
    await ctx.start(binding);
    const runId = (await ownRunId(ctx))!;
    await ctx.layer.transaction((tx) => ops(tx).deleteProcess(runId));
    await until(() => lost !== undefined, "the next renewal");
    assert(lost instanceof DelivererLostError && /a renewal of this process's row updated no row|this process's row in mesh_delivery_process lapsed or is gone/.test(lost.message), String(lost));
  });

  add("the two modes never deliver one database together: a live single-mode claim refuses a multi start, and the nil claim a single-mode start", { timing: IN_PROCESS }, async (ctx) => {
    await ctx.layer.transaction((tx) => ops(tx).writeClaim({ runId: OTHER, generation: 1, host: "elsewhere", pid: 4242, startedAt: new Date() }));
    const multi = ctx.scenario("old-list");
    const taken = await rejection(() => multi.deliver());
    assert(taken instanceof DelivererTakenError && taken.holder.pid === 4242 && !taken.holder.multiProcess, `a multi start beside a single claim gave ${String(taken)}`);
    await ctx.layer.transaction((tx) => ops(tx).releaseClaim(OTHER, 1));
    // Several processes deliver: the nil claim, renewed, and a live process row.
    await ctx.layer.transaction((tx) => ops(tx).writeClaim({ runId: "00000000-0000-0000-0000-000000000000", generation: 1, host: null, pid: null, startedAt: null }));
    await ctx.writeFake(OTHER, { h: ["multi.Alpha"] }, ["multi.Alpha"]);
    const single = ctx.scenario("old-list", { bus: singleMode(ctx.bus) });
    const refused = await rejection(() => single.deliver());
    assert(refused instanceof DelivererTakenError && refused.holder.multiProcess && refused.holder.pid === null && refused.message.includes("delivered from several processes"), `a single-mode start beside the nil claim gave ${String(refused)}`);
  });

  add("forgetByName with multiProcess refuses a handler a live process row registers and a subscription open under one, and drops a lapsed process's rows", { timing: { renewMs: 30, lapseMs: 200 } }, async (ctx) => {
    await ctx.writeFake(OTHER, { ghost: ["multi.Alpha"] }, ["multi.Alpha"]);
    await ctx.layer.transaction(async (tx) => {
      await ops(tx).writeHandlerLease({ name: "ghost", kind: "process", position: 0, events: ["multi.Alpha"], generation: 1, runId: OTHER });
      await ops(tx).writeSubscriptionOwner({ name: "feed", position: 0, filter: {}, open: true, generation: 0, runId: OTHER });
    });
    const handler = await rejection(() => forgetByName(ctx.layer, "ghost", { multiProcess: true }));
    assert(handler instanceof FrameworkError && handler.message.includes("registered by a live process (pid 4242 on host elsewhere)"), String(handler));
    const subscription = await rejection(() => forgetByName(ctx.layer, "feed", { multiProcess: true }));
    assert(subscription instanceof FrameworkError && subscription.message.includes("open in a live process (pid 4242 on host elsewhere)"), String(subscription));
    await sleep(250);
    const forgotten = await forgetByName(ctx.layer, "ghost", { multiProcess: true });
    assert(forgotten.kind === "handler" && forgotten.position === 0, JSON.stringify(forgotten));
    assert((await forgetByName(ctx.layer, "feed", { multiProcess: true })).kind === "subscription", "a crashed process's subscription row is dropped");
  });

  add("a deploy that removes an event from a handler waits at its first row, held by none and reported, until adoptByName drops it; adopt keeps what a live process lists and never drops without --drop", { timing: { renewMs: 30, lapseMs: 400 } }, async (ctx) => {
    let core: BusCore | undefined;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
    try {
      // An older build registered h with [Alpha, Beta]; this build lists Beta only (rule R1: the union keeps Alpha).
      await ctx.layer.transaction((tx) => ops(tx).writeHandlerLease({ name: "h", kind: "process", position: 0, events: ["multi.Alpha", "multi.Beta"], generation: 1, runId: null }));
      const binding = ctx.bind(FULL, { handlers: { process: { h: echoing(ctx.layer, [Beta]) } } }, { bus: watched(ctx.bus, (handed) => { core = handed; }), keep: "all" });
      await ctx.start(binding);
      const [a1, b2] = await ctx.publish(ctx.bind(FULL, {}), [Alpha, 1], [Beta, 2]);
      await until(async () => (await ctx.lease("h"))?.runId === null, "h yielded at the Alpha row");
      assert(((await ctx.lease("h"))?.position ?? -1) < a1!, "no row was passed");
      // Without --drop, adopt changes nothing, and says who lists what.
      const kept = await adoptByName(ctx.layer, "h", { multiProcess: true });
      const by = Object.fromEntries(kept.kept.map((each) => [each.event, each.listedBy]));
      assert(!kept.changed && kept.dropped.length === 0 && JSON.stringify(kept.union) === JSON.stringify(["multi.Alpha", "multi.Beta"]), `adopt without drop changed nothing, got ${JSON.stringify(kept)}`);
      assert(by["multi.Alpha"] === null && typeof by["multi.Beta"] === "string" && by["multi.Beta"]!.startsWith(`pid ${PID} on host `), `Alpha is listed by no live process and Beta by this one, got ${JSON.stringify(by)}`);
      assert(JSON.stringify((await ctx.lease("h"))!.events) === JSON.stringify(["multi.Alpha", "multi.Beta"]), "the union is unchanged");
      const listed = await rejection(() => adoptByName(ctx.layer, "h", { drop: ["multi.Beta"], multiProcess: true }));
      assert(listed instanceof FrameworkError && listed.message.includes(`multi.Beta is listed for "h" by a live process (pid ${PID} on host `) && listed.message.includes("so it is not dropped: stop that process first"), String(listed));
      const absent = await rejection(() => adoptByName(ctx.layer, "h", { drop: ["multi.Gone"], multiProcess: true }));
      assert(absent instanceof FrameworkError && absent.message.includes('multi.Gone is not in the registered union of "h"'), String(absent));
      const unregistered = await rejection(() => adoptByName(ctx.layer, "nobody", { multiProcess: true }));
      assert(unregistered instanceof FrameworkError && unregistered.message.includes('No live process registers the handler "nobody", so there is no list to adopt') && unregistered.message.includes("`mesh events forget nobody`"), String(unregistered));
      const single = await rejection(() => adoptByName(ctx.layer, "h"));
      assert(single instanceof FrameworkError && single.message.includes("applies to a project whose bus declares multi-process"), String(single));
      // The waiting report (rule K6): from the first pass that sees h held by none, after the lapse time.
      await core!.deletionPass();
      await sleep(450);
      await core!.deletionPass();
      const waiting = warnings.filter((line) => line.includes('the handler "h" is registered by 1 live process and held by none'));
      assert(waiting.length === 1 && waiting[0]!.includes(`it waits at position ${(await ctx.lease("h"))!.position}, where multi.Alpha is listed by a build no live process runs`) && waiting[0]!.includes("`mesh events adopt h --drop multi.Alpha`"), `the waiting report, got ${JSON.stringify(warnings)}`);
      // Dropping Alpha changes the union, so this process takes h again and passes the Alpha row.
      const dropped = await adoptByName(ctx.layer, "h", { drop: ["multi.Alpha"], multiProcess: true });
      assert(dropped.changed && JSON.stringify(dropped.dropped) === JSON.stringify(["multi.Alpha"]) && JSON.stringify(dropped.union) === JSON.stringify(["multi.Beta"]), JSON.stringify(dropped));
      await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= b2!, "h was taken again and handled Beta 2");
      const echoed = await ctx.echoed();
      assert(echoed.get(b2!) === 1 && !echoed.has(a1!), `Beta 2 was handled once and Alpha 1 passed, got ${JSON.stringify([...echoed])}`);
      assert(JSON.stringify((await ctx.lease("h"))!.events) === JSON.stringify(["multi.Beta"]), "the stored union is the adopted one");
    } finally { console.warn = warn; }
  });

  add("keep \"all\" recorded by one process keeps every row after it stops; a process with \"until-delivered\" reports it; keepByValue refuses while a live process runs with \"all\", then sets it back", { timing: { renewMs: 30, lapseMs: 400 } }, async (ctx) => {
    let core: BusCore | undefined;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
    try {
      const publisher = ctx.bind(FULL, {});
      const keeper = ctx.scenario("old-list", { keep: "all" });
      const [a1] = await ctx.publish(publisher, [Alpha, 1]);
      await keeper.deliver();
      assert((await ctx.layer.transaction((tx) => ops(tx).lockDeliveryState())).keep === "all", "a process with keep: \"all\" recorded it");
      const binding = ctx.scenario("old-list", { bus: watched(ctx.bus, (handed) => { core = handed; }) });
      await ctx.start(binding);
      const [a2] = await ctx.publish(publisher, [Alpha, 2]);
      await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= a2!, "h handled Alpha 2");
      await core!.deletionPass();
      const positions = () => ctx.outbox().then((rows) => rows.map((row) => row.position));
      assert((await positions()).includes(a1!) && (await positions()).includes(a2!), "the recorded keep \"all\" stops every process from deleting");
      const report = warnings.filter((line) => line.includes("the recorded keep of"));
      assert(report.length === 1 && report[0]!.includes('is "all", so no process deletes delivered rows, while this process runs with keep: "until-delivered"') && report[0]!.includes('No live process runs with "all"; run `mesh events keep until-delivered` to delete again'), `the keep report, got ${JSON.stringify(warnings)}`);
      // A live process that runs with "all" keeps the recorded keep where it is.
      await ctx.writeFake(OTHER, {}, ["multi.Alpha"], "all");
      const refused = await rejection(() => keepByValue(ctx.layer, "until-delivered", { multiProcess: true }));
      assert(refused instanceof FrameworkError && refused.message === 'The process pid 4242 on host elsewhere delivers with keep: "all", so the recorded keep stays "all": stop it, or change its configuration, first', String(refused));
      const single = await rejection(() => keepByValue(ctx.layer, "until-delivered"));
      assert(single instanceof FrameworkError && single.message.includes("applies to a project whose bus declares multi-process"), String(single));
      const bad = await rejection(() => keepByValue(ctx.layer, "some" as "all", { multiProcess: true }));
      assert(bad instanceof FrameworkError && bad.message.includes('takes "until-delivered" or "all"'), String(bad));
      await ctx.layer.transaction((tx) => ops(tx).deleteProcess(OTHER));
      const back = await keepByValue(ctx.layer, "until-delivered", { multiProcess: true });
      assert(back.before === "all" && back.after === "until-delivered", JSON.stringify(back));
      await core!.deletionPass();
      const left = await positions();
      assert(!left.includes(a1!) && !left.includes(a2!), `once set back, the pass deletes what every reader passed, got ${JSON.stringify(left)}`);
      const all = await keepByValue(ctx.layer, "all", { multiProcess: true });
      assert(all.before === "until-delivered" && all.after === "all", JSON.stringify(all));
      const [a3] = await ctx.publish(publisher, [Alpha, 3]);
      await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= a3!, "h handled Alpha 3");
      await core!.deletionPass();
      assert((await positions()).includes(a3!), "mesh events keep all stops deletion again");
    } finally { console.warn = warn; }
  });

  /** A bus that never runs a round, so no deletion pass runs but the ones a check calls; core still renews the process row. */
  const inertBus = (ctx: Ctx, onCore: (core: BusCore) => void): EventBus => Object.freeze({
    manifest: ctx.bus.manifest,
    create: (handed: BusCore) => { onCore(handed); return { start: async () => {}, stop: async () => {}, deliver: async () => {} }; },
  });
  const THIRD = "00000000-0000-4000-8000-0000000000e3";

  add("the waiting report comes only after the lapse time held by none, counts only live registrants, treats a lapsed holder as none, restarts its clock once held, and repeats at most hourly", { timing: { renewMs: 30, lapseMs: 200 } }, async (ctx) => {
    let core: BusCore | undefined;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
    const waiting = () => warnings.filter((line) => line.includes('the handler "h" is registered by'));
    try {
      await ctx.start(ctx.scenario("empty", { bus: inertBus(ctx, (handed) => { core = handed; }) }));
      // OTHER registers h and lapses (it never renews); THIRD registers h with every event of its union and is kept live.
      await ctx.writeFake(OTHER, { h: ["multi.Alpha"] }, ["multi.Alpha"]);
      const third = () => ctx.writeFake(THIRD, { h: ["multi.Alpha"] }, ["multi.Alpha"]);
      await third();
      const lease = (runId: string | null) => ctx.layer.transaction((tx) => ops(tx).writeHandlerLease({ name: "h", kind: "process", position: 0, events: ["multi.Alpha"], generation: 1, runId }));
      await lease(null);
      await core!.deletionPass();
      assert(waiting().length === 0, `the first pass that sees h held by none does not report it, got ${JSON.stringify(warnings)}`);
      await sleep(250);
      await third();
      await lease(THIRD);
      await core!.deletionPass();
      assert(waiting().length === 0, `a handler a live process holds is not reported, got ${JSON.stringify(warnings)}`);
      // OTHER's row has lapsed: its lease counts as held by none, and the clock starts again from this pass.
      await lease(OTHER);
      await core!.deletionPass();
      assert(waiting().length === 0, `held again since the last pass, h is not reported at once, got ${JSON.stringify(warnings)}`);
      await core!.deletionPass();
      assert(waiting().length === 0, `a second pass inside the lapse time does not report h yet, got ${JSON.stringify(warnings)}`);
      await sleep(250);
      await third();
      await core!.deletionPass();
      const reported = waiting();
      assert(reported.length === 1 && reported[0]!.includes('the handler "h" is registered by 1 live process and held by none: it waits at position 0, and a live process lists every event of its union')
        && reported[0]!.includes("`mesh events adopt h` lists its union"), `the report counts THIRD only and names nothing pending, got ${JSON.stringify(warnings)}`);
      await core!.deletionPass();
      assert(waiting().length === 1, `a second pass within the hour does not report again, got ${JSON.stringify(warnings)}`);
    } finally { console.warn = warn; }
  });

  add("the keep report names a live process that runs with \"all\"; a lapsed one does not stop mesh events keep until-delivered", { timing: { renewMs: 30, lapseMs: 200 } }, async (ctx) => {
    let core: BusCore | undefined;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
    try {
      await ctx.start(ctx.scenario("empty", { bus: inertBus(ctx, (handed) => { core = handed; }) }));
      await keepByValue(ctx.layer, "all", { multiProcess: true });
      await ctx.writeFake(OTHER, {}, ["multi.Alpha"], "all");
      await core!.deletionPass();
      const report = warnings.filter((line) => line.includes("the recorded keep of"));
      assert(report.length === 1 && report[0]!.includes('The live process pid 4242 on host elsewhere runs with "all"; stop it, or change its configuration, then run `mesh events keep until-delivered`'), `the keep report names the keeper, got ${JSON.stringify(warnings)}`);
      const refused = await rejection(() => keepByValue(ctx.layer, "until-delivered", { multiProcess: true }));
      assert(refused instanceof FrameworkError && refused.message.includes("pid 4242 on host elsewhere"), String(refused));
      await sleep(250);
      const back = await keepByValue(ctx.layer, "until-delivered", { multiProcess: true });
      assert(back.before === "all" && back.after === "until-delivered", `a lapsed process row with keep "all" does not count, got ${JSON.stringify(back)}`);
    } finally { console.warn = warn; }
  });

  add("adoptByName counts only live process rows, refuses a registered handler without a progress row, and drops a repeated event once", { timing: { renewMs: 30, lapseMs: 200 } }, async (ctx) => {
    await ctx.start(ctx.scenario("empty", { bus: inertBus(ctx, () => {}) }));
    // OTHER lists Alpha for h and registers solo; both then lapse with OTHER's row.
    await ctx.writeFake(OTHER, { h: ["multi.Alpha", "multi.Beta"], solo: ["multi.Alpha"] }, ["multi.Alpha", "multi.Beta"]);
    await ctx.layer.transaction(async (tx) => {
      await ops(tx).writeHandlerLease({ name: "h", kind: "process", position: 0, events: ["multi.Alpha", "multi.Beta"], generation: 1, runId: null });
      await ops(tx).writeHandlerLease({ name: "solo", kind: "process", position: 0, events: ["multi.Alpha"], generation: 1, runId: null });
    });
    const listed = await rejection(() => adoptByName(ctx.layer, "h", { drop: ["multi.Alpha"], multiProcess: true }));
    assert(listed instanceof FrameworkError && listed.message.includes("multi.Alpha is listed for \"h\" by a live process (pid 4242 on host elsewhere)"), `while OTHER is live it blocks the drop, got ${String(listed)}`);
    await sleep(250);
    // THIRD, live, lists Beta only for h, and registers lost, which has no progress row.
    await ctx.writeFake(THIRD, { h: ["multi.Beta"], lost: ["multi.Alpha"] }, ["multi.Alpha", "multi.Beta"]);
    const dropped = await adoptByName(ctx.layer, "h", { drop: ["multi.Alpha", "multi.Alpha"], multiProcess: true });
    assert(dropped.changed && JSON.stringify(dropped.dropped) === JSON.stringify(["multi.Alpha"]) && JSON.stringify(dropped.union) === JSON.stringify(["multi.Beta"])
      && JSON.stringify(dropped.kept) === JSON.stringify([{ event: "multi.Beta", listedBy: "pid 4242 on host elsewhere" }]), `a lapsed lister does not block --drop, and a repeated event drops once, got ${JSON.stringify(dropped)}`);
    assert(JSON.stringify((await ctx.lease("h"))!.events) === JSON.stringify(["multi.Beta"]), "the stored union is the adopted one");
    const solo = await rejection(() => adoptByName(ctx.layer, "solo", { multiProcess: true }));
    assert(solo instanceof FrameworkError && solo.message.includes('No live process registers the handler "solo", so there is no list to adopt'), `a handler only a lapsed row registers has no list to adopt, got ${String(solo)}`);
    const lost = await rejection(() => adoptByName(ctx.layer, "lost", { multiProcess: true }));
    assert(lost instanceof FrameworkError && lost.message === 'The handler "lost" has no progress row: it was forgotten while registered; restart a process that registers it', String(lost));
  });

  add("a subscription that ends at a row only another live build declares names that process, before any deletion pass", { timing: { renewMs: 10_000, lapseMs: 30_000 } }, async (ctx) => {
    let core: BusCore | undefined;
    // A bus that never delivers, so no deletion pass runs and the check alone feeds the subscription.
    const inert: EventBus = Object.freeze({
      manifest: ctx.bus.manifest,
      create: (handed: BusCore) => { core = handed; return { start: async () => {}, stop: async () => {}, deliver: async () => {} }; },
    });
    await ctx.writeFake(OTHER, {}, ["multi.Alpha", "multi.Beta", "multi.Echo", "multi.Gone"]);
    const binding = ctx.scenario("empty", { bus: inert });
    await ctx.start(binding);
    const subscription = await subscribe(binding, { name: "feed", after: 0 }, () => {});
    const [g1] = await ctx.publish(ctx.bind(WITH_GONE, {}), [Gone, 1]);
    const live = core!.subscriptions().find((each) => each.name === "feed")!;
    await live.feed(await core!.rows(0, 10));
    const ended = await subscription.done;
    assert(ended instanceof EventUndeclaredError && ended.position === g1 && ended.message.includes("(pid 4242 on host elsewhere) can open this subscription"), `the end names the declaring process, got ${String(ended)}`);
  });

  add("subscribe: a name open under another live process row is refused naming it; one open under a lapsed row reopens; the row records its owner", { timing: { renewMs: 30, lapseMs: 200 } }, async (ctx) => {
    const binding = ctx.scenario("empty");
    await ctx.start(binding);
    await ctx.writeFake(OTHER, {}, ["multi.Alpha"]);
    await ctx.layer.transaction((tx) => ops(tx).writeSubscriptionOwner({ name: "feed", position: 0, filter: {}, open: true, generation: 0, runId: OTHER }));
    const refused = await rejection(() => subscribe(binding, { name: "feed" }, () => {}));
    assert(refused instanceof FrameworkError && refused.message.includes("open in another process (pid 4242 on host elsewhere)"), String(refused));
    await sleep(250);
    const subscription = await subscribe(binding, { name: "feed" }, () => {});
    const row = (await ctx.layer.transaction((tx) => ops(tx).readSubscriptionOwners())).find((each) => each.name === "feed")!;
    assert(row.open && row.runId === (await ownRunId(ctx)), `the reopened row names this process, got ${JSON.stringify(row)}`);
    // ack goes on only while this process owns the row.
    await ctx.layer.transaction((tx) => ops(tx).writeSubscriptionOwner({ ...row, runId: OTHER }));
    const publisher = ctx.bind(FULL, {});
    await ctx.publish(publisher, [Alpha, 1]);
    await sleep(100);
    const lost = await rejection(() => subscription.ack(0));
    assert(lost instanceof DelivererLostError, `ack of a row another process owns gave ${String(lost)}`);
    await subscription.close();
  });

  // ---- two processes ----

  add("two processes: each handler is held by exactly one, and every process event is handled once", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("basic", ["--keep=all"]);
    const binding = ctx.scenario("basic", { keep: "all" });
    await ctx.start(binding);
    const positions = [...await ctx.publish(binding, [Alpha, 1], [Alpha, 2]), ...await ctx.publish(binding, [Alpha, 3])];
    const last = positions.at(-1)!;
    await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= last && ((await ctx.lease("log"))?.position ?? -1) >= last, "both handlers reached the last event");
    const processes = await again(() => ctx.layer.transaction((tx) => ops(tx).readProcesses()));
    assert(processes.length === 2, `two process rows, got ${processes.length}`);
    for (const name of ["count", "log"]) {
      const lease = (await ctx.lease(name))!;
      assert(await pidOf(ctx, lease.runId) === worker.pid, `${name} is held by the first process to register, the worker`);
    }
    const echoed = await ctx.echoed();
    assert(positions.every((p) => echoed.get(p) === 1), `every event was handled once, got ${JSON.stringify([...echoed])}`);
    assert(!ctx.seen.has("count") && !ctx.seen.has("log"), "this process, holding nothing, handled nothing");
  });

  add("a holder killed with SIGKILL: the other process takes its handlers over after the lapse; nothing is handled twice or skipped", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("basic", ["--keep=all"]);
    const binding = ctx.scenario("basic", { keep: "all" });
    await ctx.start(binding);
    const first = await ctx.publish(binding, [Alpha, 1], [Alpha, 2]);
    await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= first.at(-1)!, "the worker handled the first events");
    worker.kill("SIGKILL");
    const output = await worker.done;
    const second = await ctx.publish(binding, [Alpha, 3], [Alpha, 4]);
    await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= second.at(-1)! && ((await ctx.lease("log"))?.position ?? -1) >= second.at(-1)!, "this process took over and handled the rest");
    const echoed = await ctx.echoed();
    assert([...first, ...second].every((p) => echoed.get(p) === 1), `every event was handled once, got ${JSON.stringify([...echoed])}`);
    const logged = new Set([...(ctx.seen.get("log") ?? []), ...output.split("\n").filter((line) => line.startsWith("SEEN log ")).map((line) => Number(line.slice(9)))]);
    assert([...first, ...second].every((p) => logged.has(p)), "the listen handler skipped nothing");
    const lease = (await ctx.lease("count"))!;
    assert(lease.generation === 2 && await pidOf(ctx, lease.runId) === PID, `the takeover raised the generation, got ${JSON.stringify(lease)}`);
  });

  if (posix) {
    add("a holder paused past the lapse and resumed writes nothing and stops with MESH_DELIVERER_LOST", { file: true }, async (ctx) => {
      const worker = await ctx.spawn("basic", ["--keep=all"]);
      const binding = ctx.scenario("basic", { keep: "all" });
      await ctx.start(binding);
      const [p1] = await ctx.publish(binding, [Alpha, 1]);
      await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= p1!, "the worker handled the first event");
      await pause(ctx, worker);
      const [p2, p3] = await ctx.publish(binding, [Alpha, 2], [Alpha, 3]);
      await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= p3!, "this process took over", 8000);
      worker.kill("SIGCONT");
      await until(() => worker.output().includes("LOST MESH_DELIVERER_LOST"), "the woken worker lost its instance");
      await sleep(200);
      const echoed = await ctx.echoed();
      assert([p1, p2, p3].every((p) => echoed.get(p!) === 1), `nothing was handled twice, got ${JSON.stringify([...echoed])}`);
    });

    add("a listen handler whose lease is lost while its body runs moves no position, and the next holder runs it again", { file: true }, async (ctx) => {
      const worker = await ctx.spawn("slow-listen");
      const binding = ctx.scenario("slow-listen");
      await ctx.start(binding);
      const [p1] = await ctx.publish(binding, [Alpha, 1]);
      await until(() => worker.output().includes(`BODY ${p1}`), "the worker entered the body");
      await pause(ctx, worker);
      await until(() => (ctx.seen.get("slow") ?? []).includes(p1!), "this process took the handler over and ran the body again", 8000);
      worker.kill("SIGCONT");
      await until(async () => ((await ctx.lease("slow"))?.position ?? -1) >= p1!, "the position moved once, by this process");
      await sleep(600);
      const lease = (await ctx.lease("slow"))!;
      assert(await pidOf(ctx, lease.runId) === PID && lease.generation === 2, `the lease is this process's, got ${JSON.stringify(lease)}`);
    });
  }

  add("a deploy that adds an event to a handler: the old holder yields at its first row, the new build handles it, no row is passed", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("old-list", ["--keep=all"]);
    const binding = ctx.scenario("new-list", { keep: "all" });
    await ctx.start(binding);
    const lease = (await ctx.lease("h"))!;
    assert(JSON.stringify(lease.events) === JSON.stringify(["multi.Alpha", "multi.Beta"]), `the union grew at registration, got ${JSON.stringify(lease.events)}`);
    const [a1, b2, a3] = await ctx.publish(binding, [Alpha, 1], [Beta, 2], [Alpha, 3]);
    await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= a3!, "every row was handled");
    const echoed = await ctx.echoed();
    assert([a1, b2, a3].every((p) => echoed.get(p!) === 1), `each row was handled once, got ${JSON.stringify([...echoed])}`);
    assert((ctx.seen.get("h") ?? []).includes(b2!), "the new build handled the Beta row");
    assert(!worker.output().includes("LOST"), "the old process lost nothing but the handler");
  });

  add("a new event declared by the new build only: the old holder yields the handler that lists it and passes the rows with its other handler", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("old-build", ["--keep=all"]);
    const binding = ctx.scenario("new-build", { keep: "all" });
    await ctx.start(binding);
    const [a1, b2, a3] = await ctx.publish(binding, [Alpha, 1], [Beta, 2], [Alpha, 3]);
    await until(async () => ((await ctx.lease("h"))?.position ?? -1) >= a3! && ((await ctx.lease("h2"))?.position ?? -1) >= a3!, "both handlers reached the last row");
    const h2 = (await ctx.lease("h2"))!;
    assert(await pidOf(ctx, h2.runId) === worker.pid, "h2, which never lists Beta, stayed with the old build: it passed the Beta row");
    assert((ctx.seen.get("h") ?? []).includes(b2!), "the new build handled Beta for h");
    const echoed = await ctx.echoed();
    assert(echoed.get(a1!) === 2 && echoed.get(b2!) === 1 && echoed.get(a3!) === 2, `h and h2 each handled every row they list once, got ${JSON.stringify([...echoed])}`);
  });

  add("renamedFrom across builds waits until no live process registers the former name", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("rename-old", ["--keep=all"]);
    const binding = ctx.scenario("rename-new", { keep: "all" });
    await ctx.start(binding);
    await sleep(200);
    assert((await ctx.lease("after")) === undefined && (await ctx.lease("before")) !== undefined, "the row stays the old build's while it lives");
    worker.kill("SIGTERM");
    await worker.done;
    await until(async () => (await ctx.lease("after"))?.runId != null && (await ctx.lease("before")) === undefined, "the row moved to the new name and is held");
    const [p] = await ctx.publish(binding, [Alpha, 1]);
    await until(async () => ((await ctx.lease("after"))?.position ?? -1) >= p!, "the renamed handler delivers");
  });

  for (const keep of ["until-delivered", "all"] as const) {
    add(`[keep: ${keep}] deletion passes in both processes never delete past any reader`, { file: true }, async (ctx) => {
      await ctx.spawn("basic", keep === "all" ? ["--keep=all"] : []);
      const binding = ctx.scenario("basic", { keep });
      await ctx.start(binding);
      const hold: Subscription = await subscribe(binding, { name: "hold", after: 0 }, () => {});
      const positions: number[] = [];
      for (let i = 0; i < 5; i++) positions.push(...await ctx.publish(binding, [Alpha, 2 * i], [Alpha, 2 * i + 1]));
      const last = positions.at(-1)!;
      await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= last && ((await ctx.lease("log"))?.position ?? -1) >= last, "every event was handled");
      const deleted = () => ctx.layer.readOutbox!(0, 1).then((page) => page.deletedThrough);
      await sleep(200);
      assert(await deleted() === 0, "an unacknowledged subscription holds every row against both processes' passes");
      await until(async () => (await rejection(() => hold.ack(positions[3]!))) === undefined, "the subscription was handed the rows");
      await ctx.publish(binding, [Alpha, 99]);
      await sleep(400);
      const through = await deleted();
      const readers = [...(await ctx.leases()).map((lease) => lease.position), ...(await again(() => ctx.layer.transaction((tx) => ops(tx).readSubscriptionOwners()))).map((row) => row.position)];
      assert(through <= Math.min(...readers), `deleted through ${through}, past a reader at ${Math.min(...readers)}`);
      if (keep === "all") assert(through === 0, "keep: all deletes nothing");
      else assert(through > 0 && through <= positions[3]!, `until-delivered deletes up to the acknowledged position, got ${through}`);
      await hold.close();
    });
  }

  add("subscriptions open in both processes; one name in two is refused; a killed owner's row reopens; neither reports the other's open subscription", { file: true }, async (ctx) => {
    setDeliveryTiming({ renewMs: 50, lapseMs: 300, orphanAgeMs: 0, orphanReportMs: 0 });
    const worker = await ctx.spawn("empty", ["--subscribe=feed-w"]);
    const binding = ctx.scenario("empty");
    await ctx.start(binding);
    const mine = await subscribe(binding, { name: "feed-p" }, () => {});
    const refused = await rejection(() => subscribe(binding, { name: "feed-w" }, () => {}));
    assert(refused instanceof FrameworkError && refused.message.includes(`pid ${worker.pid}`), `a name open in the worker gave ${String(refused)}`);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
    try {
      await ctx.publish(binding, [Alpha, 1]);
      await sleep(300);
    } finally { console.warn = warn; }
    assert(!warnings.some((line) => line.includes("has not been open")), `an open subscription was reported as an orphan: ${warnings.join("\n")}`);
    worker.kill("SIGKILL");
    await worker.done;
    await sleep(400);
    const reopened = await subscribe(binding, { name: "feed-w" }, () => {});
    await reopened.close();
    await mine.close();
  });

  add("the modes never mix across processes: a single-mode worker refuses a multi start; a multi worker refuses a single-mode start with the several-processes wording", { file: true }, async (ctx) => {
    const single = await ctx.spawn("basic", ["--single"]);
    const multi = ctx.scenario("basic");
    const taken = await rejection(() => multi.deliver());
    assert(taken instanceof DelivererTakenError && taken.holder.pid === single.pid && !taken.holder.multiProcess, `got ${String(taken)}`);
    single.kill("SIGTERM");
    await single.done;
    await ctx.spawn("basic");
    const refused = await rejection(() => ctx.scenario("basic", { bus: singleMode(ctx.bus) }).deliver());
    assert(refused instanceof DelivererTakenError && refused.holder.multiProcess && refused.message.includes("several processes"), `got ${String(refused)}`);
  });

  add("three multi processes, the last starter killed: a single-mode start is still refused after the lapse", { file: true }, async (ctx) => {
    await ctx.spawn("basic");
    const last = await ctx.spawn("basic");
    last.kill("SIGKILL");
    await last.done;
    await sleep(500);
    const refused = await rejection(() => ctx.scenario("basic", { bus: singleMode(ctx.bus) }).deliver());
    assert(refused instanceof DelivererTakenError && refused.holder.multiProcess, `got ${String(refused)}`);
  });

  add("after every multi process stops, a single-mode start claims and delivers", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("basic");
    worker.kill("SIGTERM");
    assert((await worker.done).includes("STOPPED"), "the worker stopped cleanly");
    const single = ctx.scenario("basic", { bus: singleMode(ctx.bus), keep: "all" });
    await single.deliver();
    const [p] = await ctx.publish(single, [Alpha, 1]);
    await single.deliver();
    assert((await ctx.echoed()).get(p!) === 1, "the single-mode process delivered");
  });

  add("deliver() rounds beside another process deliver only the leases they hold", { file: true }, async (ctx) => {
    const worker = await ctx.spawn("basic", ["--keep=all"]);
    const binding = ctx.scenario("basic", { keep: "all" });
    const [p1] = await ctx.publish(binding, [Alpha, 1]);
    await until(async () => ((await ctx.lease("count"))?.position ?? -1) >= p1!, "the worker handled it");
    await binding.deliver();
    assert(!ctx.seen.has("count"), "a round beside the holder handles nothing");
    worker.kill("SIGTERM");
    await worker.done;
    const [p2] = await ctx.publish(binding, [Alpha, 2]);
    await binding.deliver();
    assert(JSON.stringify(ctx.seen.get("count")) === JSON.stringify([p2]), `once the worker stopped, a round takes the leases and delivers, got ${JSON.stringify(ctx.seen.get("count"))}`);
  });

  return checks;
}

