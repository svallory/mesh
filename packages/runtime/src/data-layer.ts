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
 * `and` or `or` therefore cannot be filtered.
 */
export type Filter =
  | { readonly and: readonly Filter[] }
  | { readonly or: readonly Filter[] }
  | { readonly [attribute: string]: Comparison };

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
}

/** A bound data adapter; handlers always open a transaction before operations. */
export interface DataLayer {
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
   * inner failure cannot be undone alone. Joined calls run one at a time: calls joined from
   * the same callback (siblings started together, as with Promise.all) run in the order they
   * were made, each after the one before it settled, so two read-then-write calls on one row
   * cannot both read before either writes. A call joined from inside a joined call queues
   * behind that call's own joined calls only, so nesting never waits for itself. Joining
   * follows async context, so a detached promise started inside the callback joins it too;
   * one whose turn comes after the outer call settled rejects with a FrameworkError. A call
   * made after the outer transaction settled starts a new one.
   */
  transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T>;
  /** Release the adapter's connection and other owned handles. Rejects while
   * transactions are running or queued, leaving the layer open. Idempotent.
   * Releases handles only: a later transaction must open the layer again, on the
   * same storage (so `disconnect()` then `connect()` reuses the configured layer).
   */
  close(): Promise<void>;
}
