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

/** Contract v0: operations are available only inside a transaction. Replaced in M3. */
export interface DataOperations {
  /** Insert a row and return its stored representation in TypeScript values. */
  insert(table: TableHandle, row: Row): Promise<Row>;
  /** Find one row by primary key, or undefined when absent. */
  selectByKey(table: TableHandle, key: Key): Promise<Row | undefined>;
  /** Return every row in this entity's storage; order is unspecified. */
  selectAll(table: TableHandle): Promise<Row[]>;
  /** Apply changes and return the stored row, or undefined when absent. */
  updateByKey(table: TableHandle, key: Key, changes: Row): Promise<Row | undefined>;
  /** Delete one row, returning false when absent. */
  deleteByKey(table: TableHandle, key: Key): Promise<boolean>;
}

/** A bound data adapter; handlers always open a transaction before operations. */
export interface DataLayer {
  /** Runs run in one transaction: commits when it resolves, rolls back and rethrows when it rejects.
   * One transaction runs at a time per layer; unrelated concurrent calls queue, and
   * a failed transaction does not block the queue unless its own rollback failed, which
   * makes the layer unusable: queued and later calls reject and only close() works.
   * A nested call from inside a running transaction is an error.
   */
  transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T>;
  /** Release the adapter's connection and other owned handles. Rejects while
   * transactions are running or queued, leaving the layer open. Idempotent.
   * Releases handles only: a later transaction may reopen the layer on the same
   * storage (so `disconnect()` then `connect()` reuses the configured layer).
   */
  close(): Promise<void>;
}
