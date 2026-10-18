import type { OutboxPage, OutboxRow, SubscriptionFilter } from "./data-layer.ts";
import type { StoppedHandler } from "./errors.ts";
import { FrameworkError } from "./errors.ts";
import type { EventRecord } from "./events.ts";
import type { ActionContext } from "./index.ts";

/**
 * The event-bus contract (spec, Events and commands, "The event-bus contract"): what an adapter (`localBus`, a broker
 * adapter later) declares and what core hands it. Core owns everything that touches the database (the claim, the
 * handler transaction and progress, registration, subscriptions' rows, deletion); a bus decides only when to read and
 * whom to feed, and reaches the outbox and the handlers through `BusCore` alone.
 */

/**
 * The promises a bus can make beyond the mandatory set, a closed list as the data layer's is.
 *
 * - `ordered-delivery`: each handler gets events in position order, one at a time. Every handler needs it.
 * - `replay`: `readEvents` from any kept position. `#mesh` exports `readEvents` only when the bus declares it.
 * - `subscribe`: live subscriptions. `#mesh` exports `subscribe` only when the bus declares it.
 * - `dead-letters`: `onFailure: "skip"` and `retryFailed`.
 * - `multi-process`: handlers and subscriptions in every process on the database (later, with Postgres).
 */
export const BUS_CAPABILITIES = ["ordered-delivery", "replay", "subscribe", "dead-letters", "multi-process"] as const;

export type BusCapability = (typeof BUS_CAPABILITIES)[number];

/**
 * The configured bus's capabilities, merged in by `mesh build` (`declare module "@meshfw/runtime"` in `#mesh`), one
 * `true` member per capability: a handler option the bus cannot honour is then a type error. Empty until a build merges it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: merged by generated code
export interface EventBusCapabilities {}

/** What a bus declares, as static data the build reads without starting it. */
export interface BusManifest {
  readonly adapter: string;
  readonly capabilities: readonly BusCapability[];
}

/**
 * A bus descriptor, what `events.bus` holds (`localBus()`): it holds no state and starts nothing, so the build may
 * construct one each time it imports the config and several bindings may share one. Core calls `create` once per binding
 * that delivers.
 */
export interface EventBus {
  readonly manifest: BusManifest;
  create(core: BusCore, options: BusOptions): EventBusInstance;
}

/** What core passes to `create` beside the core: the settings in force for this deliverer. */
export interface BusOptions {
  /** The deliverer's `events.keep`. Core deletes by it; a bus only needs to know a passed row may be gone, or kept. */
  readonly keep: "until-delivered" | "all";
}

/** One bus instance, made by core for one binding that delivers. It starts nothing when constructed. */
export interface EventBusInstance {
  /** Run on its own until `stop()`. */
  start(): Promise<void>;
  /** End subscriptions, wait for the running round, clear every timer. */
  stop(): Promise<void>;
  /** One round, then resolve; rejects with `HandlerStoppedError` naming every handler that stopped, or with the error that ended the round. */
  deliver(): Promise<void>;
  /**
   * Resume a handler this instance stopped after `start()`: feed it again from its progress row, in the next round, with
   * a fresh retry schedule. Optional; core calls it for `resumeHandler(name)` of `#mesh` (spec, Events and commands,
   * "Handler failures") and refuses that call when the started bus has none. A handler that is not stopped is left as it is.
   */
  resumeHandler?(handler: RegisteredHandler): void;
}

/** A handler as core registered it for this claim: what a bus feeds. */
export interface RegisteredHandler {
  /** The handler's name, unique across both kinds. */
  readonly name: string;
  readonly kind: "process" | "listen";
  /** The sorted FQNs it lists. */
  readonly events: readonly string[];
  readonly onFailure: "stop" | "skip";
}

/**
 * A live subscription, a core object: its own cursor (the read head, filtered rows included) and `feed(page)`, which
 * hands the page's matching rows to the subscription's callback and moves the cursor. A bus reads `rows(cursor)` for it
 * and feeds what came back, and ends it with `end(error)` when the read failed.
 */
export interface LiveSubscription {
  readonly name: string;
  /** The read head: the position of the last row read for it. */
  readonly cursor: number;
  readonly filter: SubscriptionFilter;
  /** True once it was closed or its stream ended: a bus feeds it no more. */
  readonly ended: boolean;
  /**
   * Hand the page's rows above the cursor to the callback, in order, and move the cursor to the page's last row. Resolves
   * once they are queued; the callback runs from the queue, one row at a time. A queue past `maxQueue` (default 10 000)
   * ends the subscription with `MESH_SUBSCRIPTION_OVERFLOW`; a row no declared event matches ends it with
   * `MESH_EVENT_UNDECLARED`.
   */
  feed(page: OutboxPage, options?: { readonly maxQueue?: number }): Promise<void>;
  /** End the stream with `error`, as a failed read does (`MESH_EVENTS_DELETED`, `MESH_CURSOR_AHEAD`). */
  end(error: unknown): void;
}

