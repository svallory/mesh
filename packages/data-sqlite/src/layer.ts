import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { count, max, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { drizzleOperations, drizzleTable } from "@meshfw/data-drizzle";
import { DatabaseBusyError, FrameworkError, defineCapabilities, type CapabilityManifest, type DataAdapter, type DataLayer, type DataOperations, type TableHandle } from "@meshfw/runtime";

/** What this adapter supports beyond the mandatory set, as static data (ADR-0013). */
export const capabilities: CapabilityManifest = defineCapabilities("sqlite", ["aggregates", "integer-key-fill"]);

// A type alias, not an interface, so it satisfies `DataAdapter.options` (an index signature).
export type SQLiteOptions = { readonly file: string };
/**
 * What `sqlite()` returns: one frozen value that is both the data adapter a
 * project names in `mesh.config.ts` and that adapter's run-time data layer.
 * Building reads the descriptor fields only; no connection opens until the
 * first transaction (or `createSchema`).
 */
export interface SQLiteLayer extends DataAdapter, DataLayer {
  readonly kind: "data-adapter";
  readonly name: "sqlite";
  readonly build: "@meshfw/data-sqlite/build";
  readonly capabilities: CapabilityManifest;
  readonly options: SQLiteOptions;
  /** Transactions are serialised per connection and await the callback before commit.
   * A call inside a running transaction joins it (see `DataLayer.transaction`), calls joined to one transaction
   * run one at a time, and once one of them failed the later ones are refused. There is no callback timeout: a callback
   * that never settles holds the queue; close rejects with running/queued counts
   * and leaves the layer open rather than rolling back under a running callback.
   * A failed rollback is fatal: queued and later work rejects until the caller
   * closes this layer. For a file database, the reopened connection can still find
   * the file locked until the old native handle is finalised by garbage collection
   * (Bun.gc(true) forces it); until then a transaction fails with `DatabaseBusyError`.
   * When another connection holds the write lock, `BEGIN IMMEDIATE` is retried after an awaited sleep for up to
   * 5 s in all (`busy_timeout` stays 0, since SQLite's own wait would freeze the process), then fails with
   * `DatabaseBusyError` (`MESH_DATABASE_BUSY`). A file database is put in WAL mode when it opens. Any other
   * SQLITE_BUSY is reported as `DatabaseBusyError` too, without a retry.
   * close() drops the native handle and
   * its prepared statements, so a file database's write lock is released once that
   * handle is finalised (immediately after one Bun.gc(true), or at process exit).
   * Other failures release the queue. After close() the layer is unopened again:
   * the next transaction (or createSchema) opens a new connection to the same file,
   * so a `:memory:` database starts empty.
   */
  transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T>;
}

export function sqliteTable(handle: TableHandle): SQLiteTable {
  return drizzleTable(handle, SQLiteTable, "SQLite");
}

/** The running transaction: `operations` is set once BEGIN succeeded, and `active` ends with the outer call. */
interface Token { active: boolean; operations?: DataOperations; failed?: { cause: unknown } }

/**
 * Where a call runs: the outer transaction's callback, or one call joined to it. Each frame queues the calls joined
 * from it, so calls joined to one transaction run one at a time. A call joined from inside another queues on that
 * call's frame, not on the one it waits in, so it never waits for itself.
 */
interface Frame { readonly token: Token; tail: Promise<void> }

/** What a call that joins a transaction a joined call already failed gets instead of running. */
function refusal(failed: { cause: unknown }): FrameworkError {
  return new FrameworkError("A call joined a transaction that an earlier joined call failed, so it was refused before it ran: the transaction rolls back", { cause: failed.cause });
}

interface State {
  /** Runs `run` alone on the connection, opening it first. Schema preparation uses it and never waits for a lock. */
  exclusive<T>(run: (db: BunSQLiteDatabase, token: Token, waitMs: number) => Promise<T>, options?: WaitOptions): Promise<T>;
  /** `layer.transaction` with an internal option: how long to wait for the write lock. */
  transaction<T>(run: (tx: DataOperations) => Promise<T>, options?: WaitOptions): Promise<T>;
}
const states = new WeakMap<DataLayer, State>();

/** Internal bridge for schema preparation: uses the same queue and connection. */
export function sqliteState(layer: DataLayer, caller = "createSchema"): State {
  const state = states.get(layer);
  if (!state) throw new FrameworkError(`${caller} requires a data layer made by sqlite()`);
  return state;
}

/** How long a transaction waits for another connection's write lock, in all. Below the 15 s claim lapse of the events spec. */
const DEFAULT_WAIT_MS = 5000;
const FIRST_SLEEP_MS = 1;
const LONGEST_SLEEP_MS = 50;

/** Internal settings of one layer; `sqlite()` uses the defaults. */
export interface Tuning {
  /** The wait for a lock, in all, in milliseconds. */
  readonly waitMs?: number;
}

/** Per-call internal options: a caller that needs a longer wait than the default passes it (the claim renewal of M6 PR 3). */
export interface WaitOptions {
  readonly waitMs?: number;
}

/** True when the error, or anything in its cause chain, is SQLite saying another connection holds a lock. */
function isBusy(cause: unknown): boolean {
  const seen = new Set<object>();
  let current = cause;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string" && (current.code.startsWith("SQLITE_BUSY") || current.code.startsWith("SQLITE_LOCKED"))) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** The error a caller gets for a raw busy failure that is not retried: `MESH_DATABASE_BUSY`, never the SQLite error. */
function reportBusy(cause: unknown, file: string): unknown {
  return cause instanceof DatabaseBusyError || !isBusy(cause) ? cause : new DatabaseBusyError(file, 0, { cause });
}

function connectionError(operation: string, file: string, cause: unknown): unknown {
  if (cause instanceof DatabaseBusyError) return cause;
  if (isBusy(cause)) return new DatabaseBusyError(file, 0, { cause });
  return new FrameworkError(`Cannot ${operation} for SQLite file ${JSON.stringify(file)}. Check the database path, permissions and connection state.`, { cause });
}

/**
 * Runs `attempt`, and while it fails with SQLITE_BUSY awaits a short sleep and runs it again, for `waitMs` in all. The
 * sleep is a timer, so the process's other work goes on; a synchronous SQLite wait would stop all of it.
 */
async function retryWhileBusy<T>(file: string, waitMs: number, attempt: () => T): Promise<T> {
  const started = performance.now();
  let sleep = FIRST_SLEEP_MS;
  for (;;) {
    try { return attempt(); }
    catch (cause) {
      if (!isBusy(cause)) throw cause;
      const waited = performance.now() - started;
      if (waited >= waitMs) throw new DatabaseBusyError(file, Math.round(waited), { cause });
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(sleep, waitMs - waited)));
      sleep = Math.min(sleep * 2, LONGEST_SLEEP_MS);
    }
  }
}

