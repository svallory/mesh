import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { is, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { drizzleOperations } from "@mesh/data-drizzle";
import { FrameworkError, type DataLayer, type DataOperations, type TableHandle } from "@mesh/runtime";

export interface SQLiteOptions { readonly file: string }
export interface SQLiteLayer extends DataLayer {
  readonly adapter: "sqlite";
  readonly build: "@mesh/data-sqlite/build";
  readonly options: SQLiteOptions;
  /** Transactions are serialised per connection and await the callback before commit.
   * Nested transactions are unsupported. There is no callback timeout: a callback
   * that never settles holds the queue; close rejects with running/queued counts
   * and leaves the layer open rather than rolling back under a running callback.
   * A failed rollback is fatal: queued and later work rejects until the caller
   * closes this layer and creates a new one. Other failures release the queue.
   */
  transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T>;
}

export function sqliteTable(handle: TableHandle): SQLiteTable {
  if (!is(handle, SQLiteTable)) throw new FrameworkError("Expected a Drizzle SQLite table from the emitted schema");
  return handle;
}

interface State {
  exclusive<T>(run: (db: BunSQLiteDatabase) => Promise<T>): Promise<T>;
}
const states = new WeakMap<DataLayer, State>();

/** Internal bridge for schema preparation: uses the same queue and connection. */
export function sqliteState(layer: DataLayer): State {
  const state = states.get(layer);
  if (!state) throw new FrameworkError("createSchema requires a data layer made by sqlite()");
  return state;
}

function connectionError(operation: string, file: string, cause: unknown): FrameworkError {
  const seen = new Set<object>();
  let current = cause;
  let busy = false;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "SQLITE_BUSY") busy = true;
    current = "cause" in current ? current.cause : undefined;
  }
  const advice = busy
    ? " The queue serialises one layer only; another connection holds the write lock. The caller decides whether to retry."
    : " Check the database path, permissions and connection state.";
  return new FrameworkError(`Cannot ${operation} for SQLite file ${JSON.stringify(file)}.${advice}`, { cause });
}

export function sqlite(options: SQLiteOptions): SQLiteLayer {
  if (!options || typeof options.file !== "string" || options.file.length === 0) {
    throw new FrameworkError('sqlite requires a non-empty file; pass { file: ":memory:" } or a database path');
  }
  const configured = Object.freeze({ file: options.file });
  let connection: Database | undefined;
  let db: BunSQLiteDatabase | undefined;
  let closed = false;
  let unusable: { transaction: unknown; rollback: unknown } | undefined;
  const healthError = () => unusable === undefined ? undefined : new FrameworkError(
    "this data layer is unusable: a rollback failed, so its connection may still be inside a transaction. Close it and create a new one.",
    { cause: unusable },
  );
  let running = 0;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();
  const context = new AsyncLocalStorage<{ active: boolean }>();
  const assertOpen = () => { if (closed) throw new FrameworkError("SQLite data layer is closed; create a new layer"); };
  const state: State = {
    exclusive(run) {
      assertOpen();
      const fatal = healthError();
      if (fatal) return Promise.reject(fatal);
      if (context.getStore()?.active) throw new FrameworkError("nested transactions are not supported");
      queued++;
      const work = tail.then(async () => {
        queued--;
        running++;
        const token = { active: true };
        try {
          const fatal = healthError();
          if (fatal) throw fatal;
          if (!db) {
            try {
              connection = new Database(configured.file);
              db = drizzle(connection);
            } catch (cause) { throw connectionError("open a connection", configured.file, cause); }
          }
          return await context.run(token, () => run(db!));
        } finally { token.active = false; running--; }
      });
      // Consume the queue link's rejection, not the caller's result. A failed
      // transaction releases the next one without changing the error it receives.
      tail = work.then(() => undefined, () => undefined);
      return work;
    },
  };
  const layer: SQLiteLayer = {
    adapter: "sqlite", build: "@mesh/data-sqlite/build", options: configured,
    transaction(run) {
      return state.exclusive(async (database) => {
        try { database.run(sql.raw("BEGIN IMMEDIATE")); }
        catch (cause) { throw connectionError("run BEGIN IMMEDIATE", configured.file, cause); }
        let active = true;
        const operations = drizzleOperations({
          table: sqliteTable,
          insert: (table, row) => database.insert(table).values(row).returning().get()!,
          select: (table, condition) => database.select().from(table).where(condition).all(),
          update: (table, condition, changes) => database.update(table).set(changes).where(condition).returning().all(),
          delete: (table, condition) => database.delete(table).where(condition).returning().all(),
        }, () => { if (!active) throw new FrameworkError("Transaction operations are no longer active"); });
        try {
          const result = await run(operations);
          active = false;
          database.run(sql.raw("COMMIT"));
          return result;
        } catch (cause) {
          active = false;
          try { database.run(sql.raw("ROLLBACK")); }
          catch (rollback) {
            unusable = { transaction: cause, rollback };
            throw new FrameworkError("Transaction failed and ROLLBACK failed", { cause: unusable });
          }
          throw cause;
        } finally { active = false; }
      });
    },
    async close() {
      if (closed) return;
      if (running || queued) throw new FrameworkError(`Cannot close SQLite data layer: ${running} running and ${queued} queued; wait for transactions to settle`);
      connection?.close();
      closed = true;
    },
  };
  states.set(layer, state);
  return Object.freeze(layer);
}
