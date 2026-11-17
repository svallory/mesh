import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import {
  DELIVERY_PROCESS_TABLE, FAILURES_TABLE, FrameworkError, HANDLER_PROGRESS_TABLE, OUTBOX_STATE_TABLE, OUTBOX_TABLE, SUBSCRIPTION_PROGRESS_TABLE,
  type DelivererClaim, type DeliveryOperations, type FailureOperations, type FailureRow, type RetentionOperations, type DeliveryProcessRow, type DeliveryState, type HandlerLeaseRow, type HandlerProgressRow,
  type LockedDeliveryState, type MultiProcessOperations, type SubscriptionFilter, type SubscriptionOwnerRow, type SubscriptionProgressRow,
} from "@meshfw/runtime";
import { hasHolesColumn, holesOf } from "./outbox.ts";

/**
 * Core's delivery operations on SQLite (spec, Events and commands, "The deliverer", "Retention"): the claim in
 * `mesh_outbox_state`, `mesh_handler_progress` and `mesh_subscription_progress`. Each runs on the connection inside the
 * running transaction. Timestamps are integer milliseconds, as the schema's `timestamp_ms` columns store them, and every
 * one core measures a lapse or an age on comes from the database's clock (`NOW_MS`), never the process's.
 */

/** The database's clock, in milliseconds since the epoch. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

function missingTable(cause: unknown): unknown {
  const message = cause instanceof Error ? cause.message : "";
  return /no such (table|column)/.test(message) && /mesh_(outbox|handler_progress|subscription_progress)|run_id|generation|renewed_at/.test(message)
    ? new FrameworkError("The deliverer's tables (mesh_outbox_state with the claim, mesh_handler_progress, mesh_subscription_progress, mesh_outbox_failures) do not exist in this database: prepare the schema with `mesh db push` (or createSchema in a test) after building a project that declares an event", { cause })
    : cause;
}

function withTables<T>(statement: () => T): T {
  try { return statement(); } catch (cause) { throw missingTable(cause); }
}

/** A multi-mode statement that meets a schema built for a bus without `multi-process`. */
function missingMultiTable(cause: unknown): unknown {
  const message = cause instanceof Error ? cause.message : "";
  return /no such (table|column)|has no column named/.test(message) && /mesh_(outbox|delivery_process|handler_progress|subscription_progress)|run_id|keep|declared|renewed_at/.test(message)
    ? new FrameworkError("The tables for delivery from several processes (mesh_delivery_process, and the keep and run_id columns) do not exist in this database: prepare the schema with `mesh db push` after setting localBus({ processes: \"many\" }) (or createSchema in a test, with a schema built for a bus that declares multi-process)", { cause })
    : cause;
}

function withMultiTables<T>(statement: () => T): T {
  try { return statement(); } catch (cause) { throw missingMultiTable(cause); }
}

const date = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/** The delivery operations over `client`, each guarded by `guard` (the transaction is still running) and `busy` (a lock is `MESH_DATABASE_BUSY`). */
type StateRow = {
  deleted_through: number; highest: number; generation: number; run_id: string | null; renewed_at: number | null;
  host: string | null; pid: number | null; started_at: number | null; now: number; holes?: string | null;
};

/** `mesh_outbox_state` with the highest position and the database's clock, plus `extra` columns of the row. */
function stateQuery(extra: string, client: Database): string {
  // The hole record, when the database has its column (a database not pushed since it was added has no hole).
  if (hasHolesColumn(client)) extra += ", s.holes";
  return `SELECT COALESCE(s.deleted_through, 0) AS deleted_through,
                COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${OUTBOX_TABLE}'), 0) AS highest,
                COALESCE(s.generation, 0) AS generation, s.run_id, s.renewed_at, s.host, s.pid, s.started_at,
                ${NOW_MS} AS now${extra}
         FROM (SELECT 1) AS one LEFT JOIN ${OUTBOX_STATE_TABLE} AS s ON s.id = 1`;
}

