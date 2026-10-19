import type { DataLayer, DataOperations, Key, OutboxAppend, OutboxPage, OutboxRow } from "./data-layer.ts";
import { DECLARATION, type Declaration } from "./declarations.ts";
import type { BusCapability, EventBus, Handler } from "./bus.ts";
import type { Capability } from "./capabilities.ts";
import { CursorAheadError, EventUndeclaredError, EventsConfigError, EventsDeletedError, FrameworkError } from "./errors.ts";
import type { Clock } from "./expr.ts";
import type { ActionContext, EventMetadata } from "./index.ts";
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

/** The events module (`src/events.ts`), which `events.load` loads at run time and the build never imports. */
export interface EventsModule {
  /** The handlers, by kind, each under its name: the name is unique across both kinds and keys its progress row. */
  handlers?: {
    process?: Record<string, Handler>;
    listen?: Record<string, Handler>;
  };
  metadata?: MetadataFunction<never>;
  /** The context handlers run with; default `{ system: true }`. It can read the original person from the event's `metadata`. */
  context?: (event: EventRecord) => ActionContext;
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
   * keeps every row, for an application that reads history or whose clients resume from cursors. Read by whatever starts
   * delivery.
   */
  keep?: "until-delivered" | "all";
  /** Capabilities the project needs from the bus and the data adapter: checked by the build, ignored by `bind`. */
  requires?: readonly (BusCapability | Capability)[];
}

/** The two values of `events.keep`. */
export const KEEP_VALUES: readonly NonNullable<EventsConfig["keep"]>[] = Object.freeze(["until-delivered", "all"]);

/** The class of an event, as `mesh build` generates it. */
export type EventClass = (new (fields: never) => object) & { readonly [DECLARATION]: Declaration };

/** The events each outermost transaction has published so far, in order, by its data operations. */
const publishedOf = new WeakMap<DataOperations, EventRecord[]>();
/** The id of the event whose handler a transaction runs for, by its data operations: what its publishes carry as `causedBy`. */
const causes = new WeakMap<DataOperations, string>();

/** Forget what `tx` published, and the event it ran for: called by `outermost` when the transaction opens and once it has settled. */
export function forgetPublished(tx: DataOperations): void {
  publishedOf.delete(tx);
  causes.delete(tx);
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

/** Call `listener` after each outermost commit in this process that published on `layer`'s database. Returns the unsubscribe. */
export function onPublished(layer: DataLayer, listener: () => void): () => void {
  const listeners = publishListeners.get(layer);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by `outermost` after a commit that published: wakes every listener of the database. A listener that throws is reported, never the commit's failure. */
export function notifyPublished(layer: DataLayer): void {
  for (const listener of [...publishListeners.get(layer)]) {
    try { listener(); } catch (error) { console.error("A bus's onPublished listener threw:", error); }
  }
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
      const handlers = (loaded as { handlers?: unknown }).handlers;
      if (handlers !== undefined) {
        if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers))
          throw new FrameworkError(`The events module exports handlers as ${describe(handlers)}: it must be an object { process, listen }, each a record of handlers by name`);
        for (const [kind, group] of Object.entries(handlers)) {
          if (kind !== "process" && kind !== "listen")
            throw new FrameworkError(`The events module's handlers has the kind ${JSON.stringify(kind)}: the kinds are process and listen`);
          if (group !== undefined && (typeof group !== "object" || group === null || Array.isArray(group)))
            throw new FrameworkError(`The events module's handlers.${kind} is ${describe(group)}: it must be a record of handlers by name`);
        }
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
 * read the rows, so no row is ever skipped silently.
 */
export async function rows(layer: DataLayer, after: number, limit: number): Promise<OutboxPage> {
  if (typeof layer.readOutbox !== "function")
    throw new FrameworkError("The data layer has no readOutbox: a project that declares an event needs a data adapter with the outbox operations");
  if (!Number.isSafeInteger(after) || after < 0)
    throw new FrameworkError(`A read of the outbox takes a cursor that is a whole number, 0 or more, and was given ${typeof after === "number" ? after : describe(after)}`);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new FrameworkError(`A read of the outbox takes a limit that is a whole number, 1 or more, and was given ${typeof limit === "number" ? limit : describe(limit)}`);
  const page = await layer.readOutbox(after, limit);
  if (after < page.deletedThrough) throw new EventsDeletedError(after, page.deletedThrough + 1);
  if (after > page.highest) throw new CursorAheadError(after, page.highest);
  return page;
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
  /** The position of the last row read, filtered rows included; `after` when the page read none. */
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
export async function readEventsFrom(layer: DataLayer, classes: ReadonlyMap<string, EventClass>, query: ReadEventsQuery = {}): Promise<ReadEventsPage> {
  if (typeof query !== "object" || query === null)
    throw new FrameworkError(`readEvents takes an object, { after, limit, names, entity, key }, and was given ${describe(query)}`);
  const { after = 0, limit = DEFAULT_LIMIT, names, entity, key } = query;
  if (names !== undefined) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
      throw new FrameworkError("readEvents: names must be an array of event FQNs, such as [Mesh.fqnOf(InvoicePaid)]");
    for (const name of names)
      if (!classes.has(name)) throw new FrameworkError(`readEvents: names lists ${JSON.stringify(name)}, which is not a declared event; the project declares ${[...classes.keys()].join(", ") || "none"}`);
  }
  if (entity !== undefined && typeof entity !== "string") throw new FrameworkError("readEvents: entity must be an entity's FQN, such as \"billing.Invoice\"");
  if (key !== undefined && (typeof key !== "object" || key === null || Array.isArray(key))) throw new FrameworkError("readEvents: key must be a record's key, such as { id }");
  const page = await rows(layer, after, limit);
  const wanted = names && new Set(names);
  const events: EventRecord[] = [];
  for (const row of page.rows) {
    const eventClass = classes.get(row.name);
    if (!eventClass) throw new EventUndeclaredError(row.name, row.position);
    if (wanted && !wanted.has(row.name)) continue;
    if (entity !== undefined && row.entity !== entity) continue;
    if (key !== undefined && !sameKey(row.key, key)) continue;
    events.push(recordOf(row, eventClass));
  }
  return Object.freeze({ events: Object.freeze(events), cursor: page.rows.at(-1)?.position ?? after, highest: page.highest });
}

/** True when two keys hold the same fields with the same values. */
export function sameKey(stored: Key, wanted: Key): boolean {
  const a = Object.keys(stored);
  const b = Object.keys(wanted);
  return a.length === b.length && b.every((field) => Object.hasOwn(stored, field) && JSON.stringify(stored[field]) === JSON.stringify(wanted[field]));
}

/** A stored row as a reader gets it: its payload rebuilt into an instance of its class, its dates revived first. */
export function recordOf(row: OutboxRow, eventClass: EventClass): EventRecord {
  const declaration = eventClass[DECLARATION];
  const fields = { ...(row.payload as Record<string, unknown>) };
  for (const field of declaration.dates ?? [])
    if (typeof fields[field] === "string") fields[field] = new Date(fields[field] as string);
  let payload: object;
  try {
    payload = new eventClass(fields as never);
  } catch (cause) {
    throw new FrameworkError(`The outbox row at position ${row.position} holds a ${row.name} that its class no longer accepts (its fields changed since it was published): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
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
