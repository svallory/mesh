import type { EventBus, RegisteredHandler } from "./bus.ts";
import type {
  DataLayer, DataOperations, DeliveryOperations, DeliveryProcessRow, DeliveryState, HandlerLeaseRow, HandlerProgressRow, LockedDeliveryState,
  MultiProcessOperations, OutboxRow, SubscriptionFilter, SubscriptionOwnerRow, SubscriptionProgressRow,
} from "./data-layer.ts";
import {
  NIL_RUN_ID, PID, RENEW_RETRY_MS, RUN_ID, STARTED_AT, handlerStart, holderOf, lapsed, moveFailures, operations, registrationOf, renamedFilter, timing,
  type ClaimStrategy, type DatabaseState, type DeclaredHandler, type Deliverer, type Forgotten,
} from "./deliverer.ts";
import { NO_RENAMES } from "./stored-names.ts";
import {
  CursorAheadError, DatabaseBusyError, DelivererLostError, DelivererTakenError, EventUndeclaredError, EventsDeletedError, FrameworkError, HandlerLostError,
} from "./errors.ts";

/**
 * Delivery from several processes (multi mode; design `notes/architecture/m9-multi-process-design.md`, rules M, P, L, R,
 * S and K): entered when the configured bus declares `multi-process`. There is no single deliverer: each delivering
 * process writes its row in `mesh_delivery_process`, renewed every 5 s; the claim columns of `mesh_outbox_state` hold the
 * nil claim while any such row lives, so a single-mode process meets `MESH_DELIVERER_TAKEN`; and each handler is held by
 * one process at a time through its lease, the progress row's `run_id` and `generation`, which every handler transaction
 * checks under the row's lock. A handler's `events` column holds its registered union U(H): every event any build listed
 * for it since the last adoption; a holder never passes a row of an event in U(H) its own list lacks, and yields the
 * handler instead (`MESH_HANDLER_LOST`, reason `"pending"`), so a build that lists it takes the handler over.
 */

/** The events this build and the live process rows `others` declare, sorted: what a contributed kind's `firstRow` counts as declared. */
function knownDeclared(own: readonly string[], others: readonly DeliveryProcessRow[]): readonly string[] {
  return [...new Set([...own, ...others.flatMap((row) => row.declared)])].sort();
}

/** True when `bus` declares `multi-process`: the binding delivers in multi mode (rule M1). */
export function isMultiProcess(bus: EventBus | undefined): boolean {
  return bus?.manifest?.capabilities?.includes("multi-process") === true;
}

const MULTI_OPERATIONS = [
  "lockDeliveryState", "writeKeep", "lockHandlerProgress", "readHandlerLeases", "writeHandlerLease", "moveHandler", "moveSubscription",
  "readProcesses", "writeProcess", "renewProcess", "deleteProcess", "readSubscriptionOwners", "writeSubscriptionOwner",
] as const satisfies readonly (keyof MultiProcessOperations)[];

type MultiOps = DeliveryOperations & MultiProcessOperations;

/** The delivery operations of multi mode; a `FrameworkError` naming the first one the data adapter lacks (rule M4). */
export function multiOperations(tx: DataOperations | DeliveryOperations): MultiOps {
  const delivery = operations(tx as DataOperations);
  for (const name of MULTI_OPERATIONS)
    if (typeof (delivery as Partial<MultiOps>)[name] !== "function")
      throw new FrameworkError(`The data layer's transactions have no ${name}: delivering events from several processes needs a data adapter with the multi-process delivery operations (MultiProcessOperations in @meshfw/runtime)`);
  return delivery as MultiOps;
}

/** True when a process row has not been renewed for the lapse time, by the database's clock (rule P3). */
function expired(row: DeliveryProcessRow, now: Date): boolean {
  return now.getTime() - row.renewedAt.getTime() >= timing.lapseMs;
}

const live = (rows: readonly DeliveryProcessRow[], now: Date) => rows.filter((row) => !expired(row, now));
const who = (row: { readonly pid: number | null; readonly host: string | null }) => `pid ${row.pid ?? "unknown"} on host ${row.host ?? "unknown"}`;
/** A registered union as a key, to tell whether it changed since a yield. */
const keyOf = (events: readonly string[]) => JSON.stringify([...events].sort());
const union = (a: readonly string[], b: readonly string[]) => Object.freeze([...new Set([...a, ...b])].sort());

/** `MESH_HANDLER_LOST`, reason `"taken"` (rules L3, L7). */
function takenError(handler: string, position: number, generation?: number, held?: number): HandlerLostError {
  const at = position > 0 ? ` at position ${position}` : "";
  return new HandlerLostError(handler, "taken", position, generation !== undefined && held !== undefined
    ? `The handler ${JSON.stringify(handler)} was taken over by another process (generation ${generation}, this process held ${held})${at}; this process stops delivering it`
    : `The handler ${JSON.stringify(handler)} is not held by this process${at}: another process delivers it, or none does until a process takes it over; this process does not deliver it now`);
}

/** `MESH_HANDLER_LOST`, reason `"pending"` (rule R2(b)). */
function pendingError(handler: string, position: number, event: string): HandlerLostError {
  return new HandlerLostError(handler, "pending", position,
    `The handler ${JSON.stringify(handler)} is not delivered by this process from position ${position}: ${event} there is listed by another build of the handler `
      + `(registered since the last adoption), and this build does not list it. A process whose build lists it will take the handler over; `
      + `if no build will, drop it with \`mesh events adopt ${handler} --drop ${event}\``);
}

/** What the skip check found below the row the bus handed: an undeclared row whose name only an outbox read can give. */
class UndeclaredBelow extends Error {
  constructor(readonly position: number) { super(`an outbox row at position ${position} that no live build declares`); }
}

/**
 * Multi mode's claim strategy: process row, nil claim, handler leases (spec rules M3 to K5 of the design). One instance
 * per `Deliverer`; a `deliver()` round registers again and releases at its end.
 */
