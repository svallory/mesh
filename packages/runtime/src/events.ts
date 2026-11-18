import type { DataLayer, DataOperations, Key, OutboxAppend, OutboxPage, OutboxRow } from "./data-layer.ts";
import { DECLARATION, type Declaration } from "./declarations.ts";
import { HANDLER_KIND, type BusCapability, type EventBus, type Handler, type HandlerKind } from "./bus.ts";
import type { Capability } from "./capabilities.ts";
import { CursorAheadError, EventUndeclaredError, EventsConfigError, EventsDeletedError, FrameworkError } from "./errors.ts";
import type { Clock } from "./expr.ts";
import type { ActionContext, EventMetadata } from "./index.ts";
import { NO_RENAMES, resolveEventName, storedToDeclared } from "./stored-names.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * Events at run time (M6, spec "Events and commands"): the `publish` step's write to the outbox, a transaction's own
 * events (`published()`), core's one read of the outbox (`rows`) and `readEvents` over it. Delivery, handlers and the
 * deletion pass are in `deliverer.ts`; the bus contract is in `bus.ts`.
 */

/**
 * A published event as a reader gets it: the envelope core fills, the project's `metadata`, and the event itself as an
 * instance of its generated class (`payload`). The envelope stays outside the instance, since fields named `id`, `name`
 * or `key` are common in events.
 */
export interface EventRecord<E extends object = object> {
  /** A time-ordered UUID: the event's identity, the same across redeliveries; consumers deduplicate on it. */
  readonly id: string;
  /** The event's place in the outbox's order, never reused. */
  readonly position: number;
  /** The event's FQN, e.g. `billing.InvoicePaid`. */
  readonly name: string;
  /** The publishing entity's FQN. */
  readonly entity: string;
  /** The publishing action's name. */
  readonly action: string;
  /** The publishing record's key. */
  readonly key: Key;
  /** The id of the event whose handler was running when it was published, or null. */
  readonly causedBy: string | null;
  /** What the project's `metadata` function returned for it (`{}` when there is none). */
  readonly metadata: EventMetadata;
  /** The transaction's instant at the publish. */
  readonly occurredAt: Date;
  /** The event: an instance of its generated class. */
  readonly payload: E;
}

/** What the project's `metadata` function receives: the record so far (everything but `position`, `metadata` and `causedBy`) and the publishing call's context. */
export interface MetadataArguments<E extends object = object> {
  readonly event: Omit<EventRecord<E>, "position" | "metadata" | "causedBy">;
  readonly context: Readonly<ActionContext>;
}

/**
 * The project's `metadata` function (`export const metadata` of the events module): runs in the transaction, once per
 * `publish`, after the step's function returns, and returns plain JSON, stored as the event's `metadata`. Mesh never
 * stores the context itself, which can hold secrets.
 */
export type MetadataFunction<E extends object = object> = (args: MetadataArguments<E>) => EventMetadata | Promise<EventMetadata>;

/**
 * The handlers the `.mesh.mx` files' `handlers` sections declare (section handlers), as the generated `bind` hands them to
 * `bindDomain`: one record per core kind, each handler under its key `<owner FQN>.<name>` (`billing.Invoice.receipt`),
 * and where each one is written. Core registers and delivers them as it does the events module's handlers.
 */
export interface SectionHandlers {
  readonly process?: Readonly<Record<string, Handler>>;
  readonly listen?: Readonly<Record<string, Handler>>;
  /** Where each one is written, by key (`billing/invoice.mesh.mx:9:5`), for the start errors that name both sources. */
  readonly at: Readonly<Record<string, string>>;
}

/**
 * Merges the records the generated `<owner>.handlers.ts` files export (`$handlers`) into one, in list order. Keys are
 * unique by construction (an owner's FQN and a name unique in its section), so a key two records hold can only come from
 * a hand-edited generated file: a `FrameworkError`.
 */
export function mergeHandlers(list: readonly SectionHandlers[]): SectionHandlers {
  const process: Record<string, Handler> = {};
  const listen: Record<string, Handler> = {};
  const at: Record<string, string> = {};
  for (const handlers of list) {
    for (const [kind, into] of [["process", process], ["listen", listen]] as const) {
      for (const [key, handler] of Object.entries(handlers[kind] ?? {})) {
        if (key in process || key in listen)
          throw new FrameworkError(`Two handlers sections declare the handler ${key} (${at[key] ?? "unknown"} and ${handlers.at[key] ?? "unknown"}): a generated file was edited by hand; rebuild with mesh build`);
        into[key] = handler;
        at[key] = handlers.at[key] ?? "unknown";
      }
    }
  }
  return Object.freeze({ process: Object.freeze(process), listen: Object.freeze(listen), at: Object.freeze(at) });
}

/** The events module (`src/events.ts`), which `events.load` loads at run time and the build never imports. */
export interface EventsModule {
  /** The handlers, by kind, each under its name: the name is unique across every kind and keys its progress row. */
  handlers?: {
    process?: Record<string, Handler>;
    listen?: Record<string, Handler>;
    /** A contributed kind's handlers, under the kind's name (ADR-0094): each carries the kind (`[HANDLER_KIND]`). */
    readonly [kind: string]: Record<string, Handler> | undefined;
  };
  metadata?: MetadataFunction<never>;
  /** The context handlers run with; default `{ system: true }`. It can read the original person from the event's `metadata`. */
  context?: (event: EventRecord) => ActionContext;
  /**
   * Turns a stored row's payload into the fields its event's class accepts today (ADR-0094): called for every stored row
   * read back (handlers, subscriptions, `readEvents`, `retryFailed`), after the rename map gives the row its declared
   * name and before its dates are revived and its class is constructed. Returns the payload unchanged when it already has
   * today's shape. `upcasters()` of `@meshfw/event-sourcing` builds one.
   */
  upcast?: (stored: OutboxRow) => unknown;
}