function stateOf(row: StateRow): DeliveryState {
  const claim: DelivererClaim | null = row.run_id === null || row.renewed_at === null ? null : Object.freeze({
    runId: row.run_id, generation: row.generation, renewedAt: new Date(row.renewed_at), host: row.host, pid: row.pid, startedAt: date(row.started_at),
  });
  return {
    deletedThrough: row.deleted_through, highest: row.highest, generation: row.generation, claim, now: new Date(row.now),
    ...(row.holes === undefined ? {} : { holes: holesOf(row.holes) }),
  };
}

export function deliveryOperations(client: () => Database, run: <T>(statement: () => T) => T): DeliveryOperations & RetentionOperations {
  const db = () => client();
  const exec = <T>(statement: () => T) => Promise.resolve().then(() => run(() => withTables(statement)));
  return {
    readDeliveryState: () => exec(() => Object.freeze(stateOf(db().query(stateQuery("", db())).get() as StateRow)) satisfies DeliveryState),
    writeClaim: (claim) => exec(() => {
      db().query(
        `INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through, run_id, generation, renewed_at, host, pid, started_at)
         VALUES (1, 0, ?, ?, ${NOW_MS}, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, generation = excluded.generation, renewed_at = excluded.renewed_at,
           host = excluded.host, pid = excluded.pid, started_at = excluded.started_at`,
      ).run(claim.runId, claim.generation, claim.host === undefined ? hostname() : claim.host, claim.pid, claim.startedAt?.getTime() ?? null);
    }),
    renewClaim: (runId, generation) => exec(() =>
      db().query(`UPDATE ${OUTBOX_STATE_TABLE} SET renewed_at = ${NOW_MS} WHERE id = 1 AND run_id = ? AND generation = ?`).run(runId, generation).changes === 1),
    releaseClaim: (runId, generation) => exec(() =>
      db().query(
        `UPDATE ${OUTBOX_STATE_TABLE} SET run_id = NULL, renewed_at = NULL, host = NULL, pid = NULL, started_at = NULL WHERE id = 1 AND run_id = ? AND generation = ?`,
      ).run(runId, generation).changes === 1),
    readHandlerProgress: () => exec(() =>
      Object.freeze((db().query(`SELECT name, kind, position, events, generation FROM ${HANDLER_PROGRESS_TABLE} ORDER BY name`).all() as {
        name: string; kind: string; position: number; events: string; generation: number;
      }[]).map((row) => Object.freeze({ ...row, events: Object.freeze(JSON.parse(row.events) as string[]) }) satisfies HandlerProgressRow))),
    writeHandlerProgress: (row) => exec(() => {
      db().query(
        `INSERT INTO ${HANDLER_PROGRESS_TABLE} (name, kind, position, events, generation) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, position = excluded.position, events = excluded.events, generation = excluded.generation`,
      ).run(row.name, row.kind, row.position, JSON.stringify(row.events), row.generation);
    }),
    deleteHandlerProgress: (name) => exec(() => db().query(`DELETE FROM ${HANDLER_PROGRESS_TABLE} WHERE name = ?`).run(name).changes === 1),
    readSubscriptionProgress: () => exec(() =>
      Object.freeze((db().query(`SELECT name, position, filter, seen_at, open, generation FROM ${SUBSCRIPTION_PROGRESS_TABLE} ORDER BY name`).all() as {
        name: string; position: number; filter: string; seen_at: number; open: number; generation: number;
      }[]).map((row) => Object.freeze({
        name: row.name, position: row.position, filter: Object.freeze(JSON.parse(row.filter) as SubscriptionFilter), seenAt: new Date(row.seen_at),
        open: row.open !== 0, generation: row.generation,
      }) satisfies SubscriptionProgressRow))),
    writeSubscriptionProgress: (row) => exec(() => {
      db().query(
        `INSERT INTO ${SUBSCRIPTION_PROGRESS_TABLE} (name, position, filter, seen_at, open, generation) VALUES (?, ?, ?, COALESCE(?, ${NOW_MS}), ?, ?)
         ON CONFLICT (name) DO UPDATE SET position = excluded.position, filter = excluded.filter, seen_at = excluded.seen_at,
           open = excluded.open, generation = excluded.generation`,
      ).run(row.name, row.position, JSON.stringify(row.filter), row.seenAt?.getTime() ?? null, row.open ? 1 : 0, row.generation);
    }),
    deleteSubscriptionProgress: (name) => exec(() => db().query(`DELETE FROM ${SUBSCRIPTION_PROGRESS_TABLE} WHERE name = ?`).run(name).changes === 1),
    firstOutboxRow: (after, before, listed, declared) => exec(() => {
      const row = db().query(
        `SELECT position FROM ${OUTBOX_TABLE}
         WHERE position > ? AND position < ? AND (name IN (SELECT value FROM json_each(?)) OR name NOT IN (SELECT value FROM json_each(?)))
         ORDER BY position LIMIT 1`,
      ).get(after, before, JSON.stringify(listed), JSON.stringify(declared)) as { position: number } | null;
      return row?.position ?? null;
    }),
    // occurred_at is stored as epoch milliseconds, as appendEvent writes it.
    firstOutboxRowSince: (after, through, since, names) => exec(() => {
      const row = (names === undefined
        ? db().query(`SELECT position FROM ${OUTBOX_TABLE} WHERE position > ? AND position <= ? AND occurred_at > ? ORDER BY position LIMIT 1`)
          .get(after, through, since.getTime())
        : db().query(
          `SELECT position FROM ${OUTBOX_TABLE} WHERE position > ? AND position <= ? AND occurred_at > ? AND name IN (SELECT value FROM json_each(?)) ORDER BY position LIMIT 1`,
        ).get(after, through, since.getTime(), JSON.stringify(names))) as { position: number } | null;
      return row?.position ?? null;
    }),
    deleteOutboxRows: (after, through, names, since, limit) => exec(() => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new FrameworkError(`deleteOutboxRows takes a limit that is a whole number, 1 or more, and was given ${limit}`);
      const deleted = db().query(
        `DELETE FROM ${OUTBOX_TABLE} WHERE position IN (
           SELECT position FROM ${OUTBOX_TABLE}
           WHERE position > ? AND position <= ? AND name IN (SELECT value FROM json_each(?)) AND (? IS NULL OR occurred_at <= ?)
           ORDER BY position LIMIT ?)
         RETURNING name, position`,
      ).all(after, through, JSON.stringify(names), since?.getTime() ?? null, since?.getTime() ?? null, limit) as { name: string; position: number }[];
      const highest: Record<string, number> = {};
      for (const row of deleted) highest[row.name] = Math.max(highest[row.name] ?? 0, row.position);
      return Object.freeze({ deleted: deleted.length, highest: Object.freeze(highest) });
    }),
    writeHoles: (holes) => exec(() => {
      const stored = Object.keys(holes).length === 0 ? null : JSON.stringify(holes);
      db().query(`INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through, holes) VALUES (1, 0, ?) ON CONFLICT (id) DO UPDATE SET holes = excluded.holes`).run(stored);
    }),
  };
}

