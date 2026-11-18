import type { BusCore, EventBus, EventBusInstance, Handler, HandlerKind, KindHandler, LiveSubscription, Registration, RegisteredHandler } from "./bus.ts";
import { checkedBus } from "./bus.ts";
import type {
  DataLayer, DataOperations, DelivererClaim, DeliveryOperations, DeliveryState, FailureOperations, FailureRow, HandlerProgressRow, Key, OutboxPage, OutboxRow,
  RetentionOperations, SubscriptionFilter, SubscriptionProgressRow,
} from "./data-layer.ts";
import { DECLARATION, type Declaration } from "./declarations.ts";
import {
  CursorAheadError, DatabaseBusyError, DelivererLostError, DelivererTakenError, EventUndeclaredError, EventsDeletedError, FrameworkError,
  HandlerLostError, HandlerOptionError, SubscriptionOverflowError, type ClaimHolder, type StoppedHandler,
} from "./errors.ts";
import { bindingParts, handlerScope, insideTransaction, type Binding } from "./entity.ts";
import {
  PerDatabase, causedIn, describe, holeError, keepDays, kindOf, loadEvents, onPublished, recordOf, renamedClause, renamedPage, renamedRow, rows, sameKey, storedKindProblem, type EventClass, type EventRecord, type EventsConfig, type EventsModule, type Keep, type KeepRules, type SectionHandlers,
} from "./events.ts";
import type { ActionContext } from "./index.ts";
import { NO_RENAMES, storedNamesOf, storedToDeclared } from "./stored-names.ts";
import { RenewalUnsettled, Renewals } from "./renewal.ts";
import { MultiClaim, ackOwned, adoptOwned, declarerOf, forgetOwned, isMultiProcess, keepOwned, multiOperations, openOwned, type Adopted, type KeepChange } from "./multi-process.ts";

/**
 * Core's deliverer (spec, Events and commands, "The deliverer", "Handlers", "Retention", "`subscribe`"): the claim in
 * `mesh_outbox_state`, the registration of the handlers, `runHandler` and the retry path, the deletion pass, orphan
 * reports, the subscription registry and `ack`/`close`, and the two ways a binding delivers (`deliver()` rounds and
 * `startDelivery()`). A bus reaches all of it through `BusCore` alone and never writes core's tables.
 */

/** The fixed numbers of the first build, in milliseconds (and rows for `batch` and `maxQueue`). Tests shorten them through `setDeliveryTiming`. */
const DEFAULT_TIMING = Object.freeze({
  /** A held claim is renewed this often. */
  renewMs: 5_000,
  /** A claim not renewed for this long has lapsed. */
  lapseMs: 15_000,
  /** A closed subscription row whose `seenAt` is older than this, or an open one that has not acknowledged for this long, is an orphan. */
  orphanAgeMs: 3_600_000,
  /** An orphan is reported the first time a pass finds it in a process, then at most this often. */
  orphanReportMs: 3_600_000,
  /** The rows one deletion batch reads and deletes, at most. */
  batch: 500,
  /** The default `maxQueue` of a subscription. */
  maxQueue: 10_000,
});
/** How long a renewal that met a transient error other than a lock wait waits before its next try (after one at once). */
export const RENEW_RETRY_MS = 500;
export type DeliveryTiming = { -readonly [K in keyof typeof DEFAULT_TIMING]: number };
/** The numbers in force; the multi-process strategy (`multi-process.ts`) reads them too. */
export const timing: DeliveryTiming = { ...DEFAULT_TIMING };

/** Change the deliverer's internal numbers, for tests only (`@meshfw/runtime/testing`); `null` restores the defaults. */
export function setDeliveryTiming(changes: Partial<DeliveryTiming> | null): void {
  Object.assign(timing, changes === null ? DEFAULT_TIMING : changes);
}

/** This process run's id: drawn once, never the pid (containers run every process as pid 1). */
export const RUN_ID: string = crypto.randomUUID();
export const STARTED_AT = new Date();
/** The run id of the nil claim: the database is delivered from several processes, and no single process claims it. */
export const NIL_RUN_ID = "00000000-0000-0000-0000-000000000000";
export const PID: number | null = typeof (globalThis as { process?: { pid?: unknown } }).process?.pid === "number" ? (globalThis as unknown as { process: { pid: number } }).process.pid : null;

/** A row a deliverer reads from `mesh_handler_progress` and the handler as the events module declares it. */
export interface DeclaredHandler {
  readonly registered: RegisteredHandler;
  readonly handler: Handler;
  readonly renamedFrom: string | undefined;
  /** The kind an extension contributes, for a handler that carries one (`[HANDLER_KIND]`); undefined for `process` and `listen`. */
  readonly kind?: HandlerKind;
}

/** What core keeps per database in this process. */
export interface DatabaseState {
  /** The database's name, for messages: `layer.database`, else `the database`. */
  readonly name: string;
  /** The deliverer of this process holding (or taking) the claim on this database, if any. */
  deliverer: Deliverer | undefined;
  /** The subscriptions open in this process, by name. */
  readonly subscriptions: Map<string, OpenSubscription>;
  /** When each orphan was last reported in this process (`Date.now()`), by `handler:<name>` or `subscription:<name>`. */
  readonly reported: Map<string, number>;
  /** The handlers a `retryFailed` call runs for now in this process: a second call for one of them is refused. */
  readonly retrying: Set<string>;
}
const databases = new PerDatabase<DatabaseState>((layer) => ({
  name: typeof layer.database === "string" && layer.database !== "" ? layer.database : "the database",
  deliverer: undefined,
  subscriptions: new Map(),
  reported: new Map(),
  retrying: new Set(),
}));

/** What each binding delivers: the started deliverer, the one its `deliver()` rounds reuse, and whether it was connected with `deliver: false`. */
interface BindingDelivery {
  started?: Deliverer | undefined;
  rounds?: Deliverer;
  round?: Promise<void> | undefined;
  noDeliver: boolean;
}
const deliveries = new WeakMap<Binding, BindingDelivery>();
function deliveryOf(binding: Binding): BindingDelivery {
  let delivery = deliveries.get(binding);
  if (!delivery) deliveries.set(binding, delivery = { noDeliver: false });
  return delivery;
}

/** Mark `binding` as one that never delivers (`connect({ deliver: false })`): `subscribe` on it is a `FrameworkError`. */
export function markNoDeliver(binding: Binding): void {
  deliveryOf(binding).noDeliver = true;
}

/** What `startDelivery()` returns: `stop()` stops delivery and releases the claim. */
export interface Delivery {
  stop(): Promise<void>;
}

const DELIVERY_OPERATIONS = [
  "readDeliveryState", "writeClaim", "renewClaim", "releaseClaim", "readHandlerProgress", "writeHandlerProgress", "deleteHandlerProgress",
  "readSubscriptionProgress", "writeSubscriptionProgress", "deleteSubscriptionProgress", "firstOutboxRow",
] as const satisfies readonly (keyof DeliveryOperations)[];

/** The delivery operations of a transaction; a `FrameworkError` when the data adapter lacks them. */
export function operations(tx: DataOperations): DeliveryOperations {
  for (const name of DELIVERY_OPERATIONS)
    if (typeof tx[name] !== "function")
      throw new FrameworkError(`The data layer's transactions have no ${name}: delivering events needs a data adapter with the delivery operations (DeliveryOperations in @meshfw/runtime)`);
  return tx as DataOperations & DeliveryOperations;
}

const FAILURE_OPERATIONS = ["writeFailure", "readFailures", "deleteFailure", "renameFailures"] as const satisfies readonly (keyof FailureOperations)[];

/**
 * The dead-letter operations of a transaction (`FailureOperations`); a `FrameworkError` naming the first one the data
 * adapter lacks and `why` they are needed. Not part of `operations()`: an adapter without them delivers every project
 * that has no handler with `onFailure: "skip"`.
 */
export function failureOperations(tx: DataOperations | DeliveryOperations, why: string): FailureOperations {
  for (const name of FAILURE_OPERATIONS)
    if (typeof (tx as Partial<FailureOperations>)[name] !== "function")
      throw new FrameworkError(`The data layer's transactions have no ${name}: ${why}, which needs a data adapter with the dead-letter operations (FailureOperations in @meshfw/runtime)`);
  return tx as unknown as FailureOperations;
}

/**
 * In a registration transaction that moves the `renamedFrom` row `from` to `to`: the handler's set-aside events move
 * with it, so none is left under a name no handler registers. An adapter without the dead-letter operations holds none.
 */
export async function moveFailures(tx: DataOperations | DeliveryOperations, from: string, to: string): Promise<void> {
  const renameFailures = (tx as Partial<FailureOperations>).renameFailures;
  if (typeof renameFailures === "function") await renameFailures.call(tx, from, to);
}

/**
 * The retention operations of a transaction (`RetentionOperations`); a `FrameworkError` naming the first one the data
 * adapter lacks and `why` they are needed. Not part of `operations()`: an adapter without them delivers every project
 * whose `events.keep` is `"until-delivered"` or `"all"`.
 */
export function retentionOperations(
  tx: DataOperations | DeliveryOperations, why: string, needed: readonly (keyof RetentionOperations)[] = ["firstOutboxRowSince"],
): RetentionOperations {
  const missing = needed.find((name) => typeof (tx as Partial<RetentionOperations>)[name] !== "function");
  if (missing !== undefined)
    throw new FrameworkError(`The data layer's transactions have no ${missing}: ${why}, which needs a data adapter with the retention operations (RetentionOperations in @meshfw/runtime)`);
  return tx as unknown as RetentionOperations;
}

/** Every retention operation: what a per-event `events.keep` needs. */
const PER_EVENT_OPERATIONS: readonly (keyof RetentionOperations)[] = ["firstOutboxRowSince", "deleteOutboxRows", "writeHoles"];

/** The hole record with `found` (each name's highest newly deleted position) merged in, the larger per name, less every entry at or below `through`. */
function nextHoles(holes: Readonly<Record<string, number>>, found: Readonly<Record<string, number>>, through: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [name, highest] of [...Object.entries(holes), ...Object.entries(found)])
    if (highest > through) next[name] = Math.max(next[name] ?? 0, highest);
  return next;
}

