import { FrameworkError, OUTBOX_STATE_TABLE, OUTBOX_TABLE, type OutboxAppend, type OutboxPage, type OutboxRow } from "@meshfw/runtime";
import { int8 } from "./int8.ts";

/**
 * The outbox on Postgres (spec, Events and commands, "The outbox"): `mesh_outbox`, whose `position` is a `bigint`
 * identity column, and the deleted-through position in `mesh_outbox_state`.
 *
 * A sequence hands out positions in the order statements ask, not in the order their transactions commit, and never
 * takes one back: position 41 can commit after 42, or never. A read that returned 42 while 41 was still open would
 * move every reader past 41 for good. So a read returns rows only at or below its **settled** position, below which
 * every transaction that took a position has ended (the reader rule). Each appender first takes a shared advisory
 * lock on the layer's key and an xid, both before its position, and keeps them to its end; a read samples the
 * sequence (`v`) and then the xids of the advisory key's holders in this database, so every transaction holding a
 * position at or below `v` is among them or has ended, and the sample clears once none of them runs any more.
 * Only appenders hold the read back: a long write transaction elsewhere on the server does not (D30, O3).
 */

/** One statement on a connection: Bun.SQL's `unsafe` with parameters. */
export type Query = (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[] & { count?: number | null }>;

/** The NOTIFY channel of a layer, from which the advisory-lock key is derived: `mesh_outbox`, or `mesh_outbox_<schema>`. */
export function outboxChannel(schema: string | undefined): string {
  return schema === undefined ? OUTBOX_TABLE : `${OUTBOX_TABLE}_${schema}`;
}

/** FNV-1a, 32 bits. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The two-integer advisory-lock key every appender of `channel` holds shared, as two non-negative `int4`s, so the
 * `::oid` casts of the blocker test are exact. For the production channel `mesh_outbox` it is fixed; an application
 * must not take its own advisory locks on the same pair (`outboxLockKey("mesh_outbox")`).
 */
export function outboxLockKey(channel: string): readonly [number, number] {
  return [fnv1a(`mesh:${channel}`) & 0x7fffffff, fnv1a(channel) & 0x7fffffff];
}

/** The SQLSTATE in a failure's cause chain, if any. */
export function sqlstateOf(cause: unknown): string | undefined {
  const seen = new Set<object>();
  let current = cause;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("errno" in current && typeof current.errno === "string" && /^[0-9A-Z]{5}$/.test(current.errno)) return current.errno;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

const OUTBOX_MISSING = "The outbox table mesh_outbox does not exist in this database: prepare the schema with `mesh db push` (or createSchema in a test) after building a project that declares an event";

/** Runs `statement`, turning a missing outbox table (`42P01`) into an error that says how to create it. */
export async function withOutboxTables<T>(statement: () => Promise<T>): Promise<T> {
  try { return await statement(); }
  catch (cause) {
    if (sqlstateOf(cause) === "42P01" || sqlstateOf(cause) === "42703") throw new FrameworkError(OUTBOX_MISSING, { cause });
    throw cause;
  }
}

function json(value: unknown, what: string): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new FrameworkError(`An outbox row's ${what} must be JSON; got ${typeof value}`);
  return text;
}

function checkPosition(value: number, what: string, smallest: number): void {
  if (!Number.isSafeInteger(value) || value < smallest) {
    throw new FrameworkError(`${what} must be an integer of at least ${smallest}; got ${typeof value === "number" ? value : typeof value}`);
  }
}

/** The outbox's sequence, resolved once per layer through `pg_get_serial_sequence` (schema-qualified, quoted as needed). */
export async function outboxSequence(query: Query): Promise<string> {
  const [row] = await withOutboxTables(() => query(`SELECT pg_get_serial_sequence('${OUTBOX_TABLE}', 'position') AS seq`));
  const seq = row?.seq;
  if (typeof seq !== "string") throw new FrameworkError(`The column ${OUTBOX_TABLE}.position has no identity sequence: prepare the schema with \`mesh db push\` (or createSchema in a test)`);
  return seq;
}

/** The sequence's last assigned value, 0 before the first: the highest position ever assigned. */
const highestOf = (sequence: string) => `(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ${sequence})`;

/** What a transaction needs to append: its query, the lock key, the channel, and whether it already took the lock and its xid. */
export interface Appender {
  readonly query: Query;
  readonly key: readonly [number, number];
  /** The layer's NOTIFY channel (`outboxChannel`), which a listener's `LISTEN` names. */
  readonly channel: string;
  sequence(): Promise<string>;
  /** Set once the transaction holds the advisory lock and its xid. */
  prepared: boolean;
}

/**
 * Inserts one row in the running transaction and returns its position. On the transaction's first append, before the
 * insert and as separate statements: the shared advisory lock, then `pg_current_xact_id()`, so the transaction holds
 * both before it takes a position (the reader rule rests on that order), then one `pg_notify` on the layer's channel,
 * which Postgres delivers to every `LISTEN` after the commit and drops on a rollback (`onAppended`'s wake-up).
 */
export async function appendEvent(appender: Appender, row: OutboxAppend): Promise<number> {
  if (!(row.occurredAt instanceof Date) || Number.isNaN(row.occurredAt.getTime())) throw new FrameworkError("An outbox row's occurredAt must be a valid Date");
  const values = [row.id, row.name, row.entity, row.action, json(row.key, "key"), row.causedBy, json(row.metadata, "metadata"), row.occurredAt.toISOString(), json(row.payload, "payload")];
  const { query } = appender;
  if (!appender.prepared) {
    await query("SELECT pg_advisory_xact_lock_shared($1::int4, $2::int4)", appender.key);
    await query("SELECT pg_current_xact_id()");
    await query("SELECT pg_notify($1, '')", [appender.channel]);
    appender.prepared = true;
  }
  const [stored] = await withOutboxTables(() => query(
    `INSERT INTO ${OUTBOX_TABLE} (id, name, entity, action, key, caused_by, metadata, occurred_at, payload)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7::text::jsonb, $8::text::timestamptz, $9::text::jsonb) RETURNING position`,
    values,
  ));
  return int8(stored?.position, "mesh_outbox.position");
}

/**
 * In the running transaction: deletes every row at or below `position` and records it as the deleted-through position.
 * A position at or below the recorded one is a no-op; one above the highest position ever assigned is refused.
 */
export async function deleteOutboxThrough(query: Query, sequence: string, position: number): Promise<number> {
  checkPosition(position, "deleteOutboxThrough's position", 0);
  return withOutboxTables(async () => {
    const [state] = await query(
      `SELECT COALESCE((SELECT deleted_through FROM ${OUTBOX_STATE_TABLE} WHERE id = 1), 0) AS deleted_through, ${highestOf(sequence)} AS highest`,
    );
    const current = int8(state?.deleted_through, "mesh_outbox_state.deleted_through");
    const highest = int8(state?.highest, "the outbox's highest position");
    if (position > highest) {
      throw new FrameworkError(`deleteOutboxThrough(${position}) is above the highest outbox position ever assigned, ${highest}: only delivered rows, which have positions, can be deleted`);
    }
    if (position <= current) return 0;
    const deleted = await query(`DELETE FROM ${OUTBOX_TABLE} WHERE position <= $1`, [position]);
    await query(
      `INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET deleted_through = excluded.deleted_through`,
      [position],
    );
    return deleted.count ?? 0;
  });
}

/**
 * A sample of the reader rule: every position at or below `v` was handed out to a transaction among `waitsFor` (the
 * appenders running just after `v` was read) or to one that had already ended.
 */
interface Sample { readonly v: number; readonly waitsFor: ReadonlySet<string> }

/** The most pending samples a layer keeps; dropping one only delays a read. */
const MAX_SAMPLES = 64;

/**
 * The read side of one layer object: its pending samples and its settled floor, which only grows (until `close()`
 * makes a new reader). Reads must not overlap; the layer runs them one at a time.
 */
export class OutboxReader {
  #samples: Sample[] = [];
  #settled = 0;
  readonly #key: readonly [number, number];

  constructor(key: readonly [number, number]) { this.#key = key; }

  /**
   * The rows after `after`, at most `limit`, none above the settled position, in three statements, each after the one
   * before returned: A samples the sequence, H lists the appenders running now (which also tests every pending
   * sample), and C reads the rows and both positions in one statement. H runs before C so that every transaction H saw
   * end is visible to C's snapshot; folded into C it would read the locks after C's snapshot, and a transaction
   * committing in between would be neither blocking nor visible: a skip. (A snapshot's `xmax` cannot stand in for H:
   * it is one past the latest completed xid, so a running appender can sit at or above it.)
   */
  async read(query: Query, sequence: string, after: number, limit: number): Promise<OutboxPage> {
    checkPosition(after, "readOutbox's after", 0);
    checkPosition(limit, "readOutbox's limit", 1);
    return withOutboxTables(async () => {
      const [a] = await query(`SELECT ${highestOf(sequence)} AS v`);
      const v = int8(a?.v, "the outbox's highest position");
      // The xids of the appenders running now, in this database: every transaction that holds a position at or below
      // `v` is among them, or has ended.
      const holders = await query(
        `SELECT DISTINCT tx.transactionid::text AS xid FROM pg_locks adv
         JOIN pg_locks tx ON tx.pid = adv.pid AND tx.locktype = 'transactionid' AND tx.mode = 'ExclusiveLock'
         WHERE adv.locktype = 'advisory' AND adv.database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND adv.classid = $1::bigint::oid AND adv.objid = $2::bigint::oid AND adv.objsubid = 2 AND adv.granted`,
        [this.#key[0], this.#key[1]],
      );
      const running = new Set(holders.map((row) => String(row.xid)));
      if (v > this.#settled) this.#samples.push({ v, waitsFor: running });
      if (this.#samples.length > MAX_SAMPLES) this.#samples = this.#samples.slice(-MAX_SAMPLES);
      // A sample clears once none of the appenders it waits for still runs; a cleared sample never blocks again.
      let largest = this.#settled;
      for (const sample of this.#samples) {
        if (![...sample.waitsFor].some((xid) => running.has(xid))) largest = Math.max(largest, sample.v);
      }
      this.#settled = largest;
      this.#samples = this.#samples.filter((sample) => sample.v > this.#settled);
      const settled = this.#settled;
      const result = await query(
        `SELECT s.deleted_through AS s_deleted_through, s.highest AS s_highest, o.position, o.id, o.name, o.entity, o.action,
                o.key::text AS key, o.caused_by, o.metadata::text AS metadata, o.occurred_at, o.payload::text AS payload
         FROM (SELECT COALESCE((SELECT deleted_through FROM ${OUTBOX_STATE_TABLE} WHERE id = 1), 0) AS deleted_through,
                      ${highestOf(sequence)} AS highest) AS s
         LEFT JOIN LATERAL (SELECT * FROM ${OUTBOX_TABLE} WHERE position > $1 AND position <= $2 ORDER BY position LIMIT $3) AS o ON true
         ORDER BY o.position`,
        [after, settled, limit],
      );
      const first = result[0]!;
      const deletedThrough = int8(first.s_deleted_through, "mesh_outbox_state.deleted_through");
      const highest = int8(first.s_highest, "the outbox's highest position");
      const rows: OutboxRow[] = [];
      for (const stored of result) {
        if (stored.position === null || stored.position === undefined) continue;
        rows.push(Object.freeze({
          position: int8(stored.position, "mesh_outbox.position"),
          id: stored.id as string,
          name: stored.name as string,
          entity: stored.entity as string,
          action: stored.action as string,
          key: JSON.parse(stored.key as string),
          causedBy: (stored.caused_by as string | null) ?? null,
          metadata: JSON.parse(stored.metadata as string),
          occurredAt: new Date(stored.occurred_at as Date | string),
          payload: JSON.parse(stored.payload as string),
        }));
      }
      // Rows at or below the deleted-through position are gone, so the floor may rise to it; it never exceeds the
      // sequence, which a backup restore can move back under a running process.
      this.#settled = Math.min(Math.max(this.#settled, deletedThrough), highest);
      return Object.freeze({ rows: Object.freeze(rows), deletedThrough, highest, settled: this.#settled });
    });
  }
}
