import type { BusCapability, BusCore, EventBus, EventBusInstance, Handler } from "./bus.ts";
import type { DataLayer, DataOperations, DeliveryOperations, DeliveryState, HandlerProgressRow, OutboxRow, SubscriptionProgressRow } from "./data-layer.ts";
import { DECLARATION, type Declaration } from "./declarations.ts";
import { forgetSubscription, listSubscriptions, markNoDeliver, setDeliveryTiming, subscribe, type Subscription } from "./deliverer.ts";
import { bindDomain, type AsyncFrame, type Binding } from "./entity.ts";
import {
  CursorAheadError, DatabaseBusyError, DelivererLostError, DelivererTakenError, EventUndeclaredError, EventsDeletedError, ForbiddenError, FrameworkError,
  HandlerOptionError, HandlerStoppedError, SubscriptionOverflowError, type StoppedHandler,
} from "./errors.ts";
import { publishEvent, type EventRecord, type EventsConfig, type EventsModule } from "./events.ts";
import type { ActionContext } from "./index.ts";

/**
 * The event-bus conformance suite (spec, Events and commands, "The event-bus contract", "Conformance"), and `testBus`, the
 * plain bus the suite runs core with when no adapter is at hand. Exported from `@meshfw/runtime/testing`.
 */

// ---- testBus ------------------------------------------------------------------------------------------------

/** What `testBus` takes. */
export interface TestBusOptions {
  /** The capabilities it declares; default `ordered-delivery`, `replay` and `subscribe`. */
  readonly capabilities?: readonly BusCapability[];
  /** The retry schedule handed to core's retry path, in milliseconds; default `[0, 0]`. */
  readonly retryDelays?: readonly number[];
  /** After `start()`, a round also runs this often, in milliseconds; default 50. */
  readonly pollMs?: number;
  /** Where a background round's failure goes; default `console.error`. */
  readonly onError?: (error: unknown) => void;
}

const PAGE = 100;

/**
 * A bus that does what every bus must and nothing more: a round feeds each handler from its own cursor, in position
 * order, through core's retry path, then each subscription from its own cursor, then runs the deletion pass. After
 * `start()` a round runs at once, after each commit that published in this process, and every `pollMs`.
 */
export function testBus(options: TestBusOptions = {}): EventBus {
  const capabilities = Object.freeze([...(options.capabilities ?? ["ordered-delivery", "replay", "subscribe"])]);
  const retryDelays = Object.freeze([...(options.retryDelays ?? [0, 0])]);
  const pollMs = options.pollMs ?? 50;
  const onError = options.onError ?? ((error: unknown) => console.error("testBus: a round failed:", error));
  return Object.freeze({
    manifest: Object.freeze({ adapter: "test", capabilities }),
    create(core: BusCore): EventBusInstance {
      let lost = false;
      let started = false;
      let running: Promise<void> | undefined;
      let again = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const unsubscribe: (() => void)[] = [];
      unsubscribe.push(core.onClaimLost(() => { lost = true; }));
      const round = async (): Promise<void> => {
        const stopped: StoppedHandler[] = [];
        for (const handler of core.handlers) {
          let cursor = await core.position(handler);
          handled: for (;;) {
            const page = await core.rows(cursor, PAGE);
            for (const row of page.rows) {
              if (core.lists(handler, row)) {
                const stop = await core.retry(handler, row, retryDelays);
                if (stop) { stopped.push(stop); break handled; }
              }
              cursor = row.position;
            }
            if (page.rows.length < PAGE) break;
          }
        }
        for (const subscription of core.subscriptions()) {
          try {
            while (!subscription.ended) {
              const page = await core.rows(subscription.cursor, PAGE);
              await subscription.feed(page);
              if (page.rows.length < PAGE) break;
            }
          } catch (error) {
            if (error instanceof DelivererLostError || error instanceof DatabaseBusyError) throw error;
            subscription.end(error);
          }
        }
        await core.deletionPass();
        if (stopped.length > 0) throw new HandlerStoppedError(stopped);
      };
      const wake = (): void => {
        if (!started || lost) return;
        if (running) { again = true; return; }
        running = (async () => {
          try {
            do {
              again = false;
              try { await round(); } catch (error) {
                if (!(error instanceof DelivererLostError)) try { onError(error); } catch { /* a reporter that throws ends nothing */ }
              }
            } while (again && started && !lost);
          } finally {
            // Cleared in the same turn as the loop's last check, so a wake-up that comes after it starts a new round
            // instead of setting `again` for a loop that already ended.
            running = undefined;
          }
        })();
      };
      return Object.freeze({
        async start() {
          started = true;
          unsubscribe.push(core.onPublished(wake));
          timer = setInterval(wake, pollMs);
          wake();
        },
        async stop() {
          started = false;
          clearInterval(timer);
          for (const off of unsubscribe.splice(0)) off();
          await running;
        },
        deliver: () => round(),
      });
    },
  });
}

// ---- the suite ----------------------------------------------------------------------------------------------

