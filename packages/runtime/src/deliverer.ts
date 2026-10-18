import type { BusCore, EventBus, EventBusInstance, Handler, LiveSubscription, RegisteredHandler } from "./bus.ts";
import { checkedBus } from "./bus.ts";
import type {
  DataLayer, DataOperations, DelivererClaim, DeliveryOperations, DeliveryState, HandlerProgressRow, Key, OutboxPage, OutboxRow,
  SubscriptionFilter, SubscriptionProgressRow,
} from "./data-layer.ts";
import { DECLARATION, type Declaration } from "./declarations.ts";
import {
  CursorAheadError, DatabaseBusyError, DelivererLostError, DelivererTakenError, EventUndeclaredError, EventsDeletedError, FrameworkError,
  HandlerOptionError, SubscriptionOverflowError, type ClaimHolder, type StoppedHandler,
} from "./errors.ts";
import { bindingParts, handlerScope, insideTransaction, type Binding } from "./entity.ts";
import {
  PerDatabase, causedIn, describe, loadEvents, onPublished, recordOf, rows, sameKey, type EventClass, type EventRecord, type EventsConfig, type EventsModule,
} from "./events.ts";
import type { ActionContext } from "./index.ts";

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
export type DeliveryTiming = { -readonly [K in keyof typeof DEFAULT_TIMING]: number };
const timing: DeliveryTiming = { ...DEFAULT_TIMING };

/** Change the deliverer's internal numbers, for tests only (`@meshfw/runtime/testing`); `null` restores the defaults. */
export function setDeliveryTiming(changes: Partial<DeliveryTiming> | null): void {
  Object.assign(timing, changes === null ? DEFAULT_TIMING : changes);
}

/** This process run's id: drawn once, never the pid (containers run every process as pid 1). */
const RUN_ID: string = crypto.randomUUID();
const STARTED_AT = new Date();
const PID: number | null = typeof (globalThis as { process?: { pid?: unknown } }).process?.pid === "number" ? (globalThis as unknown as { process: { pid: number } }).process.pid : null;

/** A row a deliverer reads from `mesh_handler_progress` and the handler as the events module declares it. */
interface DeclaredHandler {
  readonly registered: RegisteredHandler;
  readonly handler: Handler<never>;
  readonly renamedFrom: string | undefined;
}

