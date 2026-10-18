import {
  DatabaseBusyError, DelivererLostError, FrameworkError, HandlerStoppedError,
  type BusCore, type BusManifest, type EventBus, type EventBusInstance, type LiveSubscription, type OutboxRow, type RegisteredHandler, type StoppedHandler,
} from "@meshfw/runtime";

/**
 * `localBus` (spec, Events and commands, "`localBus`, the first adapter"): a round feeds each handler from its own
 * cursor, in position order, one event at a time, then each live subscription from its own cursor, then runs core's
 * deletion pass. After `start()` a round runs at once, after each outermost commit that published in this process, and
 * every `pollInterval`; a failing handler is retried on its own timer, outside the round, so its back-off delays no
 * other reader. A `deliver()` round retries inline, through core's retry path. The claim and its renewal are core's.
 */

/** What `localBus` takes. */
export interface LocalBusOptions {
  /** After `start()`, a round also runs this often, in milliseconds, for the commits of processes that only publish; default 1000. */
  readonly pollInterval?: number;
  /**
   * The delays before each retry of a failing handler, in milliseconds; once they are used up the handler stops. Default
   * `[100, 1000, 10000]` after `start()` and `[0, 0, 0]` in `deliver()` rounds; a value given here applies to both.
   */
  readonly retryDelays?: readonly number[];
  /** The rows a live subscription may have waiting for its callback before it ends with `MESH_SUBSCRIPTION_OVERFLOW`; default 10 000. */
  readonly maxQueue?: number;
}

/** The timer functions the bus uses; tests pass their own to count what is left after `stop()`. */
export interface LocalBusTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}

/** What the internal factory takes beside the public options. Not exported from the package. */
export interface LocalBusInternals {
  readonly timers?: LocalBusTimers;
  /** Where a stopped handler and a failed background round are reported; default `console.error`. */
  readonly report?: (error: unknown) => void;
}

const STARTED_DELAYS: readonly number[] = Object.freeze([100, 1000, 10_000]);
const DELIVER_DELAYS: readonly number[] = Object.freeze([0, 0, 0]);
const POLL_INTERVAL = 1000;
const OPTION_NAMES = new Set(["pollInterval", "retryDelays", "maxQueue"]);
/** The rows one read asks for. */
const PAGE = 100;

const MANIFEST: BusManifest = Object.freeze({ adapter: "local", capabilities: Object.freeze(["ordered-delivery", "replay", "subscribe"] as const) });

const SYSTEM_TIMERS: LocalBusTimers = Object.freeze({
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (run: () => void, ms: number) => setInterval(run, ms),
  clearInterval: (timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>),
});

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") return String(value);
  return `a value of type ${typeof value}`;
}

/** The options, checked: a `FrameworkError` names the first one that is wrong. */
function checked(options: LocalBusOptions | undefined): { pollInterval: number; retryDelays: readonly number[] | undefined; maxQueue: number | undefined } {
  if (options === undefined) return { pollInterval: POLL_INTERVAL, retryDelays: undefined, maxQueue: undefined };
  if (typeof options !== "object" || options === null || Array.isArray(options))
    throw new FrameworkError(`localBus takes { pollInterval, retryDelays, maxQueue }, and was given ${describe(options)}`);
  for (const key of Object.keys(options))
    if (!OPTION_NAMES.has(key)) throw new FrameworkError(`localBus has no option ${JSON.stringify(key)}; its options are pollInterval, retryDelays and maxQueue`);
  const { pollInterval, retryDelays, maxQueue } = options;
  if (pollInterval !== undefined && (typeof pollInterval !== "number" || !Number.isFinite(pollInterval) || pollInterval <= 0))
    throw new FrameworkError(`localBus: pollInterval is how often a round runs after start(), in milliseconds, a number above 0, and is ${describe(pollInterval)}`);
  if (retryDelays !== undefined && (!Array.isArray(retryDelays) || retryDelays.some((delay) => typeof delay !== "number" || !Number.isFinite(delay) || delay < 0)))
    throw new FrameworkError(`localBus: retryDelays is the delay before each retry, in milliseconds, an array of numbers each 0 or more (such as [100, 1000, 10000]), and is ${describe(retryDelays)}`);
  if (maxQueue !== undefined && (typeof maxQueue !== "number" || !Number.isSafeInteger(maxQueue) || maxQueue < 1))
    throw new FrameworkError(`localBus: maxQueue is how many rows a subscription may have waiting for its callback, a whole number of 1 or more, and is ${describe(maxQueue)}`);
  return { pollInterval: pollInterval ?? POLL_INTERVAL, retryDelays: retryDelays === undefined ? undefined : Object.freeze([...retryDelays]), maxQueue };
}