/**
 * The `events` key of `mesh.config.ts`, and the `events` option of `bind(layer, { events })`.
 */
export interface EventsConfig {
  /** The event bus (`localBus()`); a project that declares an event must set it, and there is no default. */
  bus?: EventBus;
  /** Loads the events module at run time: `() => import("./src/events.ts")`. `connect()` calls it; under `bind`, the binding's first `publish` does. */
  load?: () => Promise<EventsModule>;
  /**
   * How long the outbox keeps a row: `"until-delivered"` (the default) deletes a row once every reader is past it; `"all"`
   * keeps every row, for an application that reads history or whose clients resume from cursors; `{ days: n }` deletes a
   * row once every reader is past it and it is at least `n` whole days old; `{ default, events }` applies a rule per
   * event (`PerEventKeep`). Read by whatever starts delivery.
   */
  keep?: Keep | PerEventKeep;
  /** Capabilities the project needs from the bus and the data adapter: checked by the build, ignored by `bind`. */
  requires?: readonly (BusCapability | Capability)[];
  /**
   * Former event FQN to the declared event it now is: a stored row whose name is a key is read as that event, so an event
   * declaration can move while the outbox keeps its old rows. A key is written in full and is no declared event; a value
   * names a declared event, and may be shortened to the fewest trailing segments that pick one. Stored rows are never
   * rewritten.
   */
  renamed?: Readonly<Record<string, string>>;
}

/**
 * One retention rule of `events.keep`: `"until-delivered"` deletes a row once every reader has passed it, `"all"` keeps
 * every row, and `{ days }` deletes a passed row once it is `days` whole days old, its `occurredAt` measured against the
 * database's clock.
 */
export type Keep = "until-delivered" | "all" | { readonly days: number };

/**
 * `events.keep` with a rule per event: `events` maps an event's FQN (which may be shortened to the fewest trailing
 * segments that pick one declared event, or be a former FQN of `events.renamed`) to its rule, and `default` is the rule
 * of every other row. A row is deleted once every reader has passed it and its own event's rule allows it, so rows can be
 * deleted while an older row is kept (a hole); a history read that takes an event from below one of its holes is then
 * `MESH_EVENTS_DELETED`.
 */
export interface PerEventKeep {
  readonly default: Keep;
  readonly events: Readonly<Record<string, Keep>>;
}

/** The rules of `events.keep` resolved against the declared events: `events` by declared FQN, `default` for the rest. */
export interface KeepRules {
  readonly default: Keep;
  readonly events: ReadonlyMap<string, Keep>;
}

/** The two string values of `events.keep`. */
export const KEEP_VALUES: readonly ("until-delivered" | "all")[] = Object.freeze(["until-delivered", "all"]);

/** A problem with `events.keep`, as the build reports it and `bind` throws it (`MESH_EVENTS_CONFIG`). */
export interface KeepProblem {
  readonly message: string;
  readonly fix: string;
}

/**
 * The longest keep period, in days (about 273 years). The deletion pass measures a period back from the database's
 * clock (`now - days`) and hands that `since` to the data layer, so every adapter must hold it. A JavaScript Date
 * holds 100,000,000 days either side of 1970, but Postgres reads `since` as ISO text into a timestamptz, and the text
 * of a date before year 1 (`-000164-07-21T...Z`) is refused, failing every pass. 100,000 days back from any clock
 * after 1970 lands after 1696, which every adapter stores.
 */
export const MAX_KEEP_DAYS = 100_000;

/** True for an object `events.keep` value that is the per-event form (it has `default` or `events`), not a period. */
function isPerEvent(keep: unknown): keep is Record<string, unknown> {
  return typeof keep === "object" && keep !== null && !Array.isArray(keep) && !Object.hasOwn(keep, "days")
    && (Object.hasOwn(keep, "default") || Object.hasOwn(keep, "events"));
}

/** The problem with one rule (`"until-delivered"`, `"all"` or `{ days }`) at `field` (`events.keep`, `events.keep.default`, ...), or null. */
function ruleProblem(keep: unknown, field: string, forms: string, fix: string): KeepProblem | null {
  if ((KEEP_VALUES as readonly unknown[]).includes(keep)) return null;
  if (typeof keep === "object" && keep !== null && !Array.isArray(keep) && Object.hasOwn(keep, "days")) {
    const extra = Object.keys(keep).find((key) => key !== "days");
    if (extra !== undefined)
      return { message: `\`${field}\` { days } takes no other field, and has ${JSON.stringify(extra)}`, fix: "Remove the field, as in keep: { days: 30 }" };
    const days = (keep as { days: unknown }).days;
    if (!(typeof days === "number" && Number.isSafeInteger(days) && days >= 1 && days <= MAX_KEEP_DAYS))
      return { message: `\`${field}.days\` must be a whole number of days, from 1 to ${MAX_KEEP_DAYS}, and is ${describeValue(days)}`, fix: "Set days to a whole number, such as 30" };
    return null;
  }
  return { message: `\`${field}\` must be ${forms}, and is ${describeValue(keep)}`, fix };
}