/** True when two hole records hold the same entries. */
function sameHoles(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/** One day, in milliseconds: the unit of a keep period (`{ days }`). */
const DAY_MS = 86_400_000;

/** A handler's error as a failure row stores it: its string `code` (null for none) and its message. */
function failureError(error: unknown): FailureRow["error"] {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return Object.freeze({ code: typeof code === "string" ? code : null, message: error instanceof Error ? error.message : String(error) });
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the claim has not been renewed for the lapse time, by the database's clock. */
export function lapsed(claim: DelivererClaim, now: Date): boolean {
  return now.getTime() - claim.renewedAt.getTime() >= timing.lapseMs;
}

export function holderOf(database: string, claim: DelivererClaim, now: Date): ClaimHolder {
  return {
    database, pid: claim.pid, host: claim.host, startedAt: claim.startedAt, renewedAgoMs: Math.max(0, now.getTime() - claim.renewedAt.getTime()),
    lapsesAt: new Date(claim.renewedAt.getTime() + timing.lapseMs), thisProcess: claim.runId === RUN_ID, multiProcess: claim.runId === NIL_RUN_ID,
  };
}

/** `MESH_DELIVERER_TAKEN` for a claim another binding or round of this process holds. */
function takenHere(db: DatabaseState, holder: Deliverer | undefined): DelivererTakenError {
  const renewedAt = holder?.renewedAt ?? Date.now();
  return new DelivererTakenError({
    database: db.name, pid: PID, host: null, startedAt: STARTED_AT, renewedAgoMs: Math.max(0, Date.now() - renewedAt),
    lapsesAt: new Date(renewedAt + timing.lapseMs), thisProcess: true, multiProcess: false,
  });
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * Check the events module's handlers against the bus's manifest and against each other, before anything is claimed
 * (spec, "Options and their checks"): every handler needs `ordered-delivery`; `onFailure: "skip"` needs
 * `dead-letters`; names are unique across every kind; a `renamedFrom` must not name a handler the module still
 * registers, nor be named by two handlers. Shapes are checked too: `run` a function, `events` a non-empty list of the
 * domain's event classes. A handler of a kind an extension contributes is checked by its kind (`check`) after its shape
 * and before core's option checks, so the kind's own message wins (ADR-0094).
 */
export function declaredHandlers(module: EventsModule, bus: EventBus, events: ReadonlyMap<string, EventClass>, section?: SectionHandlers): DeclaredHandler[] {
  const capabilities = new Set<string>(bus.manifest.capabilities);
  const out: DeclaredHandler[] = [];
  const seen = new Map<string, string>();
  // Where each declared name comes from: the events module, or the `.mesh.mx` line of a section handler (H19).
  const sources = new Map<string, string>();
  const keys = ["process", "listen", ...Object.keys(module.handlers ?? {}).filter((key) => key !== "process" && key !== "listen")];
  // The events module's handlers first, then the sections' (`process` and `listen` only), through the same checks.
  const groups: [kind: string, handlers: Readonly<Record<string, Handler>> | undefined, fromSection: boolean][] = [
    ...keys.map((kind) => [kind, module.handlers?.[kind], false] as [string, Readonly<Record<string, Handler>> | undefined, boolean]),
    ["process", section?.process, true], ["listen", section?.listen, true],
  ];
  const sourceOf = (name: string, fromSection: boolean) => (fromSection ? section?.at[name] ?? "a handlers section" : "the events module");
  for (const [kind, group, fromSection] of groups) {
    for (const [name, handler] of Object.entries(group ?? {})) {
      const where = `The ${kind} handler ${JSON.stringify(name)}`;
      if (seen.has(name)) {
        const both = sources.get(name) !== "the events module" || fromSection ? ` (one in ${sources.get(name)}, one in ${sourceOf(name, fromSection)})` : "";
        throw new HandlerOptionError(name, `${where} has the name of a ${seen.get(name)} handler: a handler's name is unique across every kind, since it keys the handler's progress row${both}`);
      }
      seen.set(name, kind);
      sources.set(name, sourceOf(name, fromSection));
      if (typeof handler !== "object" || handler === null) throw new FrameworkError(`${where} is ${describe(handler)}: it must be a handler, Mesh.handler({ events, run })`);
      if (typeof handler.run !== "function") throw new FrameworkError(`${where} has no run function: a handler is Mesh.handler({ events: [...], run: (event, { context }) => ... })`);
      if (!Array.isArray(handler.events) || handler.events.length === 0)
        throw new FrameworkError(`${where} lists no event: its events must be a non-empty array of event classes, such as [InvoicePaid]`);
      const fqns: string[] = [];
      for (const listed of handler.events) {
        const declaration = (listed as { [DECLARATION]?: Declaration } | null)?.[DECLARATION];
        if (typeof listed !== "function" || declaration?.kind !== "event")
          throw new FrameworkError(`${where} lists ${describe(listed)}: its events must be event classes from #mesh/domain/<module>`);
        if (events.get(declaration.fqn) !== listed)
          throw new FrameworkError(`${where} lists the event ${declaration.fqn}, which is not one of this binding's domain: import it from #mesh/domain/<module> of the same project`);
        fqns.push(declaration.fqn);
      }
      const contributed = kindOf(name, handler);
      if (contributed !== undefined && contributed.name !== kind)
        throw new FrameworkError(`The events module lists the ${contributed.name} handler ${JSON.stringify(name)} under handlers.${kind}: list it under handlers.${contributed.name}`);
      if (contributed === undefined && kind !== "process" && kind !== "listen")
        throw new FrameworkError(`The events module's handlers has the kind ${JSON.stringify(kind)}, and its handler ${JSON.stringify(name)} is not one an extension made for that kind: the kinds are process, listen and those an extension's handlers carry, such as project from @meshfw/event-sourcing`);
      const sorted = Object.freeze(sortedUnique(fqns));
      contributed?.check(Object.freeze({ name, events: sorted, handler }), bus.manifest);
      if (!capabilities.has("ordered-delivery"))
        throw new HandlerOptionError(name, `${where} needs the bus's ordered-delivery, since a handler's progress is kept by position only, and the bus ${bus.manifest.adapter} does not declare it`);
      const onFailure: string = handler.onFailure ?? "stop";
      if (onFailure !== "stop" && onFailure !== "skip")
        throw new HandlerOptionError(name, `${where} has onFailure ${JSON.stringify(onFailure)}: it is "stop" (the default) or "skip"`);
      if (onFailure === "skip" && !capabilities.has("dead-letters"))
        throw new HandlerOptionError(name, `${where} has onFailure "skip", which needs the bus's dead-letters, and the bus ${bus.manifest.adapter} does not declare it: no event is ever skipped without a record`);
      const renamedFrom = handler.renamedFrom;
      if (renamedFrom !== undefined && (typeof renamedFrom !== "string" || renamedFrom.trim() === ""))
        throw new HandlerOptionError(name, `${where} has renamedFrom ${describe(renamedFrom)}: it must be the handler's former name`);
      out.push({ registered: Object.freeze({ name, kind, events: sorted, onFailure }), handler, renamedFrom, ...(contributed ? { kind: contributed } : {}) });
    }
  }
  // The renames run over both sources: the messages name where each handler is written once a section handler is involved.
  const named = (...names: string[]) => (names.some((each) => sources.get(each) !== "the events module") ? ` (${names.map((each) => `${each} in ${sources.get(each)}`).join(", ")})` : "");
  const formers = new Map<string, string>();
  for (const { registered: { name }, renamedFrom } of out) {
    if (renamedFrom === undefined) continue;
    if (seen.has(renamedFrom)) {
      const sourced = named(name, renamedFrom);
      throw new HandlerOptionError(name, `The handler ${JSON.stringify(name)} has renamedFrom ${JSON.stringify(renamedFrom)}, a handler ${sourced ? "still registered" : "the events module still registers"}: a running handler's progress is never taken over. Remove the option, or the old handler${sourced}`);
    }
    const other = formers.get(renamedFrom);
    if (other !== undefined)
      throw new HandlerOptionError(name, `The handlers ${JSON.stringify(other)} and ${JSON.stringify(name)} both have renamedFrom ${JSON.stringify(renamedFrom)}: one progress row cannot move to two names${named(other, name)}`);
    formers.set(renamedFrom, name);
  }
  return out.sort((a, b) => (a.registered.name < b.registered.name ? -1 : a.registered.name > b.registered.name ? 1 : 0));
}

/** What registration writes for one declared handler (`handlerStart`), before the claim strategy sets its generation. */
export interface HandlerStart {
  /** The handler's row: its own name, kind and list, at the position it is handled from. */
  readonly row: Omit<HandlerProgressRow, "generation">;
  /** The former name whose row this one takes over (`renamedFrom`): the strategy deletes that row. */
  readonly former: string | undefined;
  /** What to log once the registration commits. */
  readonly logs: readonly string[];
}

/**
 * What a claim strategy reads in its registration transaction, as a contributed kind sees it (`Registration`), from the
 * state it read: `firstRow` is the data adapter's `firstOutboxRow` over the events `declared` counts as declared, each
 * with the former FQNs the rename map (`renamed`) reads as it.
 */
export function registrationOf(
  ops: DeliveryOperations, state: Pick<DeliveryState, "deletedThrough" | "highest" | "holes">, keep: "until-delivered" | "all", declared: readonly string[],
  renamed: ReadonlyMap<string, string> = NO_RENAMES,
): Registration {
  // `firstOutboxRow` is SQL over stored names: a former FQN the rename map reads as a listed or declared event counts as it.
  const stored = storedNamesOf(renamed, declared);
  return Object.freeze({
    deletedThrough: state.deletedThrough,
    // A per-event keep can delete rows above a deleted-through position of 0: the hole record says so (rule KE2).
    deletedAny: state.deletedThrough > 0 || Object.keys(state.holes ?? {}).length > 0,
    highest: state.highest,
    keep,
    firstRow: (after: number, before: number, names: readonly string[]) => ops.firstOutboxRow(after, before, storedNamesOf(renamed, names), stored),
  });
}

/**
 * The spec's Registration table for one handler, shared by every claim strategy so a change to it lands once: a known
 * handler keeps its position and takes the list it registers now (an added event is logged with the position it is
 * handled from); a handler with no row takes over the row of its `renamedFrom`, when that has one; any other starts at
 * the highest position ever assigned (`registration.highest`). A handler of a contributed kind (ADR-0094) asks its kind
 * instead: `start` gives a new row's position, `adopt` may refuse a known row (which fails the whole registration), and
 * `stored` names the row's stored kind. Runs inside the registration transaction, so a refusal writes nothing. An event
 * the stored list names by a former FQN (`renamed`) is the one it now is, so it is never reported as newly listed.
 */
export async function handlerStart(
  declared: Pick<DeclaredHandler, "registered" | "renamedFrom" | "handler" | "kind">, progress: ReadonlyMap<string, HandlerProgressRow>, registration: Registration,
  renamed: ReadonlyMap<string, string> = NO_RENAMES,
): Promise<HandlerStart> {
  const { registered, renamedFrom, kind } = declared;
  const logs: string[] = [];
  let found = progress.get(registered.name);
  let former: string | undefined;
  if (!found && renamedFrom !== undefined) {
    found = progress.get(renamedFrom);
    if (found) {
      former = renamedFrom;
      logs.push(`Mesh: the handler ${JSON.stringify(registered.name)} takes over the progress of ${JSON.stringify(renamedFrom)} (renamedFrom), at position ${found.position}`);
    }
  }
  // A stored list that names an event by a former FQN lists the event it now is (events.renamed): it is not added.
  const before = found ? found.events.map((name) => storedToDeclared(renamed, name)) : [];
  const added = found ? registered.events.filter((name) => !before.includes(name)) : [];
  const handler: KindHandler | undefined = kind && Object.freeze({ name: registered.name, events: registered.events, handler: declared.handler });
  let position = found ? found.position : registration.highest;
  if (kind && handler) {
    if (found) await kind.adopt(handler, found, Object.freeze([...added]), registration);
    else {
      const start: unknown = await kind.start(handler, registration);
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < registration.deletedThrough || start > registration.highest)
        throw new FrameworkError(`The ${kind.name} kind of ${kind.owner} started the handler ${JSON.stringify(registered.name)} at ${typeof start === "number" ? String(start) : describe(start)}: a start is a position from the deleted-through position, ${registration.deletedThrough}, to the highest, ${registration.highest}`);
      position = start;
    }
  }
  let stored: string = registered.kind;
  if (kind && handler) {
    const named: unknown = kind.stored(handler, found, Object.freeze([...added]));
    if (storedKindProblem(kind, named))
      throw new FrameworkError(`The ${kind.name} kind of ${kind.owner} stored the kind ${typeof named === "string" ? JSON.stringify(named) : describe(named)} for the handler ${JSON.stringify(registered.name)}: a stored kind is ${JSON.stringify(kind.name)}, or ${JSON.stringify(`${kind.name}:`)} followed by one lowercase word`);
    stored = named as string;
  }
  const row = { name: registered.name, kind: stored, position, events: registered.events };
  if (found && added.length > 0)
    logs.push(`Mesh: the handler ${JSON.stringify(registered.name)} now lists ${added.join(", ")}, handled from position ${found.position} on`);
  return { row, former, logs };
}

/**
 * The part of a deliverer that touches the database claim (`mesh_outbox_state`) and the fencing of every write by it,
 * behind one interface so delivery from several processes can replace it. `SingleClaim` is the one claim per database
 * of the spec's "The deliverer".
 */
export interface ClaimStrategy {
  /** The generation a subscription row opened in this process is written under. */
  readonly generation: number;
  /** Claim and register in one transaction; starts the renewals. Resolves with the deleted-through position it read. */
  register(declared: readonly DeclaredHandler[]): Promise<number>;
  /** One renewal; schedules the next while the claim is held. */
  tick(): Promise<void>;
  /** Stop renewing and write nothing (the instance was lost, or is releasing). */
  halt(): void;
  /** What `core.handlers` returns. */
  handlers(): readonly RegisteredHandler[];
  /** What `core.lists` answers. */
  lists(handler: RegisteredHandler, row: OutboxRow): boolean;
  /**
   * Before any transaction of a `runHandler` (`row`) or `position` call (no row), for a handler core registered: throws
   * what the call rejects with at once (single mode: an undeclared row, a row the handler does not list).
   */
  enter(handler: RegisteredHandler, row: OutboxRow | undefined): void;
  /** In the handler transaction: the fence, then the progress row; null when `row` is handled already, or not this handler's. */
  fenceHandler(ops: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<HandlerProgressRow | null>;
  /** In the handler transaction, after a `process` body: move the row `fenceHandler` returned to `position`. */
  writeProgress(ops: DeliveryOperations, progress: HandlerProgressRow, position: number): Promise<void>;
  /** The short transaction that closes a `listen` handler's run: the fence again, then the position moves to `row`. */
  settleListen(ops: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<void>;
  /**
   * In a `retryFailed` transaction, before a set-aside event is replayed or removed: the fence alone (the claim's
   * generation, or the handler's lease), with no position check, since a set-aside event is below the progress row.
   * `position` is the set-aside event's, which a lost lease names.
   */
  fenceReplay(ops: DeliveryOperations, handler: RegisteredHandler, position: number): Promise<void>;
  /** After `runHandler` rejected with `error`, outside its transaction; resolves with the error to reject with instead, if any. */
  afterReject(handler: RegisteredHandler, error: unknown): Promise<unknown>;
  /** In each deletion batch's transaction: the fence; the state the batch computes from. */
  fenceBatch(ops: DeliveryOperations): Promise<DeliveryState>;
  /** The events the batch that `fenceBatch` just fenced counts as declared: a reader never moves over a row of any other. */
  passDeclared(): ReadonlySet<string>;
  /** In a deletion batch: every progress row, as `holds`, `moveHandler` and `isOrphan` read them. */
  readHandlers(ops: DeliveryOperations): Promise<readonly HandlerProgressRow[]>;
  /** In a deletion batch: every subscription row, as `moveSubscription` and `isOrphan` read them. */
  readSubscriptions(ops: DeliveryOperations): Promise<readonly SubscriptionProgressRow[]>;
  /** True for a progress row this instance delivers, which the deletion pass may move. */
  holds(row: HandlerProgressRow): boolean;
  /** The deletion pass's move of a handler this instance holds; resolves with the row as it stands. */
  moveHandler(ops: DeliveryOperations, row: HandlerProgressRow, to: number): Promise<HandlerProgressRow>;
  /** The deletion pass's move of a subscription; resolves with the row as it stands. */
  moveSubscription(ops: DeliveryOperations, row: SubscriptionProgressRow, to: number): Promise<SubscriptionProgressRow>;
  /** Whether a batch deletes rows (the `keep` in force). */
  deletes(state: DeliveryState): boolean;
  /** True for a row the orphan report names: a handler no live registration holds, a subscription not open here for the orphan age. */
  isOrphan(row: HandlerProgressRow | SubscriptionProgressRow, state: DeliveryState): boolean;
  /**
   * `resumeHandler(name)`: undefined for a handler this instance does not register; else the handler, and whether to hand
   * it to the bus instance's `resumeHandler` (false when the strategy resumed it itself).
   */
  resume(name: string): Promise<{ readonly handler: RegisteredHandler; readonly forBus: boolean } | undefined>;
  /** Release the claim where it is still this instance's; a lock failure is ignored, any other unless `quiet`. */
  release(quiet: boolean): Promise<void>;
}

/** How many kept rows lie above `position`: what an orphan holds. */
const held = (state: DeliveryState, position: number) => Math.max(0, state.highest - Math.max(position, state.deletedThrough));

/**
 * One bus instance and the claims it delivers under: made by `startDelivery()` (one claim, until `stop()`) or kept by a
 * binding's `deliver()` rounds (a claim per round), until the claim is lost. What touches the claim is its strategy's.
 */
export class Deliverer {
  readonly db: DatabaseState;
  readonly bus: EventBus;
  /**
   * The `keep` in force as the bus, the registration and the deletion gates see it: a period (`{ days }`) is
   * `"until-delivered"`, since a passed row may be gone; `days` holds the period.
   */
  readonly keep: "until-delivered" | "all";
  /** The whole days of `events.keep` when it is a period, else null: the deletion pass keeps passed rows younger than that. */
  readonly days: number | null;
  /**
   * A per-event `events.keep` by declared FQN (resolved at bind), else null: the deletion pass then deletes each row by
   * its own event's rule, leaving holes it records per stored name (rule KE2).
   */
  readonly rules: KeepRules | null;
  readonly instance: EventBusInstance;
  readonly core: BusCore;
  readonly strategy: ClaimStrategy;
  /** True while this instance holds the claim. */
  holding = false;
  /** When this process last claimed or renewed (`Date.now()`), for this process's own `MESH_DELIVERER_TAKEN`. */
  renewedAt = 0;
  lost: DelivererLostError | undefined;
  /** The handlers registered for the current claim, by name. */
  #handlers = new Map<string, DeclaredHandler>();
  /** The FQNs of every event this build declares, sorted. */
  readonly declared: readonly string[];
  /** The binding's checked rename map (`events.renamed`): a stored former FQN to the declared event it now is. */
  readonly renamed: ReadonlyMap<string, string>;
  /** The read head: the highest position a read through `core.rows` returned, from the deleted-through position at each claim. */
  #readHead = 0;
  readonly #lostListeners = new Set<(error: Error) => void>();

  constructor(readonly binding: Binding, readonly layer: DataLayer, readonly events: ReadonlyMap<string, EventClass>, readonly config: EventsConfig, readonly module: EventsModule) {
    this.db = databases.get(layer);
    this.bus = checkedBus(config.bus);
    this.days = keepDays(config.keep);
    this.declared = [...events.keys()].sort();
    this.renamed = bindingParts(binding).renamed;
    this.rules = bindingParts(binding).keepRules;
    // A rule other than the two strings is "until-delivered" to the bus and the gates, since a passed row may be gone; the
    // per-event form is "all" only when every one of its rules is.
    this.keep = typeof config.keep === "string" ? config.keep
      : this.rules !== null && [this.rules.default, ...this.rules.events.values()].every((rule) => rule === "all") ? "all"
      : "until-delivered";
    this.strategy = isMultiProcess(this.bus) ? new MultiClaim(this) : new SingleClaim(this);
    const self = this;
    this.core = Object.freeze({
      rows: (after: number, limit: number) => self.read(after, limit),
      get handlers() { return self.strategy.handlers(); },
      position: (handler: RegisteredHandler) => self.position(handler),
      // A bus may hand a row it did not read through rows(): lists, runHandler and retry read its name through the rename
      // map too (idempotent), so the three agree on a row stored under a former FQN.
      lists: (handler: RegisteredHandler, row: OutboxRow) => self.strategy.lists(handler, renamedRow(row, self.renamed)),
      runHandler: (handler: RegisteredHandler, row: OutboxRow) => self.runHandler(handler, row),
      retry: (handler: RegisteredHandler, row: OutboxRow, delays: readonly number[]) => self.retry(handler, row, delays),
      setAside: (handler: RegisteredHandler, row: OutboxRow, error: unknown) => self.setAside(handler, row, error),
      isRetryable,
      // A subscription still writing its row (opening) is not fed: its first read is rows(start), once the row commits.
      subscriptions: () => [...self.db.subscriptions.values()].filter((subscription) => !subscription.ended && !subscription.opening),
      deletionPass: () => self.deletionPass(),
      onPublished: (listener: () => void) => onPublished(layer, listener),
      onClaimLost: (listener: (error: Error) => void) => { self.#lostListeners.add(listener); return () => { self.#lostListeners.delete(listener); }; },
    } satisfies BusCore);
    this.instance = this.bus.create(this.core, Object.freeze({ keep: this.keep }));
  }

  /** The stored names `names` stands for in the outbox: each, and every former FQN the rename map reads as one of them. */
  storedNames(names: readonly string[]): string[] {
    return storedNamesOf(this.renamed, names);
  }

  /** The declared event a stored name is read as (the rename map; the name itself when it is no former FQN). */
  declaredName(name: string): string {
    return storedToDeclared(this.renamed, name);
  }

  /** The generation subscription rows opened in this process are written under: the claim's. */
  get generation(): number {
    return this.strategy.generation;
  }

  /** The error to throw when the instance cannot go on: the loss, or a call made while no claim is held. */
  live(): void {
    if (this.lost) throw this.lost;
    if (!this.holding) throw new FrameworkError("The bus called into core while its instance holds no claim: a bus calls core only between start() and stop(), or during deliver()");
  }

  /** The names of every handler registered for the current claim, in name order. */
  registeredNames(): readonly string[] {
    return [...this.#handlers.keys()];
  }

  /** Claim and register through the strategy (spec, "The claim", "Registration"); this instance then holds the claim. */
  async claim(declared: readonly DeclaredHandler[]): Promise<void> {
    // This process's place is taken before the first await: another binding (or a round reusing this instance) that
    // claims meanwhile sees it and is MESH_DELIVERER_TAKEN, instead of claiming under the same run id.
    if (this.db.deliverer !== undefined) throw takenHere(this.db, this.db.deliverer);
    if (this.holding) throw takenHere(this.db, this);
    this.db.deliverer = this;
    try {
      // A handler that sets events aside needs the dead-letter operations: an adapter without them fails the start, not
      // the first set-aside.
      const skipping = declared.find((entry) => entry.registered.onFailure === "skip");
      if (skipping) await this.layer.transaction(async (tx) => { failureOperations(tx, `the handler ${JSON.stringify(skipping.registered.name)} has onFailure "skip"`); });
      // A keep period needs its retention operation: an adapter without it fails the start, not the first deletion pass.
      if (this.days !== null) await this.layer.transaction(async (tx) => { retentionOperations(tx, this.#periodWhy()); });
      // A per-event keep needs every retention operation and the hole record's column: checked at the start too.
      if (this.rules !== null)
        await this.layer.transaction(async (tx) => {
          retentionOperations(tx, "events.keep sets a rule per event ({ default, events })", PER_EVENT_OPERATIONS);
          if ((await operations(tx).readDeliveryState()).holes === undefined)
            throw new FrameworkError("A per-event events.keep needs mesh_outbox_state.holes, which this database does not have: run mesh db push");
        });
      this.#readHead = await this.strategy.register(declared);
      this.#handlers = new Map(declared.map((entry) => [entry.registered.name, entry]));
      this.holding = true;
      this.renewedAt = Date.now();
    } catch (error) {
      if (this.db.deliverer === this) this.db.deliverer = undefined;
      throw error;
    }
  }

  /** The claim is lost: the instance stops, its subscriptions end with the error, and the bus hears it once. */
  lose(reason: string): DelivererLostError {
    if (this.lost) return this.lost;
    const error = this.lost = new DelivererLostError(this.db.name, reason);
    this.strategy.halt();
    this.holding = false;
    if (this.db.deliverer === this) this.db.deliverer = undefined;
    for (const subscription of [...this.db.subscriptions.values()]) subscription.end(error);
    for (const listener of [...this.#lostListeners]) {
      try { listener(error); } catch (thrown) { console.error("A bus's onClaimLost listener threw:", thrown); }
    }
    return error;
  }

  /**
   * Release the claim: stop renewing and clear the claim where it is still this instance's. A release that fails on a
   * lock is not reported (this process's next claim takes its own run id over); any other failure is, unless `quiet`.
   */
  async release(quiet: boolean): Promise<void> {
    this.strategy.halt();
    const wasHolding = this.holding;
    this.holding = false;
    if (this.db.deliverer === this) this.db.deliverer = undefined;
    if (!wasHolding || this.lost) return;
    await this.strategy.release(quiet);
  }

  async read(after: number, limit: number): Promise<OutboxPage> {
    this.live();
    const page = await rows(this.layer, after, limit, this.renamed);
    // A read from `after` means a cursor at `after` exists (a progress row or a subscription's): the bus passed it before.
    const last = page.rows.at(-1)?.position ?? after;
    if (last > this.#readHead) this.#readHead = last;
    return page;
  }

  async position(handler: RegisteredHandler): Promise<number> {
    this.live();
    this.#entry(handler);
    this.strategy.enter(handler, undefined);
    const row = await this.layer.transaction(async (tx) => (await operations(tx).readHandlerProgress()).find((each) => each.name === handler.name));
    if (!row) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
    return row.position;
  }

  #entry(handler: RegisteredHandler, what = "runHandler"): DeclaredHandler {
    const entry = this.#handlers.get(handler?.name);
    if (!entry || entry.registered !== handler)
      throw new FrameworkError(`${what} was handed ${typeof handler?.name === "string" ? `the handler ${JSON.stringify(handler.name)}, which is not` : "a value that is not"} one core registered for this claim: a bus feeds the handlers of core.handlers`);
    return entry;
  }

  /** The handler registered for the current claim under `name`, if any. */
  registered(name: string): RegisteredHandler | undefined {
    return this.#handlers.get(name)?.registered;
  }

  /** The context the handler runs with: what the events module's `context(event)` returns, else `{ system: true }`. */
  #context(record: EventRecord): ActionContext {
    if (this.module.context === undefined) return { system: true } as ActionContext;
    const context = this.module.context(record);
    if (typeof context !== "object" || context === null)
      throw new FrameworkError(`The events module's context function returned ${describe(context)} for the event ${record.name} at position ${record.position}: it must return the context handlers run with, an object`);
    return context;
  }

  /**
   * Deliver `row` to `handler` (spec, "The handler transaction and progress"): a `process` handler's body runs in the
   * handler transaction with the strategy's fence and the progress write; a `listen` handler's body runs outside any
   * transaction between a fenced check and a short fenced progress write. A body that throws records nothing.
   */
  async runHandler(handler: RegisteredHandler, row: OutboxRow): Promise<void> {
    row = renamedRow(row, this.renamed);
    try {
      await this.#run(handler, row);
    } catch (error) {
      throw (await this.strategy.afterReject(handler, error)) ?? error;
    }
  }

  async #run(handler: RegisteredHandler, row: OutboxRow): Promise<void> {
    this.live();
    const entry = this.#entry(handler);
    this.strategy.enter(handler, row);
    const eventClass = this.events.get(row.name);
    // Delivery from several processes: a row this build does not declare is judged in the fence; it never reaches a body.
    const record = eventClass ? recordOf(row, eventClass, this.module.upcast) : undefined;
    const label = `the ${handler.kind} handler ${handler.name}`;
    const run = (context: ActionContext) => (entry.handler as Handler).run(record!, { context });
    // A contributed kind (ADR-0094) runs as a `process` handler does: its body in the handler transaction.
    if (handler.kind === "process" || entry.kind !== undefined) {
      await handlerScope(this.binding, label, row.id, true, async () => {
        const progress = await this.layer.transaction(async (tx) => {
          const found = await this.strategy.fenceHandler(operations(tx), handler, row);
          if (found) causedIn(tx, row.id);
          return found;
        });
        if (!progress || !record) return;
        await run(this.#context(record));
        await this.layer.transaction((tx) => this.strategy.writeProgress(operations(tx), progress, row.position));
      }, entry.kind);
      return;
    }
    const progress = await this.layer.transaction((tx) => this.strategy.fenceHandler(operations(tx), handler, row));
    if (!progress || !record) return;
    const context = this.#context(record);
    await handlerScope(this.binding, label, row.id, false, () => Promise.resolve(run(context)));
    await this.layer.transaction((tx) => this.strategy.settleListen(operations(tx), handler, row));
  }

  /**
   * Core's retry path: `runHandler`, then again after each delay while the error is retryable. Resolves with null once
   * handled, else with the stop to report (at once for `retryable: false`). Busy, a lost claim and a lost handler lease
   * reject and are not a try.
   */
  async retry(handler: RegisteredHandler, row: OutboxRow, delays: readonly number[]): Promise<StoppedHandler | null> {
    if (!Array.isArray(delays) || delays.some((delay) => typeof delay !== "number" || !(delay >= 0)))
      throw new FrameworkError("core.retry takes the bus's retry schedule, an array of delays in milliseconds, each 0 or more");
    row = renamedRow(row, this.renamed);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.runHandler(handler, row);
        return null;
      } catch (error) {
        if (error instanceof DatabaseBusyError || error instanceof DelivererLostError || error instanceof HandlerLostError) throw error;
        if (this.lost) throw this.lost;
        if (!isRetryable(error) || attempt >= delays.length)
          return Object.freeze({ handler: handler.name, position: row.position, event: row.name, cause: error });
        await sleep(delays[attempt]!);
        if (this.lost) throw this.lost;
      }
    }
  }

  /**
   * `core.setAside` (spec, "Handler failures"): for a handler with `onFailure: "skip"` whose retries are used up (or whose
   * error says `retryable: false`), copy `row` whole into `mesh_outbox_failures` with the error and move the handler's
   * progress to it, in one transaction fenced as a handler transaction is; then warn once. Resolves at once when the
   * handler has passed the row already. A row no declared event matches is never set aside (`MESH_EVENT_UNDECLARED`),
   * and a busy database, a lost claim or a lost lease is never a handler's failure.
   */
  async setAside(handler: RegisteredHandler, row: OutboxRow, error: unknown): Promise<void> {
    this.live();
    this.#entry(handler, "core.setAside");
    if (handler.onFailure !== "skip")
      throw new FrameworkError(`core.setAside was handed the handler ${JSON.stringify(handler.name)}, whose onFailure is ${JSON.stringify(handler.onFailure)}: a bus sets aside only a handler with onFailure "skip"`);
    for (const kind of [DatabaseBusyError, DelivererLostError, HandlerLostError])
      if (error instanceof kind)
        throw new FrameworkError(`core.setAside was handed ${(error as { code: string }).code} as the failure: ${kind === DatabaseBusyError ? "a busy database ends the round" : kind === DelivererLostError ? "a lost claim ends the instance" : "a lost lease ends the handler in this process"} and is never a handler's failure`);
    row = renamedRow(row, this.renamed);
    if (!this.events.has(row.name)) throw new EventUndeclaredError(row.name, row.position);
    if (!handler.events.includes(row.name))
      throw new FrameworkError(`core.setAside was handed the ${row.name} at position ${row.position} for the handler ${JSON.stringify(handler.name)}, which does not list it: a bus sets aside only a row the handler failed on`);
    let set: boolean;
    try {
      this.strategy.enter(handler, row);
      set = await this.layer.transaction(async (tx) => {
        const ops = operations(tx);
        const failures = failureOperations(tx, `the handler ${JSON.stringify(handler.name)} has onFailure "skip"`);
        const progress = await this.strategy.fenceHandler(ops, handler, row);
        if (!progress) return false;
        // The declared (mapped) name is stored: two former FQNs may map to one event, and the map is idempotent.
        await failures.writeFailure({ ...row, handler: handler.name, error: failureError(error) });
        await this.strategy.writeProgress(ops, progress, row.position);
        return true;
      });
    } catch (thrown) {
      throw (await this.strategy.afterReject(handler, thrown)) ?? thrown;
    }
    if (set)
      console.warn(`Mesh: the handler ${JSON.stringify(handler.name)} set aside the event ${row.name} at position ${row.position} after: ${failureError(error).message}. It is kept in mesh_outbox_failures; retryFailed(${JSON.stringify(handler.name)}) replays it`);
  }

  /**
   * One set-aside event replayed by `retryFailed` (DL7): null once handled and its failure row removed (or when the row
   * was removed meanwhile), else the error it failed with, the row kept. A `process` handler's body runs in the
   * transaction that removes the row, so a throw keeps both; a `listen` handler's body runs first, then a short fenced
   * transaction removes the row. Busy, a lost claim and a lost lease reject.
   */
  async replay(handler: RegisteredHandler, failure: FailureRow): Promise<"handled" | "gone" | { readonly cause: unknown }> {
    this.live();
    const entry = this.#entry(handler, "retryFailed");
    this.strategy.enter(handler, undefined);
    const name = this.declaredName(failure.name);
    const eventClass = this.events.get(name);
    if (!eventClass) return { cause: new EventUndeclaredError(name, failure.position) };
    if (!handler.events.includes(name))
      return { cause: new FrameworkError(`retryFailed(${JSON.stringify(handler.name)}): the set-aside event at position ${failure.position} is ${name}, which the handler no longer lists; list it again, or delete the failure row`) };
    const why = `retryFailed(${JSON.stringify(handler.name)}) replays set-aside events`;
    const label = `the ${handler.kind} handler ${handler.name}`;
    try {
      const record = recordOf({ ...failure, name }, eventClass, this.module.upcast);
      const run = (context: ActionContext) => (entry.handler as Handler).run(record, { context });
      if (handler.kind === "process" || entry.kind !== undefined) {
        return await handlerScope(this.binding, label, failure.id, true, async () => {
          const removed = await this.layer.transaction(async (tx) => {
            await this.strategy.fenceReplay(operations(tx), handler, failure.position);
            causedIn(tx, failure.id);
            return failureOperations(tx, why).deleteFailure(failure.failure);
          });
          if (!removed) return "gone" as const;
          await run(this.#context(record));
          return "handled" as const;
        }, entry.kind);
      }
      await this.layer.transaction((tx) => this.strategy.fenceReplay(operations(tx), handler, failure.position));
      const context = this.#context(record);
      await handlerScope(this.binding, label, failure.id, false, () => Promise.resolve(run(context)));
      // The guard and the claim mean no other run of this row overlaps: a row already gone was removed by hand.
      await this.layer.transaction(async (tx) => {
        await this.strategy.fenceReplay(operations(tx), handler, failure.position);
        await failureOperations(tx, why).deleteFailure(failure.failure);
      });
      return "handled";
    } catch (error) {
      if (error instanceof DatabaseBusyError || error instanceof DelivererLostError || error instanceof HandlerLostError) throw error;
      if (this.lost) throw this.lost;
      return { cause: error };
    }
  }

  /**
   * Core's deletion pass (spec, "The deletion rule"), in batches, each one transaction fenced by the strategy; moves
   * the handlers this instance holds over rows they do not list and every subscription over rows its stored filter
   * drops (never over an undeclared row); and, when the strategy deletes, deletes at or below the lowest of the read
   * head and every progress and subscription row. Reports orphans.
   */
  async deletionPass(): Promise<void> {
    this.live();
    let cursor: number | null | undefined;
    let last: { state: DeliveryState; handlers: readonly HandlerProgressRow[]; subscriptions: readonly SubscriptionProgressRow[] } | undefined;
    for (let guard = 0; guard < 100_000; guard++) {
      if (cursor === undefined) {
        // Where moving starts: the lowest position among this instance's handlers and the subscriptions; nothing below moves.
        const snapshot = await this.layer.transaction(async (tx) => {
          const ops = operations(tx);
          const state = await this.strategy.fenceBatch(ops);
          return { state, handlers: await this.strategy.readHandlers(ops), subscriptions: await this.strategy.readSubscriptions(ops) };
        });
        const movers = [...snapshot.handlers.filter((row) => this.strategy.holds(row)), ...snapshot.subscriptions].map((row) => row.position);
        cursor = movers.length === 0 ? null : Math.max(snapshot.state.deletedThrough, Math.min(...movers));
      }
      const read = cursor === null || this.layer.readOutbox === undefined ? null : await this.layer.readOutbox(cursor, timing.batch);
      // Rows stored under a former FQN are read as the event they now are (events.renamed), as every reader sees them.
      const page = read === null ? null : renamedPage(read, this.renamed);
      const from = cursor;
      const outcome = await this.layer.transaction(async (tx) => {
        const ops = operations(tx);
        const state = await this.strategy.fenceBatch(ops);
        const declared = this.strategy.passDeclared();
        const handlers = await this.strategy.readHandlers(ops);
        const subscriptions = await this.strategy.readSubscriptions(ops);
        const end = page === null || from === null ? null : page.rows.length === timing.batch ? page.rows.at(-1)!.position : Math.max(page.settled, page.rows.at(-1)?.position ?? from);
        /** The position a reader at `position` moves to over the page's rows it passes (`passes`), stopping at an undeclared row. */
        const moved = (position: number, passes: (row: OutboxRow) => boolean): number => {
          if (page === null || end === null || from === null || position < from) return position;
          for (const row of page.rows) {
            if (row.position <= position) continue;
            if (!declared.has(row.name) || !passes(row)) return position;
            position = row.position;
          }
          return Math.max(position, end);
        };
        const handlerRows = await Promise.all(handlers.map(async (row) => {
          if (!this.strategy.holds(row)) return row;
          const listed = row.events.map((name) => this.declaredName(name));
          const position = moved(row.position, (outbox) => !listed.includes(outbox.name));
          if (position === row.position) return row;
          return this.strategy.moveHandler(ops, row, position);
        }));
        const subscriptionRows = await Promise.all(subscriptions.map(async (row) => {
          const position = moved(row.position, (outbox) => !matches(row.filter, outbox, this.renamed));
          if (position === row.position) return row;
          return this.strategy.moveSubscription(ops, row, position);
        }));
        let deleted = 0;
        let capped = false;
        if (this.strategy.deletes(state)) {
          const bound = Math.min(this.#readHead, ...handlerRows.map((row) => row.position), ...subscriptionRows.map((row) => row.position));
          let through = Math.min(bound, state.deletedThrough + timing.batch);
          capped = through < bound;
          if (this.days !== null && through > state.deletedThrough) {
            // A period deletes a passed row only once it is old enough, by the database's clock: the prefix stops just
            // below the first younger row, and the pass is done until that row ages.
            const since = new Date(state.now.getTime() - this.days * DAY_MS);
            const young = await retentionOperations(tx, this.#periodWhy()).firstOutboxRowSince(state.deletedThrough, through, since);
            if (young !== null) { through = young - 1; capped = false; }
          }
          let found: Readonly<Record<string, number>> = {};
          if (this.rules !== null && through > state.deletedThrough) {
            const perEvent = await this.#perEvent(tx, state, through, bound);
            through = perEvent.through;
            found = perEvent.found;
            deleted += perEvent.deleted;
            if (perEvent.stopped) capped = perEvent.capped;
          }
          if (through > state.deletedThrough) deleted += await tx.deleteOutboxThrough!(through);
          // The hole record, under every rule: holes the prefix has now passed are dropped, so it holds only holes above it
          // and is {} when none exists (rule KE2). A record exists only on an adapter with writeHoles.
          const holes = state.holes ?? {};
          if (Object.keys(holes).length > 0 || Object.keys(found).length > 0) {
            const next = nextHoles(holes, found, Math.max(through, state.deletedThrough));
            if (!sameHoles(holes, next)) await retentionOperations(tx, "a per-event events.keep left holes", ["writeHoles"]).writeHoles(next);
          }
        }
        return { state, handlers: handlerRows, subscriptions: subscriptionRows, deleted, capped, end, full: page !== null && page.rows.length === timing.batch };
      });
      last = outcome;
      cursor = outcome.full && outcome.end !== null ? outcome.end : null;
      if (!outcome.full && !outcome.capped) break;
      if (cursor === null && !outcome.capped) break;
    }
    if (last) this.#reportOrphans(last.state, last.handlers, last.subscriptions);
  }

  /**
   * A deletion batch's per-event step (design section 5.4), in its transaction: the prefix end `through` lowered to just
   * below the first row above the deleted-through position that its own rule keeps (an undeclared row counts as kept);
   * then, when it was lowered, each deleting rule's rows above it and at or below `bound` deleted, lowest first, within a
   * budget of one batch shared by the rules (`capped` when the budget ran out). Resolves with the new `through`, the rows
   * deleted as holes, and each stored name's highest such position.
   */
  async #perEvent(tx: DataOperations, state: DeliveryState, through: number, bound: number): Promise<{
    readonly through: number; readonly deleted: number; readonly found: Readonly<Record<string, number>>; readonly stopped: boolean; readonly capped: boolean;
  }> {
    const rules = this.rules!;
    const ops = retentionOperations(tx, "events.keep sets a rule per event ({ default, events })", PER_EVENT_OPERATIONS);
    // Each rule's stored names: a declared event's own rule or the default, with every former FQN read as it.
    const groups = new Map<string, { rule: Keep; names: string[] }>();
    for (const fqn of this.declared) {
      const rule = rules.events.get(fqn) ?? rules.default;
      const key = JSON.stringify(rule);
      const group = groups.get(key) ?? { rule, names: [] };
      group.names.push(...this.storedNames([fqn]));
      groups.set(key, group);
    }
    const sinceOf = (rule: Keep) => (typeof rule === "object" ? new Date(state.now.getTime() - rule.days * DAY_MS) : null);
    const all = this.storedNames(this.declared);
    // The first row a rule keeps: a row of an "all" rule, a row too young for its period, or an undeclared row.
    const kept: number[] = [];
    const forever = [...groups.values()].filter((group) => group.rule === "all").flatMap((group) => group.names);
    const first = await operations(tx).firstOutboxRow(state.deletedThrough, through + 1, forever, all);
    if (first !== null) kept.push(first);
    for (const group of groups.values()) {
      const since = sinceOf(group.rule);
      if (since === null) continue;
      const young = await ops.firstOutboxRowSince(state.deletedThrough, through, since, group.names);
      if (young !== null) kept.push(young);
    }
    if (kept.length === 0) return { through, deleted: 0, found: {}, stopped: false, capped: false };
    const end = Math.min(...kept) - 1;
    // Above the kept row: each deleting rule's own rows, up to the bound, within one batch's budget.
    let budget = timing.batch;
    let deleted = 0;
    const found: Record<string, number> = {};
    for (const group of groups.values()) {
      if (group.rule === "all" || budget === 0) continue;
      const result = await ops.deleteOutboxRows(end, bound, group.names, sinceOf(group.rule), budget);
      budget -= result.deleted;
      deleted += result.deleted;
      for (const [name, highest] of Object.entries(result.highest)) found[name] = Math.max(found[name] ?? 0, highest);
    }
    return { through: end, deleted, found, stopped: true, capped: budget === 0 };
  }

  /** What a row at `position` holds, for the reports: under a per-event keep, holes make the count an upper bound. */
  #held(state: DeliveryState, position: number): string {
    return `${this.rules !== null ? "up to " : ""}${held(state, position)}`;
  }

  /** Why a period needs the retention operations, for their `FrameworkError`. */
  #periodWhy(): string {
    return `events.keep is { days: ${this.days} }`;
  }

  /** Report each orphan the first time a pass finds it in this process, then at most once per `orphanReportMs`. */
  #reportOrphans(state: DeliveryState, handlers: readonly HandlerProgressRow[], subscriptions: readonly SubscriptionProgressRow[]): void {
    const now = Date.now();
    const due = (key: string) => {
      const before = this.db.reported.get(key);
      if (before !== undefined && now - before < timing.orphanReportMs) return false;
      this.db.reported.set(key, now);
      return true;
    };
    for (const row of handlers) {
      if (!this.strategy.isOrphan(row, state) || !due(`handler:${row.name}`)) continue;
      console.warn(`Mesh: the handler ${JSON.stringify(row.name)} is ${this.strategy instanceof MultiClaim ? "registered by no live process" : "not registered by this deliverer"}, and its progress row, at position ${row.position}, holds ${this.#held(state, row.position)} outbox rows. If it was removed or renamed without renamedFrom, drop it with \`mesh events forget ${row.name}\` or forgetHandler(${JSON.stringify(row.name)})`);
    }
    // Delivery from several processes: a handler held by none for the lapse time, and a recorded keep "all" (rules K6, K7).
    if (this.strategy instanceof MultiClaim)
      for (const report of this.strategy.reports(state, handlers, this.db.name)) if (due(report.key)) console.warn(report.message);
    if (this.keep !== "until-delivered") return;
    for (const row of subscriptions) {
      const open = this.db.subscriptions.get(row.name);
      if (open) {
        if (!open.lagging(now) || !due(`subscription:${row.name}`)) continue;
        console.warn(`Mesh: the subscription ${JSON.stringify(row.name)} has rows handed to its callback above its acknowledged position, ${row.position}, and has not acknowledged for more than an hour; it holds ${this.#held(state, row.position)} outbox rows. Call ack(position) once a row is processed`);
      } else if (this.strategy.isOrphan(row, state) && due(`subscription:${row.name}`)) {
        console.warn(`Mesh: the subscription ${JSON.stringify(row.name)} has not been open for more than an hour, and its row, acknowledged at position ${row.position}, holds ${this.#held(state, row.position)} outbox rows. If its client is not coming back, drop it with \`mesh events forget ${row.name}\` or forgetSubscription(${JSON.stringify(row.name)})`);
      }
    }
  }
}

/**
 * Single mode (spec, "The deliverer", "The claim", "The generation check"): one process per database holds the claim in
 * `mesh_outbox_state` and delivers every handler; every handler, batch and renewal is fenced by the claim's generation.
 */
class SingleClaim implements ClaimStrategy {
  /** The generation of the claim held now, or of the last one. */
  generation = 0;
  #registered: readonly RegisteredHandler[] = Object.freeze([]);
  #renewal: ReturnType<typeof setTimeout> | undefined;
  /** The renewals outside the queue, each raced against the lapse; `release` waits for the last one's statement. */
  readonly #renewals = new Renewals();

  constructor(readonly deliverer: Deliverer) {}

  /**
   * Claim and register, in one transaction (spec, "The claim", "Registration"). Succeeds when the claim is empty or
   * lapsed, or holds this process's run id while none of its instances holds it; raises the generation by one; writes
   * every handler's row by the registration table (`handlerStart`); moves `renamedFrom` rows; and marks this process's
   * open subscriptions as open under the new generation.
   */
  async register(declared: readonly DeclaredHandler[]): Promise<number> {
    const { layer, db } = this.deliverer;
    const logs: string[] = [];
    const result = await layer.transaction(async (tx) => {
      const ops = operations(tx);
      const state = await ops.readDeliveryState();
      const claim = state.claim;
      if (claim && !lapsed(claim, state.now) && claim.runId !== RUN_ID) throw new DelivererTakenError(holderOf(db.name, claim, state.now));
      const generation = state.generation + 1;
      await ops.writeClaim({ runId: RUN_ID, generation, pid: PID, startedAt: STARTED_AT });
      const progress = new Map((await ops.readHandlerProgress()).map((row) => [row.name, row]));
      const registration = registrationOf(ops, state, this.deliverer.keep, this.deliverer.declared, this.deliverer.renamed);
      for (const entry of declared) {
        const start = await handlerStart(entry, progress, registration, this.deliverer.renamed);
        if (start.former !== undefined) {
          await ops.deleteHandlerProgress(start.former);
          await moveFailures(tx, start.former, entry.registered.name);
          progress.delete(start.former);
        }
        logs.push(...start.logs);
        await ops.writeHandlerProgress({ ...start.row, generation });
      }
      if (db.subscriptions.size > 0) {
        for (const row of await ops.readSubscriptionProgress())
          if (db.subscriptions.has(row.name)) await ops.writeSubscriptionProgress({ ...row, open: true, generation });
      }
      return { generation, deletedThrough: state.deletedThrough };
    });
    for (const line of logs) console.info(line);
    this.generation = result.generation;
    this.#registered = Object.freeze(declared.map((entry) => entry.registered));
    this.#schedule();
    return result.deletedThrough;
  }

  #schedule(): void {
    clearTimeout(this.#renewal);
    this.#renewal = setTimeout(() => { void this.tick(); }, timing.renewMs);
  }

  halt(): void {
    clearTimeout(this.#renewal);
  }

  /**
   * Renew the claim in one statement matching the run id and the generation; a blocked renewal waits until the lapse.
   * A `DatabaseBusyError` that is not a lock wait (`reason` other than `"locked"` or `"lock-timeout"`: a serialization
   * failure, a deadlock, a lost connection) is retried, at once and then every 500 ms, until the renewal succeeds or
   * the lapse passes; only then is the claim lost, naming the last reason. The renewal goes outside the layer's queue
   * when the layer offers that (`#renewOnce`), so no transaction of the layer delays it (mesh-yd0i).
   */
  async tick(): Promise<void> {
    const deliverer = this.deliverer;
    if (!deliverer.holding || deliverer.lost) return;
    const generation = this.generation;
    const deadline = deliverer.renewedAt + timing.lapseMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const renewed = await this.#renewOnce(generation, deadline);
        if (!deliverer.holding || this.generation !== generation) return;
        if (!renewed) { deliverer.lose("a renewal of the claim updated no row, so another process has taken it over"); return; }
        deliverer.renewedAt = Date.now();
        this.#schedule();
        return;
      } catch (error) {
        if (!deliverer.holding || this.generation !== generation) return;
        if (error instanceof RenewalUnsettled) {
          deliverer.lose("a renewal of the claim was still unsettled when the claim lapsed: the database or the renewal's connection stopped answering");
          return;
        }
        if (!(error instanceof DatabaseBusyError)) {
          deliverer.lose(`a renewal of the claim failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (error.reason === "locked" || error.reason === "lock-timeout") {
          deliverer.lose("a renewal of the claim stayed blocked by another connection's lock until the claim lapsed");
          return;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          deliverer.lose(`a renewal of the claim kept failing (${error.reason}) until the claim lapsed`);
          return;
        }
        if (attempt > 0) await new Promise<void>((resolve) => { this.#renewal = setTimeout(resolve, Math.min(RENEW_RETRY_MS, left)); });
        if (!deliverer.holding || deliverer.lost || this.generation !== generation) return;
      }
    }
  }

  /**
   * One renewal statement, waiting for a lock at most until `deadline`, the time the claim lapses (spec, "The claim";
   * mesh-yd0i). On a layer with `DataLayer.renewClaim` it goes outside the transaction queue, so no other transaction
   * of the layer, a round's or the application's, running or queued, delays it; it still waits for the claim's row,
   * which every handler transaction and deletion batch locks first (this layer's own included), and core gives it up
   * once it is still unsettled just past the lapse (`Renewals.race`), so a connection that stops answering loses the
   * claim at the lapse. On a layer without it the renewal goes through `transaction`, as before, where it waits behind
   * whatever is queued ahead of it (the layer counts `waitMs` from the front of its queue): no race there, since a
   * layer without the method may be a memory database, which no other process can claim, and a late renewal that
   * still matches the generation keeps the claim.
   */
  #renewOnce(generation: number, deadline: number): Promise<boolean> {
    const layer = this.deliverer.layer;
    if (!layer.renewClaim) {
      return layer.transaction((tx) => operations(tx).renewClaim(RUN_ID, generation), { waitMs: Math.max(1, deadline - Date.now()) });
    }
    return this.#renewals.race(layer.renewClaim(RUN_ID, generation, { deadline }), deadline);
  }
  handlers(): readonly RegisteredHandler[] {
    return this.#registered;
  }

  lists(handler: RegisteredHandler, row: OutboxRow): boolean {
    return handler.events.includes(row.name) || !this.deliverer.events.has(row.name);
  }

  enter(handler: RegisteredHandler, row: OutboxRow | undefined): void {
    if (row === undefined) return;
    if (!this.deliverer.events.has(row.name)) throw new EventUndeclaredError(row.name, row.position);
    if (!handler.events.includes(row.name))
      throw new FrameworkError(`runHandler was handed the ${row.name} at position ${row.position} for the handler ${JSON.stringify(handler.name)}, which does not list it: a bus hands a handler only the rows core.lists says it lists`);
  }

  writeProgress(ops: DeliveryOperations, progress: HandlerProgressRow, position: number): Promise<void> {
    return ops.writeHandlerProgress({ ...progress, position });
  }

  #declared: ReadonlySet<string> | undefined;
  passDeclared(): ReadonlySet<string> {
    return this.#declared ??= new Set(this.deliverer.declared);
  }

  readHandlers(ops: DeliveryOperations): Promise<readonly HandlerProgressRow[]> {
    return ops.readHandlerProgress();
  }

  readSubscriptions(ops: DeliveryOperations): Promise<readonly SubscriptionProgressRow[]> {
    return ops.readSubscriptionProgress();
  }

  /** In the running transaction: go on only while the claim is this instance's; otherwise the instance is lost. */
  async #checkGeneration(ops: DeliveryOperations): Promise<DeliveryState> {
    this.deliverer.live();
    const state = await ops.readDeliveryState();
    if (state.generation !== this.generation || state.claim?.runId !== RUN_ID) {
      throw this.deliverer.lose(`another process claimed the database (generation ${state.generation}, this process claimed ${this.generation})`);
    }
    return state;
  }

  /**
   * In the running transaction: the generation check, then the handler's progress row; null when the row is at or past
   * `row` (handled already), else the row. Moving past a listed row the handler has not handled is a `FrameworkError`.
   */
  async fenceHandler(ops: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<HandlerProgressRow | null> {
    await this.#checkGeneration(ops);
    const progress = (await ops.readHandlerProgress()).find((each) => each.name === handler.name);
    if (!progress) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
    if (row.position <= progress.position) return null;
    // SQL over stored names: a row stored under a former FQN of a listed (or declared) event counts as that event.
    const skipped = await ops.firstOutboxRow(progress.position, row.position, this.deliverer.storedNames(handler.events), this.deliverer.storedNames(this.deliverer.declared));
    if (skipped !== null)
      throw new FrameworkError(`runHandler was asked to handle position ${row.position} for the handler ${JSON.stringify(handler.name)}, whose low-water position is ${progress.position}, while the row at ${skipped}, which it lists, is not handled: a bus hands each handler its rows in order and never skips one`);
    return progress;
  }

  async settleListen(ops: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<void> {
    await this.#checkGeneration(ops);
    const current = (await ops.readHandlerProgress()).find((each) => each.name === handler.name);
    if (!current) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
    if (current.position < row.position) await ops.writeHandlerProgress({ ...current, position: row.position });
  }

  async fenceReplay(ops: DeliveryOperations): Promise<void> {
    await this.#checkGeneration(ops);
  }

  afterReject(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  fenceBatch(ops: DeliveryOperations): Promise<DeliveryState> {
    return this.#checkGeneration(ops);
  }

  holds(row: HandlerProgressRow): boolean {
    return row.generation === this.generation;
  }

  async moveHandler(ops: DeliveryOperations, row: HandlerProgressRow, to: number): Promise<HandlerProgressRow> {
    const next = { ...row, position: to };
    await ops.writeHandlerProgress(next);
    return next;
  }

  async moveSubscription(ops: DeliveryOperations, row: SubscriptionProgressRow, to: number): Promise<SubscriptionProgressRow> {
    const next = { ...row, position: to };
    await ops.writeSubscriptionProgress(next);
    return next;
  }

  deletes(): boolean {
    return this.deliverer.keep === "until-delivered";
  }

  isOrphan(row: HandlerProgressRow | SubscriptionProgressRow, state: DeliveryState): boolean {
    if (!("filter" in row)) return row.generation !== this.generation;
    return !this.deliverer.db.subscriptions.has(row.name) && state.now.getTime() - row.seenAt.getTime() > timing.orphanAgeMs;
  }

  resume(name: string): Promise<{ readonly handler: RegisteredHandler; readonly forBus: boolean } | undefined> {
    const handler = this.#registered.find((each) => each.name === name);
    return Promise.resolve(handler && { handler, forBus: true });
  }

  async release(quiet: boolean): Promise<void> {
    // A renewal outside the queue may still be running: released beside it, the release could wait on the claim's row
    // lock or fail as a serialization failure and leave the claim to lapse instead of going at once. So wait for the
    // adapter's statement, though not past the time core gave it up (`Renewals.settled`).
    await this.#renewals.settled();
    try {
      await this.deliverer.layer.transaction((tx) => operations(tx).releaseClaim(RUN_ID, this.generation));
    } catch (error) {
      if (error instanceof DatabaseBusyError || quiet) return;
      throw error;
    }
  }
}

/** Whether a retry of a handler that threw `error` makes sense: its own `retryable`; true for an error that sets none. */
export function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null | undefined)?.retryable !== false;
}

/**
 * True when the stored filter keeps the row (its name already read through the rename map). A stored filter may name an
 * event by a former FQN (it was written before the rename): each of its names is read through `renamed` too.
 */
function matches(filter: SubscriptionFilter, row: OutboxRow, renamed: ReadonlyMap<string, string> = NO_RENAMES): boolean {
  if (filter.names !== undefined && !filter.names.some((name) => storedToDeclared(renamed, name) === row.name)) return false;
  if (filter.entity !== undefined && row.entity !== filter.entity) return false;
  if (filter.key !== undefined && !sameKey(row.key, filter.key)) return false;
  return true;
}

/** Delivery needs the layer to name its database (`DataLayer.database`): the claim and the registry are kept per database. */
function requireDatabase(layer: DataLayer, what: string): void {
  if (typeof layer.database !== "string" || layer.database === "")
    throw new FrameworkError(`${what} was called on a data layer that does not name its database (DataLayer.database): core keeps the claim and the subscription registry per database, so a layer that delivers must name it, the same for every layer object over one database`);
}

/** What a binding needs to deliver, checked: its layer, event classes, configuration with a bus, and the events module. */
async function prepare(binding: Binding, what: string) {
  const { layer, events, config, section } = bindingParts(binding);
  if (config?.bus === undefined)
    throw new FrameworkError(`${what} was called on a binding with no event bus: configure events: { bus: localBus() } in mesh.config.ts, or pass it to bind(layer, { events })`);
  if (insideTransaction(binding)) throw new FrameworkError(`${what} was called inside a transaction: delivery runs its own transactions, so call it outside any`);
  checkedBus(config.bus);
  requireDatabase(layer, what);
  const module = await loadEvents(config);
  return { layer, events, config, module, section };
}

/** `binding.deliver()`: one round (spec, "Ways to run"). */
export async function deliverRound(binding: Binding): Promise<void> {
  const delivery = deliveryOf(binding);
  if (delivery.started) throw new FrameworkError("deliver() was called on a binding whose delivery is started: startDelivery() (or connect()) delivers on its own; stop it first");
  const { layer, events, config, module, section } = await prepare(binding, "deliver()");
  const db = databases.get(layer);
  if (delivery.round || db.deliverer) throw takenHere(db, db.deliverer);
  const round = (async () => {
    const declared = declaredHandlers(module, checkedBus(config.bus), events, section);
    if (!delivery.rounds || delivery.rounds.lost) delivery.rounds = new Deliverer(binding, layer, events, config, module);
    const deliverer = delivery.rounds;
    await deliverer.claim(declared);
    let failed = false;
    try {
      await deliverer.instance.deliver();
      if (deliverer.lost) throw deliverer.lost;
    } catch (error) {
      failed = true;
      throw deliverer.lost ?? error;
    } finally {
      await deliverer.release(failed);
    }
  })();
  delivery.round = round;
  try { await round; } finally { if (delivery.round === round) delivery.round = undefined; }
}

/** `binding.startDelivery()`, and what `connect()` calls: claims, registers and starts the bus; the handle stops it. */
export async function startDelivery(binding: Binding): Promise<Delivery> {
  const delivery = deliveryOf(binding);
  if (delivery.started) throw takenHere(databases.get(bindingParts(binding).layer), delivery.started);
  const { layer, events, config, module, section } = await prepare(binding, "startDelivery()");
  const db = databases.get(layer);
  if (delivery.round || db.deliverer) throw takenHere(db, db.deliverer);
  const declared = declaredHandlers(module, checkedBus(config.bus), events, section);
  const deliverer = new Deliverer(binding, layer, events, config, module);
  await deliverer.claim(declared);
  delivery.started = deliverer;
  try {
    await deliverer.instance.start();
  } catch (error) {
    delivery.started = undefined;
    await deliverer.instance.stop().catch(() => undefined);
    await deliverer.release(true);
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return Object.freeze({
    stop(): Promise<void> {
      return stopping ??= (async () => {
        try {
          await deliverer.instance.stop();
        } finally {
          await Promise.all([...deliverer.db.subscriptions.values()].map((subscription) => subscription.close()));
          if (delivery.started === deliverer) delivery.started = undefined;
          await deliverer.release(false);
        }
      })();
    },
  });
}

// ---- subscriptions ------------------------------------------------------------------------------------------

/** What `subscribe` takes: the subscription's name, where a first open starts, and the filter. */
export interface SubscribeQuery {
  /** The subscription's identity and the key of its row: a reopen under it resumes from the acknowledged position. */
  readonly name: string;
  /** Where a first open starts (default: the highest position now, so it gets what is published from now on); ignored on a reopen. */
  readonly after?: number;
  readonly names?: readonly string[];
  readonly entity?: string;
  readonly key?: Key;
}

/** What `subscribe` resolves with. */
export interface Subscription {
  readonly name: string;
  /** Acknowledge every delivered row at or below `position`: deletion passes them, and a reopen does not get them again. */
  ack(position: number): Promise<void>;
  /** End the stream and keep the row; resolves once the row is marked closed. */
  close(): Promise<void>;
  /** Resolves when the stream ends: with null after `close()` or the deliverer's stop, else with the error that ended it. */
  readonly done: Promise<unknown>;
}

function filterOf(query: SubscribeQuery, events: ReadonlyMap<string, EventClass>, renamed: ReadonlyMap<string, string>): SubscriptionFilter {
  const { names, entity, key } = query;
  if (names !== undefined) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
      throw new FrameworkError("subscribe: names must be an array of event FQNs, such as [Mesh.fqnOf(InvoicePaid)]");
    for (const name of names)
      if (!events.has(name)) throw new FrameworkError(`subscribe: names lists ${JSON.stringify(name)}, which is not a declared event${renamedClause(renamed, name)}; the project declares ${[...events.keys()].join(", ") || "none"}`);
  }
  if (entity !== undefined && typeof entity !== "string") throw new FrameworkError("subscribe: entity must be an entity's FQN, such as \"billing.Invoice\"");
  if (key !== undefined && (typeof key !== "object" || key === null || Array.isArray(key))) throw new FrameworkError("subscribe: key must be a record's key, such as { id }");
  return JSON.parse(JSON.stringify({ ...(names ? { names: [...names].sort() } : {}), ...(entity !== undefined ? { entity } : {}), ...(key !== undefined ? { key } : {}) })) as SubscriptionFilter;
}

/** Two stored filters, compared as JSON with sorted keys. */
function sameFilter(a: SubscriptionFilter, b: SubscriptionFilter): boolean {
  return canonical(a) === canonical(b);
}

/**
 * A stored filter with its names read through the rename map, sorted and without repeats: a row written before a rename
 * names an event by its former FQN, and takes the same rows as the filter that names it by the new one.
 */
export function renamedFilter(filter: SubscriptionFilter, renamed: ReadonlyMap<string, string>): SubscriptionFilter {
  if (filter.names === undefined || renamed.size === 0 || !filter.names.some((name) => renamed.has(name))) return filter;
  return { ...filter, names: sortedUnique(filter.names.map((name) => storedToDeclared(renamed, name))) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** A live subscription: a core object in the database's registry, fed by the bus, acknowledged by its client. */
class OpenSubscription implements LiveSubscription {
  cursor: number;
  ended = false;
  /**
   * True for the reservation `subscribe` holds in the registry while it writes the row: it keeps the name taken and
   * makes no read. Ending it (a stop or a lost claim meanwhile) only records why; `subscribe` ends the real one with it.
   */
  opening = false;
  /** Why an opening reservation was ended, for `subscribe` to pass on. */
  endedWith: unknown;
  /** The highest position handed to the callback. */
  #handed: number;
  /** The acknowledged position as this process last wrote or read it. */
  #acked: number;
  /** When the acknowledged position last moved, or the subscription opened (`Date.now()`). */
  #ackMovedAt = Date.now();
  readonly #queue: EventRecord[] = [];
  #draining = false;
  #closing: Promise<void> | undefined;
  readonly done: Promise<unknown>;
  #settle!: (value: unknown) => void;
  readonly handle: Subscription;

  constructor(readonly db: DatabaseState, readonly layer: DataLayer, readonly events: ReadonlyMap<string, EventClass>, readonly name: string,
    readonly filter: SubscriptionFilter, position: number, readonly callback: (event: EventRecord) => unknown, readonly multiProcess = false,
    readonly upcast?: EventsModule["upcast"]) {
    this.cursor = position;
    this.#handed = position;
    this.#acked = position;
    this.done = new Promise((resolve) => { this.#settle = resolve; });
    const self = this;
    this.handle = Object.freeze({ name, ack: (p: number) => self.ack(p), close: () => self.close(), done: this.done });
  }

  /** True when rows above the acknowledged position were handed to the callback and it has not acknowledged for `orphanAgeMs`. */
  lagging(now: number): boolean {
    return this.#handed > this.#acked && now - this.#ackMovedAt > timing.orphanAgeMs;
  }

  async feed(page: OutboxPage, options?: { readonly maxQueue?: number }): Promise<void> {
    if (this.ended) return;
    const maxQueue = options?.maxQueue ?? timing.maxQueue;
    for (const row of page.rows) {
      if (row.position <= this.cursor) continue;
      const eventClass = this.events.get(row.name);
      if (!eventClass) {
        const declaredBy = this.multiProcess ? declarerOf(this.db, row.name) : undefined;
        this.end(new EventUndeclaredError(row.name, row.position, declaredBy === undefined ? undefined : { declaredBy }));
        return;
      }
      this.cursor = row.position;
      if (!matches(this.filter, row)) continue;
      this.#queue.push(recordOf(row, eventClass, this.upcast));
      if (this.#queue.length > maxQueue) { this.end(new SubscriptionOverflowError(this.name, maxQueue)); return; }
    }
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.ended && this.#queue.length > 0) {
        const record = this.#queue.shift()!;
        this.#handed = record.position;
        try { await this.callback(record); } catch (error) { this.end(error); return; }
      }
    } finally { this.#draining = false; }
  }

  async ack(position: number): Promise<void> {
    if (this.ended) throw new FrameworkError(`ack was called on the subscription ${JSON.stringify(this.name)}, which is ${this.#closing ? "closed" : "ended"}: open it again under its name to go on`);
    if (!Number.isSafeInteger(position) || position < 0) throw new FrameworkError(`ack takes a position, a whole number, and was given ${describe(position)}`);
    if (position > this.#handed)
      throw new FrameworkError(`ack(${position}) is above the highest position handed to the callback of the subscription ${JSON.stringify(this.name)}, ${this.#handed}: acknowledge only what it has processed`);
    const moved = await this.layer.transaction(async (tx) => {
      if (this.multiProcess) return ackOwned(multiOperations(tx), this.db.name, this.name, position);
      const ops = operations(tx);
      const state = await ops.readDeliveryState();
      const row = (await ops.readSubscriptionProgress()).find((each) => each.name === this.name);
      if (!row) throw new FrameworkError(`The subscription ${JSON.stringify(this.name)} has no row: it was forgotten while open`);
      if (row.generation !== state.generation) throw new DelivererLostError(this.db.name, `another process claimed the database (generation ${state.generation}) since the subscription ${JSON.stringify(this.name)} opened`);
      if (position <= row.position) return row.position;
      // seenAt left out: the database stamps it with its own now, as the spec's ack writes the position and seenAt.
      await ops.writeSubscriptionProgress({ name: row.name, position, filter: row.filter, open: row.open, generation: row.generation });
      return position;
    }).catch((error: unknown) => {
      if (error instanceof DelivererLostError) this.end(error);
      throw error;
    });
    if (moved > this.#acked) { this.#acked = moved; this.#ackMovedAt = Date.now(); }
  }

  close(): Promise<void> {
    this.end(null);
    return this.#closing ?? Promise.resolve();
  }

  end(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (this.opening) { this.endedWith = error; return; }
    this.#queue.length = 0;
    if (this.db.subscriptions.get(this.name) === this) this.db.subscriptions.delete(this.name);
    // A lost claim leaves the rows to the process that took it over (its generation already reads them as closed), and
    // the loss is often noticed inside a transaction that is about to roll back, where a write would join it.
    if (error instanceof DelivererLostError) { this.#closing = Promise.resolve(); this.#settle(error); return; }
    this.#closing = this.layer.transaction(async (tx) => {
      if (this.multiProcess) {
        const ops = multiOperations(tx);
        const row = (await ops.readSubscriptionOwners()).find((each) => each.name === this.name);
        if (row?.open) await ops.writeSubscriptionOwner({ name: row.name, position: row.position, filter: row.filter, open: false, generation: row.generation, runId: row.runId });
        return;
      }
      const ops = operations(tx);
      const row = (await ops.readSubscriptionProgress()).find((each) => each.name === this.name);
      // Closing writes seenAt, the database's now (left out), from which a closed row's age is measured.
      if (row?.open) await ops.writeSubscriptionProgress({ name: row.name, position: row.position, filter: row.filter, open: false, generation: row.generation });
    }).catch((thrown: unknown) => {
      console.warn(`Mesh: the subscription ${JSON.stringify(this.name)} ended, and its row could not be marked closed (it reads as open until the claim's generation moves on):`, thrown);
    }).then(() => this.#settle(error ?? null));
  }
}

/** The hole check's view of a subscription filter: every event when it names none, else the events it names. */
export function filterTakes(filter: SubscriptionFilter): { takes(name: string): boolean } {
  return { takes: (name) => filter.names === undefined || filter.names.includes(name) };
}

/** `subscribe` of `#mesh` (spec, "`subscribe`"): open (or reopen) the subscription `query.name` on `binding`'s database. */
export async function subscribe(binding: Binding, query: SubscribeQuery, callback: (event: EventRecord) => unknown): Promise<Subscription> {
  const { layer, events, config, renamed } = bindingParts(binding);
  const delivery = deliveryOf(binding);
  if (config?.bus === undefined || delivery.noDeliver)
    throw new FrameworkError("subscribe was called in a process that does not deliver (connected with { deliver: false }, or bound with no bus): nothing would feed it. Subscribe in the deliverer's process");
  if (!checkedBus(config.bus).manifest.capabilities.includes("subscribe"))
    throw new FrameworkError(`subscribe was called, and the bus ${config.bus.manifest.adapter} does not declare subscribe`);
  if (typeof query !== "object" || query === null) throw new FrameworkError(`subscribe takes { name, after, names, entity, key }, and was given ${describe(query)}`);
  const { name, after } = query;
  if (typeof name !== "string" || name.trim() === "")
    throw new FrameworkError("subscribe needs a name: the subscription's identity and the key of its row, so a client that comes back resumes from what it acknowledged");
  if (typeof callback !== "function") throw new FrameworkError(`subscribe takes a callback, (event) => ..., and was given ${describe(callback)}`);
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new FrameworkError(`subscribe: after must be a position, a whole number, and is ${describe(after)}`);
  if (insideTransaction(binding)) throw new FrameworkError("subscribe was called inside a transaction: a subscription never runs inside one");
  requireDatabase(layer, "subscribe");
  const filter = filterOf(query, events, renamed);
  // Loaded here, not left to a delivery round: under bind(layer, { events }) a subscription can open before anything
  // has loaded the module, and its rows must reach the callback upcast all the same.
  const { upcast } = await loadEvents(config);
  const db = databases.get(layer);
  if (db.subscriptions.has(name))
    throw new FrameworkError(`A subscription named ${JSON.stringify(name)} is open in this process already: two readers acknowledging under one row would pass each other's rows`);
  const multiProcess = isMultiProcess(checkedBus(config.bus));
  const placeholder = new OpenSubscription(db, layer, events, name, filter, 0, callback, multiProcess, upcast);
  placeholder.opening = true;
  db.subscriptions.set(name, placeholder);
  try {
    const position = await layer.transaction(async (tx) => {
      if (multiProcess) return openOwned(multiOperations(tx), name, filter, after, renamed);
      const ops = operations(tx);
      const state = await ops.readDeliveryState();
      if (state.claim !== null && state.claim.runId !== RUN_ID && !lapsed(state.claim, state.now))
        throw new FrameworkError(`subscribe was called in a process that does not deliver: another process (pid ${state.claim.pid ?? "unknown"} on host ${state.claim.host ?? "unknown"}) holds ${db.name}'s deliverer claim, so nothing here would feed the subscription. Subscribe in the deliverer's process`);
      const row = (await ops.readSubscriptionProgress()).find((each) => each.name === name);
      let start: number;
      if (row) {
        // A row written before a rename names the event by its former FQN: the same filter, rewritten below with the new name.
        if (!sameFilter(renamedFilter(row.filter, renamed), filter))
          throw new FrameworkError(`The subscription ${JSON.stringify(name)} was opened with the filter ${canonical(filter)}, and its row was reached with ${canonical(row.filter)}: an acknowledged position means something only under its filter. Forget it (forgetSubscription(${JSON.stringify(name)})), then open it with the new filter`);
        start = row.position;
      } else {
        start = after ?? state.highest;
        if (start < state.deletedThrough) throw new EventsDeletedError(start, state.deletedThrough + 1);
        if (start > state.highest) throw new CursorAheadError(start, state.highest);
      }
      // A hole above the cursor of an event the filter takes would be skipped (rule KE3): refused before the row is
      // written. A reopen's stored position is never below one (a hole is made only at or below every reader's row).
      const hole = holeError(state.holes, start, renamed, filterTakes(filter));
      if (hole) throw hole;
      const generation = db.deliverer?.holding ? db.deliverer.generation : state.generation;
      await ops.writeSubscriptionProgress({ name, position: start, filter, open: true, generation });
      return start;
    });
    const subscription = new OpenSubscription(db, layer, events, name, filter, position, callback, multiProcess, upcast);
    if (db.subscriptions.get(name) === placeholder) db.subscriptions.delete(name);
    if (placeholder.ended) {
      // Delivery stopped, or the claim was lost, while the row was being written: the stream ends as it would have.
      subscription.end(placeholder.endedWith);
      return subscription.handle;
    }
    db.subscriptions.set(name, subscription);
    return subscription.handle;
  } catch (error) {
    if (db.subscriptions.get(name) === placeholder) db.subscriptions.delete(name);
    throw error;
  }
}

// ---- forgetting ---------------------------------------------------------------------------------------------

/** True when the claim is held now (not released, not lapsed) under `generation`. */
function liveUnder(state: DeliveryState, generation: number): boolean {
  return state.claim !== null && !lapsed(state.claim, state.now) && state.claim.generation === generation;
}

/** `forgetHandler(name)` of `#mesh`: drop an orphaned handler's progress row; refuses one the live deliverer registered. */
export async function forgetHandler(binding: Binding, name: string): Promise<void> {
  const { layer, config } = bindingParts(binding);
  if (typeof name !== "string" || name === "") throw new FrameworkError(`forgetHandler takes a handler's name, and was given ${describe(name)}`);
  if (isMultiProcess(config?.bus)) {
    await forgetOwned(layer, name, "handler", "forgetHandler");
    return;
  }
  await layer.transaction(async (tx) => {
    const ops = operations(tx);
    const state = await ops.readDeliveryState();
    const row = (await ops.readHandlerProgress()).find((each) => each.name === name);
    if (!row) throw new FrameworkError(`forgetHandler: no handler named ${JSON.stringify(name)} has a progress row`);
    if (liveUnder(state, row.generation))
      throw new FrameworkError(`forgetHandler: the handler ${JSON.stringify(name)} is registered by the live deliverer, so its progress is not dropped. Remove it from the events module or from the handlers section of its entity file (then rebuild) and restart first`);
    await ops.deleteHandlerProgress(name);
  });
}

/** A persisted subscription's identity and acknowledged position, whether its stream is open or closed. */
export interface SubscriptionProgress {
  readonly name: string;
  /** The stored acknowledged position, including rows its filter passed. Not its in-memory read cursor. */
  readonly position: number;
}

/**
 * `listSubscriptions()` of `#mesh`: a frozen snapshot of every persisted subscription on the binding's database,
 * ordered by name. Includes closed and abandoned subscriptions until forgotten; needs no running deliverer.
 * Runs through the layer's transaction (a write lock on SQLite); inside an application transaction it joins it.
 */
export async function listSubscriptions(binding: Binding): Promise<readonly SubscriptionProgress[]> {
  const { layer } = bindingParts(binding);
  return layer.transaction(async (tx) => {
    const rows = await operations(tx).readSubscriptionProgress();
    return Object.freeze(rows.map(({ name, position }) => Object.freeze({ name, position }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });
}

/** `forgetSubscription(name)` of `#mesh`: drop a subscription's row; refuses one that is open in this process. */
export async function forgetSubscription(binding: Binding, name: string): Promise<void> {
  const { layer, config } = bindingParts(binding);
  if (typeof name !== "string" || name === "") throw new FrameworkError(`forgetSubscription takes a subscription's name, and was given ${describe(name)}`);
  if (databases.get(layer).subscriptions.has(name))
    throw new FrameworkError(`forgetSubscription: the subscription ${JSON.stringify(name)} is open in this process; close it first`);
  if (isMultiProcess(config?.bus)) {
    await forgetOwned(layer, name, "subscription", "forgetSubscription");
    return;
  }
  await layer.transaction(async (tx) => {
    const ops = operations(tx);
    const state = await ops.readDeliveryState();
    const row = (await ops.readSubscriptionProgress()).find((each) => each.name === name);
    if (!row) throw new FrameworkError(`forgetSubscription: no subscription named ${JSON.stringify(name)} has a row`);
    if (row.open && liveUnder(state, row.generation) && state.claim?.runId !== RUN_ID)
      throw new FrameworkError(`forgetSubscription: the subscription ${JSON.stringify(name)} is open in the process that delivers; close it there first`);
    await ops.deleteSubscriptionProgress(name);
  });
}

/**
 * `resumeHandler(name)` of `#mesh` (spec, Events and commands, "Handler failures"): resume a handler the started bus of
 * this binding stopped at a failing event, from its progress row, in the next round. A handler that is not stopped is
 * left as it is. Without a started delivery in this process there is nothing to resume here: the next start and the next
 * `deliver()` round feed every handler again on their own, so the call is a `FrameworkError` that says so.
 */
export async function resumeHandler(binding: Binding, name: string): Promise<void> {
  if (typeof name !== "string" || name === "") throw new FrameworkError(`resumeHandler takes a handler's name, and was given ${describe(name)}`);
  const deliverer = deliveryOf(binding).started;
  if (!deliverer || deliverer.lost)
    throw new FrameworkError(`resumeHandler(${JSON.stringify(name)}) was called on a binding whose delivery is not started in this process: it resumes a handler the running bus stopped. A stopped handler also resumes at the next start (connect() or startDelivery()) and in the next deliver() round`);
  const resumed = await deliverer.strategy.resume(name);
  if (!resumed)
    throw new FrameworkError(`resumeHandler: no handler named ${JSON.stringify(name)} is registered by this deliverer; it registers ${deliverer.registeredNames().map((each) => JSON.stringify(each)).join(", ") || "none"}`);
  // Delivery from several processes: a handler this process yielded or does not hold was resumed by the strategy.
  if (!resumed.forBus) return;
  const handler = resumed.handler;
  if (typeof deliverer.instance.resumeHandler !== "function")
    throw new FrameworkError(`resumeHandler: the bus ${JSON.stringify(deliverer.bus.manifest.adapter)} cannot resume a handler while it runs (its instance has no resumeHandler); restart delivery to resume it`);
  deliverer.instance.resumeHandler(handler);
}

/** What `retryFailed(name)` resolves with. */
export interface RetryFailedResult {
  /** How many set-aside events were handled and removed. */
  readonly handled: number;
  /** The first one that failed again, which stays with every later one; null when none failed. */
  readonly failed: StoppedHandler | null;
}

/** The set-aside events `retryFailed` reads at a time. */
const REPLAY_PAGE = 100;

/**
 * `retryFailed(name)` of `#mesh` (spec, Events and commands, "Handler failures"; design DL7, DL8): run the handler
 * `name` once on each of its set-aside events, in position order, removing each row as it is handled; stop at the first
 * that fails again (or that the handler no longer lists, or that no declared event matches) and resolve with it as
 * `failed`, keeping it and every later row. Runs only where delivery may run, under this process's claim: the started
 * delivery's when there is one, else a claim taken for the call (`MESH_DELIVERER_TAKEN` while another process holds it);
 * with a bus that declares `multi-process`, only while this process holds the handler's lease (`MESH_HANDLER_LOST`).
 * A second call for the same handler while one runs in this process is refused.
 */
export async function retryFailed(binding: Binding, name: string): Promise<RetryFailedResult> {
  if (typeof name !== "string" || name === "") throw new FrameworkError(`retryFailed takes a handler's name, and was given ${describe(name)}`);
  const { config } = bindingParts(binding);
  const delivery = deliveryOf(binding);
  if (config?.bus === undefined || delivery.noDeliver)
    throw new FrameworkError("retryFailed was called in a process that does not deliver (connected with { deliver: false }, or bound with no bus): call it in the deliverer's process");
  if (!checkedBus(config.bus).manifest.capabilities.includes("dead-letters"))
    throw new FrameworkError(`retryFailed was called, and the bus ${config.bus.manifest.adapter} does not declare dead-letters: no event is set aside without it`);
  const { layer, events, module, section } = await prepare(binding, "retryFailed");
  const db = databases.get(layer);
  const started = delivery.started && !delivery.started.lost ? delivery.started : undefined;
  let declared: DeclaredHandler[] | undefined;
  if (!started) {
    declared = declaredHandlers(module, checkedBus(config.bus), events, section);
    if (!declared.some((entry) => entry.registered.name === name))
      throw new FrameworkError(`retryFailed(${JSON.stringify(name)}): no handler named ${JSON.stringify(name)} is registered (by the events module or a handlers section); the handlers are ${declared.map((entry) => entry.registered.name).join(", ") || "none"}`);
  } else if (!started.registered(name)) {
    throw new FrameworkError(`retryFailed(${JSON.stringify(name)}): no handler named ${JSON.stringify(name)} is registered (by the events module or a handlers section); the handlers are ${started.registeredNames().join(", ") || "none"}`);
  }
  if (db.retrying.has(name))
    throw new FrameworkError(`retryFailed(${JSON.stringify(name)}) is already running in this process: two runs would handle one set-aside event twice`);
  db.retrying.add(name);
  try {
    let deliverer = started;
    let claimed = false;
    if (!deliverer) {
      if (delivery.round || db.deliverer) throw takenHere(db, db.deliverer);
      if (!delivery.rounds || delivery.rounds.lost) delivery.rounds = new Deliverer(binding, layer, events, config, module);
      deliverer = delivery.rounds;
      await deliverer.claim(declared!);
      claimed = true;
    }
    let failed = false;
    try {
      // Delivery from several processes: only the process holding the handler's lease runs it.
      const handler = deliverer.strategy.handlers().find((each) => each.name === name);
      if (!handler)
        throw new HandlerLostError(name, "taken", 0, `retryFailed(${JSON.stringify(name)}): this process does not hold the handler's lease; another process delivers it, or none does until a process takes it over. Call it where the handler is held`);
      let handled = 0;
      let cursor: { position: number; failure: number } | null = null;
      for (;;) {
        const after: { position: number; failure: number } | null = cursor;
        const page: readonly FailureRow[] = await layer.transaction((tx) => failureOperations(tx, `retryFailed(${JSON.stringify(name)}) reads set-aside events`).readFailures(name, after, REPLAY_PAGE));
        for (const failure of page) {
          const outcome = await deliverer.replay(handler, failure);
          if (typeof outcome === "object")
            return Object.freeze({ handled, failed: Object.freeze({ handler: name, position: failure.position, event: deliverer.declaredName(failure.name), cause: outcome.cause }) });
          if (outcome === "handled") handled++;
          cursor = { position: failure.position, failure: failure.failure };
        }
        if (page.length < REPLAY_PAGE) return Object.freeze({ handled, failed: null });
      }
    } catch (error) {
      failed = true;
      throw deliverer.lost ?? error;
    } finally {
      if (claimed) await deliverer.release(failed);
    }
  } finally {
    db.retrying.delete(name);
  }
}

/** What `mesh events forget` dropped. */
export interface Forgotten {
  readonly kind: "handler" | "subscription";
  readonly name: string;
  readonly position: number;
}

/**
 * `mesh events forget <name>`, outside the deliverer's process: drops the handler's or the subscription's row of that
 * name. A handler registered under the live claim's generation, and a subscription whose `open` flag is set under it,
 * are refused; a flag set under a lapsed or older generation is a crash's leftover. A name held by both tables is
 * refused, naming both. With `multiProcess` (the project's bus declares `multi-process`, as its configuration says, never
 * probed from the schema), a handler a live process row registers and a subscription open under a live process row are
 * refused instead.
 */
export async function forgetByName(layer: DataLayer, name: string, options?: { readonly multiProcess?: boolean }): Promise<Forgotten> {
  if (typeof name !== "string" || name === "") throw new FrameworkError("mesh events forget takes a handler's or a subscription's name");
  if (options?.multiProcess === true) return forgetOwned(layer, name, "either", "mesh events forget");
  return layer.transaction(async (tx) => {
    const ops = operations(tx);
    const state = await ops.readDeliveryState();
    const handler = (await ops.readHandlerProgress()).find((each) => each.name === name);
    const subscription = (await ops.readSubscriptionProgress()).find((each) => each.name === name);
    if (handler && subscription)
      throw new FrameworkError(`The name ${JSON.stringify(name)} is held by a handler's progress row and by a subscription's row: forget each from the application, with forgetHandler(${JSON.stringify(name)}) or forgetSubscription(${JSON.stringify(name)})`);
    if (handler) {
      if (liveUnder(state, handler.generation))
        throw new FrameworkError(`The handler ${JSON.stringify(name)} is registered by the live deliverer (generation ${handler.generation}), so its progress is not dropped. Remove it from the events module or from the handlers section of its entity file (then rebuild) and restart the deliverer first`);
      await ops.deleteHandlerProgress(name);
      return { kind: "handler", name, position: handler.position };
    }
    if (subscription) {
      if (subscription.open && liveUnder(state, subscription.generation))
        throw new FrameworkError(`The subscription ${JSON.stringify(name)} is open in the deliverer's process (generation ${subscription.generation}); close it there first`);
      await ops.deleteSubscriptionProgress(name);
      return { kind: "subscription", name, position: subscription.position };
    }
    throw new FrameworkError(`No handler and no subscription named ${JSON.stringify(name)} has a row in this database`);
  });
}

// ---- adopting and the recorded keep (delivery from several processes) ---------------------------------------

/** The `drop` option of `adoptByName` and `adoptHandler`, checked: a list of event names. */
function dropList(what: string, options: { readonly drop?: readonly string[] } | undefined): readonly string[] {
  const drop: unknown = options?.drop ?? [];
  if (!Array.isArray(drop) || drop.some((event) => typeof event !== "string" || event === ""))
    throw new FrameworkError(`${what}: drop is a list of event names, such as ["billing.InvoiceVoided"], and is ${describe(drop)}`);
  return drop as readonly string[];
}

/**
 * `mesh events adopt <handler> [--drop <event>]...` (design rule R5), outside the delivering processes: shrinks the
 * handler's registered union, keeping every event a live process lists for it and dropping only the events named in
 * `drop`; refused when no live process registers it, and for a `drop` of an event a live process lists or the union
 * lacks. Only in a project whose bus declares `multi-process`, which `multiProcess` says (from the configuration, never
 * probed from the schema); in single mode there is no union to adopt.
 */
export async function adoptByName(layer: DataLayer, name: string, options?: { readonly drop?: readonly string[]; readonly multiProcess?: boolean }): Promise<Adopted> {
  if (typeof name !== "string" || name === "") throw new FrameworkError("mesh events adopt takes a handler's name");
  const drop = dropList("mesh events adopt", options);
  if (options?.multiProcess !== true)
    throw new FrameworkError("mesh events adopt applies to a project whose bus declares multi-process: in single mode a handler's events are the list its one deliverer registered");
  return adoptOwned(layer, name, drop, "mesh events adopt");
}

/** `adoptHandler(name, { drop })` of `#mesh`, in a project whose bus declares `multi-process`: `adoptByName` on the binding's layer. */
export async function adoptHandler(binding: Binding, name: string, options?: { readonly drop?: readonly string[] }): Promise<Adopted> {
  const { layer, config } = bindingParts(binding);
  if (typeof name !== "string" || name === "") throw new FrameworkError(`adoptHandler takes a handler's name, and was given ${describe(name)}`);
  const drop = dropList("adoptHandler", options);
  if (!isMultiProcess(config?.bus))
    throw new FrameworkError("adoptHandler applies to a project whose bus declares multi-process: in single mode a handler's events are the list its one deliverer registered");
  return adoptOwned(layer, name, drop, "adoptHandler");
}

/**
 * `mesh events keep <until-delivered|all>` (design rule K4): sets the `keep` recorded in `mesh_outbox_state`, which
 * every delivering process of a multi-process project obeys; `"until-delivered"` is refused while a live process runs
 * with `keep: "all"`. Only with `multiProcess`, as for `adoptByName`.
 */
export async function keepByValue(layer: DataLayer, keep: "until-delivered" | "all", options?: { readonly multiProcess?: boolean }): Promise<KeepChange> {
  if (keep !== "until-delivered" && keep !== "all")
    throw new FrameworkError(`mesh events keep takes "until-delivered" or "all", and was given ${describe(keep)}`);
  if (options?.multiProcess !== true)
    throw new FrameworkError("mesh events keep applies to a project whose bus declares multi-process: in single mode the deliverer's own keep is the one in force");
  return keepOwned(layer, keep);
}
