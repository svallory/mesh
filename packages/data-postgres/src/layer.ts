import { SQL as BunSQL, type ReservedSQL } from "bun";
import { count, getTableColumns, getTableName, is, max, sql, SQL as DrizzleSQL, type Column, type SQL } from "drizzle-orm";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { PgJsonb, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { drizzleOperations, drizzleTable, serialTransactions, type Deadline } from "@meshfw/data-drizzle";
import { CORE_TABLE_NAMES, FrameworkError, defineCapabilities, type CapabilityManifest, type DataAdapter, type DataLayer, type DataOperations, type Filter, type OutboxOperations, type Row, type TableHandle, type TransactionOptions } from "@meshfw/runtime";
import { deliveryOperations } from "./delivery.ts";
import { postgresDialect } from "./dialect.ts";
import { mapPostgresError, type Stage } from "./errors.ts";
import { appendEvent, deleteOutboxThrough, OutboxReader, outboxChannel, outboxLockKey, outboxSequence, type Appender, type Query } from "./outbox.ts";

/**
 * What this adapter supports beyond the mandatory set, as static data (ADR-0013). No `gapless-positions`: on Postgres
 * it would cost a lock held from the first publish to the commit.
 */
export const capabilities: CapabilityManifest = defineCapabilities("postgres", ["aggregates", "integer-key-fill", "conditions", "joins"]);

// A type alias, not an interface, so it satisfies `DataAdapter.options` (an index signature).
export type PostgresOptions = { readonly url: string | undefined };

/**
 * What `postgres()` returns: one frozen value that is both the data adapter a project names in `mesh.config.ts` and
 * that adapter's run-time data layer. Building reads the descriptor fields only, so `url` may be undefined while the
 * project builds; nothing connects until the first transaction, `readOutbox` or `createSchema`, each of which throws a
 * `FrameworkError` when `url` is missing (`mesh db push` exits 1 with the same advice).
 */
export interface PostgresLayer extends DataAdapter, DataLayer {
  readonly kind: "data-adapter";
  readonly name: "postgres";
  readonly build: "@meshfw/data-postgres/build";
  readonly capabilities: CapabilityManifest;
  readonly options: PostgresOptions;
  /** `postgres://<host>:<port>/<database>`, with no credentials or query; undefined while `url` is missing or unreadable. */
  readonly database?: string;
  /**
   * Transactions run one at a time per layer, each on a connection reserved from the layer's pool, at `SERIALIZABLE`,
   * waiting at most 5 s for any one lock (`lock_timeout`; `options.waitMs` in its place). A call inside a running
   * transaction joins it, with the rollback-only and fail-fast rules of `DataLayer.transaction`. A failed statement
   * aborts a Postgres transaction, so once one failed the outer call rejects even if the callback caught the failure:
   * with that failure when it is transient (`DatabaseBusyError`), else with a `FrameworkError` whose cause is the
   * failure; the call resolves only when `COMMIT` reported `COMMIT`. Transient failures (a serialization failure, a
   * deadlock, a lock wait that timed out, a lost connection, a server that did not answer) are `DatabaseBusyError` with
   * `reason` and `sqlstate`; a connection lost during `COMMIT` has `retryable: false`. A rollback that fails closes
   * its connection, and the layer stays usable. close() rejects while transactions run or queue; afterwards the layer
   * is unopened again and the next transaction opens a new pool.
   */
  transaction<T>(run: (tx: DataOperations) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /**
   * The outbox read (the reader rule, `src/outbox.ts`): three statements (the sequence sample, the appenders' xids from
   * `pg_locks`, the row read; one more on the first read, to resolve the sequence) on a connection of its own, outside
   * the transaction queue, each in its own autocommit transaction at the server's default isolation, one read at a
   * time per layer. A page holds only rows at or below its
   * `settled` position, below which every transaction that took a position has ended, so a row that commits later is
   * never below a row a read returned. Refused inside a transaction.
   */
  readOutbox: OutboxOperations["readOutbox"];
}

/** Internal settings of one layer; `postgres()` uses the defaults. Not exported from the package: tests use it. */
export interface Tuning {
  /** The longest wait for any one lock, in milliseconds. */
  readonly waitMs?: number;
  /**
   * A Postgres schema other than `public` that every transaction runs in (`search_path`), so each test gets its own
   * tables in one database. `database` then ends in `#<schema>`, so core keeps its per-database state apart.
   */
  readonly schema?: string;
}

/** The wait for any one lock, in milliseconds. Below the 15 s claim lapse of the events spec. */
const DEFAULT_WAIT_MS = 5000;

/** A connection a job runs on, and whether it must be closed instead of returned to the pool. */
interface Connection {
  readonly reserved: ReservedSQL;
  readonly db: BunSQLDatabase;
  /** The lock wait of the running transaction, which a lock-timeout error reports. */
  waitMs: number;
  broken: boolean;
}

interface State {
  /** The configured URL, or a `FrameworkError` saying it is missing; never opens anything. */
  url(caller: string): string;
  /** The schema the layer runs in, when it is not `public` (tests only). */
  readonly schema: string | undefined;
  /** What messages name: the database without credentials. */
  readonly database: string;
  /** Runs `run` alone on a reserved connection, in the layer's queue, outside any transaction. */
  exclusive<T>(run: (conn: Connection) => Promise<T>): Promise<T>;
}
const states = new WeakMap<DataLayer, State>();

/** Internal bridge for schema preparation: the same queue and pool. */
export function postgresState(layer: DataLayer, caller = "createSchema"): State {
  const state = states.get(layer);
  if (!state) throw new FrameworkError(`${caller} requires a data layer made by postgres()`);
  return state;
}

export function postgresTable(handle: TableHandle): PgTable {
  return drizzleTable(handle, PgTable, "Postgres");
}

/** An entity's table; the outbox's tables are core's and reached through the outbox operations only. */
function entityTable(handle: TableHandle): PgTable {
  const table = postgresTable(handle);
  const name = getTableName(table);
  if (CORE_TABLE_NAMES.has(name)) throw new FrameworkError(`The table ${name} is Mesh's own: the outbox is written by publish and read through rows() and readEvents, never through data operations`);
  return table;
}

/** `postgres://<host>:<port>/<database>` from a URL, without user, password or query; undefined when it cannot be read. */
export function databaseName(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === "") return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    const port = parsed.port === "" ? "5432" : parsed.port;
    return `postgres://${parsed.hostname}:${port}${parsed.pathname === "" ? "/" : parsed.pathname}`;
  } catch {
    return undefined;
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  try { return JSON.stringify(value); } catch { return Object.prototype.toString.call(value); }
}

export function postgres(options: PostgresOptions): PostgresLayer {
  return postgresWith(options, {});
}

/** `postgres()` with internal settings; tests use it for a shorter lock wait and a schema of their own. */
export function postgresWith(options: PostgresOptions, tuning: Tuning): PostgresLayer {
  if (typeof options !== "object" || options === null || (options.url !== undefined && typeof options.url !== "string")) {
    throw new FrameworkError(`postgres requires { url }: a postgres:// URL string, or undefined while it is not configured; got ${describeValue(options)}`);
  }
  if (tuning.schema !== undefined && !SCHEMA_NAME.test(tuning.schema)) throw new FrameworkError(`A test schema must be a lowercase identifier, not ${JSON.stringify(tuning.schema)}`);
  const configured: PostgresOptions = Object.freeze({ url: options.url });
  const defaultWaitMs = tuning.waitMs ?? DEFAULT_WAIT_MS;
  const named = databaseName(configured.url);
  const database = named === undefined ? undefined : tuning.schema === undefined ? named : `${named}#${tuning.schema}`;
  /** What messages name before a URL can be read. */
  const label = database ?? "postgres (no readable url)";
  let pool: BunSQL | undefined;
  /** The key every appender of this layer's outbox holds shared until it ends (the reader rule). */
  const lockKey = outboxLockKey(outboxChannel(tuning.schema));
  /** The outbox's sequence, resolved on the first outbox call; forgotten by close(). */
  let sequenceName: string | undefined;
  let reader = new OutboxReader(lockKey);
  /** The connection outbox reads run on, reserved on the first read and kept until close() or until it breaks. */
  let readConnection: ReservedSQL | undefined;
  /** The last read, so reads run one at a time. */
  let reading: Promise<unknown> = Promise.resolve();

  const url = (caller: string): string => {
    if (configured.url === undefined || configured.url.trim() === "") {
      throw new FrameworkError(caller === "db push"
        ? "db push needs a database url: set data: postgres({ url: process.env.DATABASE_URL }) and define the variable"
        : `postgres needs a url, and was given ${configured.url === undefined ? "undefined" : "an empty string"}: set data: postgres({ url: process.env.DATABASE_URL }) and define DATABASE_URL. Mesh never guesses a database`);
    }
    return configured.url;
  };

  /** The pool, made on first use: one connection for the running transaction, two more for the outbox reader and LISTEN. */
  const open = (): BunSQL => {
    if (pool) return pool;
    const target = url("postgres");
    // Bun's connect timeout is in seconds and 30 by default; bounded by the layer's lock wait, a connect that never
    // answers ends soon after the job that asked for it gave up (`reserveWithin`), so close() is not held by it.
    try { pool = new BunSQL(target, { max: 3, connectionTimeout: Math.max(1, Math.ceil(defaultWaitMs / 1000)) }); }
    catch (cause) { throw mapPostgresError(cause, label, "connect"); }
    return pool;
  };

  /** Runs one statement of a running transaction, mapping its failure and recording it, since Postgres has aborted the transaction. */
  const statement = (conn: Connection, failed: (cause: unknown) => void) => async <T>(run: () => T | Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (cause) {
      const mapped = mapPostgresError(cause, label, "statement", conn.waitMs);
      if (mapped !== cause || isServerError(cause)) {
        failed(mapped);
        if (isConnectionLoss(mapped)) conn.broken = true;
      }
      throw mapped;
    }
  };

  const queue = serialTransactions<Connection>({
    health: () => undefined,
    async acquire(deadline: Deadline): Promise<Connection> {
      const current = open();
      let reserved: ReservedSQL;
      try { reserved = await reserveWithin(current, deadline); }
      catch (cause) { throw mapPostgresError(cause, label, "connect"); }
      return { reserved, db: drizzle({ client: reserved as unknown as BunSQL }), waitMs: defaultWaitMs, broken: false };
    },
    release(conn) {
      if (conn.broken) void Promise.resolve().then(() => conn.reserved.close()).catch(() => { /* already gone */ });
      else conn.reserved.release();
    },
    async begin(conn, deadline: Deadline) {
      conn.waitMs = Math.max(1, Math.round(deadline.at - deadline.started));
      // One round trip: a query without parameters may hold several statements.
      const path = tuning.schema === undefined ? "" : `; SET LOCAL search_path TO "${tuning.schema}"`;
      await conn.reserved.unsafe(`BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL lock_timeout = '${conn.waitMs}ms'${path}`);
    },
    operations(conn, guard, failed) {
      const run = statement(conn, failed);
      const { db } = conn;
      const query: Query = async (text, params) => { guard(); return await run(() => conn.reserved.unsafe(text, params as unknown[] | undefined)); };
      const sequence = async () => sequenceName ??= await outboxSequence(query);
      const appender: Appender = { query, key: lockKey, sequence, prepared: false };
      const entities = refuseJsonFilters(drizzleOperations({
        dialect: postgresDialect,
        table: entityTable,
        insert: (table, row) => run(async () => (await db.insert(table).values(jsonIn(table, row)).returning(fieldsOf(table)))[0]!),
        select: (table, options) => run(async () => {
          let query = db.select(fieldsOf(table)).from(table).$dynamic();
          if (options?.where) query = query.where(options.where);
          if (options?.orderBy?.length) query = query.orderBy(...options.orderBy);
          // Postgres takes OFFSET without LIMIT.
          if (options?.limit !== undefined) query = query.limit(options.limit);
          if (options?.offset !== undefined) query = query.offset(options.offset);
          return await query;
        }),
        selectForUpdate: (table, options) => run(async () => {
          let query = db.select(fieldsOf(table)).from(table).$dynamic();
          if (options.where) query = query.where(options.where);
          if (options.orderBy.length) query = query.orderBy(...options.orderBy);
          return await query.for("update");
        }),
        aggregate: (table, kind, column, where) => run(async () => {
          const query = db.select({ value: kind === "max" ? largest(column) : count(column) }).from(table).$dynamic();
          return (await (where ? query.where(where) : query))[0]?.value ?? null;
        }),
        update: (table, condition, changes) => run(async () => await db.update(table).set(jsonIn(table, changes)).where(condition).returning(fieldsOf(table))),
        delete: (table, condition) => run(async () => await db.delete(table).where(condition).returning(fieldsOf(table))),
        rows: (statement) => run(async () => [...await db.execute<Row>(statement)]),
      }, guard, capabilities));
      return Object.freeze({
        ...entities,
        appendEvent: (row) => appendEvent(appender, row),
        deleteOutboxThrough: async (position) => deleteOutboxThrough(query, await sequence(), position),
        ...deliveryOperations(query, sequence),
      } satisfies DataOperations);
    },
    async commit(conn) {
      checkCommitTag(await conn.reserved.unsafe("COMMIT"));
    },
    async rollback(conn) {
      try { await conn.reserved.unsafe("ROLLBACK"); }
      catch {
        // The server rolls back an open transaction when its session ends, so closing the connection is enough; the
        // pool opens a new one and this layer stays usable.
        conn.broken = true;
      }
    },
    report: (cause: unknown, stage: "begin" | "commit" | "job") => mapPostgresError(cause, label, stage satisfies Stage),
  }, defaultWaitMs);

  /** One outbox read on the read connection; a lost connection is dropped, and the next read reserves another. */
  const readOnce = async (after: number, limit: number) => {
    const current = open();
    if (!readConnection) {
      const started = performance.now();
      let reserved: ReservedSQL;
      try { reserved = await reserveWithin(current, { started, at: started + defaultWaitMs }); }
      catch (cause) { throw mapPostgresError(cause, label, "connect"); }
      if (tuning.schema !== undefined) {
        try { await reserved.unsafe(`SET search_path TO "${tuning.schema}"`); }
        catch (cause) { void Promise.resolve().then(() => reserved.close()).catch(() => undefined); throw mapPostgresError(cause, label, "job"); }
      }
      readConnection = reserved;
    }
    const conn = readConnection;
    const query: Query = async (text, params) => {
      try { return await conn.unsafe(text, params as unknown[] | undefined); }
      catch (cause) {
        const mapped = mapPostgresError(cause, label, "job");
        if (isConnectionLoss(mapped)) {
          if (readConnection === conn) readConnection = undefined;
          void Promise.resolve().then(() => conn.close()).catch(() => { /* already gone */ });
        }
        throw mapped;
      }
    };
    sequenceName ??= await outboxSequence(query);
    return reader.read(query, sequenceName, after, limit);
  };

  const state: State = {
    url,
    schema: tuning.schema,
    database: label,
    exclusive: (run) => queue.exclusive((conn) => run(conn)),
  };
  const layer: PostgresLayer = {
    kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", capabilities, options: configured,
    ...(database === undefined ? {} : { database }),
    transaction(run, transactionOptions?: TransactionOptions) {
      return queue.transaction(run, transactionOptions?.waitMs === undefined ? undefined : { waitMs: transactionOptions.waitMs });
    },
    readOutbox(after, limit) {
      // The read sees committed rows only; inside a transaction it is refused rather than run beside it.
      if (queue.insideTransaction()) {
        return Promise.reject(new FrameworkError("The outbox cannot be read inside a transaction: the read sees committed rows only, and a transaction's own events come from published() (from #mesh)"));
      }
      const read = reading.then(() => readOnce(after, limit));
      reading = read.catch(() => undefined);
      return read;
    },
    refuseIfFailed: () => queue.refuseIfFailed(),
    async close() {
      const { running, queued } = queue.counts();
      if (running || queued) throw new FrameworkError(`Cannot close Postgres data layer: ${running} running and ${queued} queued; wait for transactions to settle`);
      await reading;
      const closing = pool;
      pool = undefined;
      readConnection?.release();
      readConnection = undefined;
      sequenceName = undefined;
      reader = new OutboxReader(lockKey);
      await closing?.close();
    },
  };
  states.set(layer, state);
  return Object.freeze(layer);
}

/** R27's error: a statement failed, so Postgres aborted the transaction, and nothing it wrote was committed. */
export function abortedError(cause: unknown): FrameworkError {
  return new FrameworkError("A statement of this transaction failed, so Postgres aborted the transaction even though its callback caught the error", cause === undefined ? undefined : { cause });
}

/**
 * R27's last line of defence: the result of `COMMIT` must carry the command tag `COMMIT`. A `COMMIT` of a transaction
 * Postgres had aborted resolves with the tag `ROLLBACK` instead of failing, so anything else throws R27's error.
 */
export function checkCommitTag(result: unknown): void {
  const command = typeof result === "object" && result !== null && "command" in result ? result.command : undefined;
  if (command !== "COMMIT") throw abortedError(undefined);
}

/**
 * The operations, with a filter that compares a `jsonb` column refused before anything runs (`nil` alone is allowed).
 * A filter's operand goes through Drizzle's `jsonb` encoding, `JSON.stringify`, and Bun.SQL encodes that string as JSON
 * once more, so `{ eq: "x" }` would compare with the JSON string `"\"x\""` and quietly match the wrong rows. Generated
 * filters never name a json attribute; a hand-written one gets this error instead of a wrong answer.
 */
function refuseJsonFilters(operations: DataOperations): DataOperations {
  const check = (handle: TableHandle, filter: unknown): void => {
    if (filter === undefined) return;
    const columns = getTableColumns(postgresTable(handle));
    const walk = (node: unknown, depth: number): void => {
      if (typeof node !== "object" || node === null || Array.isArray(node) || depth > 64) return; // data-drizzle refuses these
      for (const [key, value] of Object.entries(node)) {
        if ((key === "and" || key === "or") && Array.isArray(value)) { for (const item of value) walk(item, depth + 1); continue; }
        const column = columns[key];
        if (!column || !is(column, PgJsonb) || value === undefined) continue;
        const operators = typeof value === "object" && value !== null ? Object.keys(value) : [];
        if (operators.length > 0 && operators.every((operator) => operator === "nil")) continue;
        throw new FrameworkError(`Filter on "${key}": a json column takes only nil on Postgres, since a filter compares scalars and a jsonb value is not one`);
      }
    };
    walk(filter, 0);
  };
  return Object.freeze({
    ...operations,
    select: (handle, query) => { try { check(handle, query?.filter); } catch (error) { return Promise.reject(error); } return operations.select(handle, query); },
    max: (handle: TableHandle, attribute: string, filter?: Filter, where?) => { try { check(handle, filter); } catch (error) { return Promise.reject(error); } return operations.max(handle, attribute, filter, where); },
    count: (handle: TableHandle, attribute: string, filter?: Filter, where?) => { try { check(handle, filter); } catch (error) { return Promise.reject(error); } return operations.count(handle, attribute, filter, where); },
  } satisfies DataOperations);
}

/**
 * A connection reserved from `pool` before the job's deadline. Bun's own connect timeout is 30 s, longer than any
 * lock wait, so past the deadline the wait ends with a DatabaseBusyError reason "connection" (`during: "connect"`); a
 * connection that arrives later goes back to the pool.
 */
export async function reserveWithin(pool: Pick<BunSQL, "reserve">, deadline: Deadline): Promise<ReservedSQL> {
  const remaining = Math.max(1, Math.round(deadline.at - performance.now()));
  const reserving = pool.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reserving.then((late) => late.release(), () => undefined);
      reject(Object.assign(new Error(`no connection within ${remaining} ms`), { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }));
    }, remaining);
  });
  try { return await Promise.race([reserving, expired]); }
  finally { clearTimeout(timer); }
}