/**
 * The problem with an `events.keep` value, or null when it is one of `KEEP_VALUES`, `{ days }` with a whole number
 * of days from 1 to `MAX_KEEP_DAYS`, or `{ default, events }` (`PerEventKeep`) whose `default` and every value of
 * `events` is one of those, on a bus that delivers from one process. Shared by the build's check of `mesh.config.ts`
 * and `bind`'s check of its `events` option; the names of `events` are checked against the declared events by
 * `keepEventsProblems`. A period or the per-event form is refused on a bus that declares `multi-process`: the keep
 * recorded for several processes is one of the two strings, and a process without the rule would delete the rows it keeps.
 */
export function keepProblem(keep: unknown, bus?: unknown): KeepProblem | null {
  if ((KEEP_VALUES as readonly unknown[]).includes(keep)) return null;
  const manifest = (bus as { manifest?: { adapter?: unknown; capabilities?: unknown } } | null | undefined)?.manifest;
  const multi = Array.isArray(manifest?.capabilities) && manifest.capabilities.includes("multi-process");
  if (isPerEvent(keep)) {
    const extra = Object.keys(keep).find((key) => key !== "default" && key !== "events");
    if (extra !== undefined)
      return { message: `\`events.keep\` { default, events } takes no other field, and has ${JSON.stringify(extra)}`, fix: "Remove the field, as in keep: { default: \"until-delivered\", events: { \"audit.Viewed\": \"all\" } }" };
    for (const field of ["default", "events"] as const)
      if (!Object.hasOwn(keep, field))
        return { message: `\`events.keep\` { default, events } needs both fields, and has no ${field}`, fix: "Set both, as in keep: { default: \"until-delivered\", events: { \"audit.Viewed\": \"all\" } }" };
    const single = ruleProblem(keep.default, "events.keep.default", "\"until-delivered\", \"all\" or { days }", "Set default to \"until-delivered\", \"all\" or { days: 30 }");
    if (single) return single;
    const events = keep.events;
    const prototype = typeof events === "object" && events !== null && !Array.isArray(events) ? Object.getPrototypeOf(events) : undefined;
    if (prototype !== Object.prototype && prototype !== null)
      return { message: `\`events.keep.events\` must be an object from an event's FQN to its rule, such as { "audit.Viewed": "all" }, and is ${describeValue(events)}`, fix: "Set events: { \"<event FQN>\": \"all\" }" };
    for (const [name, rule] of Object.entries(events as Record<string, unknown>)) {
      if (name.trim() === "")
        return { message: "`events.keep.events` has an empty key: each key names a declared event", fix: "Write the event's FQN as the key" };
      const problem = ruleProblem(rule, `events.keep.events[${JSON.stringify(name)}]`, "\"until-delivered\", \"all\" or { days }", "Set the event's rule to \"until-delivered\", \"all\" or { days: 30 }");
      if (problem) return problem;
    }
    if (multi)
      return {
        message: `\`events.keep\` sets a rule per event ({ default, events }), and the bus ${String(manifest!.adapter)} delivers from several processes (multi-process), whose recorded keep is "until-delivered" or "all": a process without the rule would delete the rows this one keeps`,
        fix: "Set keep: \"until-delivered\" or keep: \"all\", or deliver from one process",
      };
    return null;
  }
  const problem = ruleProblem(keep, "events.keep", "\"until-delivered\", \"all\", { days } or { default, events }",
    "Set keep: \"until-delivered\" (the default: a row is deleted once delivered), keep: \"all\" (every row is kept), keep: { days: 30 } (a delivered row is kept 30 days) or keep: { default: \"until-delivered\", events: { \"audit.Viewed\": \"all\" } } (a rule per event)");
  if (problem) return problem;
  if (multi)
    return {
      message: `\`events.keep\` is { days: ${(keep as { days: number }).days} }, and the bus ${String(manifest!.adapter)} delivers from several processes (multi-process), whose recorded keep is "until-delivered" or "all": a process without the period would delete the rows this one keeps`,
      fix: "Set keep: \"until-delivered\" or keep: \"all\", or deliver from one process",
    };
  return null;
}

/** The whole days of a period rule, or null for `"until-delivered"`, `"all"`, the per-event form and an absent `keep`. */
export function keepDays(keep: Keep | PerEventKeep | undefined): number | null {
  return typeof keep === "object" && keep !== null && Object.hasOwn(keep, "days") ? (keep as { days: number }).days : null;
}