/** What core hands a bus instance. */
export interface BusCore {
  /** The one read of the outbox: the committed rows above `after`, at most `limit`, checked against both positions. */
  rows(after: number, limit: number): Promise<OutboxPage>;
  /** The handlers registered for this claim, in name order. */
  readonly handlers: readonly RegisteredHandler[];
  /** The handler's cursor: its progress row's low-water position, read now. A bus re-reads it each round. */
  position(handler: RegisteredHandler): Promise<number>;
  /** True when the handler is to be handed `row`: it lists the row's event, or no declared event matches the row's name. */
  lists(handler: RegisteredHandler, row: OutboxRow): boolean;
  /**
   * Deliver `row` to `handler`, the only way a bus delivers: the handler transaction, the generation check, the
   * progress check and write. Rejects with the handler's error (nothing recorded), `MESH_DATABASE_BUSY` (the round ends;
   * never a handler failure), `MESH_DELIVERER_LOST` (the instance is over) or `MESH_EVENT_UNDECLARED`.
   */
  runHandler(handler: RegisteredHandler, row: OutboxRow): Promise<void>;
  /**
   * Core's retry path: `runHandler`, retried after each of `delays` (milliseconds; the bus's schedule) while the error is
   * retryable. Resolves with null once handled, or with the stop to report: at once for an error whose `retryable` is
   * false, after the schedule otherwise. `MESH_DATABASE_BUSY` and `MESH_DELIVERER_LOST` reject, and do not count as a try.
   */
  retry(handler: RegisteredHandler, row: OutboxRow, delays: readonly number[]): Promise<StoppedHandler | null>;
  /** Whether a retry of a handler that threw `error` makes sense: its own `retryable`, true for an error that sets none. */
  isRetryable(error: unknown): boolean;
  /** The subscriptions open on this database in this process, now. */
  subscriptions(): readonly LiveSubscription[];
  /** Core's deletion pass, by `keep`, in batches; takes no position. A bus calls it after each round. */
  deletionPass(): Promise<void>;
  /** Call `listener` after each outermost commit in this process that published on this database. Returns the unsubscribe. */
  onPublished(listener: () => void): () => void;
  /** Call `listener` once the claim is lost; the instance must make no further call into core. Returns the unsubscribe. */
  onClaimLost(listener: (error: Error) => void): () => void;
}

/** The context a handler runs with: what the events module's `context(event)` returns, by default `{ system: true }`. */
export interface HandlerTools {
  readonly context: ActionContext;
}

/** What `onFailure` may be: `"skip"` only when the bus declares `dead-letters` (through `EventBusCapabilities`). */
export type OnFailure = "stop" | ("dead-letters" extends keyof EventBusCapabilities ? "skip" : never);

/** An event class as a handler lists it. */
export type ListedEvent<E extends object = object> = abstract new (fields: never) => E;

/**
 * A handler, registered under a kind and a name in the events module's `handlers`: the events it lists, and `run`, which
 * gets each as a record whose `payload` is an instance of its class.
 */
export interface Handler<E extends object = object> {
  readonly events: readonly ListedEvent<E>[];
  run(event: EventRecord<E>, tools: HandlerTools): void | Promise<void>;
  /** Default `"stop"`: retry, report and stop at the event. `"skip"` needs the bus's `dead-letters`. */
  readonly onFailure?: OnFailure;
  /** The handler's former name, whose progress row it takes over at registration. */
  readonly renamedFrom?: string;
}

/**
 * `Mesh.handler(options)`: returns `options` as it is. It exists so that TypeScript infers the type of `run`'s event from
 * `events`, which it cannot do through a plain object literal.
 */
export function handler<const C extends readonly ListedEvent[]>(options: {
  readonly events: C;
  run(event: EventRecord<InstanceType<C[number]>>, tools: HandlerTools): void | Promise<void>;
  readonly onFailure?: OnFailure;
  readonly renamedFrom?: string;
}): Handler<InstanceType<C[number]>> {
  return options as unknown as Handler<InstanceType<C[number]>>;
}

/**
 * Check a bus descriptor read from a config (the build) or handed to a binding (start): a manifest with a non-empty
 * adapter name and capabilities from the closed list, and a `create` function. Returns the problem, or null.
 */
export function busProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "it must be an event-bus descriptor, such as localBus()";
  const { manifest, create } = value as { manifest?: unknown; create?: unknown };
  if (typeof create !== "function") return "it has no create function: an event-bus descriptor has { manifest, create(core, options) }";
  if (typeof manifest !== "object" || manifest === null) return "it has no manifest: an event-bus descriptor declares { adapter, capabilities }";
  const { adapter, capabilities } = manifest as { adapter?: unknown; capabilities?: unknown };
  if (typeof adapter !== "string" || adapter.trim() === "") return "its manifest's adapter must be a non-empty string";
  if (!Array.isArray(capabilities)) return "its manifest's capabilities must be an array";
  const seen = new Set<unknown>();
  for (const name of capabilities) {
    if (typeof name !== "string" || !(BUS_CAPABILITIES as readonly string[]).includes(name))
      return `its manifest lists the unknown capability ${JSON.stringify(name)}; the closed set is ${BUS_CAPABILITIES.join(", ")}`;
    if (seen.has(name)) return `its manifest lists the capability "${name}" twice`;
    seen.add(name);
  }
  return null;
}

/** `busProblem` as a throw: the bus of a binding that is asked to deliver. */
export function checkedBus(value: unknown): EventBus {
  const problem = busProblem(value);
  if (problem) throw new FrameworkError(`events.bus is not a valid event bus: ${problem}`);
  return value as EventBus;
}