type FailureColumns = {
  failure: number; handler: string; position: number; id: string; name: string; entity: string; action: string; key: string; caused_by: string | null;
  metadata: string; occurred_at: number; payload: string; error: string; failed_at: number;
};

function failureOf(row: FailureColumns): FailureRow {
  const error = JSON.parse(row.error) as { code: string | null; message: string };
  return Object.freeze({
    failure: row.failure, handler: row.handler, position: row.position, id: row.id, name: row.name, entity: row.entity, action: row.action,
    key: JSON.parse(row.key), causedBy: row.caused_by, metadata: JSON.parse(row.metadata), occurredAt: new Date(row.occurred_at),
    payload: JSON.parse(row.payload), error: Object.freeze({ code: error.code, message: error.message }), failedAt: new Date(row.failed_at),
  });
}

/**
 * The dead-letter operations on SQLite (`FailureOperations`): `mesh_outbox_failures`, whose `failure` key is
 * `AUTOINCREMENT`, with JSON and timestamps stored as the outbox stores them. Only a project with a handler whose
 * `onFailure` is `"skip"` calls them.
 */
export function failureOperations(client: () => Database, run: <T>(statement: () => T) => T): FailureOperations {
  const db = () => client();
  const exec = <T>(statement: () => T) => Promise.resolve().then(() => run(() => withTables(statement)));
  return {
    writeFailure: (row) => exec(() => {
      db().query(
        `INSERT INTO ${FAILURES_TABLE} (handler, position, id, name, entity, action, key, caused_by, metadata, occurred_at, payload, error, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_MS})`,
      ).run(row.handler, row.position, row.id, row.name, row.entity, row.action, JSON.stringify(row.key), row.causedBy, JSON.stringify(row.metadata ?? {}),
        row.occurredAt.getTime(), JSON.stringify(row.payload), JSON.stringify({ code: row.error.code, message: row.error.message }));
    }),
    readFailures: (handler, after, limit) => exec(() =>
      Object.freeze((db().query(
        `SELECT * FROM ${FAILURES_TABLE} WHERE handler = ? AND (? IS NULL OR position > ? OR (position = ? AND failure > ?))
         ORDER BY position, failure LIMIT ?`,
      ).all(handler, after?.position ?? null, after?.position ?? 0, after?.position ?? 0, after?.failure ?? 0, limit) as FailureColumns[]).map(failureOf))),
    deleteFailure: (failure) => exec(() => db().query(`DELETE FROM ${FAILURES_TABLE} WHERE failure = ?`).run(failure).changes === 1),
    renameFailures: (from, to) => exec(() => { db().query(`UPDATE ${FAILURES_TABLE} SET handler = ? WHERE handler = ?`).run(to, from); }),
  };
}