export class MultiClaim implements ClaimStrategy {
  /** Subscription rows of multi mode carry generation 0; the owner's run id fences them instead. */
  readonly generation = 0;
  /** Every handler this instance registers, by name, in name order. */
  #registered = new Map<string, RegisteredHandler>();
  #declared = new Map<string, DeclaredHandler>();
  /** The held set: handler name to the lease generation this process took. */
  readonly #held = new Map<string, number>();
  /** Handlers this process yielded, with the union it yielded under: not taken again until it changes (rule R2). */
  readonly #yielded = new Map<string, string>();
  /** Handlers whose fence just yielded, with the generation, so `afterReject` clears the lease. */
  readonly #yielding = new Map<string, number>();
  /** The snapshot of each handler's registered union (rule R3). */
  readonly #unions = new Map<string, readonly string[]>();
  /** The known declared set: this build's events and those of every live process row (rule P1). */
  #known: ReadonlySet<string> = new Set();
  /** The live process rows the last deletion batch read, for its orphan report. */
  #passProcesses: readonly DeliveryProcessRow[] = [];
  /** Handlers whose take transaction is running, so overlapping take loops never take one lease twice. */
  readonly #taking = new Set<string>();
  /** The live process rows of the last read that refreshed `#known`: at registration, each tick, a fence, a pass. */
  #liveRows: readonly DeliveryProcessRow[] = [];
  #passKnown: ReadonlySet<string> = new Set();
  /** `renamedFrom` moves that wait until no live process registers the former name: new name to former (rule R7). */
  readonly #renames = new Map<string, string>();
  /** Handlers live processes register and none holds, by when a deletion pass of this instance first saw them so (rule K6). */
  readonly #unheld = new Map<string, number>();
  #handlers: readonly RegisteredHandler[] | undefined;
  #renewal: ReturnType<typeof setTimeout> | undefined;
  #halted = true;

  constructor(readonly deliverer: Deliverer) {}