export function sqlite(options: SQLiteOptions): SQLiteLayer {
  return sqliteWith(options, {});
}

/** `sqlite()` with internal settings; tests use it to shorten the wait for a lock. Not exported from the package. */
export function sqliteWith(options: SQLiteOptions, tuning: Tuning): SQLiteLayer {
  if (!options || typeof options.file !== "string" || options.file.trim().length === 0) {
    throw new FrameworkError('sqlite requires a non-empty file; pass { file: ":memory:" } or a database path');
  }
  const configured = Object.freeze({ file: options.file });
  const defaultWaitMs = tuning.waitMs ?? DEFAULT_WAIT_MS;
  let connection: Database | undefined;
  let db: BunSQLiteDatabase | undefined;
  let unusable: { transaction: unknown; rollback: unknown } | undefined;
  const healthError = () => unusable === undefined ? undefined : new FrameworkError(
    "this data layer is unusable: a rollback failed, so its connection may still be inside a transaction. Close it; the next transaction opens a new connection, which for a file database can find the file locked until the old connection is garbage-collected.",
    { cause: unusable },
  );
  let running = 0;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();
  const context = new AsyncLocalStorage<Frame>();
  /** Opens the connection; a file database is put in WAL mode, which is a write, so it waits for a lock like BEGIN does. */
  const open = async (waitMs: number) => {
    let opened: Database | undefined;
    try {
      opened = new Database(configured.file);
      if (configured.file !== ":memory:") {
        const mode = await retryWhileBusy(configured.file, waitMs, () => opened!.query("PRAGMA journal_mode=WAL").get() as { journal_mode?: string } | null);
        if (mode?.journal_mode?.toLowerCase() !== "wal") {
          throw new FrameworkError(`Cannot switch SQLite file ${JSON.stringify(configured.file)} to WAL mode: the database answered ${JSON.stringify(mode?.journal_mode ?? null)}. Mesh runs file databases in WAL mode only`);
        }
      }
      connection = opened;
      db = drizzle(opened);
    } catch (cause) {
      try { opened?.close(); } catch { /* the open failed already; the first error is the one to report */ }
      throw cause instanceof FrameworkError || cause instanceof DatabaseBusyError ? cause : connectionError("open a connection", configured.file, cause);
    }
  };
  const state: State = {
    exclusive(run, waitOptions) {
      const waitMs = waitOptions?.waitMs ?? defaultWaitMs;
      const fatal = healthError();
      if (fatal) return Promise.reject(fatal);
      if (context.getStore()?.token.active) throw new FrameworkError("nested transactions are not supported");
      queued++;
      const work = tail.then(async () => {
        queued--;
        running++;
        const token: Token = { active: true };
        try {
          const fatal = healthError();
          if (fatal) throw fatal;
          if (!db) await open(waitMs);
          try { return await context.run({ token, tail: Promise.resolve() }, () => run(db!, token, waitMs)); }
          catch (cause) { throw reportBusy(cause, configured.file); }
        } finally { token.active = false; running--; }
      });
      // Consume the queue link's rejection, not the caller's result. A failed
      // transaction releases the next one without changing the error it receives.
      tail = work.then(() => undefined, () => undefined);
      return work;
    },
    transaction: (run, waitOptions) => transactionWith(run, waitOptions),
  };
  const layer: SQLiteLayer = {
    kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: configured,
    transaction(run) { return transactionWith(run, undefined); },
    refuseIfFailed() {
      // The same test as the join in `transaction`: true exactly when a call made here would join.
      const token = context.getStore()?.token;
      if (!token?.active || !token.operations) return false;
      if (token.failed) throw refusal(token.failed);
      return true;
    },
    async close() {
      if (running || queued) throw new FrameworkError(`Cannot close SQLite data layer: ${running} running and ${queued} queued; wait for transactions to settle`);
      connection?.close();
      // Drop both references. Drizzle holds prepared statements, and a live
      // statement keeps the native close of a connection with an open
      // transaction pending, which leaves a file database locked. Releasing
      // them lets the deferred close finish and the lock go.
      connection = undefined;
      db = undefined;
      // The connection that may have been inside a transaction is gone with it.
      unusable = undefined;
    },
  };
  function transactionWith<T>(run: (tx: DataOperations) => Promise<T>, waitOptions: WaitOptions | undefined): Promise<T> {
    const frame = context.getStore();
    if (frame?.token.active && frame.token.operations) {
      // Joined calls run one at a time: this call waits for the ones joined before it from the same frame, so two
      // read-then-write calls on one row cannot both read before either writes. It runs in a frame of its own.
      // Rollback-only: a joined call that fails poisons the whole transaction, even if the
      // outer callback catches the error, so a half-done inner call can never commit.
      // Fail fast: once a joined call failed, a call that joins afterwards is refused before its callback runs, at
      // once or, if it was queued before the failure, when its turn comes.
      const { token } = frame;
      if (token.failed) return Promise.reject(refusal(token.failed));
      const operations = frame.token.operations;
      const work = frame.tail.then(() => {
        if (!token.active) throw new FrameworkError("A call joined a transaction that ended before the call's turn came: await every call joined to a transaction before its callback returns");
        if (token.failed) throw refusal(token.failed);
        // Inside then, so a callback that throws before returning a promise is caught too.
        return context.run({ token, tail: Promise.resolve() }, () => run(operations));
      }).catch((cause: unknown) => { token.failed ??= { cause }; throw cause; });
      frame.tail = work.then(() => undefined, () => undefined);
      return work;
    }
    return state.exclusive(async (database, token, waitMs) => {
      // The queue is held while this waits, so a write begins only after the one before it has committed.
      try { await retryWhileBusy(configured.file, waitMs, () => database.run(sql.raw("BEGIN IMMEDIATE"))); }
      catch (cause) { throw connectionError("run BEGIN IMMEDIATE", configured.file, cause); }
      let active = true;
      const operations = drizzleOperations({
        table: sqliteTable,
        insert: (table, row) => database.insert(table).values(row).returning().get()!,
        select: (table, options) => {
          let query = database.select().from(table).$dynamic();
          if (options?.where) query = query.where(options.where);
          if (options?.orderBy?.length) query = query.orderBy(...options.orderBy);
          // SQLite has no OFFSET without LIMIT; Drizzle drops a negative limit, so use the largest safe integer.
          if (options?.limit !== undefined || options?.offset !== undefined) query = query.limit(options.limit ?? Number.MAX_SAFE_INTEGER);
          if (options?.offset !== undefined) query = query.offset(options.offset);
          return query.all();
        },
        aggregate: (table, kind, column, where) => {
          const query = database.select({ value: kind === "max" ? max(column) : count(column) }).from(table).$dynamic();
          return (where ? query.where(where) : query).get()?.value ?? null;
        },
        update: (table, condition, changes) => database.update(table).set(changes).where(condition).returning().all(),
        delete: (table, condition) => database.delete(table).where(condition).returning().all(),
      }, () => { if (!active) throw new FrameworkError("Transaction operations are no longer active"); });
      token.operations = operations;
      try {
        const result = await run(operations);
        active = false;
        token.active = false; // a call from here on starts a new transaction instead of joining
        if (token.failed) {
          throw new FrameworkError("A call joined to this transaction failed, so the transaction is rolled back even though its callback caught the error", { cause: token.failed.cause });
        }
        database.run(sql.raw("COMMIT"));
        return result;
      } catch (cause) {
        active = false;
        token.active = false;
        try { database.run(sql.raw("ROLLBACK")); }
        catch (rollback) {
          unusable = { transaction: cause, rollback };
          throw new FrameworkError("Transaction failed and ROLLBACK failed", { cause: unusable });
        }
        throw cause;
      } finally { active = false; }
    }, waitOptions);
  }
  states.set(layer, state);
  return Object.freeze(layer);
}