/** A started handler's state: stopped at an event, or backing off before the next try of one. */
interface Lane {
  stopped: boolean;
  backoff: { readonly position: number; readonly tries: number; timer: unknown; ready: boolean } | undefined;
}

/**
 * `localBus(options?)`: the bus descriptor for `events: { bus: localBus() }`. It holds no state and starts nothing, so
 * the build may make one each time it loads the config; core makes one instance per binding that delivers.
 */
export function localBus(options?: LocalBusOptions): EventBus {
  return createLocalBus(options);
}

/** `localBus` with the timers and the reporter it uses, for tests. */
export function createLocalBus(options: LocalBusOptions | undefined, internals: LocalBusInternals = {}): EventBus {
  const settings = checked(options);
  const startedDelays = settings.retryDelays ?? STARTED_DELAYS;
  const deliverDelays = settings.retryDelays ?? DELIVER_DELAYS;
  // Core's default maxQueue applies unless the project sets one: the option is handed to feed only when given.
  const feedOptions = settings.maxQueue === undefined ? undefined : Object.freeze({ maxQueue: settings.maxQueue });
  const timers = internals.timers ?? SYSTEM_TIMERS;
  const report = internals.report ?? ((error: unknown) => {
    if (error instanceof HandlerStoppedError)
      console.error("Mesh (localBus): a handler stopped. Fix the cause, then call resumeHandler(name), or restart delivery:", error);
    else console.error("Mesh (localBus): a delivery round failed; the next round runs at the next commit or poll:", error);
  });
  return Object.freeze({
    manifest: MANIFEST,
    create(core: BusCore): EventBusInstance {
      return instance(core, { pollInterval: settings.pollInterval, startedDelays, deliverDelays, feedOptions, timers, report });
    },
  });
}

interface InstanceSettings {
  readonly pollInterval: number;
  readonly startedDelays: readonly number[];
  readonly deliverDelays: readonly number[];
  readonly feedOptions: { readonly maxQueue: number } | undefined;
  readonly timers: LocalBusTimers;
  readonly report: (error: unknown) => void;
}