/** What core keeps per database in this process. */
interface DatabaseState {
  /** The database's name, for messages: `layer.database`, else `the database`. */
  readonly name: string;
  /** The deliverer of this process holding (or taking) the claim on this database, if any. */
  deliverer: Deliverer | undefined;
  /** The subscriptions open in this process, by name. */
  readonly subscriptions: Map<string, OpenSubscription>;
  /** When each orphan was last reported in this process (`Date.now()`), by `handler:<name>` or `subscription:<name>`. */
  readonly reported: Map<string, number>;
}
const databases = new PerDatabase<DatabaseState>((layer) => ({
  name: typeof layer.database === "string" && layer.database !== "" ? layer.database : "the database",
  deliverer: undefined,
  subscriptions: new Map(),
  reported: new Map(),
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
function operations(tx: DataOperations): DeliveryOperations {
  for (const name of DELIVERY_OPERATIONS)
    if (typeof tx[name] !== "function")
      throw new FrameworkError(`The data layer's transactions have no ${name}: delivering events needs a data adapter with the delivery operations (DeliveryOperations in @meshfw/runtime)`);
  return tx as DataOperations & DeliveryOperations;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the claim has not been renewed for the lapse time, by the database's clock. */
function lapsed(claim: DelivererClaim, now: Date): boolean {
  return now.getTime() - claim.renewedAt.getTime() >= timing.lapseMs;
}

function holderOf(database: string, claim: DelivererClaim, now: Date): ClaimHolder {
  return {
    database, pid: claim.pid, host: claim.host, startedAt: claim.startedAt, renewedAgoMs: Math.max(0, now.getTime() - claim.renewedAt.getTime()),
    lapsesAt: new Date(claim.renewedAt.getTime() + timing.lapseMs), thisProcess: claim.runId === RUN_ID,
  };
}

/** `MESH_DELIVERER_TAKEN` for a claim another binding or round of this process holds. */
function takenHere(db: DatabaseState, holder: Deliverer | undefined): DelivererTakenError {
  const renewedAt = holder?.renewedAt ?? Date.now();
  return new DelivererTakenError({
    database: db.name, pid: PID, host: null, startedAt: STARTED_AT, renewedAgoMs: Math.max(0, Date.now() - renewedAt),
    lapsesAt: new Date(renewedAt + timing.lapseMs), thisProcess: true,
  });
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * Check the events module's handlers against the bus's manifest and against each other, before anything is claimed
 * (spec, "Options and their checks"): every handler needs `ordered-delivery`; `onFailure: "skip"` needs
 * `dead-letters`; names are unique across both kinds; a `renamedFrom` must not name a handler the module still
 * registers, nor be named by two handlers. Shapes are checked too: `run` a function, `events` a non-empty list of the
 * domain's event classes.
 */
export function declaredHandlers(module: EventsModule, bus: EventBus, events: ReadonlyMap<string, EventClass>): DeclaredHandler[] {
  const capabilities = new Set<string>(bus.manifest.capabilities);
  const out: DeclaredHandler[] = [];
  const seen = new Map<string, string>();
  for (const kind of ["process", "listen"] as const) {
    for (const [name, handler] of Object.entries(module.handlers?.[kind] ?? {})) {
      const where = `The ${kind} handler ${JSON.stringify(name)}`;
      if (seen.has(name)) throw new HandlerOptionError(name, `${where} has the name of a ${seen.get(name)} handler: a handler's name is unique across both kinds, since it keys the handler's progress row`);
      seen.set(name, kind);
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
      out.push({ registered: Object.freeze({ name, kind, events: Object.freeze(sortedUnique(fqns)), onFailure }), handler, renamedFrom });
    }
  }
  const formers = new Map<string, string>();
  for (const { registered: { name }, renamedFrom } of out) {
    if (renamedFrom === undefined) continue;
    if (seen.has(renamedFrom))
      throw new HandlerOptionError(name, `The handler ${JSON.stringify(name)} has renamedFrom ${JSON.stringify(renamedFrom)}, a handler the events module still registers: a running handler's progress is never taken over. Remove the option, or the old handler`);
    const other = formers.get(renamedFrom);
    if (other !== undefined)
      throw new HandlerOptionError(name, `The handlers ${JSON.stringify(other)} and ${JSON.stringify(name)} both have renamedFrom ${JSON.stringify(renamedFrom)}: one progress row cannot move to two names`);
    formers.set(renamedFrom, name);
  }
  return out.sort((a, b) => (a.registered.name < b.registered.name ? -1 : a.registered.name > b.registered.name ? 1 : 0));
}

/** How many kept rows lie above `position`: what an orphan holds. */
const held = (state: DeliveryState, position: number) => Math.max(0, state.highest - Math.max(position, state.deletedThrough));

/**
 * One bus instance and the claims it delivers under: made by `startDelivery()` (one claim, until `stop()`) or kept by a
 * binding's `deliver()` rounds (a claim per round), until the claim is lost.
 */
class Deliverer {
  readonly db: DatabaseState;
  readonly bus: EventBus;
  readonly keep: "until-delivered" | "all";
  readonly instance: EventBusInstance;
  readonly core: BusCore;
  /** The generation of the claim held now, or of the last one. */
  generation = 0;
  /** True while this instance holds the claim. */
  holding = false;
  /** When this process last claimed or renewed (`Date.now()`), for this process's own `MESH_DELIVERER_TAKEN`. */
  renewedAt = 0;
  lost: DelivererLostError | undefined;
  /** The handlers registered for the current claim, by name. */
  #handlers = new Map<string, DeclaredHandler>();
  #registered: readonly RegisteredHandler[] = Object.freeze([]);
  readonly #declared: string[];
  /** The read head: the highest position a read through `core.rows` returned, from the deleted-through position at each claim. */
  #readHead = 0;
  #renewal: ReturnType<typeof setTimeout> | undefined;
  readonly #lostListeners = new Set<(error: Error) => void>();

  constructor(readonly binding: Binding, readonly layer: DataLayer, readonly events: ReadonlyMap<string, EventClass>, readonly config: EventsConfig, readonly module: EventsModule) {
    this.db = databases.get(layer);
    this.bus = checkedBus(config.bus);
    this.keep = config.keep ?? "until-delivered";
    this.#declared = [...events.keys()].sort();
    const self = this;
    this.core = Object.freeze({
      rows: (after: number, limit: number) => self.read(after, limit),
      get handlers() { return self.#registered; },
      position: (handler: RegisteredHandler) => self.position(handler),
      lists: (handler: RegisteredHandler, row: OutboxRow) => handler.events.includes(row.name) || !self.events.has(row.name),
      runHandler: (handler: RegisteredHandler, row: OutboxRow) => self.runHandler(handler, row),
      retry: (handler: RegisteredHandler, row: OutboxRow, delays: readonly number[]) => self.retry(handler, row, delays),
      isRetryable,
      subscriptions: () => [...self.db.subscriptions.values()].filter((subscription) => !subscription.ended),
      deletionPass: () => self.deletionPass(),
      onPublished: (listener: () => void) => onPublished(layer, listener),
      onClaimLost: (listener: (error: Error) => void) => { self.#lostListeners.add(listener); return () => { self.#lostListeners.delete(listener); }; },
    } satisfies BusCore);
    this.instance = this.bus.create(this.core, Object.freeze({ keep: this.keep }));
  }

  /** The error to throw when the instance cannot go on: the loss, or a call made while no claim is held. */
  #live(): void {
    if (this.lost) throw this.lost;
    if (!this.holding) throw new FrameworkError("The bus called into core while its instance holds no claim: a bus calls core only between start() and stop(), or during deliver()");
  }

  /**
   * Claim and register, in one transaction (spec, "The claim", "Registration"). Succeeds when the claim is empty or
   * lapsed, or holds this process's run id while none of its instances holds it; raises the generation by one; writes
   * every handler's row by the registration table; moves `renamedFrom` rows; and marks this process's open
   * subscriptions as open under the new generation.
   */
  async claim(declared: readonly DeclaredHandler[]): Promise<void> {
    if (this.db.deliverer !== undefined && this.db.deliverer !== this) throw takenHere(this.db, this.db.deliverer);
    if (this.holding) throw takenHere(this.db, this);
    this.db.deliverer = this;
    try {
      const logs: string[] = [];
      const result = await this.layer.transaction(async (tx) => {
        const ops = operations(tx);
        const state = await ops.readDeliveryState();
        const claim = state.claim;
        if (claim && !lapsed(claim, state.now) && claim.runId !== RUN_ID) throw new DelivererTakenError(holderOf(this.db.name, claim, state.now));
        const generation = state.generation + 1;
        await ops.writeClaim({ runId: RUN_ID, generation, pid: PID, startedAt: STARTED_AT });
        const progress = new Map((await ops.readHandlerProgress()).map((row) => [row.name, row]));
        for (const { registered, renamedFrom } of declared) {
          let row = progress.get(registered.name);
          if (!row && renamedFrom !== undefined) {
            const former = progress.get(renamedFrom);
            if (former) {
              await ops.deleteHandlerProgress(former.name);
              progress.delete(former.name);
              row = { ...former, name: registered.name };
              logs.push(`Mesh: the handler ${JSON.stringify(registered.name)} takes over the progress of ${JSON.stringify(renamedFrom)} (renamedFrom), at position ${former.position}`);
            }
          }
          if (!row) {
            await ops.writeHandlerProgress({ name: registered.name, kind: registered.kind, position: state.highest, events: registered.events, generation });
            continue;
          }
          const added = registered.events.filter((name) => !row.events.includes(name));
          if (added.length > 0)
            logs.push(`Mesh: the handler ${JSON.stringify(registered.name)} now lists ${added.join(", ")}, handled from position ${row.position} on`);
          await ops.writeHandlerProgress({ name: registered.name, kind: registered.kind, position: row.position, events: registered.events, generation });
        }
        if (this.db.subscriptions.size > 0) {
          for (const row of await ops.readSubscriptionProgress())
            if (this.db.subscriptions.has(row.name)) await ops.writeSubscriptionProgress({ ...row, open: true, generation });
        }
        return { generation, deletedThrough: state.deletedThrough };
      });
      for (const line of logs) console.info(line);
      this.generation = result.generation;
      this.#readHead = result.deletedThrough;
      this.#handlers = new Map(declared.map((entry) => [entry.registered.name, entry]));
      this.#registered = Object.freeze(declared.map((entry) => entry.registered));
      this.holding = true;
      this.renewedAt = Date.now();
      this.#scheduleRenewal();
    } catch (error) {
      if (this.db.deliverer === this) this.db.deliverer = undefined;
      throw error;
    }
  }

  #scheduleRenewal(): void {
    clearTimeout(this.#renewal);
    this.#renewal = setTimeout(() => { void this.#renew(); }, timing.renewMs);
  }

  /** Renew the claim in one statement matching the run id and the generation; a blocked renewal waits until the lapse. */
  async #renew(): Promise<void> {
    if (!this.holding || this.lost) return;
    const generation = this.generation;
    try {
      const waitMs = Math.max(1, this.renewedAt + timing.lapseMs - Date.now());
      const renewed = await this.layer.transaction((tx) => operations(tx).renewClaim(RUN_ID, generation), { waitMs });
      if (!this.holding || this.generation !== generation) return;
      if (!renewed) { this.lose("a renewal of the claim updated no row, so another process has taken it over"); return; }
      this.renewedAt = Date.now();
      this.#scheduleRenewal();
    } catch (error) {
      if (!this.holding || this.generation !== generation) return;
      this.lose(error instanceof DatabaseBusyError
        ? "a renewal of the claim stayed blocked by another connection's lock until the claim lapsed"
        : `a renewal of the claim failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The claim is lost: the instance stops, its subscriptions end with the error, and the bus hears it once. */
  lose(reason: string): DelivererLostError {
    if (this.lost) return this.lost;
    const error = this.lost = new DelivererLostError(this.db.name, reason);
    clearTimeout(this.#renewal);
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
    clearTimeout(this.#renewal);
    const wasHolding = this.holding;
    this.holding = false;
    if (this.db.deliverer === this) this.db.deliverer = undefined;
    if (!wasHolding || this.lost) return;
    try {
      await this.layer.transaction((tx) => operations(tx).releaseClaim(RUN_ID, this.generation));
    } catch (error) {
      if (error instanceof DatabaseBusyError || quiet) return;
      throw error;
    }
  }

  /** In the running transaction: go on only while the claim is this instance's; otherwise the instance is lost. */
  async #checkGeneration(ops: DeliveryOperations): Promise<DeliveryState> {
    this.#live();
    const state = await ops.readDeliveryState();
    if (state.generation !== this.generation || state.claim?.runId !== RUN_ID) {
      throw this.lose(`another process claimed the database (generation ${state.generation}, this process claimed ${this.generation})`);
    }
    return state;
  }

  async read(after: number, limit: number): Promise<OutboxPage> {
    this.#live();
    const page = await rows(this.layer, after, limit);
    // A read from `after` means a cursor at `after` exists (a progress row or a subscription's): the bus passed it before.
    const last = page.rows.at(-1)?.position ?? after;
    if (last > this.#readHead) this.#readHead = last;
    return page;
  }

  async position(handler: RegisteredHandler): Promise<number> {
    this.#live();
    this.#entry(handler);
    const row = await this.layer.transaction(async (tx) => (await operations(tx).readHandlerProgress()).find((each) => each.name === handler.name));
    if (!row) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
    return row.position;
  }

  #entry(handler: RegisteredHandler): DeclaredHandler {
    const entry = this.#handlers.get(handler?.name);
    if (!entry || entry.registered !== handler)
      throw new FrameworkError(`runHandler was handed ${typeof handler?.name === "string" ? `the handler ${JSON.stringify(handler.name)}, which is not` : "a value that is not"} one core registered for this claim: a bus feeds the handlers of core.handlers`);
    return entry;
  }

  /**
   * In the running transaction: the generation check, then the handler's progress row; null when the row is at or past
   * `row` (handled already), else the row. Moving past a listed row the handler has not handled is a `FrameworkError`.
   */
  async #progress(ops: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<HandlerProgressRow | null> {
    await this.#checkGeneration(ops);
    const progress = (await ops.readHandlerProgress()).find((each) => each.name === handler.name);
    if (!progress) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
    if (row.position <= progress.position) return null;
    const skipped = await ops.firstOutboxRow(progress.position, row.position, handler.events, this.#declared);
    if (skipped !== null)
      throw new FrameworkError(`runHandler was asked to handle position ${row.position} for the handler ${JSON.stringify(handler.name)}, whose low-water position is ${progress.position}, while the row at ${skipped}, which it lists, is not handled: a bus hands each handler its rows in order and never skips one`);
    return progress;
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
   * handler transaction with the generation and progress checks and the progress write; a `listen` handler's body runs
   * outside any transaction between a check and a short progress write. A body that throws records nothing.
   */
  async runHandler(handler: RegisteredHandler, row: OutboxRow): Promise<void> {
    this.#live();
    const entry = this.#entry(handler);
    const eventClass = this.events.get(row.name);
    if (!eventClass) throw new EventUndeclaredError(row.name, row.position);
    if (!handler.events.includes(row.name))
      throw new FrameworkError(`runHandler was handed the ${row.name} at position ${row.position} for the handler ${JSON.stringify(handler.name)}, which does not list it: a bus hands a handler only the rows core.lists says it lists`);
    const record = recordOf(row, eventClass);
    const label = `the ${handler.kind} handler ${handler.name}`;
    const run = (context: ActionContext) => (entry.handler as Handler).run(record, { context });
    if (handler.kind === "process") {
      await handlerScope(this.binding, label, row.id, true, async () => {
        const progress = await this.layer.transaction(async (tx) => {
          const found = await this.#progress(operations(tx), handler, row);
          if (found) causedIn(tx, row.id);
          return found;
        });
        if (!progress) return;
        await run(this.#context(record));
        await this.layer.transaction((tx) => operations(tx).writeHandlerProgress({ ...progress, position: row.position }));
      });
      return;
    }
    const progress = await this.layer.transaction((tx) => this.#progress(operations(tx), handler, row));
    if (!progress) return;
    const context = this.#context(record);
    await handlerScope(this.binding, label, row.id, false, () => Promise.resolve(run(context)));
    await this.layer.transaction(async (tx) => {
      const ops = operations(tx);
      await this.#checkGeneration(ops);
      const current = (await ops.readHandlerProgress()).find((each) => each.name === handler.name);
      if (!current) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
      if (current.position < row.position) await ops.writeHandlerProgress({ ...current, position: row.position });
    });
  }

  /**
   * Core's retry path: `runHandler`, then again after each delay while the error is retryable. Resolves with null once
   * handled, else with the stop to report (at once for `retryable: false`). Busy and lost reject and are not a try.
   */
  async retry(handler: RegisteredHandler, row: OutboxRow, delays: readonly number[]): Promise<StoppedHandler | null> {
    if (!Array.isArray(delays) || delays.some((delay) => typeof delay !== "number" || !(delay >= 0)))
      throw new FrameworkError("core.retry takes the bus's retry schedule, an array of delays in milliseconds, each 0 or more");
    for (let attempt = 0; ; attempt++) {
      try {
        await this.runHandler(handler, row);
        return null;
      } catch (error) {
        if (error instanceof DatabaseBusyError || error instanceof DelivererLostError) throw error;
        if (this.lost) throw this.lost;
        if (!isRetryable(error) || attempt >= delays.length)
          return Object.freeze({ handler: handler.name, position: row.position, event: row.name, cause: error });
        await sleep(delays[attempt]!);
        if (this.lost) throw this.lost;
      }
    }
  }

  /**
   * Core's deletion pass (spec, "The deletion rule"), in batches, each one transaction that checks the generation; moves
   * this claim's handlers over rows they do not list and every subscription over rows its stored filter drops (never
   * over an undeclared row); and, under `keep: "until-delivered"`, deletes at or below the lowest of the read head and
   * every progress and subscription row. Reports orphans.
   */
  async deletionPass(): Promise<void> {
    this.#live();
    const declared = new Set(this.#declared);
    let cursor: number | null | undefined;
    let last: { state: DeliveryState; handlers: readonly HandlerProgressRow[]; subscriptions: readonly SubscriptionProgressRow[] } | undefined;
    for (let guard = 0; guard < 100_000; guard++) {
      if (cursor === undefined) {
        // Where moving starts: the lowest position among this claim's handlers and the subscriptions; nothing below moves.
        const snapshot = await this.layer.transaction(async (tx) => {
          const ops = operations(tx);
          const state = await this.#checkGeneration(ops);
          return { state, handlers: await ops.readHandlerProgress(), subscriptions: await ops.readSubscriptionProgress() };
        });
        const movers = [...snapshot.handlers.filter((row) => row.generation === this.generation), ...snapshot.subscriptions].map((row) => row.position);
        cursor = movers.length === 0 ? null : Math.max(snapshot.state.deletedThrough, Math.min(...movers));
      }
      const page = cursor === null || this.layer.readOutbox === undefined ? null : await this.layer.readOutbox(cursor, timing.batch);
      const from = cursor;
      const outcome = await this.layer.transaction(async (tx) => {
        const ops = operations(tx);
        const state = await this.#checkGeneration(ops);
        const handlers = await ops.readHandlerProgress();
        const subscriptions = await ops.readSubscriptionProgress();
        const end = page === null || from === null ? null : page.rows.length === timing.batch ? page.rows.at(-1)!.position : Math.max(page.highest, page.rows.at(-1)?.position ?? from);
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
          if (row.generation !== this.generation) return row;
          const position = moved(row.position, (outbox) => !row.events.includes(outbox.name));
          if (position === row.position) return row;
          const next = { ...row, position };
          await ops.writeHandlerProgress(next);
          return next;
        }));
        const subscriptionRows = await Promise.all(subscriptions.map(async (row) => {
          const position = moved(row.position, (outbox) => !matches(row.filter, outbox));
          if (position === row.position) return row;
          const next = { ...row, position };
          await ops.writeSubscriptionProgress(next);
          return next;
        }));
        let deleted = 0;
        let capped = false;
        if (this.keep === "until-delivered") {
          const bound = Math.min(this.#readHead, ...handlerRows.map((row) => row.position), ...subscriptionRows.map((row) => row.position));
          const through = Math.min(bound, state.deletedThrough + timing.batch);
          capped = through < bound;
          if (through > state.deletedThrough) deleted = await tx.deleteOutboxThrough!(through);
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
      if (row.generation === this.generation || !due(`handler:${row.name}`)) continue;
      console.warn(`Mesh: the handler ${JSON.stringify(row.name)} is not registered by this deliverer, and its progress row, at position ${row.position}, holds ${held(state, row.position)} outbox rows. If it was removed or renamed without renamedFrom, drop it with \`mesh events forget ${row.name}\` or forgetHandler(${JSON.stringify(row.name)})`);
    }
    if (this.keep !== "until-delivered") return;
    for (const row of subscriptions) {
      const open = this.db.subscriptions.get(row.name);
      if (open) {
        if (!open.lagging(now) || !due(`subscription:${row.name}`)) continue;
        console.warn(`Mesh: the subscription ${JSON.stringify(row.name)} has rows handed to its callback above its acknowledged position, ${row.position}, and has not acknowledged for more than an hour; it holds ${held(state, row.position)} outbox rows. Call ack(position) once a row is processed`);
      } else if (state.now.getTime() - row.seenAt.getTime() > timing.orphanAgeMs && due(`subscription:${row.name}`)) {
        console.warn(`Mesh: the subscription ${JSON.stringify(row.name)} has not been open for more than an hour, and its row, acknowledged at position ${row.position}, holds ${held(state, row.position)} outbox rows. If its client is not coming back, drop it with \`mesh events forget ${row.name}\` or forgetSubscription(${JSON.stringify(row.name)})`);
      }
    }
  }
}

/** Whether a retry of a handler that threw `error` makes sense: its own `retryable`; true for an error that sets none. */
export function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null | undefined)?.retryable !== false;
}

/** True when the stored filter keeps the row. */
function matches(filter: SubscriptionFilter, row: OutboxRow): boolean {
  if (filter.names !== undefined && !filter.names.includes(row.name)) return false;
  if (filter.entity !== undefined && row.entity !== filter.entity) return false;
  if (filter.key !== undefined && !sameKey(row.key, filter.key)) return false;
  return true;
}

/** What a binding needs to deliver, checked: its layer, event classes, configuration with a bus, and the events module. */
async function prepare(binding: Binding, what: string) {
  const { layer, events, config } = bindingParts(binding);
  if (config?.bus === undefined)
    throw new FrameworkError(`${what} was called on a binding with no event bus: configure events: { bus: localBus() } in mesh.config.ts, or pass it to bind(layer, { events })`);
  if (insideTransaction(binding)) throw new FrameworkError(`${what} was called inside a transaction: delivery runs its own transactions, so call it outside any`);
  checkedBus(config.bus);
  const module = await loadEvents(config);
  return { layer, events, config, module };
}

/** `binding.deliver()`: one round (spec, "Ways to run"). */
export async function deliverRound(binding: Binding): Promise<void> {
  const delivery = deliveryOf(binding);
  if (delivery.started) throw new FrameworkError("deliver() was called on a binding whose delivery is started: startDelivery() (or connect()) delivers on its own; stop it first");
  const { layer, events, config, module } = await prepare(binding, "deliver()");
  const db = databases.get(layer);
  if (delivery.round || db.deliverer) throw takenHere(db, db.deliverer);
  const round = (async () => {
    const declared = declaredHandlers(module, checkedBus(config.bus), events);
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
  const { layer, events, config, module } = await prepare(binding, "startDelivery()");
  const db = databases.get(layer);
  if (delivery.round || db.deliverer) throw takenHere(db, db.deliverer);
  const declared = declaredHandlers(module, checkedBus(config.bus), events);
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

function filterOf(query: SubscribeQuery, events: ReadonlyMap<string, EventClass>): SubscriptionFilter {
  const { names, entity, key } = query;
  if (names !== undefined) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
      throw new FrameworkError("subscribe: names must be an array of event FQNs, such as [Mesh.fqnOf(InvoicePaid)]");
    for (const name of names)
      if (!events.has(name)) throw new FrameworkError(`subscribe: names lists ${JSON.stringify(name)}, which is not a declared event; the project declares ${[...events.keys()].join(", ") || "none"}`);
  }
  if (entity !== undefined && typeof entity !== "string") throw new FrameworkError("subscribe: entity must be an entity's FQN, such as \"billing.Invoice\"");
  if (key !== undefined && (typeof key !== "object" || key === null || Array.isArray(key))) throw new FrameworkError("subscribe: key must be a record's key, such as { id }");
  return JSON.parse(JSON.stringify({ ...(names ? { names: [...names].sort() } : {}), ...(entity !== undefined ? { entity } : {}), ...(key !== undefined ? { key } : {}) })) as SubscriptionFilter;
}

/** Two stored filters, compared as JSON with sorted keys. */
function sameFilter(a: SubscriptionFilter, b: SubscriptionFilter): boolean {
  return canonical(a) === canonical(b);
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
    readonly filter: SubscriptionFilter, position: number, readonly callback: (event: EventRecord) => unknown) {
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
      if (!eventClass) { this.end(new EventUndeclaredError(row.name, row.position)); return; }
      this.cursor = row.position;
      if (!matches(this.filter, row)) continue;
      this.#queue.push(recordOf(row, eventClass));
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
      const ops = operations(tx);
      const state = await ops.readDeliveryState();
      const row = (await ops.readSubscriptionProgress()).find((each) => each.name === this.name);
      if (!row) throw new FrameworkError(`The subscription ${JSON.stringify(this.name)} has no row: it was forgotten while open`);
      if (row.generation !== state.generation) throw new DelivererLostError(this.db.name, `another process claimed the database (generation ${state.generation}) since the subscription ${JSON.stringify(this.name)} opened`);
      if (position <= row.position) return row.position;
      await ops.writeSubscriptionProgress({ ...row, position });
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
    this.#queue.length = 0;
    if (this.db.subscriptions.get(this.name) === this) this.db.subscriptions.delete(this.name);
    // A lost claim leaves the rows to the process that took it over (its generation already reads them as closed), and
    // the loss is often noticed inside a transaction that is about to roll back, where a write would join it.
    if (error instanceof DelivererLostError) { this.#closing = Promise.resolve(); this.#settle(error); return; }
    this.#closing = this.layer.transaction(async (tx) => {
      const ops = operations(tx);
      const row = (await ops.readSubscriptionProgress()).find((each) => each.name === this.name);
      // Closing writes seenAt, the database's now (left out), from which a closed row's age is measured.
      if (row?.open) await ops.writeSubscriptionProgress({ name: row.name, position: row.position, filter: row.filter, open: false, generation: row.generation });
    }).catch((thrown: unknown) => {
      console.warn(`Mesh: the subscription ${JSON.stringify(this.name)} ended, and its row could not be marked closed (it reads as open until the claim's generation moves on):`, thrown);
    }).then(() => this.#settle(error ?? null));
  }
}

/** `subscribe` of `#mesh` (spec, "`subscribe`"): open (or reopen) the subscription `query.name` on `binding`'s database. */
export async function subscribe(binding: Binding, query: SubscribeQuery, callback: (event: EventRecord) => unknown): Promise<Subscription> {
  const { layer, events, config } = bindingParts(binding);
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
  const filter = filterOf(query, events);
  const db = databases.get(layer);
  if (db.subscriptions.has(name))
    throw new FrameworkError(`A subscription named ${JSON.stringify(name)} is open in this process already: two readers acknowledging under one row would pass each other's rows`);
  const placeholder = new OpenSubscription(db, layer, events, name, filter, 0, callback);
  db.subscriptions.set(name, placeholder);
  try {
    const position = await layer.transaction(async (tx) => {
      const ops = operations(tx);
      const state = await ops.readDeliveryState();
      const row = (await ops.readSubscriptionProgress()).find((each) => each.name === name);
      let start: number;
      if (row) {
        if (!sameFilter(row.filter, filter))
          throw new FrameworkError(`The subscription ${JSON.stringify(name)} was opened with the filter ${canonical(filter)}, and its row was reached with ${canonical(row.filter)}: an acknowledged position means something only under its filter. Forget it (forgetSubscription(${JSON.stringify(name)})), then open it with the new filter`);
        start = row.position;
      } else {
        start = after ?? state.highest;
        if (start < state.deletedThrough) throw new EventsDeletedError(start, state.deletedThrough + 1);
        if (start > state.highest) throw new CursorAheadError(start, state.highest);
      }
      const generation = db.deliverer?.holding ? db.deliverer.generation : state.generation;
      await ops.writeSubscriptionProgress({ name, position: start, filter, open: true, generation });
      return start;
    });
    placeholder.cursor = position;
    const subscription = new OpenSubscription(db, layer, events, name, filter, position, callback);
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
  const { layer } = bindingParts(binding);
  if (typeof name !== "string" || name === "") throw new FrameworkError(`forgetHandler takes a handler's name, and was given ${describe(name)}`);
  await layer.transaction(async (tx) => {
    const ops = operations(tx);
    const state = await ops.readDeliveryState();
    const row = (await ops.readHandlerProgress()).find((each) => each.name === name);
    if (!row) throw new FrameworkError(`forgetHandler: no handler named ${JSON.stringify(name)} has a progress row`);
    if (liveUnder(state, row.generation))
      throw new FrameworkError(`forgetHandler: the handler ${JSON.stringify(name)} is registered by the live deliverer, so its progress is not dropped. Remove it from the events module and restart first`);
    await ops.deleteHandlerProgress(name);
  });
}

/** `forgetSubscription(name)` of `#mesh`: drop a subscription's row; refuses one that is open in this process. */
export async function forgetSubscription(binding: Binding, name: string): Promise<void> {
  const { layer } = bindingParts(binding);
  if (typeof name !== "string" || name === "") throw new FrameworkError(`forgetSubscription takes a subscription's name, and was given ${describe(name)}`);
  if (databases.get(layer).subscriptions.has(name))
    throw new FrameworkError(`forgetSubscription: the subscription ${JSON.stringify(name)} is open in this process; close it first`);
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
 * refused, naming both.
 */
export async function forgetByName(layer: DataLayer, name: string): Promise<Forgotten> {
  if (typeof name !== "string" || name === "") throw new FrameworkError("mesh events forget takes a handler's or a subscription's name");
  return layer.transaction(async (tx) => {
    const ops = operations(tx);
    const state = await ops.readDeliveryState();
    const handler = (await ops.readHandlerProgress()).find((each) => each.name === name);
    const subscription = (await ops.readSubscriptionProgress()).find((each) => each.name === name);
    if (handler && subscription)
      throw new FrameworkError(`The name ${JSON.stringify(name)} is held by a handler's progress row and by a subscription's row: forget each from the application, with forgetHandler(${JSON.stringify(name)}) or forgetSubscription(${JSON.stringify(name)})`);
    if (handler) {
      if (liveUnder(state, handler.generation))
        throw new FrameworkError(`The handler ${JSON.stringify(name)} is registered by the live deliverer (generation ${handler.generation}), so its progress is not dropped. Remove it from the events module and restart the deliverer first`);
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