/** The per-event form of a `keep` already checked by `keepProblem`, or null for a single rule. */
export function perEventKeep(keep: Keep | PerEventKeep | undefined): PerEventKeep | null {
  return isPerEvent(keep) ? keep as unknown as PerEventKeep : null;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every problem of the names of a per-event `events.keep` (`keep.events`) against the declared FQNs (rule RN4): each key
 * is a former FQN of the checked rename map `renamed` (read as the event it now is) or picks one declared event, exactly
 * or by its trailing segments; no two keys pick the same event. A single rule has no names, and no problem here.
 */
export function keepEventsProblems(keep: unknown, fqns: readonly string[], renamed: ReadonlyMap<string, string> = NO_RENAMES): KeepProblem[] {
  if (!isPerEvent(keep) || typeof keep.events !== "object" || keep.events === null) return [];
  const names = Object.keys(keep.events);
  if (names.length === 0) return [];
  if (fqns.length === 0)
    return [{ message: `\`events.keep.events\` names ${JSON.stringify(names[0])}, and the project declares no event: each key names a declared event`, fix: "Remove the entry, or declare the event" }];
  const problems: KeepProblem[] = [];
  const sorted = [...fqns].sort(byCodeUnit);
  const seen = new Map<string, string>();
  for (const name of names) {
    const former = renamed.get(name);
    const found = former !== undefined ? { kind: "found" as const, fqn: former } : resolveEventName(name, fqns);
    if (found.kind === "ambiguous") {
      problems.push({ message: `\`events.keep.events\` names ${JSON.stringify(name)}, which is ambiguous: ${found.candidates.join(" or ")}`, fix: "Write more of the name" });
      continue;
    }
    if (found.kind === "unknown") {
      problems.push({ message: `\`events.keep.events\` names ${JSON.stringify(name)}, which is no declared event; the project declares ${sorted.join(", ")}`, fix: "Correct the name" });
      continue;
    }
    const before = seen.get(found.fqn);
    if (before !== undefined)
      problems.push({ message: `\`events.keep.events\` names ${found.fqn} twice (as ${JSON.stringify(before)} and ${JSON.stringify(name)})`, fix: "Remove the second one" });
    else seen.set(found.fqn, name);
  }
  return problems;
}

/**
 * The rules of a per-event `keep` (checked by `keepProblem` and `keepEventsProblems`) by declared FQN; null for a
 * single rule. A key that is a former FQN or a shortened name is stored under the event it picks.
 */
export function keepRulesOf(keep: Keep | PerEventKeep | undefined, fqns: readonly string[], renamed: ReadonlyMap<string, string> = NO_RENAMES): KeepRules | null {
  const form = perEventKeep(keep);
  if (form === null) return null;
  const events = new Map<string, Keep>();
  for (const [name, rule] of Object.entries(form.events)) {
    const former = renamed.get(name);
    const found = former !== undefined ? { kind: "found" as const, fqn: former } : resolveEventName(name, fqns);
    if (found.kind === "found") events.set(found.fqn, rule);
  }
  return Object.freeze({ default: form.default, events });
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "a function";
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** The class of an event, as `mesh build` generates it. */
export type EventClass = (new (fields: never) => object) & { readonly [DECLARATION]: Declaration };

/** The events each outermost transaction has published so far, in order, by its data operations. */
const publishedOf = new WeakMap<DataOperations, EventRecord[]>();
/** The id of the event whose handler a transaction runs for, by its data operations: what its publishes carry as `causedBy`. */
const causes = new WeakMap<DataOperations, string>();

/**
 * The quiet call chain a transaction runs in, by its data operations: the handler of a contributed kind (ADR-0094) at
 * the chain's root, whose chain may not publish until the handler call settles.
 */
const quiets = new WeakMap<DataOperations, { readonly label: string; readonly kind: HandlerKind }>();

/** Forget what `tx` published, the event it ran for and its quiet chain: called by `outermost` when the transaction opens and once it has settled. */
export function forgetPublished(tx: DataOperations): void {
  publishedOf.delete(tx);
  causes.delete(tx);
  quiets.delete(tx);
}

/** Record that `tx` runs in the quiet call chain of `label`, a handler of `kind`: a publish in it is refused. */
export function quietIn(tx: DataOperations, label: string, kind: HandlerKind): void {
  if (!quiets.has(tx)) quiets.set(tx, { label, kind });
}

/** Record that `tx` runs for the handler of the event `eventId`, unless it already runs for one. */
export function causedIn(tx: DataOperations, eventId: string): void {
  if (!causes.has(tx)) causes.set(tx, eventId);
}

/** A frozen copy of the events published so far in the transaction whose operations are `tx`. */
export function publishedIn(tx: DataOperations): readonly EventRecord[] {
  return Object.freeze([...(publishedOf.get(tx) ?? [])]);
}

/**
 * One value per database: by `layer.database` when the layer names its database, else by the layer object. Core keeps
 * the deliverer's process-side state, the subscription registry and the publish wake-ups this way.
 */
export class PerDatabase<T> {
  readonly #named = new Map<string, T>();
  readonly #objects = new WeakMap<DataLayer, T>();
  constructor(private readonly make: (layer: DataLayer) => T) {}
  get(layer: DataLayer): T {
    const name = typeof layer.database === "string" && layer.database !== "" ? layer.database : undefined;
    let value = name === undefined ? this.#objects.get(layer) : this.#named.get(name);
    if (value === undefined) {
      value = this.make(layer);
      if (name === undefined) this.#objects.set(layer, value); else this.#named.set(name, value);
    }
    return value;
  }
}

/** The listeners `BusCore.onPublished` registered, per database. */
const publishListeners = new PerDatabase<Set<() => void>>(() => new Set());

/**
 * Call `listener` after each outermost commit in this process that published on `layer`'s database, and, when the layer
 * reports them (`DataLayer.onAppended`), after such commits in other processes. Returns the unsubscribe, which removes both.
 */
export function onPublished(layer: DataLayer, listener: () => void): () => void {
  const listeners = publishListeners.get(layer);
  listeners.add(listener);
  // The adapter calls this from its own notification callback: a throw is reported here and never reaches the adapter.
  const appended = layer.onAppended?.(() => { wake(listener); });
  return () => { listeners.delete(listener); appended?.(); };
}

/** Calls one `onPublished` listener; a listener that throws is reported, never thrown to the caller. */
function wake(listener: () => void): void {
  try { listener(); } catch (error) { console.error("A bus's onPublished listener threw:", error); }
}

/** Called by `outermost` after a commit that published: wakes every listener of the database. A listener that throws is reported, never the commit's failure. */
export function notifyPublished(layer: DataLayer): void {
  for (const listener of [...publishListeners.get(layer)]) wake(listener);
}

/** The loaded events module, by the configuration object that loads it: loaded once per configuration. */
const modules = new WeakMap<EventsConfig, Promise<EventsModule>>();
const NO_MODULE: EventsModule = Object.freeze({});

/**
 * The events module of `config`, loaded on the first call and kept: `{}` when there is no configuration or no `load`.
 * A `load` that rejects, or resolves with something that is not a module whose `metadata` is a function, is a
 * `FrameworkError`; a failed load is tried again on the next call.
 */
export function loadEvents(config: EventsConfig | undefined): Promise<EventsModule> {
  if (config === undefined || config.load === undefined) return Promise.resolve(NO_MODULE);
  let loading = modules.get(config);
  if (!loading) {
    const load = config.load;
    if (typeof load !== "function")
      return Promise.reject(new FrameworkError(`events.load must be a function that imports the events module, () => import("./src/events.ts"), and is ${describe(load)}`));
    loading = (async () => {
      let loaded: unknown;
      try {
        loaded = await load();
      } catch (cause) {
        throw new FrameworkError(`events.load() rejected: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (typeof loaded !== "object" || loaded === null)
        throw new FrameworkError(`events.load() must resolve with the events module, and resolved with ${describe(loaded)}`);
      const metadata = (loaded as { metadata?: unknown }).metadata;
      if (metadata !== undefined && typeof metadata !== "function")
        throw new FrameworkError(`The events module exports metadata as ${describe(metadata)}: it must be a function ({ event, context }) => ({ ... })`);
      const context = (loaded as { context?: unknown }).context;
      if (context !== undefined && typeof context !== "function")
        throw new FrameworkError(`The events module exports context as ${describe(context)}: it must be a function (event) => ({ ... }), the context handlers run with`);
      const upcast = (loaded as { upcast?: unknown }).upcast;
      if (upcast !== undefined && typeof upcast !== "function")
        throw new FrameworkError(`The events module exports upcast as ${describe(upcast)}: it must be a function (stored) => payload, which turns a stored row's payload into its event's current fields`);
      const handlers = (loaded as { handlers?: unknown }).handlers;
      if (handlers !== undefined) {
        if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers))
          throw new FrameworkError(`The events module exports handlers as ${describe(handlers)}: it must be an object { process, listen }, each a record of handlers by name`);
        checkKinds(handlers as Record<string, unknown>);
        const count = Object.values(handlers as Record<string, object | undefined>).reduce((sum, group) => sum + Object.keys(group ?? {}).length, 0);
        if (count > 0 && config.bus === undefined)
          throw new EventsConfigError("The events module exports handlers, and mesh.config.ts configures no events.bus: nothing would deliver to them. Set events: { bus: localBus() }, or remove the handlers");
      }
      return loaded as EventsModule;
    })();
    modules.set(config, loading);
    loading.catch(() => { if (modules.get(config) === loading) modules.delete(config); });
  }
  return loading;
}

/** The kinds core runs itself; every other key of `handlers` names a kind an extension contributes. */
const CORE_KINDS: ReadonlySet<string> = new Set(["process", "listen"]);
/** A contributed kind's name, and the word after `name:` in what its `stored` returns. */
const KIND_WORD = /^[a-z]+$/;

/** The kind a handler carries (`[HANDLER_KIND]`), checked (D3); undefined when it carries none. */
export function kindOf(name: string, handler: unknown): HandlerKind | undefined {
  if (typeof handler !== "object" || handler === null) return undefined;
  const kind = (handler as { [HANDLER_KIND]?: unknown })[HANDLER_KIND];
  if (kind === undefined) return undefined;
  const { name: kindName, owner } = (kind ?? {}) as Partial<HandlerKind>;
  const functions = ["check", "start", "adopt", "stored"] as const;
  if (typeof kind !== "object" || kind === null || typeof kindName !== "string" || typeof owner !== "string" || functions.some((key) => typeof (kind as Record<string, unknown>)[key] !== "function"))
    throw new FrameworkError(`The handler ${JSON.stringify(name)} carries ${describe(kind)} as its kind: a handler kind is an object { name, owner, check, start, adopt, stored }, made by the extension that contributes it`);
  if (CORE_KINDS.has(kindName) || !KIND_WORD.test(kindName))
    throw new FrameworkError(`The handler ${JSON.stringify(name)} carries a kind named ${JSON.stringify(kindName)} from ${owner}: an extension's kind cannot take the name of a core kind, and its name is one lowercase word`);
  return kind as HandlerKind;
}

/**
 * The keys of the events module's `handlers` (ADR-0094): `process` and `listen`, and the name of each kind an extension
 * contributes, under which every handler carries that kind. A handler under a key that is not its kind's, an empty group
 * under a key no kind names, and a handler with no kind under such a key are `FrameworkError`s.
 */
function checkKinds(handlers: Record<string, unknown>): void {
  for (const [key, group] of Object.entries(handlers)) {
    if (group !== undefined && (typeof group !== "object" || group === null || Array.isArray(group)))
      throw new FrameworkError(`The events module's handlers.${key} is ${describe(group)}: it must be a record of handlers by name`);
    for (const [name, handler] of Object.entries(group ?? {})) {
      const kind = kindOf(name, handler);
      if (kind !== undefined && kind.name !== key)
        throw new FrameworkError(`The events module lists the ${kind.name} handler ${JSON.stringify(name)} under handlers.${key}: list it under handlers.${kind.name}`);
      if (kind === undefined && !CORE_KINDS.has(key))
        throw new FrameworkError(`The events module's handlers has the kind ${JSON.stringify(key)}, and its handler ${JSON.stringify(name)} is not one an extension made for that kind: the kinds are process, listen and those an extension's handlers carry, such as project from @meshfw/event-sourcing`);
    }
  }
  for (const [key, group] of Object.entries(handlers))
    if (!CORE_KINDS.has(key) && Object.keys(group ?? {}).length === 0)
      throw new FrameworkError(`The events module's handlers has the kind ${JSON.stringify(key)}, with no handler under it and none of that kind anywhere in the module: the kinds are process, listen and those an extension's handlers carry. Check the spelling, or remove the empty group`);
}

/** Whether `stored`, what `kind.stored` returned, is `kind.name` or `kind.name:<one lowercase word>`. */
export function storedKindProblem(kind: HandlerKind, stored: unknown): boolean {
  if (stored === kind.name) return false;
  return typeof stored !== "string" || !stored.startsWith(`${kind.name}:`) || !KIND_WORD.test(stored.slice(kind.name.length + 1));
}

/** Where a `publish` step is: the publishing entity and action, the record's key and the step's source line. */
export interface PublishTarget {
  /** The entity's FQN, e.g. `billing.Invoice`. */
  readonly entity: string;
  readonly action: string;
  readonly key: Key;
  /** The step's place in its entity file, `billing/invoice.mesh.mx:13:17`. */
  readonly at: string;
}

/**
 * What a generated `publish` step calls with what its function returned: checks that `value` is an instance of a
 * declared event (DOM-58), builds its record, runs the project's `metadata`, appends the row in the running transaction
 * (`tx`) and adds the record to the transaction's own events (`published()`). Anything else, `null` and a plain object
 * shaped like the event included, is a `FrameworkError` naming the entity, the action and the source line; it rolls the
 * action back, since a `publish` that quietly raised nothing would hide a bug.
 */
export async function publishEvent(
  tx: DataOperations, events: EventsConfig | undefined, target: PublishTarget, value: unknown, context: unknown, clock: Clock,
): Promise<EventRecord> {
  const quiet = quiets.get(tx);
  if (quiet !== undefined)
    throw new FrameworkError(`The publish step of ${target.entity}#${target.action} (${target.at}) ran inside ${quiet.label}, or in an action it or a seam started while it ran, and a ${quiet.kind.name} handler may not publish: a handler of a kind ${quiet.kind.owner} contributes is run again over history to rebuild what it writes, and a rebuild must never re-raise events. Publish from the action the event records, or from a process handler`);
  const declaration = eventDeclaration(value);
  if (!declaration)
    throw new FrameworkError(`The publish step of ${target.entity}#${target.action} (${target.at}) must return an instance of a declared event, such as new InvoicePaid({ ... }), and returned ${describe(value)}. A publish that should sometimes raise nothing is written inside a when=`);
  if (typeof tx.appendEvent !== "function")
    throw new FrameworkError(`${target.entity}#${target.action} publishes an event, and the data layer has no appendEvent: a project that declares an event needs a data adapter with the outbox operations`);
  const event = Object.freeze({
    id: uuidv7(),
    name: declaration.fqn,
    entity: target.entity,
    action: target.action,
    key: deepFrozen(jsonCopy(target.key, "the record's key")) as Key,
    occurredAt: clock(),
    payload: value as object,
  });
  const metadata = await metadataOf(events, event, context, target);
  const causedBy = causes.get(tx) ?? null;
  const row: OutboxAppend = { ...event, causedBy, metadata, payload: jsonCopy(value, `the event ${declaration.fqn}`) };
  const position = await tx.appendEvent(row);
  const record: EventRecord = Object.freeze({ ...event, position, causedBy, metadata: metadata as EventMetadata });
  const list = publishedOf.get(tx);
  if (list) list.push(record); else publishedOf.set(tx, [record]);
  return record;
}

/** The declaration of `value`'s class when `value` is a true instance of a generated event class, else undefined. */
function eventDeclaration(value: unknown): Declaration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const declaration = (value.constructor as { [DECLARATION]?: Declaration } | undefined)?.[DECLARATION];
  return declaration?.kind === "event" && typeof declaration.is === "function" && declaration.is(value) ? declaration : undefined;
}

/** The event's metadata: what the project's `metadata` function returns, as a deeply frozen JSON copy; `{}` when there is none. */
async function metadataOf(events: EventsConfig | undefined, event: MetadataArguments["event"], context: unknown, target: PublishTarget): Promise<object> {
  const { metadata } = await loadEvents(events);
  if (metadata === undefined) return Object.freeze({});
  const result: unknown = await (metadata as MetadataFunction)({ event, context: (context ?? {}) as Readonly<ActionContext> });
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new FrameworkError(`The events module's metadata function returned ${describe(result)} for the event ${event.name} published by ${target.entity}#${target.action} (${target.at}): it must return an object of plain JSON values`);
  return deepFrozen(jsonCopy(result, "the metadata")) as object;
}

/** A plain JSON copy of `value`: what the outbox stores. A value JSON cannot hold (a cycle, a bigint) is a `FrameworkError` naming `what`. */
function jsonCopy(value: unknown, what: string): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new FrameworkError(`${what} cannot be stored as JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return text === undefined ? null : JSON.parse(text);
}

function deepFrozen(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFrozen((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** A value, for a message. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "function") return "a function";
  if (typeof value !== "object") return `a ${typeof value}`;
  const declaration = (value.constructor as { [DECLARATION]?: Declaration } | undefined)?.[DECLARATION];
  if (declaration?.kind === "command") return `an instance of the command ${declaration.fqn}`;
  if (declaration?.kind === "event") return `an object that is not an instance of the event ${declaration.fqn}, though its constructor is that class`;
  return value.constructor === Object || Object.getPrototypeOf(value) === null ? "a plain object" : `an instance of ${value.constructor?.name || "a class"}, not of a declared event`;
}

/**
 * Core's read of the outbox, and the only way any reader reaches it: the committed rows above `after`, at most `limit`,
 * in order. A cursor behind the deleted-through position is `MESH_EVENTS_DELETED`, naming the oldest kept position, and
 * one above the highest position ever assigned is `MESH_CURSOR_AHEAD`; both are checked against the same statement that
 * read the rows, so no row is ever skipped silently. With `renamed`, the binding's checked rename map, a row stored under
 * a former FQN comes back under the name of the event it now is. With `check`, a reader that chose its own cursor (a
 * history read) is also refused with `MESH_EVENTS_DELETED` when an event it takes has a hole above the cursor (rule KE3),
 * checked against the hole record of the same statement.
 */
export async function rows(layer: DataLayer, after: number, limit: number, renamed: ReadonlyMap<string, string> = NO_RENAMES, check?: HoleCheck): Promise<OutboxPage> {
  if (typeof layer.readOutbox !== "function")
    throw new FrameworkError("The data layer has no readOutbox: a project that declares an event needs a data adapter with the outbox operations");
  if (!Number.isSafeInteger(after) || after < 0)
    throw new FrameworkError(`A read of the outbox takes a cursor that is a whole number, 0 or more, and was given ${typeof after === "number" ? after : describe(after)}`);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new FrameworkError(`A read of the outbox takes a limit that is a whole number, 1 or more, and was given ${typeof limit === "number" ? limit : describe(limit)}`);
  const page = await layer.readOutbox(after, limit);
  if (after < page.deletedThrough) throw new EventsDeletedError(after, page.deletedThrough + 1);
  if (after > page.highest) throw new CursorAheadError(after, page.highest);
  if (check !== undefined) {
    const hole = holeError(page.holes, after, renamed, check);
    if (hole) throw hole;
  }
  return renamedPage(page, renamed);
}

/** What a reader takes, for the hole check: true for each declared event name its filter takes. */
export interface HoleCheck {
  takes(name: string): boolean;
}

/**
 * The `MESH_EVENTS_DELETED` for a read from `after` that takes an event with rows deleted above `after` while older
 * rows are kept (a hole of the hole record `holes`, stored names read through `renamed`), naming the event whose hole
 * is highest; null when the read takes no such event (rule KE3).
 */
export function holeError(holes: Readonly<Record<string, number>> | undefined, after: number, renamed: ReadonlyMap<string, string>, check: HoleCheck): EventsDeletedError | null {
  let worst: { name: string; highest: number } | undefined;
  for (const [stored, highest] of Object.entries(holes ?? {})) {
    if (highest <= after) continue;
    const name = storedToDeclared(renamed, stored);
    if (!check.takes(name)) continue;
    if (worst === undefined || highest > worst.highest || (highest === worst.highest && name < worst.name)) worst = { name, highest };
  }
  return worst === undefined ? null : new EventsDeletedError(after, worst.highest + 1, { eventName: worst.name });
}

/**
 * The page with each row whose stored name is a key of the rename map (`events.renamed`) read as the event it now is;
 * the page itself when no row is renamed. The stored row is never rewritten.
 */
export function renamedPage(page: OutboxPage, renamed: ReadonlyMap<string, string>): OutboxPage {
  if (renamed.size === 0 || !page.rows.some((row) => renamed.has(row.name))) return page;
  return { ...page, rows: page.rows.map((row) => renamedRow(row, renamed)) };
}

/** `row` read through the rename map: the row itself when its stored name is no key of it. */
export function renamedRow(row: OutboxRow, renamed: ReadonlyMap<string, string>): OutboxRow {
  const name = storedToDeclared(renamed, row.name);
  return name === row.name ? row : Object.freeze({ ...row, name });
}

/** The clause a refusal of a name adds when the name is a former FQN the rename map reads as another event. */
export function renamedClause(renamed: ReadonlyMap<string, string>, name: string): string {
  const now = renamed.get(name);
  return now === undefined ? "" : `; it was renamed to ${now} (events.renamed)`;
}

/** What `readEvents` takes: the cursor, how many rows to read, and the filters. */
export interface ReadEventsQuery {
  /** The position of the last row read before; `0` (the default) reads from the start. */
  after?: number;
  /** How many outbox rows to read, filtered ones included; default 100. A page may hold fewer events than this. */
  limit?: number;
  /** Only events with these FQNs (`Mesh.fqnOf(InvoicePaid)`); each must be a declared event. */
  names?: readonly string[];
  /** Only events published by this entity (its FQN). */
  entity?: string;
  /** Only events published for the record with this key; compared field by field. */
  key?: Key;
}

/** What `readEvents` resolves with: the events, the next cursor, and the outbox's high-water position. */
export interface ReadEventsPage<E extends object = object> {
  readonly events: readonly EventRecord<E>[];
  /**
   * The position of the last row read, filtered rows included; on a page shorter than its limit, the page's settled
   * position when that is higher (every position up to it is final), so it can name a position with no row; `after`
   * when neither moves it.
   */
  readonly cursor: number;
  /**
   * The highest position ever assigned, as `readOutbox` reports it in the same snapshot as the rows; 0 before the first
   * append, retained after deletion. On SQLite this includes only committed assignments, not a writer's uncommitted
   * ones. Read outside any transaction, it can be ahead of what the caller's earlier transaction saw. It is not capped
   * by the page's limit or filters, so it can be ahead of the page's cursor.
   */
  readonly highest: number;
}

const DEFAULT_LIMIT = 100;

/**
 * Read a page of kept events through `rows`: each row is turned back into an instance of its class (`classes`, by FQN),
 * and the filters drop what they do not match. The cursor counts filtered rows, so a filter never makes a later read
 * read a row again; a page that matched nothing moves the cursor all the same. A row whose stored name matches no
 * declared event is `MESH_EVENT_UNDECLARED`, never skipped.
 */
export async function readEventsFrom(
  layer: DataLayer, classes: ReadonlyMap<string, EventClass>, query: ReadEventsQuery = {}, renamed: ReadonlyMap<string, string> = NO_RENAMES,
  upcast?: EventsModule["upcast"],
): Promise<ReadEventsPage> {
  if (typeof query !== "object" || query === null)
    throw new FrameworkError(`readEvents takes an object, { after, limit, names, entity, key }, and was given ${describe(query)}`);
  const { after = 0, limit = DEFAULT_LIMIT, names, entity, key } = query;
  if (names !== undefined) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
      throw new FrameworkError("readEvents: names must be an array of event FQNs, such as [Mesh.fqnOf(InvoicePaid)]");
    for (const name of names)
      if (!classes.has(name)) throw new FrameworkError(`readEvents: names lists ${JSON.stringify(name)}, which is not a declared event${renamedClause(renamed, name)}; the project declares ${[...classes.keys()].join(", ") || "none"}`);
  }
  if (entity !== undefined && typeof entity !== "string") throw new FrameworkError("readEvents: entity must be an entity's FQN, such as \"billing.Invoice\"");
  if (key !== undefined && (typeof key !== "object" || key === null || Array.isArray(key))) throw new FrameworkError("readEvents: key must be a record's key, such as { id }");
  const wanted = names && new Set(names);
  // A history read chooses its own cursor: an event it takes with rows deleted above it (a hole) is refused, never skipped.
  const page = await rows(layer, after, limit, renamed, { takes: (name) => wanted === undefined || wanted.has(name) });
  const events: EventRecord[] = [];
  for (const row of page.rows) {
    const eventClass = classes.get(row.name);
    if (!eventClass) throw new EventUndeclaredError(row.name, row.position);
    if (wanted && !wanted.has(row.name)) continue;
    if (entity !== undefined && row.entity !== entity) continue;
    if (key !== undefined && !sameKey(row.key, key)) continue;
    events.push(recordOf(row, eventClass, upcast));
  }
  const last = page.rows.at(-1)?.position ?? after;
  const cursor = page.rows.length < limit ? Math.max(last, page.settled) : last;
  return Object.freeze({ events: Object.freeze(events), cursor, highest: page.highest });
}

/** True when two keys hold the same fields with the same values. */
export function sameKey(stored: Key, wanted: Key): boolean {
  const a = Object.keys(stored);
  const b = Object.keys(wanted);
  return a.length === b.length && b.every((field) => Object.hasOwn(stored, field) && JSON.stringify(stored[field]) === JSON.stringify(wanted[field]));
}

/**
 * A stored row as a reader gets it: its payload turned into today's fields by the events module's `upcast` when it has
 * one, then rebuilt into an instance of its class, its dates revived first. `row.name` is already the declared name
 * (the rename map runs before this), so `upcast` sees the row under its event's current FQN.
 */
export function recordOf(row: OutboxRow, eventClass: EventClass, upcast?: EventsModule["upcast"]): EventRecord {
  const declaration = eventClass[DECLARATION];
  let stored: unknown = row.payload;
  if (upcast !== undefined) {
    try {
      stored = upcast(row);
    } catch (cause) {
      throw new FrameworkError(`The events module's upcast threw on the ${row.name} at position ${row.position}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    if (typeof stored !== "object" || stored === null || Array.isArray(stored))
      throw new FrameworkError(`The events module's upcast returned ${describe(stored)} for the ${row.name} at position ${row.position}: it must return the event's fields, an object`);
    if (typeof (stored as { then?: unknown }).then === "function") {
      // Refused, never awaited: mark it handled so an async upcast that rejects leaves no unhandled rejection behind.
      Promise.resolve(stored).then(undefined, () => {});
      throw new FrameworkError(`The events module's upcast returned a promise for the ${row.name} at position ${row.position}: it must return the event's fields, an object, without awaiting`);
    }
  }
  const fields = { ...(stored as Record<string, unknown>) };
  for (const field of declaration.dates ?? [])
    if (typeof fields[field] === "string") fields[field] = new Date(fields[field] as string);
  let payload: object;
  try {
    payload = new eventClass(fields as never);
  } catch (cause) {
    throw new FrameworkError(`The outbox row at position ${row.position} holds a ${row.name} that its class no longer accepts (its fields changed since it was published): ${cause instanceof Error ? cause.message : String(cause)}. ${upcast === undefined ? "Export upcast from the events module to turn old payloads into today's fields (upcasters() of @meshfw/event-sourcing)" : `The events module's upcast left it in a shape the class refuses: give ${row.name} a step that turns this payload into today's fields`}`, { cause });
  }
  return Object.freeze({
    id: row.id,
    position: row.position,
    name: row.name,
    entity: row.entity,
    action: row.action,
    key: deepFrozen(row.key) as Key,
    causedBy: row.causedBy,
    metadata: deepFrozen(row.metadata ?? {}) as EventMetadata,
    occurredAt: row.occurredAt,
    payload,
  });
}