function instance(core: BusCore, settings: InstanceSettings): EventBusInstance {
  const { timers, report } = settings;
  let started = false;
  /** Set once core says the claim is lost: the instance is over and calls core no more. */
  let lost: Error | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let poll: unknown;
  let offPublished: (() => void) | undefined;
  const lanes = new Map<string, Lane>();

  const laneOf = (handler: RegisteredHandler): Lane => {
    let lane = lanes.get(handler.name);
    if (!lane) lanes.set(handler.name, lane = { stopped: false, backoff: undefined });
    return lane;
  };
  const clearBackoffs = (): void => {
    for (const lane of lanes.values()) {
      if (lane.backoff?.timer !== undefined) timers.clearTimeout(lane.backoff.timer);
      lane.backoff = undefined;
    }
  };
  const clearTimers = (): void => {
    if (poll !== undefined) timers.clearInterval(poll);
    poll = undefined;
    clearBackoffs();
  };
  // The listener lives as long as core's deliverer, which drops it with the instance.
  core.onClaimLost((error) => {
    lost = error;
    started = false;
    clearTimers();
  });

  /** One try of `row` for a started handler; true once handled, false when it backs off or stops. */
  const tryStarted = async (handler: RegisteredHandler, lane: Lane, row: OutboxRow): Promise<boolean> => {
    try {
      await core.runHandler(handler, row);
      lane.backoff = undefined;
      return true;
    } catch (error) {
      // Busy ends the round and is not a try: the backoff is left as it was, so the next round tries again.
      if (error instanceof DatabaseBusyError || error instanceof DelivererLostError) throw error;
      const tries = lane.backoff?.position === row.position ? lane.backoff.tries : 0;
      if (!core.isRetryable(error) || tries >= settings.startedDelays.length) {
        lane.backoff = undefined;
        lane.stopped = true;
        const stop: StoppedHandler = { handler: handler.name, position: row.position, event: row.name, cause: error };
        report(new HandlerStoppedError([stop]));
        return false;
      }
      const backoff: NonNullable<Lane["backoff"]> = { position: row.position, tries: tries + 1, timer: undefined, ready: false };
      lane.backoff = backoff;
      backoff.timer = timers.setTimeout(() => {
        backoff.timer = undefined;
        if (lane.backoff !== backoff) return;
        backoff.ready = true;
        wake();
      }, settings.startedDelays[tries]!);
      return false;
    }
  };

  /** Feed `handler` from its own cursor; resolves with its stop in a `deliver()` round, else null. */
  const feedHandler = async (handler: RegisteredHandler, mode: "started" | "deliver"): Promise<StoppedHandler | null> => {
    const lane = mode === "started" ? laneOf(handler) : undefined;
    let cursor = await core.position(handler);
    for (;;) {
      const page = await core.rows(cursor, PAGE);
      for (const row of page.rows) {
        if (mode === "started" && !started) return null;
        if (core.lists(handler, row)) {
          if (lane) {
            if (!(await tryStarted(handler, lane, row))) return null;
          } else {
            const stop = await core.retry(handler, row, settings.deliverDelays);
            if (stop) return stop;
          }
        }
        cursor = row.position;
      }
      if (page.rows.length < PAGE) return null;
    }
  };

  const feedSubscription = async (subscription: LiveSubscription): Promise<void> => {
    try {
      while (!subscription.ended) {
        const page = await core.rows(subscription.cursor, PAGE);
        await subscription.feed(page, settings.feedOptions);
        if (page.rows.length < PAGE) break;
      }
    } catch (error) {
      if (error instanceof DelivererLostError || error instanceof DatabaseBusyError) throw error;
      // MESH_EVENTS_DELETED, MESH_CURSOR_AHEAD, MESH_EVENT_UNDECLARED: the reader that asked ends, with that error.
      subscription.end(error);
    }
  };

  const round = async (mode: "started" | "deliver"): Promise<void> => {
    if (lost) throw lost;
    const stopped: StoppedHandler[] = [];
    for (const handler of core.handlers) {
      if (mode === "started") {
        if (!started) return;
        const lane = laneOf(handler);
        if (lane.stopped || (lane.backoff && !lane.backoff.ready)) continue;
      }
      const stop = await feedHandler(handler, mode);
      if (stop) stopped.push(stop);
    }
    if (mode === "started" && !started) return;
    for (const subscription of core.subscriptions()) await feedSubscription(subscription);
    if (mode === "started" && !started) return;
    await core.deletionPass();
    if (stopped.length > 0) throw new HandlerStoppedError(stopped);
  };

  const wake = (): void => {
    if (!started || lost) return;
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        try {
          await round("started");
        } catch (error) {
          // A lost claim ends the instance; a busy database ends the round, and the next one runs at the next wake-up.
          if (!(error instanceof DelivererLostError) && !(error instanceof DatabaseBusyError) && !lost) report(error);
        }
      } while (again && started && !lost);
    })().finally(() => { running = undefined; });
  };

  return Object.freeze({
    async start() {
      if (lost) throw lost;
      if (started) return;
      started = true;
      lanes.clear();
      offPublished = core.onPublished(wake);
      poll = timers.setInterval(wake, settings.pollInterval);
      wake();
    },
    async stop() {
      started = false;
      clearTimers();
      offPublished?.();
      offPublished = undefined;
      await running;
      lanes.clear();
    },
    async deliver() {
      if (lost) throw lost;
      await round("deliver");
    },
    resumeHandler(handler: RegisteredHandler) {
      const lane = lanes.get(handler.name);
      if (!lane?.stopped) return;
      lane.stopped = false;
      lane.backoff = undefined;
      wake();
    },
  } satisfies EventBusInstance);
}