/** `max(column)`, a text column compared by code point as everywhere else, decoded as the column decodes. */
function largest(column: Column): SQL {
  return column.dataType === "string" ? sql`max(${column} collate "C")`.mapWith(column) : max(column);
}

/** True when the failure came from the server, so the transaction is aborted even though nothing maps it. */
function isServerError(cause: unknown): boolean {
  const seen = new Set<object>();
  let current = cause;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("errno" in current && typeof current.errno === "string") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function isConnectionLoss(error: unknown): boolean {
  return typeof error === "object" && error !== null && "reason" in error && error.reason === "connection";
}

/**
 * A row with every `jsonb` value written as its JSON text cast to `jsonb`. Drizzle's `jsonb` column hands the driver
 * `JSON.stringify(value)`, and Bun.SQL, seeing a parameter of type `jsonb`, encodes that string as JSON once more, so
 * the database would hold a JSON string instead of the value (an object stored as the string `"{\"a\":1}"`). Bound
 * as text and cast, the text is parsed once. SQL `NULL` and SQL expressions pass unchanged.
 */
function jsonIn<R extends Record<string, unknown>>(table: PgTable, row: R): R {
  const columns = getTableColumns(table);
  let out: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(row)) {
    const column = columns[name];
    if (!column || !is(column, PgJsonb) || value === null || value === undefined || is(value, DrizzleSQL)) continue;
    out ??= { ...row };
    out[name] = sql`${JSON.stringify(value)}::text::jsonb`;
  }
  return (out ?? row) as R;
}

/**
 * The fields a read returns: every column, a `jsonb` one read as its text and parsed here. Bun.SQL parses `jsonb`
 * itself and Drizzle's column then parses any string again, so a stored JSON string that reads like JSON (`"123"`,
 * `"true"`) would come back as a number or a boolean.
 */
function fieldsOf(table: PgTable): Record<string, PgColumn | SQL> {
  const fields: Record<string, PgColumn | SQL> = {};
  for (const [name, column] of Object.entries(getTableColumns(table) as Record<string, PgColumn>)) {
    fields[name] = is(column, PgJsonb) ? sql`${column}::text`.mapWith((text: string | null) => text === null ? null : JSON.parse(text)) : column;
  }
  return fields;
}