type LeaseColumns = { name: string; kind: string; position: number; events: string; generation: number; run_id: string | null };
const leaseOf = (row: LeaseColumns): HandlerLeaseRow => Object.freeze({
  name: row.name, kind: row.kind, position: row.position, events: Object.freeze(JSON.parse(row.events) as string[]), generation: row.generation, runId: row.run_id,
});

/**
 * The delivery operations of multi mode on SQLite (`MultiProcessOperations`): the process rows, the leases on the
 * progress rows, the subscription owners and the recorded `keep`. SQLite has one writer, and the `BEGIN IMMEDIATE`
 * transaction holds it from the start, so every `lock*` is a plain read. Only a project whose bus declares
 * `multi-process` calls them, so a single-mode schema without the table and columns never meets them.
 */
export function multiProcessOperations(client: () => Database, run: <T>(statement: () => T) => T): MultiProcessOperations {
  const db = () => client();
  const exec = <T>(statement: () => T) => Promise.resolve().then(() => run(() => withMultiTables(statement)));
  return {
    lockDeliveryState: () => exec(() => {
      const row = db().query(stateQuery(", s.keep", db())).get() as StateRow & { keep: "until-delivered" | "all" | null };
      return Object.freeze({ ...stateOf(row), keep: row.keep }) satisfies LockedDeliveryState;
    }),
    readDeliveryStateUnlocked: () => exec(() => Object.freeze(stateOf(db().query(stateQuery("", db())).get() as StateRow)) satisfies DeliveryState),
    writeKeep: (keep) => exec(() => {
      db().query(`INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through, keep) VALUES (1, 0, ?) ON CONFLICT (id) DO UPDATE SET keep = excluded.keep`).run(keep);
    }),
    lockHandlerProgress: (name) => exec(() => {
      const row = db().query(`SELECT name, kind, position, events, generation, run_id FROM ${HANDLER_PROGRESS_TABLE} WHERE name = ?`).get(name) as LeaseColumns | null;
      return row === null ? undefined : leaseOf(row);
    }),
    readHandlerLeases: () => exec(() =>
      Object.freeze((db().query(`SELECT name, kind, position, events, generation, run_id FROM ${HANDLER_PROGRESS_TABLE} ORDER BY name`).all() as LeaseColumns[]).map(leaseOf))),
    writeHandlerLease: (row) => exec(() => {
      db().query(
        `INSERT INTO ${HANDLER_PROGRESS_TABLE} (name, kind, position, events, generation, run_id) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, position = excluded.position, events = excluded.events,
           generation = excluded.generation, run_id = excluded.run_id`,
      ).run(row.name, row.kind, row.position, JSON.stringify(row.events), row.generation, row.runId);
    }),
    moveHandler: (name, from, to, runId, generation) => exec(() =>
      db().query(`UPDATE ${HANDLER_PROGRESS_TABLE} SET position = ? WHERE name = ? AND position = ? AND run_id = ? AND generation = ?`)
        .run(to, name, from, runId, generation).changes === 1),
    moveSubscription: (name, from, to) => exec(() =>
      db().query(`UPDATE ${SUBSCRIPTION_PROGRESS_TABLE} SET position = ? WHERE name = ? AND position = ?`).run(to, name, from).changes === 1),
    readProcesses: () => exec(() =>
      Object.freeze((db().query(`SELECT run_id, renewed_at, host, pid, started_at, keep, handlers, declared FROM ${DELIVERY_PROCESS_TABLE} ORDER BY run_id`).all() as {
        run_id: string; renewed_at: number; host: string | null; pid: number | null; started_at: number | null; keep: "until-delivered" | "all"; handlers: string; declared: string;
      }[]).map((row) => {
        const handlers = JSON.parse(row.handlers) as Record<string, string[]>;
        for (const name of Object.keys(handlers)) Object.freeze(handlers[name]);
        return Object.freeze({
          runId: row.run_id, renewedAt: new Date(row.renewed_at), host: row.host, pid: row.pid, startedAt: date(row.started_at), keep: row.keep,
          handlers: Object.freeze(handlers), declared: Object.freeze(JSON.parse(row.declared) as string[]),
        }) satisfies DeliveryProcessRow;
      }))),
    writeProcess: (row) => exec(() => {
      db().query(
        `INSERT INTO ${DELIVERY_PROCESS_TABLE} (run_id, renewed_at, host, pid, started_at, keep, handlers, declared) VALUES (?, ${NOW_MS}, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET renewed_at = excluded.renewed_at, host = excluded.host, pid = excluded.pid, started_at = excluded.started_at,
           keep = excluded.keep, handlers = excluded.handlers, declared = excluded.declared`,
      ).run(row.runId, row.host === undefined ? hostname() : row.host, row.pid, row.startedAt?.getTime() ?? null, row.keep, JSON.stringify(row.handlers), JSON.stringify(row.declared));
    }),
    renewProcess: (runId, lapseMs) => exec(() =>
      db().query(`UPDATE ${DELIVERY_PROCESS_TABLE} SET renewed_at = ${NOW_MS} WHERE run_id = ? AND ${NOW_MS} - renewed_at < ?`).run(runId, lapseMs).changes === 1),
    deleteProcess: (runId) => exec(() => db().query(`DELETE FROM ${DELIVERY_PROCESS_TABLE} WHERE run_id = ?`).run(runId).changes === 1),
    readSubscriptionOwners: () => exec(() =>
      Object.freeze((db().query(`SELECT name, position, filter, seen_at, open, generation, run_id FROM ${SUBSCRIPTION_PROGRESS_TABLE} ORDER BY name`).all() as {
        name: string; position: number; filter: string; seen_at: number; open: number; generation: number; run_id: string | null;
      }[]).map((row) => Object.freeze({
        name: row.name, position: row.position, filter: Object.freeze(JSON.parse(row.filter) as SubscriptionFilter), seenAt: new Date(row.seen_at),
        open: row.open !== 0, generation: row.generation, runId: row.run_id,
      }) satisfies SubscriptionOwnerRow))),
    writeSubscriptionOwner: (row) => exec(() => {
      db().query(
        `INSERT INTO ${SUBSCRIPTION_PROGRESS_TABLE} (name, position, filter, seen_at, open, generation, run_id) VALUES (?, ?, ?, COALESCE(?, ${NOW_MS}), ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET position = excluded.position, filter = excluded.filter, seen_at = excluded.seen_at,
           open = excluded.open, generation = excluded.generation, run_id = excluded.run_id`,
      ).run(row.name, row.position, JSON.stringify(row.filter), row.seenAt?.getTime() ?? null, row.open ? 1 : 0, row.generation, row.runId);
    }),
  };
}
