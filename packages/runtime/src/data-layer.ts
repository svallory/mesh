import type { Condition, OrderKey } from "./condition.ts";

/** Attribute names mapped to generated TypeScript values (including Date and boolean).
 * Storage conversions belong to the adapter, not the caller.
 */
export type Row = Record<string, unknown>;

/** Primary-key attribute names mapped to their values. */
export type Key = Readonly<Record<string, unknown>>;

/** Opaque handle to one entity's storage, exported by the emitted schema file
 * and understood only by the adapter.
 */
export type TableHandle = object;

/** A value a filter can compare an attribute with. `null` is how a filter says "no value". */
export type Scalar = string | number | boolean | Date | null;

/**
 * What one attribute is compared with. Every operator is lowercase; several operators
 * in one object must all hold. An operator whose value is `undefined` is an error, not
 * a skipped condition, so a missing variable never widens a query.
 *
 * `eq: null` and `ne: null` mean "is null" and "is not null" (as `nil` does), never SQL
 * `= NULL`. `lt`, `lte`, `gt` and `gte` reject `null`. `in` takes a list of non-null
 * values; an empty list matches nothing. The type argument narrows the values to one
 * attribute's type: the generated filter of an entity uses it.
 */
export interface Comparison<T extends Exclude<Scalar, null> = Exclude<Scalar, null>> {
  readonly eq?: T | null;
  readonly ne?: T | null;
  readonly lt?: T;
  readonly lte?: T;
  readonly gt?: T;
  readonly gte?: T;
  readonly in?: readonly T[];
  /** `true` matches null, `false` matches not null. */
  readonly nil?: boolean;
}

/**
 * A plain-data filter over attribute names (ADR-0013, ADR-0014): data, never a string
 * or a query-library object. A key `and` or `or` holding a list combines filters, and
 * every other key names an attribute; the keys of one object are all required to hold.
 * `{ and: [] }` matches every row and `{ or: [] }` matches none. An attribute named
 * `and` or `or` therefore cannot be filtered. An attribute whose comparison is `undefined`
 * is the same as one left out, as for an optional field of a generated filter type
 * (`toString?: Comparison<string> | undefined`: a caller leaves out an attribute named like
 * a member of `Object.prototype` by giving it as `undefined`); an operator whose
 * value is `undefined` is still an error.
 */
export type Filter =
  | { readonly and: readonly Filter[] }
  | { readonly or: readonly Filter[] }
  | { readonly [attribute: string]: Comparison | undefined };

/** Attribute names in order of priority; a leading `-` sorts that attribute descending. */
export type Sort = readonly string[];

/**
 * A read. Rows that tie on every `sort` field come back in primary-key order, so a page
 * is the same page every time. Nulls sort first ascending and last descending, and text
 * sorts and compares (`eq`, `lt`, `lte`, `gt`, `gte`) bytewise, letter case included, as
 * SQLite does; a server dialect pins this order (`COLLATE "C"`, `NULLS FIRST`/`NULLS LAST`).
 * `offset` without `limit` skips rows and returns the rest. A
 * field that is `undefined` is the same as one that is left out, so a caller can pass an
 * optional input through; a filter's operators do not have this leniency.
 * `limit` and `offset` are non-negative integers; an offset past the end returns no rows.
 */
