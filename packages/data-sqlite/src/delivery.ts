import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import {
  FrameworkError, HANDLER_PROGRESS_TABLE, OUTBOX_STATE_TABLE, OUTBOX_TABLE, SUBSCRIPTION_PROGRESS_TABLE,
  type DelivererClaim, type DeliveryOperations, type DeliveryState, type HandlerProgressRow, type SubscriptionFilter, type SubscriptionProgressRow,
} from "@meshfw/runtime";

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
    ? new FrameworkError("The deliverer's tables (mesh_outbox_state with the claim, mesh_handler_progress, mesh_subscription_progress) do not exist in this database: prepare the schema with `mesh db push` (or createSchema in a test) after building a project that declares an event", { cause })
    : cause;
}

function withTables<T>(statement: () => T): T {
  try { return statement(); } catch (cause) { throw missingTable(cause); }
}

const date = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/** The delivery operations over `client`, each guarded by `guard` (the transaction is still running) and `busy` (a lock is `MESH_DATABASE_BUSY`). */
export function deliveryOperations(client: () => Database, run: <T>(statement: () => T) => T): DeliveryOperations {
  const db = () => client();
  const exec = <T>(statement: () => T) => Promise.resolve().then(() => run(() => withTables(statement)));
  return {
    readDeliveryState: () => exec(() => {
      const row = db().query(
        `SELECT COALESCE(s.deleted_through, 0) AS deleted_through,
                COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${OUTBOX_TABLE}'), 0) AS highest,
                COALESCE(s.generation, 0) AS generation, s.run_id, s.renewed_at, s.host, s.pid, s.started_at,
                ${NOW_MS} AS now
         FROM (SELECT 1) AS one LEFT JOIN ${OUTBOX_STATE_TABLE} AS s ON s.id = 1`,
      ).get() as {
        deleted_through: number; highest: number; generation: number; run_id: string | null; renewed_at: number | null;
        host: string | null; pid: number | null; started_at: number | null; now: number;
      };
      const claim: DelivererClaim | null = row.run_id === null || row.renewed_at === null ? null : Object.freeze({
        runId: row.run_id, generation: row.generation, renewedAt: new Date(row.renewed_at), host: row.host, pid: row.pid, startedAt: date(row.started_at),
      });
      return Object.freeze({ deletedThrough: row.deleted_through, highest: row.highest, generation: row.generation, claim, now: new Date(row.now) }) satisfies DeliveryState;
    }),
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
        name: string; kind: "process" | "listen"; position: number; events: string; generation: number;
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
  };
}