  /** The known declared set of the live process rows just read; the rows are kept for the declarer hint (rule S4). */
  #knownOf(rows: readonly DeliveryProcessRow[]): ReadonlySet<string> {
    this.#liveRows = rows;
    return new Set([...this.deliverer.declared, ...rows.flatMap((row) => row.declared)]);
  }

  /**
   * A stored union read through the rename map (`events.renamed`): an event a registration listed under a former FQN is
   * the event it now is. A registration writes the union back with the new names.
   */
  #declaredList(events: readonly string[]): readonly string[] {
    return this.deliverer.renamed.size === 0 ? events : union(events.map((name) => this.deliverer.declaredName(name)), []);
  }

  #drop(name: string): void {
    if (this.#held.delete(name)) this.#handlers = undefined;
  }

  /**
   * Register in one transaction (rules M3, P1, P3, P5, K3, R1, R7): a live single-mode claim is `MESH_DELIVERER_TAKEN`;
   * the nil claim is written at the claim's generation; lapsed process rows are deleted and this process's row written;
   * each handler's union grows by its list (a new handler starts at the highest position, with no holder). Then takes
   * every free lease, one transaction each.
   */
  async register(declared: readonly DeclaredHandler[]): Promise<number> {
    const { layer, db, keep } = this.deliverer;
    this.#halted = false;
    this.#held.clear();
    this.#yielded.clear();
    this.#yielding.clear();
    this.#renames.clear();
    this.#handlers = undefined;
    this.#registered = new Map(declared.map((entry) => [entry.registered.name, entry.registered]));
    this.#declared = new Map(declared.map((entry) => [entry.registered.name, entry]));
    const logs: string[] = [];
    const handlers = Object.fromEntries(declared.map((entry) => [entry.registered.name, entry.registered.events]));
    const result = await layer.transaction(async (tx) => {
      const ops = multiOperations(tx);
      const state = await ops.lockDeliveryState();
      const claim = state.claim;
      if (claim && !lapsed(claim, state.now) && claim.runId !== NIL_RUN_ID && claim.runId !== RUN_ID) throw new DelivererTakenError(holderOf(db.name, claim, state.now));
      await ops.writeClaim({ runId: NIL_RUN_ID, generation: state.generation, host: null, pid: null, startedAt: null });
      if (keep === "all" && state.keep !== "all") await ops.writeKeep("all");
      const others: DeliveryProcessRow[] = [];
      for (const row of await ops.readProcesses()) {
        if (row.runId === RUN_ID) continue;
        if (expired(row, state.now)) await ops.deleteProcess(row.runId);
        else others.push(row);
      }
      await ops.writeProcess({ runId: RUN_ID, pid: PID, startedAt: STARTED_AT, keep, handlers, declared: this.deliverer.declared });
      const renames = new Map<string, string>();
      const unions = new Map<string, readonly string[]>();
      const registration = registrationOf(ops, state, keep === "all" ? "all" : state.keep ?? keep, knownDeclared(this.deliverer.declared, others), this.deliverer.renamed);
      for (const entry of declared) {
        const name = entry.registered.name;
        const own = await ops.lockHandlerProgress(name);
        const former = !own && entry.renamedFrom !== undefined ? entry.renamedFrom : undefined;
        if (former !== undefined && others.some((row) => Object.hasOwn(row.handlers, former))) {
          // A live process of another build still registers the former name: its holder keeps the row until it stops.
          renames.set(name, former);
          continue;
        }
        const formerRow = former === undefined ? undefined : await ops.lockHandlerProgress(former);
        const progress = new Map<string, HandlerProgressRow>();
        if (own) progress.set(name, own);
        if (former !== undefined && formerRow) progress.set(former, formerRow);
        const start = await handlerStart(entry, progress, registration, this.deliverer.renamed);
        logs.push(...start.logs);
        if (start.former !== undefined) {
          await ops.deleteHandlerProgress(start.former);
          await moveFailures(tx, start.former, name);
        }
        // The union only grows here; a row taken over by renamedFrom starts from this build's list, since no live build lists the old one.
        const events = own ? union(this.#declaredList(own.events), start.row.events) : start.row.events;
        await ops.writeHandlerLease({ ...start.row, events, generation: (own ?? formerRow)?.generation ?? 0, runId: own?.runId ?? null });
        unions.set(name, events);
      }
      return { deletedThrough: state.deletedThrough, others, renames, unions };
    });
    for (const line of logs) console.info(line);
    for (const [name, former] of result.renames) this.#renames.set(name, former);
    for (const [name, events] of result.unions) this.#unions.set(name, events);
    this.#known = this.#knownOf(result.others);
    this.#schedule();
    await this.#takeLeases();
    return result.deletedThrough;
  }

  #schedule(): void {
    clearTimeout(this.#renewal);
    this.#renewal = setTimeout(() => { void this.tick(); }, timing.renewMs);
  }

  halt(): void {
    this.#halted = true;
    clearTimeout(this.#renewal);
  }

  /** True while this instance may still change its held set. */
  #active(): boolean {
    return !this.#halted && !this.deliverer.lost;
  }

  /**
   * Take every lease this process may take (rule L2), one transaction per handler: a handler it registers, not held, not
   * waiting for a rename, not yielded under the union it has now, whose row names no holder, a lapsed or absent process
   * row, or this process's own run id. A take raises the row's generation by one. `only` limits it to one handler.
   */
  async #takeLeases(only?: string): Promise<void> {
    for (const name of this.#registered.keys()) {
      if (only !== undefined && name !== only) continue;
      if (!this.#active()) return;
      // A take of this handler already running (register's, a tick's, resumeHandler's) is not repeated: two would both
      // raise the generation, and the first one's held generation would no longer match the row.
      if (this.#held.has(name) || this.#renames.has(name) || this.#taking.has(name)) continue;
      let taken: number | undefined;
      this.#taking.add(name);
      try {
        taken = await this.deliverer.layer.transaction(async (tx) => {
          const ops = multiOperations(tx);
          const state = await ops.readDeliveryState();
          const row = await ops.lockHandlerProgress(name);
          if (!row) return undefined;
          this.#unions.set(name, this.#declaredList(row.events));
          const mark = this.#yielded.get(name);
          if (mark !== undefined) {
            if (mark === keyOf(row.events)) return undefined;
            this.#yielded.delete(name);
          }
          if (row.runId !== null && row.runId !== RUN_ID) {
            const holder = (await ops.readProcesses()).find((each) => each.runId === row.runId);
            if (holder && !expired(holder, state.now)) return undefined;
          }
          if (!this.#active()) return undefined;
          const generation = row.generation + 1;
          await ops.writeHandlerLease({ ...row, runId: RUN_ID, generation });
          return generation;
        });
        if (taken !== undefined && this.#active()) {
          this.#held.set(name, taken);
          this.#handlers = undefined;
        }
      } catch (error) {
        // A lock wait ends this round of takes; the next tick tries again.
        if (error instanceof DatabaseBusyError) return;
        throw error;
      } finally {
        this.#taking.delete(name);
      }
    }
  }

  /**
   * One renewal (rules P2, P5, L6, R7): renew this process's row in one statement that refuses a lapsed one, retrying a
   * transient error that is not a lock wait until the lapse, as single mode renews the claim; then, in one transaction
   * that locks `mesh_outbox_state`, renew or rewrite the nil claim (a live claim of another run id loses the instance),
   * drop the leases no longer held, clear the yielded ones that still name this process, refresh the snapshots; then move
   * the renames that no live process blocks any more, and take the free leases.
   */
  async tick(): Promise<void> {
    const deliverer = this.deliverer;
    if (!deliverer.holding || !this.#active()) return;
    const deadline = deliverer.renewedAt + timing.lapseMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const waitMs = Math.max(1, deadline - Date.now());
        const renewed = await deliverer.layer.transaction((tx) => multiOperations(tx).renewProcess(RUN_ID, timing.lapseMs), { waitMs });
        if (!deliverer.holding || !this.#active()) return;
        if (!renewed) { deliverer.lose("a renewal of this process's row updated no row, so it lapsed and its handlers may have been taken over"); return; }
        deliverer.renewedAt = Date.now();
        break;
      } catch (error) {
        if (!deliverer.holding || !this.#active()) return;
        if (!(error instanceof DatabaseBusyError)) {
          deliverer.lose(`a renewal of this process's row failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (error.reason === "locked" || error.reason === "lock-timeout") {
          deliverer.lose("a renewal of this process's row stayed blocked by another connection's lock until the row lapsed");
          return;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          deliverer.lose(`a renewal of this process's row kept failing (${error.reason}) until the row lapsed`);
          return;
        }
        if (attempt > 0) await new Promise<void>((resolve) => { this.#renewal = setTimeout(resolve, Math.min(RENEW_RETRY_MS, left)); });
        if (!deliverer.holding || !this.#active()) return;
      }
    }
    try {
      await this.#afterRenewal();
      for (const [name, former] of [...this.#renames]) await this.#moveRenamed(name, former);
      await this.#takeLeases();
    } catch (error) {
      if (!this.#active()) return;
      // A lock wait here is not a miss of the renewal itself: the next tick does it again.
      if (!(error instanceof DatabaseBusyError)) {
        deliverer.lose(`a renewal of this process's leases failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (deliverer.holding && this.#active()) this.#schedule();
  }

  async #afterRenewal(): Promise<void> {
    await this.deliverer.layer.transaction(async (tx) => {
      const ops = multiOperations(tx);
      const state = await ops.lockDeliveryState();
      this.#nilClaim(state);
      if (state.claim?.runId === NIL_RUN_ID) await ops.renewClaim(NIL_RUN_ID, state.generation);
      else await ops.writeClaim({ runId: NIL_RUN_ID, generation: state.generation, host: null, pid: null, startedAt: null });
      this.#known = this.#knownOf(live(await ops.readProcesses(), state.now));
      const leases = new Map((await ops.readHandlerLeases()).map((lease) => [lease.name, lease]));
      for (const name of [...this.#held.keys()]) {
        const lease = leases.get(name);
        if (!lease || lease.runId !== RUN_ID || lease.generation !== this.#held.get(name)) this.#drop(name);
      }
      for (const [name, lease] of leases) {
        if (!this.#registered.has(name)) continue;
        this.#unions.set(name, this.#declaredList(lease.events));
        const mark = this.#yielded.get(name);
        if (mark !== undefined && mark !== keyOf(lease.events)) this.#yielded.delete(name);
        // A yield whose clearing transaction failed: the row still names this process (rule L6).
        if (this.#yielded.has(name) && lease.runId === RUN_ID && !this.#held.has(name)) {
          const locked = await ops.lockHandlerProgress(name);
          if (locked?.runId === RUN_ID) await ops.writeHandlerLease({ ...locked, runId: null });
        }
      }
    });
  }

  /** The nil claim check of a renewal: a live claim of another run id means a single-mode process claims the database. */
  #nilClaim(state: DeliveryState): void {
    const claim = state.claim;
    if (claim && claim.runId !== NIL_RUN_ID && !lapsed(claim, state.now) && claim.runId !== RUN_ID)
      throw this.deliverer.lose(`the database is now claimed by a single-mode process (${who(claim)}), so this process stops delivering`);
  }

  /** A `renamedFrom` move that waited for the former name's live registrations to end (rule R7). */
  async #moveRenamed(name: string, former: string): Promise<void> {
    const entry = this.#declared.get(name);
    if (!entry) return;
    const logs = await this.deliverer.layer.transaction(async (tx) => {
      const ops = multiOperations(tx);
      const state = await ops.lockDeliveryState();
      const others = live(await ops.readProcesses(), state.now).filter((row) => row.runId !== RUN_ID);
      if (others.some((row) => Object.hasOwn(row.handlers, former))) return undefined;
      const own = await ops.lockHandlerProgress(name);
      const formerRow = own ? undefined : await ops.lockHandlerProgress(former);
      const progress = new Map<string, HandlerProgressRow>();
      if (own) progress.set(name, own);
      if (formerRow) progress.set(former, formerRow);
      const registration = registrationOf(ops, state, this.deliverer.keep === "all" ? "all" : state.keep ?? this.deliverer.keep, knownDeclared(this.deliverer.declared, others), this.deliverer.renamed);
      let start: Awaited<ReturnType<typeof handlerStart>>;
      try {
        start = await handlerStart(entry, progress, registration, this.deliverer.renamed);
      } catch (error) {
        // connect() resolved long ago, so a refusal here (the handler's kind refusing the adopt, an invalid start or stored
        // kind) has no start to reject: it rolls this transaction back and stops delivery, naming the move (ADR-0094).
        const message = error instanceof Error ? error.message : String(error);
        throw this.deliverer.lose(`the renamedFrom move of the handler ${JSON.stringify(name)} from ${JSON.stringify(former)}, made once no live process registered ${JSON.stringify(former)}, was refused: ${message}`);
      }
      if (start.former !== undefined) {
        await ops.deleteHandlerProgress(start.former);
        await moveFailures(tx, start.former, name);
      }
      const events = own ? union(this.#declaredList(own.events), start.row.events) : start.row.events;
      await ops.writeHandlerLease({ ...start.row, events, generation: (own ?? formerRow)?.generation ?? 0, runId: own?.runId ?? null });
      this.#unions.set(name, events);
      return start.logs;
    });
    if (logs === undefined) return;
    this.#renames.delete(name);
    for (const line of logs) console.info(line);
  }

  handlers(): readonly RegisteredHandler[] {
    return this.#handlers ??= Object.freeze([...this.#registered.values()].filter((handler) => this.#held.has(handler.name)));
  }

  /**
   * From the snapshot (rule R3): true for a row the handler lists, a row of an event in its union (the fence yields), and
   * a row no known build declares (the fence stops); false for a row of any other event, which the position passes.
   */
  lists(handler: RegisteredHandler, row: OutboxRow): boolean {
    if (handler.events.includes(row.name)) return true;
    if ((this.#unions.get(handler.name) ?? handler.events).includes(row.name)) return true;
    return !this.deliverer.events.has(row.name) && !this.#known.has(row.name);
  }

  /** A handler core registered and this process does not hold now is `MESH_HANDLER_LOST` (rule L7). */
  enter(handler: RegisteredHandler, row: OutboxRow | undefined): void {
    if (!this.#held.has(handler.name)) throw takenError(handler.name, row?.position ?? 0);
  }

  /** The lease check of a handler transaction (rules L3, L4): the nil claim, then the locked row's run id and generation. */
  async #lease(ops: MultiOps, handler: RegisteredHandler, position: number): Promise<{ lease: HandlerLeaseRow; state: DeliveryState }> {
    this.deliverer.live();
    const state = await ops.readDeliveryState();
    if (state.claim?.runId !== NIL_RUN_ID) {
      const claim = state.claim;
      throw this.deliverer.lose(claim && !lapsed(claim, state.now)
        ? `the database is now claimed by a single-mode process (${who(claim)}), so this process stops delivering`
        : "the database's claim is no longer the one of several processes, so this process stops delivering");
    }
    const lease = await ops.lockHandlerProgress(handler.name);
    if (!lease) throw new FrameworkError(`The handler ${JSON.stringify(handler.name)} has no progress row: it was forgotten while registered`);
    const held = this.#held.get(handler.name);
    if (lease.runId !== RUN_ID || lease.generation !== held) {
      this.#drop(handler.name);
      throw takenError(handler.name, position, lease.generation, held);
    }
    this.#unions.set(handler.name, this.#declaredList(lease.events));
    return { lease, state };
  }

  async #knownIn(ops: MultiOps, now: Date): Promise<ReadonlySet<string>> {
    return this.#known = this.#knownOf(live(await ops.readProcesses(), now));
  }

  /** Yield the handler at a pending row (rule R2(b)): the lease is cleared after the transaction rolls back. */
  #yield(handler: RegisteredHandler, lease: HandlerLeaseRow, position: number, event: string): HandlerLostError {
    this.#drop(handler.name);
    this.#yielded.set(handler.name, keyOf(lease.events));
    this.#yielding.set(handler.name, lease.generation);
    return pendingError(handler.name, position, event);
  }

  /**
   * The fence of a handler transaction, judged under the lock (rules L3, R2, R4): the lease, then the row's class (listed;
   * pending, a yield; another build's or not this handler's, nothing recorded; declared by no live build, stopped), then,
   * for a listed row above the position, the skip check against the union and the known declared set.
   */
  async fenceHandler(delivery: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<HandlerProgressRow | null> {
    const ops = multiOperations(delivery);
    const { lease, state } = await this.#lease(ops, handler, row.position);
    const listed = handler.events.includes(row.name);
    // The row's name is read through the rename map already; the stored union is read the same way, and the SQL below
    // (over stored names) takes each name with the former FQNs the map reads as it.
    const unionNow = this.#declaredList(lease.events);
    const stored = (names: readonly string[]) => this.deliverer.storedNames(names);
    const inUnion = unionNow.includes(row.name);
    if (!listed) {
      if (!inUnion && !this.deliverer.events.has(row.name) && !(await this.#knownIn(ops, state.now)).has(row.name))
        throw new EventUndeclaredError(row.name, row.position);
      if (row.position <= lease.position) return null;
      if (inUnion) throw this.#yield(handler, lease, row.position, row.name);
      return null;
    }
    if (row.position <= lease.position) return null;
    const known = await this.#knownIn(ops, state.now);
    const blocked = await ops.firstOutboxRow(lease.position, row.position, stored(unionNow), stored([...known]));
    if (blocked === null) return lease;
    const either = stored([...new Set([...known, ...unionNow])]);
    if ((await ops.firstOutboxRow(blocked - 1, blocked + 1, [], either)) !== null) throw new UndeclaredBelow(blocked);
    if ((await ops.firstOutboxRow(blocked - 1, blocked + 1, stored(handler.events), either)) !== null)
      throw new FrameworkError(`runHandler was asked to handle position ${row.position} for the handler ${JSON.stringify(handler.name)}, whose low-water position is ${lease.position}, while the row at ${blocked}, which it lists, is not handled: a bus hands each handler its rows in order and never skips one`);
    // A pending row the bus passed on a stale snapshot: yield there.
    let event = "an event";
    for (const name of unionNow) {
      if (handler.events.includes(name)) continue;
      if ((await ops.firstOutboxRow(blocked - 1, blocked + 1, stored([name]), either)) !== null) { event = name; break; }
    }
    throw this.#yield(handler, lease, blocked, event);
  }

  /** A `retryFailed` transaction's fence: the nil claim and the handler's lease, as a handler transaction checks them. */
  async fenceReplay(delivery: DeliveryOperations, handler: RegisteredHandler, position: number): Promise<void> {
    await this.#lease(multiOperations(delivery), handler, position);
  }

  async writeProgress(delivery: DeliveryOperations, progress: HandlerProgressRow, position: number): Promise<void> {
    await multiOperations(delivery).writeHandlerLease({ ...(progress as HandlerLeaseRow), position });
  }

  /** The closing transaction of a `listen` handler: the lease again, then the move (rule L4). */
  async settleListen(delivery: DeliveryOperations, handler: RegisteredHandler, row: OutboxRow): Promise<void> {
    const ops = multiOperations(delivery);
    const { lease } = await this.#lease(ops, handler, row.position);
    if (lease.position < row.position) await ops.writeHandlerLease({ ...lease, position: row.position });
  }

  /**
   * After a rejected `runHandler`: a yield clears the lease where it still names this process, in a fresh transaction
   * (a failure is left to the next tick); the skip check's undeclared row is read for its name.
   */
  async afterReject(handler: RegisteredHandler, error: unknown): Promise<unknown> {
    if (error instanceof UndeclaredBelow) {
      const name = await this.deliverer.layer.readOutbox?.(error.position - 1, 1).then((page) => page.rows[0]?.name, () => undefined);
      return new EventUndeclaredError(name ?? "(unknown)", error.position);
    }
    const generation = this.#yielding.get(handler.name);
    if (!(error instanceof HandlerLostError) || error.reason !== "pending" || generation === undefined) return undefined;
    this.#yielding.delete(handler.name);
    try {
      await this.deliverer.layer.transaction(async (tx) => {
        const ops = multiOperations(tx);
        const lease = await ops.lockHandlerProgress(handler.name);
        if (lease?.runId === RUN_ID && lease.generation === generation) await ops.writeHandlerLease({ ...lease, runId: null });
      });
    } catch { /* the next tick clears it (rule L6) */ }
    return undefined;
  }

  /** A deletion batch's fence (rule K1): `mesh_outbox_state` locked, this process's row live, the known declared set read. */
  async fenceBatch(delivery: DeliveryOperations): Promise<DeliveryState> {
    this.deliverer.live();
    const ops = multiOperations(delivery);
    const state = await ops.lockDeliveryState();
    const rows = live(await ops.readProcesses(), state.now);
    if (!rows.some((row) => row.runId === RUN_ID))
      throw this.deliverer.lose("this process's row in mesh_delivery_process lapsed or is gone, so its handlers may have been taken over");
    this.#passProcesses = rows;
    this.#passKnown = this.#known = this.#knownOf(rows);
    return state;
  }

  passDeclared(): ReadonlySet<string> {
    return this.#passKnown;
  }

  readHandlers(delivery: DeliveryOperations): Promise<readonly HandlerProgressRow[]> {
    return multiOperations(delivery).readHandlerLeases();
  }

  readSubscriptions(delivery: DeliveryOperations): Promise<readonly SubscriptionProgressRow[]> {
    return multiOperations(delivery).readSubscriptionOwners();
  }

  holds(row: HandlerProgressRow): boolean {
    return (row as HandlerLeaseRow).runId === RUN_ID && this.#held.get(row.name) === row.generation;
  }

  /** The pass's move of a held handler, conditional on the position and the lease it read (rule K2). */
  async moveHandler(delivery: DeliveryOperations, row: HandlerProgressRow, to: number): Promise<HandlerProgressRow> {
    return (await multiOperations(delivery).moveHandler(row.name, row.position, to, RUN_ID, row.generation)) ? { ...row, position: to } : row;
  }

  /** The pass's move of a subscription, conditional on the position it read (rule K2). */
  async moveSubscription(delivery: DeliveryOperations, row: SubscriptionProgressRow, to: number): Promise<SubscriptionProgressRow> {
    return (await multiOperations(delivery).moveSubscription(row.name, row.position, to)) ? { ...row, position: to } : row;
  }

  /** A batch deletes only when the recorded `keep` and this process's are both `"until-delivered"` (rule K3). */
  deletes(state: DeliveryState): boolean {
    return (state as LockedDeliveryState).keep !== "all" && this.deliverer.keep === "until-delivered";
  }

  /** A handler no live process row registers; a subscription not open under a live process row for the orphan age (rules K5, S5). */
  isOrphan(row: HandlerProgressRow | SubscriptionProgressRow, state: DeliveryState): boolean {
    if (!("filter" in row)) return !this.#passProcesses.some((each) => Object.hasOwn(each.handlers, row.name));
    const owner = (row as SubscriptionOwnerRow).runId;
    const openLive = row.open && owner !== null && this.#passProcesses.some((each) => each.runId === owner);
    return !openLive && !this.deliverer.db.subscriptions.has(row.name) && state.now.getTime() - row.seenAt.getTime() > timing.orphanAgeMs;
  }

  /**
   * The reports of a deletion pass beside the orphans, each with the key the orphan rule's "first time, then hourly"
   * counts it under (rules K6, K7): a handler live processes register and none has held for longer than the lapse time,
   * seen from this process, naming its pending events and `mesh events adopt`; and a recorded `keep: "all"` while this
   * process runs with `"until-delivered"`, naming `mesh events keep until-delivered`.
   */
  reports(state: DeliveryState, handlers: readonly HandlerProgressRow[], database: string): readonly { readonly key: string; readonly message: string }[] {
    const reports: { key: string; message: string }[] = [];
    const now = Date.now();
    const rows = this.#passProcesses;
    for (const row of handlers) {
      const registrants = rows.filter((each) => Object.hasOwn(each.handlers, row.name));
      const holder = (row as HandlerLeaseRow).runId;
      if (registrants.length === 0 || (holder !== null && rows.some((each) => each.runId === holder))) {
        this.#unheld.delete(row.name);
        continue;
      }
      const since = this.#unheld.get(row.name);
      if (since === undefined) { this.#unheld.set(row.name, now); continue; }
      if (now - since <= timing.lapseMs) continue;
      const pending = row.events.filter((event) => !registrants.some((each) => each.handlers[row.name]!.includes(event)));
      const count = registrants.length === 1 ? "1 live process" : `${registrants.length} live processes`;
      reports.push({
        key: `waiting:${row.name}`,
        message: pending.length > 0
          ? `Mesh: the handler ${JSON.stringify(row.name)} is registered by ${count} and held by none: it waits at position ${row.position}, where ${pending.join(" and ")} ${pending.length === 1 ? "is" : "are"} listed by a build no live process runs. Drop ${pending.length === 1 ? "it" : "them"} with \`mesh events adopt ${row.name}${pending.map((event) => ` --drop ${event}`).join("")}\`, or start a process whose build lists ${pending.length === 1 ? "it" : "them"}`
          : `Mesh: the handler ${JSON.stringify(row.name)} is registered by ${count} and held by none: it waits at position ${row.position}, and a live process lists every event of its union. A process that yielded it takes it again once its union changes, at resumeHandler(${JSON.stringify(row.name)}) or at a restart; \`mesh events adopt ${row.name}\` lists its union`,
      });
    }
    for (const name of [...this.#unheld.keys()]) if (!handlers.some((row) => row.name === name)) this.#unheld.delete(name);
    if (this.deliverer.keep === "until-delivered" && (state as LockedDeliveryState).keep === "all") {
      const keepers = rows.filter((each) => each.keep === "all");
      reports.push({
        key: "keep",
        message: `Mesh: the recorded keep of ${database} is "all", so no process deletes delivered rows, while this process runs with keep: "until-delivered". `
          + (keepers.length === 0
            ? "No live process runs with \"all\"; run `mesh events keep until-delivered` to delete again"
            : `The live ${keepers.length === 1 ? "process" : "processes"} ${keepers.map(who).join(", ")} ${keepers.length === 1 ? "runs" : "run"} with "all"; stop ${keepers.length === 1 ? "it" : "them"}, or change ${keepers.length === 1 ? "its" : "their"} configuration, then run \`mesh events keep until-delivered\``),
      });
    }
    return reports;
  }

  /**
   * `resumeHandler` (rule R6): a handler this process holds goes to the bus as in single mode; any other registered one
   * loses its yield mark and is taken if rule L2 allows, else at a later tick once its lease frees.
   */
  async resume(name: string): Promise<{ readonly handler: RegisteredHandler; readonly forBus: boolean } | undefined> {
    const handler = this.#registered.get(name);
    if (!handler) return undefined;
    if (this.#held.has(name)) return { handler, forBus: true };
    this.#yielded.delete(name);
    await this.#takeLeases(name);
    return { handler, forBus: false };
  }

  /**
   * Release (rules P4, P5): in one transaction that locks `mesh_outbox_state`, clear every lease that names this process,
   * delete its row, and clear the nil claim when no other live process row remains. A failure on a lock is ignored (the
   * row lapses, and this process may retake leases that still name it); any other unless `quiet`.
   */
  async release(quiet: boolean): Promise<void> {
    try {
      await this.deliverer.layer.transaction(async (tx) => {
        const ops = multiOperations(tx);
        const state = await ops.lockDeliveryState();
        for (const name of this.#registered.keys()) {
          const lease = await ops.lockHandlerProgress(name);
          if (lease?.runId === RUN_ID) await ops.writeHandlerLease({ ...lease, runId: null });
        }
        await ops.deleteProcess(RUN_ID);
        const others = live(await ops.readProcesses(), state.now);
        if (others.length === 0 && state.claim?.runId === NIL_RUN_ID) await ops.releaseClaim(NIL_RUN_ID, state.generation);
      });
    } catch (error) {
      if (error instanceof DatabaseBusyError || quiet) return;
      throw error;
    } finally {
      this.#held.clear();
      this.#handlers = undefined;
    }
  }

  /** A live process row whose build declares `event`, for a subscription's message (rule S4). */
  declarer(event: string): string | undefined {
    if (!this.#known.has(event)) return undefined;
    const row = this.#liveRows.find((each) => each.runId !== RUN_ID && each.declared.includes(event));
    return row ? who(row) : "another live process";
  }
}

/** The live process whose build declares `event`, if this process delivers `db` in multi mode (rule S4). */
export function declarerOf(db: DatabaseState, event: string): string | undefined {
  const strategy = db.deliverer?.strategy;
  return strategy instanceof MultiClaim ? strategy.declarer(event) : undefined;
}

// ---- subscriptions and forgetting, outside the deliverer -------------------------------------------------------

/**
 * `subscribe`'s transaction in multi mode (rules S1, S2): `mesh_outbox_state` locked first, so an open is serialised
 * against other opens and deletion batches; a row open under another live process row is refused; the row is written
 * with this process as its owner. Resolves with the position the subscription starts from.
 */
export async function openOwned(
  ops: MultiOps, name: string, filter: SubscriptionFilter, after: number | undefined, renamed: ReadonlyMap<string, string> = NO_RENAMES,
): Promise<number> {
  const state = await ops.lockDeliveryState();
  const row = (await ops.readSubscriptionOwners()).find((each) => each.name === name);
  if (row?.open && row.runId !== null && row.runId !== RUN_ID) {
    const owner = (await ops.readProcesses()).find((each) => each.runId === row.runId && !expired(each, state.now));
    if (owner)
      throw new FrameworkError(`A subscription named ${JSON.stringify(name)} is open in another process (${who(owner)}): two readers acknowledging under one row would pass each other's rows. Close it there, or open another name`);
  }
  let start: number;
  if (row) {
    // A row written before a rename names the event by its former FQN: the same filter, rewritten below with the new name.
    if (canonicalJson(renamedFilter(row.filter, renamed)) !== canonicalJson(filter))
      throw new FrameworkError(`The subscription ${JSON.stringify(name)} was opened with the filter ${canonicalJson(filter)}, and its row was reached with ${canonicalJson(row.filter)}: an acknowledged position means something only under its filter. Forget it (forgetSubscription(${JSON.stringify(name)})), then open it with the new filter`);
    start = row.position;
  } else {
    start = after ?? state.highest;
    if (start < state.deletedThrough) throw new EventsDeletedError(start, state.deletedThrough + 1);
    if (start > state.highest) throw new CursorAheadError(start, state.highest);
  }
  await ops.writeSubscriptionOwner({ name, position: start, filter, open: true, generation: 0, runId: RUN_ID });
  return start;
}

/** `ack`'s transaction in multi mode (rule S3): it goes on only while the row's owner is this process. */
export async function ackOwned(ops: MultiOps, database: string, name: string, position: number): Promise<number> {
  const row = (await ops.readSubscriptionOwners()).find((each) => each.name === name);
  if (!row) throw new FrameworkError(`The subscription ${JSON.stringify(name)} has no row: it was forgotten while open`);
  if (row.runId !== RUN_ID) throw new DelivererLostError(database, `another process opened the subscription ${JSON.stringify(name)} since it opened here`);
  if (position <= row.position) return row.position;
  await ops.writeSubscriptionOwner({ name: row.name, position, filter: row.filter, open: row.open, generation: row.generation, runId: row.runId });
  return position;
}

/** Stored filters compare as JSON with sorted keys, as single mode compares them. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * `forgetHandler`, `forgetSubscription` and `forgetByName` in multi mode (rules K5, S2, M6): `mesh_outbox_state` locked
 * first; a handler a live process row registers and a subscription open under a live process row are refused, naming
 * the process; a row of a lapsed or absent process is a crash's leftover and is dropped.
 */
export async function forgetOwned(layer: DataLayer, name: string, kind: "handler" | "subscription" | "either", what: string): Promise<Forgotten> {
  const prefix = what === "mesh events forget" ? "" : `${what}: `;
  const cap = (text: string) => prefix === "" ? text[0]!.toUpperCase() + text.slice(1) : prefix + text;
  return layer.transaction(async (tx) => {
    const ops = multiOperations(tx);
    const state = await ops.lockDeliveryState();
    const processes = live(await ops.readProcesses(), state.now);
    const handler = kind === "subscription" ? undefined : (await ops.readHandlerLeases()).find((each) => each.name === name);
    const subscription = kind === "handler" ? undefined : (await ops.readSubscriptionOwners()).find((each) => each.name === name);
    if (handler && subscription)
      throw new FrameworkError(`The name ${JSON.stringify(name)} is held by a handler's progress row and by a subscription's row: forget each from the application, with forgetHandler(${JSON.stringify(name)}) or forgetSubscription(${JSON.stringify(name)})`);
    if (handler) {
      const registrant = processes.find((each) => Object.hasOwn(each.handlers, name));
      if (registrant)
        throw new FrameworkError(cap(`the handler ${JSON.stringify(name)} is registered by a live process (${who(registrant)}), so its progress is not dropped. Remove it from the events module and restart every process first`));
      await ops.deleteHandlerProgress(name);
      return { kind: "handler" as const, name, position: handler.position };
    }
    if (subscription) {
      const owner = subscription.open ? processes.find((each) => each.runId === subscription.runId) : undefined;
      if (owner && owner.runId !== RUN_ID)
        throw new FrameworkError(cap(`the subscription ${JSON.stringify(name)} is open in a live process (${who(owner)}); close it there first`));
      await ops.deleteSubscriptionProgress(name);
      return { kind: "subscription" as const, name, position: subscription.position };
    }
    if (kind === "handler") throw new FrameworkError(`${what}: no handler named ${JSON.stringify(name)} has a progress row`);
    if (kind === "subscription") throw new FrameworkError(`${what}: no subscription named ${JSON.stringify(name)} has a row`);
    throw new FrameworkError(`No handler and no subscription named ${JSON.stringify(name)} has a row in this database`);
  });
}

// ---- adopting a handler's union, and the recorded keep ----------------------------------------------------------

/** What `mesh events adopt` (and `adoptHandler`) did to a handler's registered union (rule R5). */
export interface Adopted {
  readonly handler: string;
  /** The registered union after the call, sorted. */
  readonly union: readonly string[];
  /** The events dropped from it, as named. */
  readonly dropped: readonly string[];
  /** Every event kept, with the live process that lists it (`pid 4242 on host api-1`), or null when none does. */
  readonly kept: readonly { readonly event: string; readonly listedBy: string | null }[];
  /** False when the union is unchanged. */
  readonly changed: boolean;
}

/**
 * Shrink a handler's registered union (rule R5), in one transaction that locks `mesh_outbox_state`, then the handler's
 * progress row: it keeps every event a live process lists for the handler, and every other event unless it is named in
 * `drop`. A handler no live process registers, and a `drop` of an event that a live process lists or that the union
 * lacks, are refused. `what` names the caller in messages (`mesh events adopt`, `adoptHandler`).
 */
export async function adoptOwned(layer: DataLayer, name: string, drop: readonly string[], what: string): Promise<Adopted> {
  const prefix = what === "mesh events adopt" ? "" : `${what}: `;
  const cap = (text: string) => prefix === "" ? text[0]!.toUpperCase() + text.slice(1) : prefix + text;
  return layer.transaction(async (tx) => {
    const ops = multiOperations(tx);
    const state = await ops.lockDeliveryState();
    const registrants = live(await ops.readProcesses(), state.now).filter((row) => Object.hasOwn(row.handlers, name));
    if (registrants.length === 0)
      throw new FrameworkError(cap(`no live process registers the handler ${JSON.stringify(name)}, so there is no list to adopt: if it was removed, drop its progress with \`mesh events forget ${name}\``));
    const row = await ops.lockHandlerProgress(name);
    if (!row) throw new FrameworkError(cap(`the handler ${JSON.stringify(name)} has no progress row: it was forgotten while registered; restart a process that registers it`));
    const listedBy = (event: string) => registrants.find((each) => each.handlers[name]!.includes(event));
    for (const event of drop) {
      if (!row.events.includes(event))
        throw new FrameworkError(prefix + (`${event} is not in the registered union of ${JSON.stringify(name)} (${row.events.join(", ") || "none"}), so there is nothing to drop`));
      const lister = listedBy(event);
      if (lister) throw new FrameworkError(prefix + (`${event} is listed for ${JSON.stringify(name)} by a live process (${who(lister)}), so it is not dropped: stop that process first`));
    }
    const dropped = [...new Set(drop)].sort();
    const union = Object.freeze(row.events.filter((event) => !dropped.includes(event)).sort());
    const kept = union.map((event) => { const lister = listedBy(event); return Object.freeze({ event, listedBy: lister ? who(lister) : null }); });
    if (dropped.length > 0) await ops.writeHandlerLease({ ...row, events: union });
    return Object.freeze({ handler: name, union, dropped: Object.freeze(dropped), kept: Object.freeze(kept), changed: dropped.length > 0 });
  });
}

/** What `mesh events keep` (rule K4) found and left. */
export interface KeepChange {
  /** The recorded keep before the call; null before the first multi-mode start. */
  readonly before: "until-delivered" | "all" | null;
  readonly after: "until-delivered" | "all";
}

/**
 * Set the recorded `keep` (rule K4), in one transaction that locks `mesh_outbox_state`. Setting it back to
 * `"until-delivered"` is refused while a live process row was registered with `keep: "all"`, naming it.
 */
export async function keepOwned(layer: DataLayer, keep: "until-delivered" | "all"): Promise<KeepChange> {
  return layer.transaction(async (tx) => {
    const ops = multiOperations(tx);
    const state = await ops.lockDeliveryState();
    if (keep === "until-delivered") {
      const keeper = live(await ops.readProcesses(), state.now).find((row) => row.keep === "all");
      if (keeper)
        throw new FrameworkError(`The process ${who(keeper)} delivers with keep: "all", so the recorded keep stays "all": stop it, or change its configuration, first`);
    }
    if (state.keep !== keep) await ops.writeKeep(keep);
    return Object.freeze({ before: state.keep, after: keep });
  });
}
