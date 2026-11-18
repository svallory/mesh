import { Database } from "bun:sqlite";
import { count, getTableName, max, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { ClaimRowOrder, drizzleOperations, drizzleTable, serialTransactions, type Deadline } from "@meshfw/data-drizzle";
import { CORE_TABLE_NAMES, DatabaseBusyError, FrameworkError, MeshError, defineCapabilities, type CapabilityManifest, type DataAdapter, type DataLayer, type ClaimRenewalOptions, type DataOperations, type OutboxOperations, type Row, type TableHandle, type TransactionOptions } from "@meshfw/runtime";
import { resolve } from "node:path";
import { sqliteDialect } from "./dialect.ts";
import { deliveryOperations, failureOperations, multiProcessOperations, renewClaimStatement, renewProcessStatement } from "./delivery.ts";
import { appendEvent, deleteOutboxThrough, readOutbox } from "./outbox.ts";
import { rawQuery } from "./raw-query.ts";

/** How many `:memory:` layers this process made: each names its private database `:memory: #<n>`. */
let memoryLayers = 0;

/** What this adapter supports beyond the mandatory set, as static data (ADR-0013). */
export const capabilities: CapabilityManifest = defineCapabilities("sqlite", ["aggregates", "integer-key-fill", "gapless-positions", "conditions", "joins", "raw-sql", "policy-guards"]);

// A type alias, not an interface, so it satisfies `DataAdapter.options` (an index signature).
export type SQLiteOptions = { readonly file: string };
/**
 * What `sqlite()` returns: one frozen value that is both the data adapter a
 * project names in `mesh.config.ts` and that adapter's run-time data layer.
 * Building reads the descriptor fields only; no connection opens until the
 * first transaction (or `createSchema`).
 */
export interface SQLiteLayer extends DataAdapter, DataLayer {
  /**
   * The outbox read: one statement, run as one job in this layer's queue after any running transaction, without
   * `BEGIN IMMEDIATE`, so it takes no write lock and sees committed rows only. Inside a transaction it is refused.
   */
  readOutbox: OutboxOperations["readOutbox"];
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

/** An entity's table; the outbox's tables are core's and reached through the outbox operations only. */
function entityTable(handle: TableHandle): SQLiteTable {
  const table = sqliteTable(handle);
  const name = getTableName(table);
  if (CORE_TABLE_NAMES.has(name)) throw new FrameworkError(`The table ${name} is Mesh's own: the outbox is written by publish and read through rows() and readEvents, never through data operations`);
  return table;
}

interface State {
  /**
   * Runs `run` alone on the connection, opening it first. The open's switch to WAL waits for a lock, within the one
   * deadline of the call, which `run` receives; schema preparation does not use it and fails at once on a lock.
   */
  exclusive<T>(run: (db: BunSQLiteDatabase, deadline: Deadline) => Promise<T>, options?: WaitOptions): Promise<T>;
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

/**
 * True when the error is SQLite saying another connection holds a lock, or wraps one that does (Drizzle wraps what
 * `bun:sqlite` throws). The walk stops at a Mesh error: whatever Mesh already reports is not rewritten.
 */
function isBusy(cause: unknown): boolean {
  const seen = new Set<object>();
  let current = cause;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof MeshError) return false;
    seen.add(current);
    if ("code" in current && typeof current.code === "string" && (current.code.startsWith("SQLITE_BUSY") || current.code.startsWith("SQLITE_LOCKED"))) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** The error a caller gets for a raw busy failure that is not retried: `MESH_DATABASE_BUSY`, never the SQLite error. A Mesh error passes unchanged. */
function reportBusy(cause: unknown, file: string): unknown {
  return isBusy(cause) ? new DatabaseBusyError(file, 0, { cause }) : cause;
}

function connectionError(operation: string, file: string, cause: unknown): unknown {
  if (cause instanceof MeshError) return cause;
  if (isBusy(cause)) return new DatabaseBusyError(file, 0, { cause });
  return new FrameworkError(`Cannot ${operation} for SQLite file ${JSON.stringify(file)}. Check the database path, permissions and connection state.`, { cause });
}

/**
 * Runs `attempt`, and while it fails with SQLITE_BUSY awaits a short sleep and runs it again until the deadline. The
 * sleep is a timer, so the process's other work goes on; a synchronous SQLite wait would stop all of it. The
 * error's wait is the time since the deadline's start, so it is the total of the call.
 */
async function retryWhileBusy<T>(file: string, deadline: Deadline, attempt: () => T): Promise<T> {
  let sleep = FIRST_SLEEP_MS;
  for (;;) {
    try { return attempt(); }
    catch (cause) {
      if (!isBusy(cause)) throw cause;
      const now = performance.now();
      // At least 1 ms, so a wait is never worded as "not retried" (0 is for statements that are not retried).
      if (now >= deadline.at) throw new DatabaseBusyError(file, Math.max(1, Math.round(now - deadline.started)), { cause });
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(sleep, deadline.at - now)));
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
  /** Opens the connection; a file database is put in WAL mode, which is a write, so it waits for a lock like BEGIN does. */
  const open = async (deadline: Deadline) => {
    let opened: Database | undefined;
    try {
      opened = new Database(configured.file);
      if (configured.file !== ":memory:") {
        const mode = await retryWhileBusy(configured.file, deadline, () => opened!.query("PRAGMA journal_mode=WAL").get() as { journal_mode?: string } | null);
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
  /** A statement of a running transaction: a lock it meets is reported as `MESH_DATABASE_BUSY` where it happens, not retried. */
  function busy<T>(statement: () => T): T {
    try { return statement(); } catch (cause) { throw reportBusy(cause, configured.file); }
  }
  /**
   * The order between `renewClaim` and this layer's transactions, each of which holds the one write lock the renewal
   * needs (mesh-yd0i): `BEGIN IMMEDIATE` waits for a renewal in flight, and a renewal waits for the running transaction
   * in the process, not in a busy retry, so the wait does not count toward the lapse and the queue's next transaction
   * never takes the lock from under a polling renewal.
   */
  const claimOrder = new ClaimRowOrder();
  // One connection, opened on first use and kept until close(); a failed statement leaves the transaction usable, so
  // this driver never records one through `failed`.
  const queue = serialTransactions<BunSQLiteDatabase>({
    health: healthError,
    async acquire(deadline) {
      if (!db) await open(deadline);
      return db!;
    },
    release() { claimOrder.end(); },
    async begin(database, deadline) {
      await claimOrder.take();
      await retryWhileBusy(configured.file, deadline, () => database.run(sql.raw("BEGIN IMMEDIATE")));
    },
    operations: (database, guard) => ({ ...drizzleOperations({
      dialect: sqliteDialect,
      table: entityTable,
      insert: (table, row) => busy(() => database.insert(table).values(row).returning().get()!),
      select: (table, options) => busy(() => {
        let query = database.select().from(table).$dynamic();
        if (options?.where) query = query.where(options.where);
        if (options?.orderBy?.length) query = query.orderBy(...options.orderBy);
        // SQLite has no OFFSET without LIMIT; Drizzle drops a negative limit, so use the largest safe integer.
        if (options?.limit !== undefined || options?.offset !== undefined) query = query.limit(options.limit ?? Number.MAX_SAFE_INTEGER);
        if (options?.offset !== undefined) query = query.offset(options.offset);
        return query.all();
      }),
      aggregate: (table, kind, column, where) => busy(() => {
        const query = database.select({ value: kind === "max" ? max(column) : count(column) }).from(table).$dynamic();
        return (where ? query.where(where) : query).get()?.value ?? null;
      }),
      update: (table, condition, changes) => busy(() => database.update(table).set(changes).where(condition).returning().all()),
      delete: (table, condition) => busy(() => database.delete(table).where(condition).returning().all()),
      rows: (statement) => busy(() => database.all<Row>(statement)),
    }, guard, capabilities),
      appendEvent: async (row) => { guard(); return busy(() => appendEvent(connection!, row)); },
      deleteOutboxThrough: async (position) => { guard(); return busy(() => deleteOutboxThrough(connection!, position)); },
      query: async (statement) => { guard(); return busy(() => rawQuery(connection!, statement)); },
      ...deliveryOperations(() => connection!, (statement) => { guard(); return busy(statement); }),
      ...multiProcessOperations(() => connection!, (statement) => { guard(); return busy(statement); }),
      ...failureOperations(() => connection!, (statement) => { guard(); return busy(statement); }),
    }),
    async commit(database) {
      database.run(sql.raw("COMMIT"));
    },
    async rollback(database, cause) {
      try { database.run(sql.raw("ROLLBACK")); }
      catch (rollback) {
        unusable = { transaction: cause, rollback };
        throw new FrameworkError("Transaction failed and ROLLBACK failed", { cause: unusable });
      }
    },
    report: (cause, stage) => stage === "begin" ? connectionError("run BEGIN IMMEDIATE", configured.file, cause) : reportBusy(cause, configured.file),
  }, defaultWaitMs);
  /**
   * The connection renewals run on (`DataLayer.renewClaim` and `DataLayer.renewProcess`), a file database's only:
   * opened on the first renewal and kept until close(). One renewal at a time; each is one autocommit statement, so it
   * holds the write lock for that statement only. It waits for the lock (held by another connection's transaction, this
   * layer's included) with the awaited retry `BEGIN IMMEDIATE` uses, until its deadline, and never behind this layer's
   * queue.
   */
  let renewalConnection: Database | undefined;
  let renewing: Promise<unknown> = Promise.resolve();
  const renewOnce = async (statement: (conn: Database) => boolean, deadline: number): Promise<boolean> => {
    const started = performance.now();
    const within: Deadline = { started, at: started + Math.max(0, deadline - Date.now()) };
    if (!renewalConnection) {
      try { renewalConnection = new Database(configured.file); }
      catch (cause) { throw connectionError("open the renewal connection", configured.file, cause); }
    }
    const conn = renewalConnection;
    return retryWhileBusy(configured.file, within, () => statement(conn));
  };
  /** One renewal on the renewal connection; `turn` (the claim's: `ClaimRowOrder`) runs when its turn came and may move the deadline. */
  const renewOutside = (method: string, statement: (conn: Database) => boolean, deadline: number, turn?: (deadline: number) => Promise<number>): Promise<boolean> => {
    // Its own connection would wait for this transaction's write lock, which is held until the renewal gives up.
    if (queue.insideTransaction()) {
      return Promise.reject(new FrameworkError(`${method} cannot run inside a transaction of this layer: it renews on a connection of its own, which waits for the write lock this transaction holds`));
    }
    const run = renewing.then(async () => renewOnce(statement, turn ? await turn(deadline) : deadline));
    renewing = run.catch(() => undefined);
    return run;
  };
  const state: State = {
    exclusive: (run, waitOptions) => queue.exclusive(run, waitOptions),
    transaction: (run, waitOptions) => queue.transaction(run, waitOptions),
  };
  const layer: SQLiteLayer = {
    kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: configured,
    // Every layer object over one file names it alike, so core keeps one deliverer and one subscription registry per
    // file; a `:memory:` database is private to its layer object, so each gets a name of its own.
    database: configured.file === ":memory:" ? `:memory: #${++memoryLayers}` : resolve(configured.file),
    transaction(run, options?: TransactionOptions) { return queue.transaction(run, options?.waitMs === undefined ? undefined : { waitMs: options.waitMs }); },
    readOutbox(after, limit) {
      // A statement sent on this connection while a transaction is open would see that transaction's uncommitted rows;
      // inside one, the read is refused rather than queued behind the transaction that is waiting for it.
      if (queue.insideTransaction()) {
        return Promise.reject(new FrameworkError("The outbox cannot be read inside a transaction: the read sees committed rows only, and a transaction's own events come from published() (from #mesh)"));
      }
      return queue.exclusive(async () => busy(() => readOutbox(connection!, after, limit)));
    },
    ...(configured.file === ":memory:" ? {} : {
      renewProcess(runId: string, lapseMs: number, options: { readonly deadline: number }): Promise<boolean> {
        return renewOutside("renewProcess", (conn) => renewProcessStatement(conn, runId, lapseMs), options.deadline);
      },
      renewClaim(runId: string, generation: number, options: ClaimRenewalOptions): Promise<boolean> {
        return claimOrder.renew((turn) => renewOutside("renewClaim", (conn) => renewClaimStatement(conn, runId, generation), options.deadline, turn), options.onHeld);
      },
    }),
    refuseIfFailed: () => queue.refuseIfFailed(),
    async close() {
      const { running, queued } = queue.counts();
      if (running || queued) throw new FrameworkError(`Cannot close SQLite data layer: ${running} running and ${queued} queued; wait for transactions to settle`);
      await renewing;
      renewalConnection?.close();
      renewalConnection = undefined;
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
  states.set(layer, state);
  return Object.freeze(layer);
}