/** What `busConformance` needs from the adapter under test. */
export interface BusConformanceFixture {
  /** A fresh database with core's tables (a project that declares an event) and no row in them. Each check closes it. */
  makeLayer(): Promise<DataLayer>;
  /** The project's async frame, as the generated `binding.ts` makes it (`new AsyncLocalStorage()`); one per call. */
  frame(): AsyncFrame;
  /** The bus under test, built with the suite's retry schedule and polling interval. */
  bus(settings: { readonly retryDelays: readonly number[]; readonly pollMs: number }): EventBus;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Bus conformance: ${message}`);
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
const Alpha = eventClass("conformance.Alpha");
const Beta = eventClass("conformance.Beta");
const Never = eventClass("conformance.Never");
const Echo = eventClass("conformance.Echo");
type Fields = { n: number };
const FULL = Object.freeze({ Alpha, Beta, Never, Echo });
/** The domain after `conformance.Beta` was moved away: its rows name no declared event. */
const WITHOUT_BETA = Object.freeze({ Alpha, Never, Echo });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`Bus conformance: timed out waiting until ${what}`);
    await sleep(5);
  }
}
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}
const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;

/** One database, its bindings and what their handlers saw. */
interface World {
  readonly layer: DataLayer;
  readonly frame: AsyncFrame;
  readonly keep: "until-delivered" | "all";
  /** What each handler body was called with, by handler name, in order. */
  readonly seen: Map<string, EventRecord[]>;
  /** A binding with `module` as its events module, over the world's layer and frame. */
  bind(module: EventsModule, options?: { domain?: object; bus?: EventBus }): Binding;
  /** Publish one event per `[class, n]` in one outermost transaction of `binding`; resolves with their positions. */
  publish(binding: Binding, ...events: [typeof Alpha, number][]): Promise<number[]>;
  state(): Promise<{ state: DeliveryState; handlers: readonly HandlerProgressRow[]; subscriptions: readonly SubscriptionProgressRow[] }>;
  outbox(): Promise<readonly OutboxRow[]>;
  /** A handler that records each event it is handed under `name`. */
  recorder(name: string, events: readonly (typeof Alpha)[], extra?: Partial<Handler<object>>): Handler<object>;
  readonly bus: EventBus;
}

const CLOCK = () => new Date();

/**
 * The bus checks, as named, runner-independent asynchronous checks like `dataLayerConformanceV1`, each under both `keep`
 * values: what every bus must do, the cursor model, the claim and registration, and one group per capability the bus
 * declares. Each check owns and closes its layer, stops what it started, and restores the deliverer's timing.
 */
export function busConformance(fixture: BusConformanceFixture): Record<string, () => Promise<void>> {
  const checks: Record<string, () => Promise<void>> = {};
  const probe = fixture.bus({ retryDelays: [0, 0], pollMs: 20 });
  const declares = new Set<string>(probe.manifest.capabilities);
  for (const keep of ["until-delivered", "all"] as const) {
    const add = (name: string, run: (world: World) => Promise<void>) => {
      checks[`[keep: ${keep}] ${name}`] = async () => {
        const layer = await fixture.makeLayer();
        const frame = fixture.frame();
        const bus = fixture.bus({ retryDelays: [0, 0], pollMs: 20 });
        const seen = new Map<string, EventRecord[]>();
        const stops: (() => Promise<void>)[] = [];
        const world: World = {
          layer, frame, keep, seen, bus,
          bind(module, options = {}) {
            const config: EventsConfig = { bus: options.bus ?? bus, keep, load: async () => module };
            return bindDomain(options.domain ?? FULL, layer, { events: config }, frame);
          },
          publish(binding, ...events) {
            return binding.transaction(() => layer.transaction(async (tx) => {
              const positions: number[] = [];
              for (const [Class, n] of events) {
                const record = await publishEvent(tx, undefined, { entity: "conformance.Thing", action: "make", key: { id: `k${n}` }, at: "conformance" }, new Class({ n }), {}, CLOCK);
                positions.push(record.position);
              }
              return positions;
            }));
          },
          state: () => layer.transaction(async (tx) => ({
            state: await ops(tx).readDeliveryState(), handlers: await ops(tx).readHandlerProgress(), subscriptions: await ops(tx).readSubscriptionProgress(),
          })),
          async outbox() {
            const out: OutboxRow[] = [];
            let after = (await layer.readOutbox!(0, 1)).deletedThrough;
            for (;;) {
              const page = await layer.readOutbox!(after, 500);
              out.push(...page.rows);
              if (page.rows.length < 500) return out;
              after = page.rows.at(-1)!.position;
            }
          },
          recorder(name, events, extra = {}) {
            return {
              events, ...extra,
              run: (event: EventRecord<object>, tools: { context: ActionContext }) => {
                const list = seen.get(name) ?? [];
                list.push(event);
                seen.set(name, list);
                return extra.run?.(event, tools);
              },
            };
          },
        };
        const startDelivery = async (binding: Binding) => { const delivery = await binding.startDelivery(); stops.push(() => delivery.stop()); return delivery; };
        (world as { start?: typeof startDelivery }).start = startDelivery;
        try {
          await run(world);
        } finally {
          for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
          setDeliveryTiming(null);
          await sleep(5);
          await layer.close();
        }
      };
    };
    const start = (world: World, binding: Binding) => (world as World & { start: (b: Binding) => Promise<{ stop(): Promise<void> }> }).start(binding);
    const positions = (world: World, name: string) => (world.seen.get(name) ?? []).map((event) => event.position);
    const deliverRejects = async (binding: Binding) => {
      const error = await rejection(() => binding.deliver());
      assert(error instanceof HandlerStoppedError, `deliver() was to reject with MESH_HANDLER_STOPPED, and ${error === undefined ? "resolved" : `rejected with ${String(error)}`}`);
      return error;
    };

    // ---- what every bus must do ----

    add("every listed event reaches every handler that lists it once, in position order, and an unlisted one none", async (world) => {
      const binding = world.bind({ handlers: { process: { a: world.recorder("a", [Alpha]), ab: world.recorder("ab", [Alpha, Beta]) } } });
      await binding.deliver();
      await world.publish(binding, [Alpha, 1], [Beta, 2], [Alpha, 3]);
      await world.publish(binding, [Echo, 4]);
      await binding.deliver();
      assert(JSON.stringify(positions(world, "a")) === "[1,3]", `a got ${JSON.stringify(positions(world, "a"))}`);
      assert(JSON.stringify(positions(world, "ab")) === "[1,2,3]", `ab got ${JSON.stringify(positions(world, "ab"))}`);
      await binding.deliver();
      assert(positions(world, "ab").length === 3, "a second round handled an event again");
      const event = world.seen.get("ab")![1]!;
      assert(event.name === "conformance.Beta" && (event.payload as Fields).n === 2 && event.payload instanceof Beta && typeof event.id === "string", "a handler gets the event as published, its payload an instance of its class");
    });

    add("a process handler's work commits with its progress, in one transaction, and what it publishes carries causedBy", async (world) => {
      const echoes: EventRecord[] = [];
      const binding = world.bind({ handlers: { process: { echo: world.recorder("echo", [Alpha], {
        run: async (event) => {
          await world.layer.transaction(async (tx) => {
            echoes.push(await publishEvent(tx, undefined, { entity: "conformance.Thing", action: "echo", key: { id: "e" }, at: "conformance" }, new Echo({ n: event.position }), {}, CLOCK));
          });
        },
      }) } } });
      await binding.deliver();
      const [first] = await world.publish(binding, [Alpha, 1]);
      await binding.deliver();
      assert(echoes.length === 1 && echoes[0]!.causedBy === world.seen.get("echo")![0]!.id, "the event a process handler publishes carries the handled event's id as causedBy");
      const { handlers } = await world.state();
      assert(handlers.find((row) => row.name === "echo")!.position >= first!, "the handler's progress moved past the event");
    });

    add("a handler body that throws records nothing, and the event is handed again", async (world) => {
      let fail = 1;
      const binding = world.bind({ handlers: { process: { flaky: world.recorder("flaky", [Alpha], { run: () => { if (fail-- > 0) throw new Error("once"); } }) } } });
      await binding.deliver();
      await world.publish(binding, [Alpha, 1]);
      await binding.deliver();
      assert(JSON.stringify(positions(world, "flaky")) === "[1,1]", `the failing event was to be retried once, got ${JSON.stringify(positions(world, "flaky"))}`);
    });

    add("a listen handler runs outside any transaction", async (world) => {
      let joined: boolean | undefined;
      const binding = world.bind({ handlers: { listen: { mail: world.recorder("mail", [Alpha], { run: () => { joined = world.layer.refuseIfFailed(); } }) } } });
      await binding.deliver();
      await world.publish(binding, [Alpha, 1]);
      await binding.deliver();
      assert(joined === false, "a listen handler's body ran inside a transaction");
    });

    add("handlers run with { system: true }, or with what the module's context(event) returns", async (world) => {
      const contexts: unknown[] = [];
      const first = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha], { run: (_e, { context }) => { contexts.push(context); } }) } } });
      await first.deliver();
      await world.publish(first, [Alpha, 1]);
      await first.deliver();
      const second = world.bind({
        handlers: { process: { h: world.recorder("h", [Alpha], { run: (_e, { context }) => { contexts.push(context); } }) } },
        // SAFETY: This fixture tests system-only contexts; importing projects may augment ActionContext with a required actor.
        context: (event) => ({ system: true, origin: event.position } as unknown as ActionContext),
      });
      await world.publish(second, [Alpha, 2]);
      await second.deliver();
      assert(JSON.stringify(contexts) === JSON.stringify([{ system: true }, { system: true, origin: 2 }]), `got ${JSON.stringify(contexts)}`);
    });

    add("retryable: a ForbiddenError stops the handler at its event with no retry, as does an error with retryable: false; a plain Error is retried", async (world) => {
      let plain = 0;
      const binding = world.bind({ handlers: { process: {
        denied: world.recorder("denied", [Alpha], { run: () => { throw new ForbiddenError({ entity: "conformance.Thing", action: "make", policies: [], reason: "failed", breakdown: [] } as never); } }),
        final: world.recorder("final", [Alpha], { run: () => { throw Object.assign(new Error("final"), { retryable: false }); } }),
        plain: world.recorder("plain", [Alpha], { run: () => { if (++plain < 3) throw new Error("try again"); } }),
      } } });
      await binding.deliver();
      const [p] = await world.publish(binding, [Alpha, 1]);
      const error = await deliverRejects(binding);
      assert(JSON.stringify(error.stopped.map((s) => s.handler).sort()) === '["denied","final"]', `stopped ${JSON.stringify(error.stopped.map((s) => s.handler))}`);
      assert(error.stopped.every((s) => s.position === p && s.event === "conformance.Alpha"), "a stop names the event's position and name");
      assert(positions(world, "denied").length === 1 && positions(world, "final").length === 1, "a non-retryable error was retried");
      assert(positions(world, "plain").length === 3, `a plain Error was to be retried until it passed, tried ${positions(world, "plain").length} times`);
    });

    add("a stopped handler holds deletion, and the next deliver() retries it", async (world) => {
      let broken = true;
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha], { run: () => { if (broken) throw Object.assign(new Error("down"), { retryable: false }); } }) } } });
      await binding.deliver();
      const [p] = await world.publish(binding, [Alpha, 1], [Alpha, 2]);
      await deliverRejects(binding);
      let rows = await world.outbox();
      assert(rows.some((row) => row.position === p), "a row a stopped handler has not handled was deleted");
      broken = false;
      await binding.deliver();
      assert(JSON.stringify(positions(world, "h")) === "[1,1,2]", `got ${JSON.stringify(positions(world, "h"))}`);
      rows = await world.outbox();
      if (world.keep === "until-delivered") assert(rows.length === 0, "every delivered row was to be deleted");
      else assert(rows.length === 2, "keep: all deletes nothing");
    });

    add("deletion follows keep: until-delivered deletes what every reader passed, all deletes nothing", async (world) => {
      const binding = world.bind({ handlers: { process: { a: world.recorder("a", [Alpha]) } } });
      await binding.deliver();
      await world.publish(binding, [Alpha, 1], [Beta, 2], [Echo, 3]);
      await binding.deliver();
      const { state } = await world.state();
      assert(state.deletedThrough === (world.keep === "all" ? 0 : 3), `deleted through ${state.deletedThrough}`);
    });

    add("a row whose name matches no declared event stops every handler there, and is never deleted", async (world) => {
      const before = world.bind({ handlers: { process: { a: world.recorder("a", [Alpha]), b: world.recorder("b", [Beta]) } } });
      await before.deliver();
      const [, renamed] = await world.publish(before, [Alpha, 1], [Beta, 2], [Alpha, 3]);
      const after = world.bind({ handlers: { process: { a: world.recorder("a", [Alpha]), b: world.recorder("b", [Alpha]) } } }, { domain: WITHOUT_BETA });
      const error = await deliverRejects(after);
      assert(error.stopped.length === 2 && error.stopped.every((s) => s.position === renamed && s.cause instanceof EventUndeclaredError), "every handler stops at the undeclared row with MESH_EVENT_UNDECLARED");
      assert((await world.outbox()).some((row) => row.position === renamed), "the undeclared row was deleted");
      assert(!positions(world, "a").includes(3), "a handler went past the undeclared row");
    });

    // ---- the cursor model, through fake buses ----

    const fakeBus = (body: (core: BusCore) => Promise<void>): EventBus => Object.freeze({
      manifest: Object.freeze({ adapter: "fake", capabilities: ["ordered-delivery", "subscribe"] as BusCapability[] }),
      create: (core: BusCore) => ({ start: async () => {}, stop: async () => {}, deliver: () => body(core) }),
    });

    add("runHandler for a row while an earlier listed row is unhandled is refused, and the earlier row stays", async (world) => {
      let caught: unknown;
      const bus = fakeBus(async (core) => {
        const handler = core.handlers[0]!;
        const page = await core.rows(0, 10);
        caught = await rejection(() => core.runHandler(handler, page.rows[1]!));
        await core.deletionPass();
      });
      const publisher = world.bind({});
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } }, { bus });
      await binding.deliver();
      await world.publish(publisher, [Alpha, 1], [Alpha, 2]);
      await binding.deliver();
      assert(caught instanceof FrameworkError, `runHandler skipping a listed row was to be a FrameworkError, got ${String(caught)}`);
      assert(positions(world, "h").length === 0, "the handler ran");
      assert((await world.outbox()).some((row) => row.position === 1), "the unhandled row was deleted");
    });

    add("a bus that hands rows out of order and twice still produces each effect once", async (world) => {
      const bus = fakeBus(async (core) => {
        const handler = core.handlers[0]!;
        const page = await core.rows(await core.position(handler), 10);
        for (const index of [0, 0, 1, 0, 1, 2, 2]) {
          const row = page.rows[index];
          if (row) await core.runHandler(handler, row);
        }
        await core.deletionPass();
      });
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } }, { bus });
      await binding.deliver();
      await world.publish(binding, [Alpha, 1], [Alpha, 2], [Alpha, 3]);
      await binding.deliver();
      await binding.deliver();
      assert(JSON.stringify(positions(world, "h")) === "[1,2,3]", `got ${JSON.stringify(positions(world, "h"))}`);
    });

    add("rows(after): a cursor below a delete is MESH_EVENTS_DELETED, one above the highest position MESH_CURSOR_AHEAD", async (world) => {
      const errors: unknown[] = [];
      const bus = fakeBus(async (core) => {
        errors.push(await rejection(() => core.rows(0, 10)), await rejection(() => core.rows(99, 10)));
      });
      const plain = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await plain.deliver();
      await world.publish(plain, [Alpha, 1], [Alpha, 2]);
      await plain.deliver();
      await world.layer.transaction(async (tx) => { await tx.deleteOutboxThrough!(1); });
      const binding = world.bind({}, { bus });
      await binding.deliver();
      assert(errors[0] instanceof EventsDeletedError, `rows(0) after a delete gave ${String(errors[0])}`);
      assert(errors[1] instanceof CursorAheadError, `rows(99) gave ${String(errors[1])}`);
    });

    add("a round run while an action's transaction is open, which then rolls back, delivers nothing, and the event that reuses the position is delivered", async (world) => {
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await binding.deliver();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = 0;
      const action = world.publish(binding, [Alpha, 1]).then(async () => undefined);
      const rolledBack = binding.transaction(() => world.layer.transaction(async (tx) => {
        held = (await publishEvent(tx, undefined, { entity: "conformance.Thing", action: "make", key: { id: "x" }, at: "conformance" }, new Alpha({ n: 2 }), {}, CLOCK)).position;
        await gate;
        throw new Error("rolled back");
      })).catch(() => undefined);
      await action;
      await until(() => held > 0, "the action's transaction holds a row");
      const round = binding.deliver();
      await sleep(20);
      release();
      await rolledBack;
      await round;
      assert(JSON.stringify(positions(world, "h")) === "[1]", `got ${JSON.stringify(positions(world, "h"))}`);
      const [again] = await world.publish(binding, [Alpha, 3]);
      await binding.deliver();
      assert(JSON.stringify(positions(world, "h")) === JSON.stringify([1, again]), `got ${JSON.stringify(positions(world, "h"))}`);
    });

    // ---- the claim ----

    add("bind with a bus starts nothing and writes no row until deliver() or startDelivery()", async (world) => {
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await world.publish(binding, [Alpha, 1]);
      await sleep(30);
      const { state, handlers } = await world.state();
      assert(state.generation === 0 && state.claim === null && handlers.length === 0, "bind claimed or registered");
    });

    add("deliver() on a started binding is a FrameworkError", async (world) => {
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await start(world, binding);
      assert(await rejection(() => binding.deliver()) instanceof FrameworkError, "deliver() on a started binding");
    });

    add("a second delivering binding is MESH_DELIVERER_TAKEN, as is an overlapping deliver(); two awaited one after the other both deliver", async (world) => {
      const first = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      const second = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await first.deliver();
      await world.publish(first, [Alpha, 1]);
      await first.deliver();
      await world.publish(second, [Alpha, 2]);
      await second.deliver();
      assert(JSON.stringify(positions(world, "h")) === "[1,2]", `got ${JSON.stringify(positions(world, "h"))}`);
      const delivery = await start(world, first);
      const taken = await rejection(() => second.deliver());
      assert(taken instanceof DelivererTakenError && taken.holder.thisProcess && taken.retryable, `got ${String(taken)}`);
      const startedTwice = await rejection(() => second.startDelivery());
      assert(startedTwice instanceof DelivererTakenError, `a second startDelivery() gave ${String(startedTwice)}`);
      await delivery.stop();
      let slow!: () => void;
      const gate = new Promise<void>((resolve) => { slow = resolve; });
      const third = world.bind({ handlers: { process: { g: world.recorder("g", [Alpha], { run: () => gate }) } } });
      await third.deliver();
      await world.publish(third, [Alpha, 3]);
      const round = third.deliver();
      await sleep(20);
      const overlap = await rejection(() => second.deliver());
      slow();
      await round;
      assert(overlap instanceof DelivererTakenError, `an overlapping deliver() gave ${String(overlap)}`);
    });

    add("a deliverer claims after the first stops, and after a claim of another process lapses", async (world) => {
      setDeliveryTiming({ lapseMs: 150 });
      const first = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      const delivery = await start(world, first);
      await delivery.stop();
      const second = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await second.deliver();
      await world.layer.transaction(async (tx) => {
        const { generation } = await ops(tx).readDeliveryState();
        await ops(tx).writeClaim({ runId: "00000000-0000-4000-8000-0000000000aa", generation: generation + 1, host: "elsewhere", pid: 4242, startedAt: new Date() });
      });
      const taken = await rejection(() => second.deliver());
      assert(taken instanceof DelivererTakenError && !taken.holder.thisProcess && taken.holder.pid === 4242 && taken.holder.host === "elsewhere", `a live claim of another process gave ${String(taken)}`);
      await sleep(200);
      await second.deliver();
    });

    add("a replaced deliverer is MESH_DELIVERER_LOST, and neither handles nor deletes afterwards", async (world) => {
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      const publisher = world.bind({});
      markNoDeliver(publisher);
      await start(world, binding);
      await world.publish(publisher, [Alpha, 1]);
      await until(() => positions(world, "h").length === 1, "the started deliverer handles the event of a deliver: false binding");
      await world.layer.transaction(async (tx) => {
        const { generation } = await ops(tx).readDeliveryState();
        await ops(tx).writeClaim({ runId: "00000000-0000-4000-8000-0000000000bb", generation: generation + 1, host: null, pid: null, startedAt: null });
      });
      const [p] = await world.publish(publisher, [Alpha, 2]);
      await sleep(150);
      assert(positions(world, "h").length === 1, "a replaced deliverer handled an event");
      assert((await world.outbox()).some((row) => row.position === p), "a replaced deliverer deleted a row");
      const other = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      const taken = await rejection(() => other.deliver());
      assert(taken instanceof DelivererTakenError && !taken.holder.thisProcess, "the lost deliverer still holds this process's place");
    });

    add("a renewal that updates no row loses the claim", async (world) => {
      setDeliveryTiming({ renewMs: 30 });
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await start(world, binding);
      await world.layer.transaction(async (tx) => {
        const { generation } = await ops(tx).readDeliveryState();
        await ops(tx).writeClaim({ runId: "00000000-0000-4000-8000-0000000000cc", generation, host: null, pid: null, startedAt: null });
      });
      await sleep(120);
      const other = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      const taken = await rejection(() => other.deliver());
      assert(taken instanceof DelivererTakenError && !taken.holder.thisProcess, `after a failed renewal another binding of this process was to see only the other process's claim, got ${String(taken)}`);
    });

    // ---- registration ----

    add("a new handler on a database with rows starts at the highest position and handles none of them", async (world) => {
      const publisher = world.bind({});
      await world.publish(publisher, [Alpha, 1], [Alpha, 2]);
      const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha]) } } });
      await binding.deliver();
      assert(positions(world, "h").length === 0, "a new handler handled rows published before it");
      const { handlers } = await world.state();
      assert(handlers[0]!.position === 2 && handlers[0]!.kind === "process" && JSON.stringify(handlers[0]!.events) === '["conformance.Alpha"]', `row ${JSON.stringify(handlers[0])}`);
    });

    add("a handler that gains an event handles every row of it above its position once; one that gains an event never published adopts it", async (world) => {
      const first = world.bind({ handlers: { process: { notify: world.recorder("notify", [Alpha]) } } });
      await first.deliver();
      await world.publish(first, [Beta, 1], [Alpha, 2], [Beta, 3]);
      const wider = world.bind({ handlers: { process: { notify: world.recorder("notify", [Alpha, Beta, Never]) } } });
      const info = console.info;
      const lines: string[] = [];
      console.info = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try { await wider.deliver(); await wider.deliver(); } finally { console.info = info; }
      assert(JSON.stringify(positions(world, "notify")) === "[1,2,3]", `got ${JSON.stringify(positions(world, "notify"))}`);
      assert(lines.some((line) => line.includes("conformance.Beta") && line.includes("conformance.Never")), "registration reports the events a handler gained");
      const { handlers } = await world.state();
      assert(JSON.stringify(handlers[0]!.events) === '["conformance.Alpha","conformance.Beta","conformance.Never"]', "the row takes the new list");
    });

    add("renamedFrom moves the old row to the new name, kind included, and a second start changes nothing", async (world) => {
      const before = world.bind({ handlers: { process: { old: world.recorder("old", [Alpha]) } } });
      await before.deliver();
      await world.publish(before, [Alpha, 1]);
      await before.deliver();
      await world.publish(before, [Alpha, 2]);
      const info = console.info;
      const lines: string[] = [];
      console.info = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        const after = world.bind({ handlers: { listen: { renamed: world.recorder("renamed", [Alpha], { renamedFrom: "old" }) } } });
        await after.deliver();
        await after.deliver();
      } finally { console.info = info; }
      assert(JSON.stringify(positions(world, "renamed")) === "[2]", `got ${JSON.stringify(positions(world, "renamed"))}`);
      assert(lines.some((line) => line.includes('"renamed"') && line.includes('"old"')), "the move is reported naming both names");
      const { handlers } = await world.state();
      assert(handlers.length === 1 && handlers[0]!.name === "renamed" && handlers[0]!.kind === "listen", `rows ${JSON.stringify(handlers)}`);
    });

    add("renamedFrom with no former row starts from now; naming a registered handler, or one former name twice, is MESH_HANDLER_OPTION before any claim", async (world) => {
      const publisher = world.bind({});
      await world.publish(publisher, [Alpha, 1]);
      const fresh = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha], { renamedFrom: "nobody" }) } } });
      await fresh.deliver();
      assert(positions(world, "h").length === 0, "a renamedFrom with no former row handled old rows");
      const { state } = await world.state();
      const still = world.bind({ handlers: { process: { a: world.recorder("a", [Alpha]), b: world.recorder("b", [Alpha], { renamedFrom: "a" }) } } });
      const twice = world.bind({ handlers: { process: { a: world.recorder("a", [Alpha], { renamedFrom: "x" }), b: world.recorder("b", [Alpha], { renamedFrom: "x" }) } } });
      for (const binding of [still, twice]) {
        const error = await rejection(() => binding.deliver());
        assert(error instanceof HandlerOptionError && error.code === "MESH_HANDLER_OPTION", `got ${String(error)}`);
      }
      assert((await world.state()).state.generation === state.generation, "a refused start claimed");
    });

    add("a handler with onFailure: \"skip\" is MESH_HANDLER_OPTION, on a bus with or without dead-letters, until dead-letter handling is built", async (world) => {
      for (const capabilities of [["ordered-delivery"], ["ordered-delivery", "dead-letters"]] as BusCapability[][]) {
        const bus = testBus({ capabilities });
        const binding = world.bind({ handlers: { process: { h: world.recorder("h", [Alpha], { onFailure: "skip" as never }) } } }, { bus });
        const error = await rejection(() => binding.deliver());
        assert(error instanceof HandlerOptionError && error.code === "MESH_HANDLER_OPTION", `with ${capabilities.join(", ")}: got ${String(error)}`);
        assert(capabilities.length === 1 || error.message.includes("dead-letter handling is not built yet"), `with dead-letters: ${error.message}`);
      }
      assert((await world.state()).handlers.length === 0, "a refused handler was registered");
    });

    add("an orphaned handler row is reported once in a run of deliver() rounds", async (world) => {
      setDeliveryTiming({ orphanReportMs: 60_000 });
      const before = world.bind({ handlers: { process: { gone: world.recorder("gone", [Alpha]), kept: world.recorder("kept", [Alpha]) } } });
      await before.deliver();
      const after = world.bind({ handlers: { process: { kept: world.recorder("kept", [Alpha]) } } });
      const warn = console.warn;
      const lines: string[] = [];
      console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try { for (let i = 0; i < 3; i++) await after.deliver(); } finally { console.warn = warn; }
      const reports = lines.filter((line) => line.includes('"gone"'));
      assert(reports.length === 1 && reports[0]!.includes("mesh events forget gone"), `reports: ${JSON.stringify(lines)}`);
    });

    // ---- replay ----

    if (declares.has("replay")) {
      add("replay: rows(after) reads from any kept position", async (world) => {
        let read: number[] = [];
        const bus = fakeBus(async (core) => { read = (await core.rows(1, 10)).rows.map((row) => row.position); });
        const publisher = world.bind({});
        await world.publish(publisher, [Alpha, 1], [Beta, 2], [Alpha, 3]);
        await world.bind({}, { bus }).deliver();
        assert(JSON.stringify(read) === "[2,3]", `got ${JSON.stringify(read)}`);
      });
    }

    // ---- subscribe ----

    if (declares.has("subscribe")) {
      const received = () => {
        const list: EventRecord[] = [];
        return { list, callback: (event: EventRecord) => { list.push(event); }, positions: () => list.map((event) => event.position) };
      };

      add("listSubscriptions: lists none, one and several persisted subscriptions, their acknowledged progress, and excludes forgotten ones", async (world) => {
        const binding = world.bind({});
        const other = world.bind({});
        assert(JSON.stringify(await listSubscriptions(other)) === "[]", "a fresh database lists no subscriptions");
        const got = received();
        const z = await subscribe(binding, { name: "z", after: 0 }, got.callback);
        const first = await listSubscriptions(other);
        assert(JSON.stringify(first) === '[{"name":"z","position":0}]', `one subscription: ${JSON.stringify(first)}`);
        assert(Object.isFrozen(first) && Object.isFrozen(first[0]), "the list and its entries are frozen snapshots");
        await world.publish(binding, [Alpha, 1], [Alpha, 2]);
        await binding.deliver();
        await until(() => got.list.length === 2, "both rows reach the callback");
        await z.ack(1);
        const a = await subscribe(binding, { name: "a", after: 1 }, () => {});
        await z.close();
        const listed = await listSubscriptions(other);
        assert(JSON.stringify(listed) === '[{"name":"a","position":1},{"name":"z","position":1}]', `open and closed, by acknowledged position not read cursor: ${JSON.stringify(listed)}`);
        assert(first[0]!.position === 0, "a later acknowledgement did not change the earlier snapshot");
        await forgetSubscription(binding, "z");
        assert(JSON.stringify(await listSubscriptions(other)) === '[{"name":"a","position":1}]', "forgotten z is absent");
        await a.close();
        await forgetSubscription(binding, "a");
        assert(JSON.stringify(await listSubscriptions(other)) === "[]", "forgetting every subscription empties the list");
      });

      add("subscribe: a subscription opened on a backlog larger than a page, while commits land during each read, gets every position once, in order", async (world) => {
        const binding = world.bind({});
        const backlog: [typeof Alpha, number][] = Array.from({ length: 250 }, (_, i) => [Alpha, i + 1]);
        await world.publish(binding, ...backlog);
        const got = received();
        await start(world, binding);
        const subscription = await subscribe(binding, { name: "feed", after: 0 }, got.callback);
        let n = 251;
        for (let i = 0; i < 20; i++) { await world.publish(binding, [Alpha, n++]); await sleep(2); }
        await until(() => got.list.length >= 270, "every row reaches the subscription");
        await sleep(50);
        assert(JSON.stringify(got.positions()) === JSON.stringify(Array.from({ length: 270 }, (_, i) => i + 1)), `got ${got.list.length} rows, first gap at ${got.positions().findIndex((p, i) => p !== i + 1)}`);
        await subscription.close();
      });

      add("subscribe: a filter that drops every row still moves the cursor, and the pass moves the acknowledged position, so deletion passes it", async (world) => {
        const binding = world.bind({});
        const got = received();
        const subscription = await subscribe(binding, { name: "never", names: ["conformance.Never"] }, got.callback);
        await world.publish(binding, [Alpha, 1], [Beta, 2]);
        await binding.deliver();
        await binding.deliver();
        const { state, subscriptions } = await world.state();
        assert(got.list.length === 0, "a filtered row reached the callback");
        assert(subscriptions[0]!.position === 2, `acknowledged position ${subscriptions[0]!.position}`);
        assert(state.deletedThrough === (world.keep === "all" ? 0 : 2), `deleted through ${state.deletedThrough}`);
        await subscription.close();
      });

      add("subscribe: an unacknowledged row is never deleted, ack(p) lets deletion pass p, and a reopen gets every unacknowledged row again whatever after it passes", async (world) => {
        const binding = world.bind({});
        const got = received();
        let subscription = await subscribe(binding, { name: "s", after: 0 }, got.callback);
        await world.publish(binding, [Alpha, 1], [Alpha, 2], [Alpha, 3]);
        await binding.deliver();
        await until(() => got.list.length === 3, "three rows are handed over");
        await binding.deliver();
        assert((await world.outbox()).length === 3, "an unacknowledged row was deleted");
        await subscription.ack(2);
        await binding.deliver();
        const kept = (await world.outbox()).map((row) => row.position);
        assert(JSON.stringify(kept) === (world.keep === "all" ? "[1,2,3]" : "[3]"), `kept ${JSON.stringify(kept)}`);
        await subscription.close();
        const again = received();
        subscription = await subscribe(binding, { name: "s", after: 0 }, again.callback);
        await binding.deliver();
        await until(() => again.list.length === 1, "the unacknowledged row is handed again");
        assert(JSON.stringify(again.positions()) === "[3]", `reopen got ${JSON.stringify(again.positions())}`);
        await subscription.close();
      });

      add("subscribe: a first open behind the deleted-through position or above the highest is refused and writes no row", async (world) => {
        const binding = world.bind({});
        await world.publish(binding, [Alpha, 1], [Alpha, 2]);
        await world.layer.transaction(async (tx) => { await tx.deleteOutboxThrough!(1); });
        const behind = await rejection(() => subscribe(binding, { name: "s", after: 0 }, () => {}));
        const ahead = await rejection(() => subscribe(binding, { name: "s", after: 9 }, () => {}));
        assert(behind instanceof EventsDeletedError && ahead instanceof CursorAheadError, `got ${String(behind)} and ${String(ahead)}`);
        assert((await world.state()).subscriptions.length === 0, "a refused open wrote a row");
        const subscription = await subscribe(binding, { name: "s", after: 1 }, () => {});
        await subscription.close();
      });

      add("subscribe: a reopen with another filter is a FrameworkError until forgetSubscription drops the row; forgetSubscription refuses an open one", async (world) => {
        const binding = world.bind({});
        const subscription = await subscribe(binding, { name: "s", names: ["conformance.Alpha"] }, () => {});
        assert(await rejection(() => forgetSubscription(binding, "s")) instanceof FrameworkError, "forgetSubscription dropped an open subscription");
        await subscription.close();
        assert(await rejection(() => subscribe(binding, { name: "s", names: ["conformance.Beta"] }, () => {})) instanceof FrameworkError, "a reopen with another filter");
        await forgetSubscription(binding, "s");
        assert((await world.state()).subscriptions.length === 0, "forgetSubscription left the row");
        await (await subscribe(binding, { name: "s", names: ["conformance.Beta"] }, () => {})).close();
      });

      add("subscribe: ack above what was handed, ack on a closed handle, a second open under an open name and an open with no name are FrameworkErrors", async (world) => {
        const binding = world.bind({});
        const got = received();
        const subscription = await subscribe(binding, { name: "s", after: 0 }, got.callback);
        await world.publish(binding, [Alpha, 1]);
        await binding.deliver();
        await until(() => got.list.length === 1, "the row is handed over");
        assert(await rejection(() => subscription.ack(2)) instanceof FrameworkError, "ack above what was handed");
        assert(await rejection(() => subscribe(binding, { name: "s" }, () => {})) instanceof FrameworkError, "a second open under an open name");
        assert(await rejection(() => subscribe(binding, { name: "" }, () => {})) instanceof FrameworkError, "an open with no name");
        await subscription.close();
        assert(await rejection(() => subscription.ack(1)) instanceof FrameworkError, "ack on a closed handle");
      });

      add("subscribe: close() and an ended stream clear the open flag and write seenAt", async (world) => {
        const binding = world.bind({});
        const subscription = await subscribe(binding, { name: "s" }, () => {});
        const opened = (await world.state()).subscriptions[0]!;
        assert(opened.open, "an open subscription's row is open");
        await sleep(10);
        await subscription.close();
        const closed = (await world.state()).subscriptions[0]!;
        assert(!closed.open && closed.seenAt.getTime() > opened.seenAt.getTime(), `row ${JSON.stringify(closed)}`);
        const ended = await subscribe(binding, { name: "t", after: 0 }, () => { throw new Error("callback failed"); });
        await world.publish(binding, [Alpha, 1]);
        await binding.deliver();
        const cause = await ended.done;
        assert(cause instanceof Error && cause.message === "callback failed", `the stream ended with ${String(cause)}`);
        assert(!(await world.state()).subscriptions.find((row) => row.name === "t")!.open, "an ended stream left the row open");
      });

      add("subscribe: ack writes the position and the database's now as seenAt", async (world) => {
        const binding = world.bind({});
        const got = received();
        const subscription = await subscribe(binding, { name: "s", after: 0 }, got.callback);
        await world.publish(binding, [Alpha, 1], [Alpha, 2]);
        await binding.deliver();
        await until(() => got.list.length === 2, "two rows are handed over");
        const before = (await world.state()).subscriptions[0]!;
        await sleep(10);
        await subscription.ack(1);
        const acked = (await world.state()).subscriptions[0]!;
        assert(acked.position === 1 && acked.open, `row ${JSON.stringify(acked)}`);
        assert(acked.seenAt.getTime() > before.seenAt.getTime(), `seenAt stayed at ${before.seenAt.toISOString()} through ack`);
        await subscription.close();
      });

      add("subscribe: a round that runs while subscribe writes the row does not feed it; it then reads from its row's position", async (world) => {
        const publisher = world.bind({});
        await world.publish(publisher, [Alpha, 1], [Alpha, 2]);
        const got = received();
        let opening = -1;
        let cursors: number[] = [];
        let opened: Subscription | undefined;
        const bus = fakeBus(async (core) => {
          // subscribe reserves the name in the registry before its first await, then writes the row
          const pending = subscribe(binding, { name: "s" }, got.callback);
          opening = core.subscriptions().length;
          opened = await pending;
          cursors = core.subscriptions().map((subscription) => subscription.cursor);
          await world.publish(publisher, [Alpha, 3]);
          for (const subscription of core.subscriptions()) await subscription.feed(await core.rows(subscription.cursor, 10));
          await core.deletionPass();
        });
        const binding = world.bind({}, { bus });
        await binding.deliver();
        assert(opening === 0, `a round fed a subscription still writing its row (${opening} listed)`);
        assert(JSON.stringify(cursors) === "[2]", `the opened subscription's cursor: ${JSON.stringify(cursors)}`);
        await until(() => got.list.length === 1, "the row published after the open is handed over");
        assert(JSON.stringify(got.positions()) === "[3]", `got ${JSON.stringify(got.positions())}`);
        await opened!.close();
      });

      add("subscribe: a stop while subscribe writes the row ends the stream with null and leaves the row closed", async (world) => {
        const bus = fakeBus(async () => {});
        const binding = world.bind({}, { bus });
        const delivery = await start(world, binding);
        // hold the layer, so subscribe's transaction waits behind it while the stop runs
        let release!: () => void;
        const held = world.layer.transaction(() => new Promise<void>((resolve) => { release = resolve; }));
        const pending = subscribe(binding, { name: "s" }, () => {});
        const stopping = delivery.stop();
        await sleep(10);
        release();
        await held;
        const subscription = await pending;
        await stopping;
        const cause = await Promise.race([subscription.done, sleep(2000).then(() => "timeout")]);
        assert(cause === null, `the stream ended with ${String(cause)}`);
        const row = (await world.state()).subscriptions.find((each) => each.name === "s");
        assert(row !== undefined && !row.open, `row ${JSON.stringify(row)}`);
        // the name is free again: nothing of the ended open stayed in the registry
        await (await subscribe(binding, { name: "s" }, () => {})).close();
      });

      add("subscribe in a process whose database another process's live claim holds is a FrameworkError naming it, and writes no row", async (world) => {
        setDeliveryTiming({ lapseMs: 150 });
        const binding = world.bind({});
        await world.layer.transaction(async (tx) => {
          const { generation } = await ops(tx).readDeliveryState();
          await ops(tx).writeClaim({ runId: "00000000-0000-4000-8000-0000000000ee", generation: generation + 1, host: "elsewhere", pid: 4242, startedAt: new Date() });
        });
        const error = await rejection(() => subscribe(binding, { name: "s" }, () => {}));
        assert(error instanceof FrameworkError && error.message.startsWith("subscribe was called in a process that does not deliver: another process (pid 4242 on host elsewhere)"), `got ${String(error)}`);
        assert((await world.state()).subscriptions.length === 0, "a refused open wrote a row");
        await sleep(200);
        // once that claim lapses, nothing holds the database, and the open goes ahead
        await (await subscribe(binding, { name: "s" }, () => {})).close();
      });

      add("subscribe: an orphaned subscription is reported once, then at most hourly, under until-delivered only", async (world) => {
        setDeliveryTiming({ orphanReportMs: 60_000 });
        const binding = world.bind({});
        const closedOne = await subscribe(binding, { name: "away" }, () => {});
        await closedOne.close();
        const got = received();
        const lagging = await subscribe(binding, { name: "lagging", after: 0 }, got.callback);
        await world.publish(binding, [Alpha, 1]);
        await binding.deliver();
        await until(() => got.list.length === 1, "the row is handed over");
        setDeliveryTiming({ orphanAgeMs: 30 });
        await sleep(60);
        const warn = console.warn;
        const lines: string[] = [];
        console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
        try { for (let i = 0; i < 3; i++) await binding.deliver(); } finally { console.warn = warn; }
        const away = lines.filter((line) => line.includes('"away"')).length;
        const lag = lines.filter((line) => line.includes('"lagging"')).length;
        if (world.keep === "until-delivered") assert(away === 1 && lag === 1, `reports: ${JSON.stringify(lines)}`);
        else assert(away === 0 && lag === 0, `keep: all reported ${JSON.stringify(lines)}`);
        await lagging.close();
      });

      add("subscribe: MESH_SUBSCRIPTION_OVERFLOW is retryable and keeps the row", async (world) => {
        setDeliveryTiming({ maxQueue: 3 });
        const binding = world.bind({});
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const subscription = await subscribe(binding, { name: "slow", after: 0 }, () => gate);
        await world.publish(binding, ...Array.from({ length: 10 }, (_, i) => [Alpha, i + 1] as [typeof Alpha, number]));
        await binding.deliver();
        const cause = await subscription.done;
        release();
        assert(cause instanceof SubscriptionOverflowError && cause.retryable, `the stream ended with ${String(cause)}`);
        const row = (await world.state()).subscriptions[0]!;
        assert(row && !row.open && row.position === 0, `row ${JSON.stringify(row)}`);
      });

      add("subscribe: a subscription of a deliverer that loses its claim ends with MESH_DELIVERER_LOST", async (world) => {
        setDeliveryTiming({ renewMs: 30 });
        const binding = world.bind({});
        await start(world, binding);
        const subscription: Subscription = await subscribe(binding, { name: "s" }, () => {});
        await world.layer.transaction(async (tx) => {
          const { generation } = await ops(tx).readDeliveryState();
          await ops(tx).writeClaim({ runId: "00000000-0000-4000-8000-0000000000dd", generation: generation + 1, host: null, pid: null, startedAt: null });
        });
        const cause = await Promise.race([subscription.done, sleep(2000).then(() => "timeout")]);
        assert(cause instanceof DelivererLostError, `the stream ended with ${String(cause)}`);
      });
    }
  }
  return checks;
}