export interface Query {
  readonly filter?: Filter | undefined;
  readonly sort?: Sort | undefined;
  /**
   * Set only by generated code, never from a caller's input: every row returned makes this condition true (an unknown
   * result leaves the row out). Combined with `filter` by AND. Requires the `conditions` capability; a hop in it
   * (`one`, `some`, `every`, `count`, `first`) also requires `joins`. An adapter without `conditions` must never
   * receive one: `whereFor` refuses before the call.
   */
  readonly where?: Condition | undefined;
  /**
   * Set only by generated code, in place of `sort` (both set is a FrameworkError): the order, first key first; rows that
   * tie on every key come back in primary-key order. Nulls are the smallest value and strings order by code point.
   * Requires the `conditions` capability.
   */
  readonly order?: readonly OrderKey[] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Contract v1: operations are available only inside a transaction.
 *
 * Keys: an insert whose row has no value for a single-column primary key gets one. A text
 * key becomes a UUIDv7 (time-ordered, and increasing within one process even inside one
 * millisecond); an integer key becomes the highest stored value plus one, computed in the
 * write transaction, so a rolled-back insert leaves no gap. Inserts into one table run one at a time
 * within one layer, so parallel inserts get distinct consecutive keys; across processes on a server dialect, one of two
 * parallel fills fails with a retryable `MESH_DATABASE_BUSY`. Deleting the highest row frees its key for the
 * next insert, so a key is not a monotonic cursor. A value the caller supplies is
 * stored as given. The adapter must declare `integer-key-fill` to take an integer key.
 */
export interface DataOperations {
  /** Insert a row and return its stored representation in TypeScript values, key included. */
  insert(table: TableHandle, row: Row): Promise<Row>;
  /** Find one row by primary key, or undefined when absent. */
  selectByKey(table: TableHandle, key: Key): Promise<Row | undefined>;
  /**
   * Reload one row by primary key under the transaction's write lock, or undefined when
   * absent. No other writer can change the row until this transaction ends, so a rule that
   * reads, decides and then writes sees what it writes over. How the lock is taken is the
   * adapter's: SQLite's single writer already holds it, so there it is a plain keyed read; a
   * server dialect issues `SELECT ... FOR UPDATE` (the Drizzle layer has a hook for it).
   */
  selectByKeyForUpdate(table: TableHandle, key: Key): Promise<Row | undefined>;
  /** Rows matching a plain-data query. No query means every row, in primary-key order. */
  select(table: TableHandle, query?: Query): Promise<Row[]>;
  /** Apply changes and return the stored row, or undefined when absent. */
  updateByKey(table: TableHandle, key: Key, changes: Row): Promise<Row | undefined>;
  /** Delete one row, returning false when absent. */
  deleteByKey(table: TableHandle, key: Key): Promise<boolean>;
  /**
   * The highest value of one attribute among the rows matching `filter`, or null when no
   * row matches or every match is null. Requires the `aggregates` capability. `where`, as `Query.where`, narrows the
   * rows further and requires `conditions` (and `joins` for a hop).
   */
  max(table: TableHandle, attribute: string, filter?: Filter, where?: Condition): Promise<Exclude<Scalar, boolean> | null>;
  /** How many matching rows have a value (not null) in `attribute`. Requires `aggregates`; `where` as for `max`. */
  count(table: TableHandle, attribute: string, filter?: Filter, where?: Condition): Promise<number>;
  /** The outbox append; see `OutboxOperations`. Mandatory for an adapter of a project that declares an event. */
  appendEvent?: OutboxOperations["appendEvent"];
  /** The outbox delete; see `OutboxOperations`. Mandatory for an adapter of a project that declares an event. */
  deleteOutboxThrough?: OutboxOperations["deleteOutboxThrough"];
  /** The deliverer's operations on core's delivery state; see `DeliveryOperations`. Mandatory with the outbox ones. */
  readDeliveryState?: DeliveryOperations["readDeliveryState"];
  writeClaim?: DeliveryOperations["writeClaim"];
  renewClaim?: DeliveryOperations["renewClaim"];
  releaseClaim?: DeliveryOperations["releaseClaim"];
  readHandlerProgress?: DeliveryOperations["readHandlerProgress"];
  writeHandlerProgress?: DeliveryOperations["writeHandlerProgress"];
  deleteHandlerProgress?: DeliveryOperations["deleteHandlerProgress"];
  readSubscriptionProgress?: DeliveryOperations["readSubscriptionProgress"];
  writeSubscriptionProgress?: DeliveryOperations["writeSubscriptionProgress"];
  deleteSubscriptionProgress?: DeliveryOperations["deleteSubscriptionProgress"];
  firstOutboxRow?: DeliveryOperations["firstOutboxRow"];
  /** Delivery from several processes; see `MultiProcessOperations`. Mandatory only when the bus declares `multi-process`. */
  lockDeliveryState?: MultiProcessOperations["lockDeliveryState"];
  writeKeep?: MultiProcessOperations["writeKeep"];
  lockHandlerProgress?: MultiProcessOperations["lockHandlerProgress"];
  readHandlerLeases?: MultiProcessOperations["readHandlerLeases"];
  writeHandlerLease?: MultiProcessOperations["writeHandlerLease"];
  moveHandler?: MultiProcessOperations["moveHandler"];
  moveSubscription?: MultiProcessOperations["moveSubscription"];
  readProcesses?: MultiProcessOperations["readProcesses"];
  writeProcess?: MultiProcessOperations["writeProcess"];
  renewProcess?: MultiProcessOperations["renewProcess"];
  deleteProcess?: MultiProcessOperations["deleteProcess"];
  readSubscriptionOwners?: MultiProcessOperations["readSubscriptionOwners"];
  writeSubscriptionOwner?: MultiProcessOperations["writeSubscriptionOwner"];
  /**
   * One read-only statement written by hand, run in the running transaction (capability `raw-sql`, ADR-0087); present
   * exactly when the adapter declares it. The adapter writes its own placeholders between the text pieces, and refuses
   * a statement that is not a query (a first word other than `select`, `with` or `values`, or a leading comment), more
   * than one statement, a parameter written in the text, a value it cannot bind, a result that names a column twice,
   * and any write the database would make; each refusal is a `FrameworkError` that leaves the transaction open and
   * unchanged, and no message carries a value. Resolves with the rows as stored, integers exact (a `bigint` beyond
   * 2^53).
   */
  query?(statement: RawStatement): Promise<readonly RawRow[]>;
}

/** A value a raw query binds: anything else is refused, never bound as NULL. A `bigint` must fit in signed 64 bits. */
export type RawValue = string | number | bigint | boolean | Date | null;

/**
 * One raw statement as plain data: the template's cooked text pieces (never `undefined`) and the values between them,
 * `text.length === values.length + 1`. The adapter writes its own placeholders between the pieces; core assembles no
 * SQL string. Frozen.
 */
export interface RawStatement {
  readonly text: readonly string[];
  readonly values: readonly RawValue[];
}

/** A row of a raw query: the column names the statement gives, the values as stored. */
export type RawRow = Readonly<Record<string, unknown>>;

/**
 * One row of `mesh_outbox`: an event record as stored. Rows are never updated. `key`, `metadata` and `payload` are JSON
 * (the payload is the event instance's fields; a date field is stored as its ISO text and read back as a `Date` by
 * core, which knows the declaration). `occurredAt` is the transaction's instant at the `publish`.
 */
export interface OutboxRow {
  /** Order in the outbox, assigned by the adapter at the append, from 1, never reused (even after a delete). */
  readonly position: number;
  /** A time-ordered UUID: the event's identity. */
  readonly id: string;
  /** The event's FQN, `billing.InvoicePaid`. */
  readonly name: string;
  /** The publishing entity's FQN. */
  readonly entity: string;
  /** The publishing action's name. */
  readonly action: string;
  /** The publishing record's key. */
  readonly key: Key;
  /** The id of the event whose handler was running, or null. */
  readonly causedBy: string | null;
  /** What the project's metadata function returned (`{}` without one). */
  readonly metadata: unknown;
  readonly occurredAt: Date;
  /** The event's fields as JSON. */
  readonly payload: unknown;
}

/** What `appendEvent` takes: a row without its position, which the adapter assigns. */
export type OutboxAppend = Omit<OutboxRow, "position">;

/** One read of the outbox: its rows and both positions, taken from one state of the database. */
export interface OutboxPage {
  /** Committed rows with `position > after` and `position <= settled`, in order, at most `limit`. */
  readonly rows: readonly OutboxRow[];
  /** The highest deleted position, from `mesh_outbox_state`; 0 before the first delete. */
  readonly deletedThrough: number;
  /**
   * The highest position ever assigned; 0 before the first append. On a server dialect whose positions come from a
   * sequence (Postgres) it counts rolled-back and still-running assignments too.
   */
  readonly highest: number;
  /**
   * Every position at or below it is final: its row is committed, or will never commit. `deletedThrough <= settled <=
   * highest`; every row returned is at or below it; with no transaction open on the database it equals `highest`.
   * SQLite: always `highest` (one writer). A reader that passes a short page may move its cursor to `settled`, never to
   * `highest`. Required: every layer object, a fake included, sets it; core never falls back to `highest`.
   */
  readonly settled: number;
}

/**
 * The three outbox operations, mandatory once a project declares an event (spec, Events and commands, "The outbox").
 * `appendEvent` and `deleteOutboxThrough` are members of `DataOperations`, so they run in the caller's transaction;
 * `readOutbox` is a member of `DataLayer`, since it runs outside any transaction. No reader calls `readOutbox`
 * directly: core's `rows(after, limit)` checks its answer.
 */
export interface OutboxOperations {
  /** Insert one row in the running transaction and return its position. */
  appendEvent(row: OutboxAppend): Promise<number>;
  /**
   * The committed rows after `after`, in an order that never skips (once position p was returned, no row that commits
   * later is below p), and only rows at or below the page's `settled` position, with the rows and both positions in one
   * statement, outside any transaction. Inside a transaction it is
   * refused with a `FrameworkError`: a transaction's own events come from `published()`.
   */
  readOutbox(after: number, limit: number): Promise<OutboxPage>;
  /**
   * In the running transaction, delete every row at or below `position` and record it as the deleted-through
   * position; returns the rows deleted. A position at or below the recorded one deletes nothing and returns 0; one
   * above the highest position ever assigned is a `FrameworkError`.
   */
  deleteOutboxThrough(position: number): Promise<number>;
}

/** The deliverer claim as `mesh_outbox_state` holds it (spec, Events and commands, "The claim"). */
export interface DelivererClaim {
  /** A random UUID drawn once per process run: never the pid, since containers run every process as pid 1. */
  readonly runId: string;
  /** The generation the holder claimed under. */
  readonly generation: number;
  /** When the holder last claimed or renewed, by the database's clock. */
  readonly renewedAt: Date;
  /** For messages only. */
  readonly host: string | null;
  readonly pid: number | null;
  readonly startedAt: Date | null;
}

/** `mesh_outbox_state` as one read in the running transaction, with the database's clock. */
export interface DeliveryState {
  readonly deletedThrough: number;
  /** The highest position ever assigned. */
  readonly highest: number;
  /** The generation of the latest claim, kept after a release; 0 before the first claim. */
  readonly generation: number;
  /** The claim, or null when nobody holds it (never claimed, or released). A lapsed claim is still returned. */
  readonly claim: DelivererClaim | null;
  /** The database's clock now: every lapse and every `seenAt` is measured on it. */
  readonly now: Date;
}

/** One row of `mesh_handler_progress`: a handler's low-water position, as last registered. */
export interface HandlerProgressRow {
  /** The handler's name, unique across every kind: the row's key. */
  readonly name: string;
  /** `"process"`, `"listen"`, or what a contributed kind's `stored` returned (`"project"`, `"project:now"`): stored as it is. */
  readonly kind: string;
  /** The low-water position: every row the handler lists at or below it is handled. */
  readonly position: number;
  /** The sorted FQNs the handler lists, as last registered. */
  readonly events: readonly string[];
  /** The generation of the claim that last registered it. */
  readonly generation: number;
}

/** A subscription's filter as its row stores it: each member is left out when not set. */
export interface SubscriptionFilter {
  readonly names?: readonly string[];
  readonly entity?: string;
  readonly key?: Key;
}

/** One row of `mesh_subscription_progress`. */
export interface SubscriptionProgressRow {
  readonly name: string;
  /** The acknowledged position. */
  readonly position: number;
  readonly filter: SubscriptionFilter;
  /** Its last open, acknowledgement, close or stream end, by the database's clock. */
  readonly seenAt: Date;
  readonly open: boolean;
  /** The generation of the claim under which it was last open. */
  readonly generation: number;
}

/**
 * The operations core's deliverer runs on its own tables (spec, Events and commands, "The deliverer", "Retention"), each
 * in the running transaction, mandatory with the outbox operations. Only core calls them; a bus never does.
 */
export interface DeliveryOperations {
  /** `mesh_outbox_state` and the highest position, read with the database's clock. */
  readDeliveryState(): Promise<DeliveryState>;
  /**
   * Write the claim; `renewedAt` is the database's clock. A claim that leaves `host` out gets the name of the host the
   * data layer runs on (core names no host API, ADR-0025); `null` stores none.
   */
  writeClaim(claim: { readonly runId: string; readonly generation: number; readonly host?: string | null; readonly pid: number | null; readonly startedAt: Date | null }): Promise<void>;
  /** In one statement: set `renewedAt` to the database's clock where the claim holds `runId` and `generation`; false when no row matched. */
  renewClaim(runId: string, generation: number): Promise<boolean>;
  /** Clear the claim where it holds `runId` and `generation`, keeping the generation; false when no row matched. */
  releaseClaim(runId: string, generation: number): Promise<boolean>;
  readHandlerProgress(): Promise<readonly HandlerProgressRow[]>;
  /** Insert or replace the row named `row.name`. */
  writeHandlerProgress(row: HandlerProgressRow): Promise<void>;
  /** Delete the row named `name`; false when there was none. */
  deleteHandlerProgress(name: string): Promise<boolean>;
  readSubscriptionProgress(): Promise<readonly SubscriptionProgressRow[]>;
  /** Insert or replace the row named `row.name`; `seenAt`, when left out, is the database's clock. */
  writeSubscriptionProgress(row: Omit<SubscriptionProgressRow, "seenAt"> & { readonly seenAt?: Date }): Promise<void>;
  deleteSubscriptionProgress(name: string): Promise<boolean>;
  /**
   * The position of the first outbox row above `after` and below `before` whose name is in `listed` or not in
   * `declared` (a row no declared event matches counts as listed by every handler), or null.
   */
  firstOutboxRow(after: number, before: number, listed: readonly string[], declared: readonly string[]): Promise<number | null>;
}

/** One row of `mesh_delivery_process`: a process that delivers in multi mode (the bus declares `multi-process`). */
export interface DeliveryProcessRow {
  readonly runId: string;
  /** When the process last registered or renewed, by the database's clock. */
  readonly renewedAt: Date;
  /** For messages only. */
  readonly host: string | null;
  readonly pid: number | null;
  readonly startedAt: Date | null;
  /** The process's `events.keep`. */
  readonly keep: "until-delivered" | "all";
  /** The handlers this process registers, each with its sorted list: name to FQNs. */
  readonly handlers: Readonly<Record<string, readonly string[]>>;
  /** Every event its build declares, sorted FQNs. */
  readonly declared: readonly string[];
}

/**
 * A progress row with its handler lease: `runId` is the run id of the process that holds the handler, null when none
 * does. In multi mode `generation` is the lease's, raised at each take, and `events` is the registered union: every event
 * any build registered for the handler since the last adoption.
 */
export type HandlerLeaseRow = HandlerProgressRow & { readonly runId: string | null };

/** A subscription row with its owner: the run id of the process it was last opened in, null for none. */
export type SubscriptionOwnerRow = SubscriptionProgressRow & { readonly runId: string | null };

/** `mesh_outbox_state` as `lockDeliveryState` reads it: `DeliveryState` and the recorded `keep`, null before any multi-mode start. */
export type LockedDeliveryState = DeliveryState & { readonly keep: "until-delivered" | "all" | null };

/**
 * The delivery operations of multi mode (the bus declares `multi-process`), each in the running transaction, beside
 * `DeliveryOperations`. Mandatory for a data adapter that delivers a project whose bus declares `multi-process`; core
 * checks them at the start and calls none of them otherwise, so a single-mode project runs on a schema without the
 * multi-process table and columns. A `lock*` operation takes the row's lock for the rest of the transaction (`FOR
 * UPDATE`; a plain read on SQLite, whose one writer holds every lock already). Every transaction that locks
 * `mesh_outbox_state` locks it before any progress row.
 */
export interface MultiProcessOperations {
  /** `mesh_outbox_state` as `readDeliveryState` reads it, plus the recorded `keep`, under the row's lock. */
  lockDeliveryState(): Promise<LockedDeliveryState>;
  /** Record the `keep` in force on `mesh_outbox_state` (written by the first multi-mode start if the row is absent). */
  writeKeep(keep: "until-delivered" | "all"): Promise<void>;
  /** One handler's progress row under its lock, with its lease; undefined when it has none. */
  lockHandlerProgress(name: string): Promise<HandlerLeaseRow | undefined>;
  /** Every progress row with its lease, unlocked, in name order: for bounds and reports only, never written back. */
  readHandlerLeases(): Promise<readonly HandlerLeaseRow[]>;
  /** Insert or replace a progress row with its lease; only from a row `lockHandlerProgress` read in the same transaction, or a new row. */
  writeHandlerLease(row: HandlerLeaseRow): Promise<void>;
  /** In one statement: move the handler from `from` to `to` where it is still at `from` under the lease `runId` and `generation`; false when no row matched. */
  moveHandler(name: string, from: number, to: number, runId: string, generation: number): Promise<boolean>;
  /** In one statement: move the subscription from `from` to `to` where it is still at `from`; false when no row matched. */
  moveSubscription(name: string, from: number, to: number): Promise<boolean>;
  /** Every process row, in run id order. */
  readProcesses(): Promise<readonly DeliveryProcessRow[]>;
  /** Insert or replace this process's row; `renewedAt` is the database's clock, and a left-out `host` is the data layer's host. */
  writeProcess(row: Omit<DeliveryProcessRow, "renewedAt" | "host"> & { readonly host?: string | null }): Promise<void>;
  /** In one statement: renew the row of `runId` where it has not lapsed (the database's now minus `renewedAt` is below `lapseMs`); false when no row matched. */
  renewProcess(runId: string, lapseMs: number): Promise<boolean>;
  /** Delete the row of `runId`; false when there was none. */
  deleteProcess(runId: string): Promise<boolean>;
  /** Every subscription row with its owner, in name order. */
  readSubscriptionOwners(): Promise<readonly SubscriptionOwnerRow[]>;
  /** Insert or replace a subscription row with its owner; `seenAt`, when left out, is the database's clock. */
  writeSubscriptionOwner(row: Omit<SubscriptionProgressRow, "seenAt"> & { readonly seenAt?: Date; readonly runId: string | null }): Promise<void>;
}

/** What `DataLayer.transaction` takes beside its callback. */
export interface TransactionOptions {
  /**
   * How long to wait for another connection's write lock, in all, in milliseconds, in place of the adapter's default.
   * Core's claim renewal passes the 15 s lapse; nothing else sets it. On Postgres it bounds each lock wait.
   */
  readonly waitMs?: number;
}

/** A bound data adapter; handlers always open a transaction before operations. */
export interface DataLayer {
  /**
   * Names the database this layer opens, the same for every layer object over it and different for every other database
   * (data-sqlite: the file's absolute path, or `:memory: #<n>` for a private memory database). Required to deliver
   * events: core keeps the deliverer's process-side state and the subscription registry per database by it, so two
   * layer objects over one database without it would each claim under this process's run id, the second taking the
   * first's claim over quietly. `deliver()`, `startDelivery()` and `subscribe` refuse a layer without it.
   */
  readonly database?: string;
  /** Runs run in one transaction: commits when it resolves, rolls back and rethrows when it rejects.
   * One transaction runs at a time per layer; unrelated concurrent calls queue, and
   * a failed transaction does not block the queue unless its own rollback failed, which
   * makes the layer unusable: queued and later calls reject and only close() works.
   * Re-entrant: a call made inside a running transaction (from its callback or from
   * anything that callback awaits) joins it and receives the same operations. It commits
   * nothing and rolls nothing back by itself: the outer call decides, so a throw that
   * leaves the outer callback rolls back the inner call's writes too. Rollback-only: when
   * a joined call fails, the transaction is marked, and the outer call rejects with a
   * FrameworkError (cause: the inner error) and rolls back everything even if its callback
   * caught the error. This holds for parallel joined calls; there are no savepoints, so an
   * inner failure cannot be undone alone. Fail fast: once a joined call failed, a call that joins the transaction
   * afterwards (or that was queued to join it and whose turn comes after the failure) is refused before its callback
   * runs, with a FrameworkError whose cause is the first failure. Joined calls run one at a time: calls joined from
   * the same callback (siblings started together, as with Promise.all) run in the order they
   * were made, each after the one before it settled, so two read-then-write calls on one row
   * cannot both read before either writes. A call joined from inside a joined call queues
   * behind that call's own joined calls only, so nesting never waits for itself. So a joined call must never
   * await a call that was joined after it from the same frame: that call's turn comes only once the awaiting one
   * settled, and the transaction hangs. Joining
   * follows async context, so a detached promise started inside the callback joins it too;
   * one whose turn comes after the outer call settled rejects with a FrameworkError. A call
   * made after the outer transaction settled starts a new one. On a server dialect, a failed statement may abort the
   * transaction: the adapter then rejects the outer call even if the callback caught the failure, and never resolves a
   * transaction that did not commit.
   */
  transaction<T>(run: (tx: DataOperations) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /**
   * Whether a call made here would join a running transaction, refusing it if that transaction has failed. Every
   * generated function calls this first, before it casts its input. Inside a transaction that a joined call already
   * failed it throws the FrameworkError that `transaction` would refuse the call with (cause: the first failure), so the
   * call does no work at all. Inside a running transaction that has not failed it returns true: a call made here joins
   * it. Anywhere else (at top level, from another request's async context while a transaction runs, or after the
   * transaction settled) it returns false: a call made here would start its own. It opens nothing, takes no lock and
   * waits for nothing, and it answers for the caller's async context only, never from layer-wide state.
   */
  refuseIfFailed(): boolean;
  /** The outbox read; see `OutboxOperations`. Mandatory for an adapter of a project that declares an event. */
  readOutbox?: OutboxOperations["readOutbox"];
  /**
   * Optional. Calls `listener` after a transaction that appended to the outbox commits, in this process or in any other
   * on the same database, and never for a rollback. Best effort: a call can be late, repeated or, while the adapter
   * reconnects, missed, so a bus that relies on it keeps a poll. Returns the unsubscribe. data-sqlite leaves it out.
   */
  onAppended?(listener: () => void): () => void;
  /** Release the adapter's connection and other owned handles. Rejects while
   * transactions are running or queued, leaving the layer open. Idempotent.
   * Releases handles only: a later transaction must open the layer again, on the
   * same storage (so `disconnect()` then `connect()` reuses the configured layer).
   */
  close(): Promise<void>;
}
