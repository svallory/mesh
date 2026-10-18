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
 * is the same page every time. `offset` without `limit` skips rows and returns the rest. A
 * field that is `undefined` is the same as one that is left out, so a caller can pass an
 * optional input through; a filter's operators do not have this leniency.
 * `limit` and `offset` are non-negative integers; an offset past the end returns no rows.
 */
export interface Query {
  readonly filter?: Filter | undefined;
  readonly sort?: Sort | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Contract v1: operations are available only inside a transaction.
 *
 * Keys: an insert whose row has no value for a single-column primary key gets one. A text
 * key becomes a UUIDv7 (time-ordered, and increasing within one process even inside one
 * millisecond); an integer key becomes the highest stored value plus one, computed in the
 * write transaction, so a rolled-back insert leaves no gap. Inserts into one table run one at a time,
 * so parallel inserts get distinct consecutive keys. Deleting the highest row frees its key for the
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
   * row matches or every match is null. No joins. Requires the `aggregates` capability.
   */
  max(table: TableHandle, attribute: string, filter?: Filter): Promise<Exclude<Scalar, boolean> | null>;
  /** How many matching rows have a value (not null) in `attribute`. Requires `aggregates`. */
  count(table: TableHandle, attribute: string, filter?: Filter): Promise<number>;
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
}

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
  /** Committed rows with `position > after`, in order, at most `limit`. */
  readonly rows: readonly OutboxRow[];
  /** The highest deleted position, from `mesh_outbox_state`; 0 before the first delete. */
  readonly deletedThrough: number;
  /** The highest position ever assigned; 0 before the first append. */
  readonly highest: number;
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
   * later is below p), with both positions, in one statement, outside any transaction. Inside a transaction it is
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
  /** The handler's name, unique across both kinds: the row's key. */
  readonly name: string;
  readonly kind: "process" | "listen";
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

/** What `DataLayer.transaction` takes beside its callback. */
export interface TransactionOptions {
  /**
   * How long to wait for another connection's write lock, in all, in milliseconds, in place of the adapter's default.
   * Core's claim renewal passes the 15 s lapse; nothing else sets it.
   */
  readonly waitMs?: number;
}

/** A bound data adapter; handlers always open a transaction before operations. */
export interface DataLayer {
  /**
   * Names the database this layer opens, the same for every layer object over it (data-sqlite: the file's absolute
   * path); left out when no other layer object can open it (`:memory:`). Core keeps the deliverer's process-side state
   * and the subscription registry per database by it, and names it in the claim's errors.
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
   * made after the outer transaction settled starts a new one.
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
  /** Release the adapter's connection and other owned handles. Rejects while
   * transactions are running or queued, leaving the layer open. Idempotent.
   * Releases handles only: a later transaction must open the layer again, on the
   * same storage (so `disconnect()` then `connect()` reuses the configured layer).
   */
  close(): Promise<void>;
}
