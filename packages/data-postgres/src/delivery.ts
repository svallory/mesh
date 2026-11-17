import { hostname } from "node:os";
import {
  DELIVERY_PROCESS_TABLE, FAILURES_TABLE, FrameworkError, HANDLER_PROGRESS_TABLE, OUTBOX_STATE_TABLE, OUTBOX_TABLE, SUBSCRIPTION_PROGRESS_TABLE,
  type DelivererClaim, type DeliveryOperations, type DeliveryProcessRow, type DeliveryState, type FailureOperations, type FailureRow, type HandlerLeaseRow,
  type HandlerProgressRow, type LockedDeliveryState, type MultiProcessOperations, type RetentionOperations, type SubscriptionFilter, type SubscriptionOwnerRow,
  type SubscriptionProgressRow,
} from "@meshfw/runtime";
import { int8, int8OrNull } from "./int8.ts";
import { HolesColumn, holesOf, sqlstateOf, type Query } from "./outbox.ts";

/**
 * Core's delivery operations on Postgres (spec, Events and commands, "The deliverer", "Retention"): the claim in
 * `mesh_outbox_state`, `mesh_handler_progress` and `mesh_subscription_progress`, each in the running transaction.
 * Every time core measures a lapse or an age on is the database's clock at the statement, `clock_timestamp()`, never
 * `now()` (the transaction's start).
 *
 * The claim's row lock: `readDeliveryState` takes `FOR UPDATE` on the state row (creating it first), and it is the
 * first statement of the claim transaction, of every handler transaction (the generation check), of every deletion
 * batch and of the `#mesh` calls that read the state. So a takeover waits for a running handler transaction or batch
 * of another process, and the reverse, as SQLite's one writer orders them. At `SERIALIZABLE` the side that waited
 * fails with `40001` when the other changed the row (a `DatabaseBusyError`, reason `serialization`): its round ends,
 * and the next transaction, with a fresh snapshot, sees the new generation.
 */

const DELIVERY_MISSING = "The deliverer's tables (mesh_outbox_state with the claim, mesh_handler_progress, mesh_subscription_progress, mesh_outbox_failures) do not exist in this database: prepare the schema with `mesh db push` (or createSchema in a test) after building a project that declares an event";

const MULTI_MISSING = "The tables for delivery from several processes (mesh_delivery_process, and the keep and run_id columns) do not exist in this database: prepare the schema with `mesh db push` after setting localBus({ processes: \"many\" }) (or createSchema in a test, with a schema built for a bus that declares multi-process)";

/** A statement whose table or column is missing (`42P01`, `42703`) is the `FrameworkError` `missing`. */
async function withTables<T>(statement: () => Promise<T>, missing = DELIVERY_MISSING): Promise<T> {
  try { return await statement(); }
  catch (cause) {
    const state = sqlstateOf(cause);
    if (state === "42P01" || state === "42703") throw new FrameworkError(missing, { cause });
    throw cause;
  }
}

const date = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as Date | string));
const iso = (value: Date | null | undefined): string | null => (value === null || value === undefined ? null : value.toISOString());

function stateOf(row: Record<string, unknown>): DeliveryState {
  const runId = (row.run_id as string | null) ?? null;
  const renewedAt = date(row.renewed_at);
  const generation = int8(row.generation, "mesh_outbox_state.generation");
  const claim: DelivererClaim | null = runId === null || renewedAt === null ? null : Object.freeze({
    runId, generation, renewedAt, host: (row.host as string | null) ?? null, pid: int8OrNull(row.pid, "mesh_outbox_state.pid"), startedAt: date(row.started_at),
  });
  return Object.freeze({
    deletedThrough: int8(row.deleted_through, "mesh_outbox_state.deleted_through"),
    highest: int8(row.highest, "the outbox's highest position"),
    generation, claim, now: date(row.now)!,
    ...(Object.hasOwn(row, "holes") ? { holes: holesOf(row.holes) } : {}),
  });
}

/**
 * `mesh_outbox_state` (created first), with the highest position, the database's clock and `extra` columns, under its
 * row lock unless `lock` is false. `ON CONFLICT DO NOTHING` takes no lock on a row that exists.
 */
async function lockedState(query: Query, sequence: () => Promise<string>, holes: HolesColumn, extra = "", lock = true): Promise<Record<string, unknown>> {
  const seq = await sequence();
  // The hole record, when the database has its column (a database not pushed since it was added has no hole).
  if (await holes.present(query)) extra += ", holes::text AS holes";
  await query(`INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);
  const [row] = await query(
    `SELECT deleted_through, COALESCE(generation, 0) AS generation, run_id, renewed_at, host, pid, started_at, clock_timestamp() AS now,
            (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ${seq}) AS highest${extra}
     FROM ${OUTBOX_STATE_TABLE} WHERE id = 1${lock ? " FOR UPDATE" : ""}`,
  );
  return row!;
}

/** The delivery operations over `query` (the running transaction's statements); `sequence` resolves the outbox's sequence. */
export function deliveryOperations(query: Query, sequence: () => Promise<string>, holes: HolesColumn = new HolesColumn()): DeliveryOperations & RetentionOperations {
  const exec = <T>(statement: () => Promise<T>) => withTables(statement);
  return {
    readDeliveryState: () => exec(async () => stateOf(await lockedState(query, sequence, holes))),
    writeClaim: (claim) => exec(async () => {
      await query(
        `INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through, run_id, generation, renewed_at, host, pid, started_at)
         VALUES (1, 0, $1, $2, clock_timestamp(), $3, $4, $5::text::timestamptz)
         ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, generation = excluded.generation, renewed_at = excluded.renewed_at,
           host = excluded.host, pid = excluded.pid, started_at = excluded.started_at`,
        [claim.runId, claim.generation, claim.host === undefined ? hostname() : claim.host, claim.pid, iso(claim.startedAt)],
      );
    }),
    renewClaim: (runId, generation) => exec(async () =>
      (await query(`UPDATE ${OUTBOX_STATE_TABLE} SET renewed_at = clock_timestamp() WHERE id = 1 AND run_id = $1 AND generation = $2`, [runId, generation])).count === 1),
    releaseClaim: (runId, generation) => exec(async () =>
      (await query(
        `UPDATE ${OUTBOX_STATE_TABLE} SET run_id = NULL, renewed_at = NULL, host = NULL, pid = NULL, started_at = NULL WHERE id = 1 AND run_id = $1 AND generation = $2`,
        [runId, generation],
      )).count === 1),
    readHandlerProgress: () => exec(async () =>
      Object.freeze((await query(`SELECT name, kind, position, events::text AS events, generation FROM ${HANDLER_PROGRESS_TABLE} ORDER BY name COLLATE "C"`)).map((row) => Object.freeze({
        name: row.name as string,
        kind: row.kind as "process" | "listen",
        position: int8(row.position, "mesh_handler_progress.position"),
        events: Object.freeze(JSON.parse(row.events as string) as string[]),
        generation: int8(row.generation, "mesh_handler_progress.generation"),
      }) satisfies HandlerProgressRow))),
    writeHandlerProgress: (row) => exec(async () => {
      await query(
        `INSERT INTO ${HANDLER_PROGRESS_TABLE} (name, kind, position, events, generation) VALUES ($1, $2, $3, $4::text::jsonb, $5)
         ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, position = excluded.position, events = excluded.events, generation = excluded.generation`,
        [row.name, row.kind, row.position, JSON.stringify(row.events), row.generation],
      );
    }),
    deleteHandlerProgress: (name) => exec(async () => (await query(`DELETE FROM ${HANDLER_PROGRESS_TABLE} WHERE name = $1`, [name])).count === 1),
    readSubscriptionProgress: () => exec(async () =>
      Object.freeze((await query(`SELECT name, position, filter::text AS filter, seen_at, open, generation FROM ${SUBSCRIPTION_PROGRESS_TABLE} ORDER BY name COLLATE "C"`)).map((row) => Object.freeze({
        name: row.name as string,
        position: int8(row.position, "mesh_subscription_progress.position"),
        filter: Object.freeze(JSON.parse(row.filter as string) as SubscriptionFilter),
        seenAt: date(row.seen_at)!,
        open: int8(row.open, "mesh_subscription_progress.open") !== 0,
        generation: int8(row.generation, "mesh_subscription_progress.generation"),
      }) satisfies SubscriptionProgressRow))),
    writeSubscriptionProgress: (row) => exec(async () => {
      await query(
        `INSERT INTO ${SUBSCRIPTION_PROGRESS_TABLE} (name, position, filter, seen_at, open, generation)
         VALUES ($1, $2, $3::text::jsonb, COALESCE($4::text::timestamptz, clock_timestamp()), $5, $6)
         ON CONFLICT (name) DO UPDATE SET position = excluded.position, filter = excluded.filter, seen_at = excluded.seen_at,
           open = excluded.open, generation = excluded.generation`,
        [row.name, row.position, JSON.stringify(row.filter), iso(row.seenAt), row.open ? 1 : 0, row.generation],
      );
    }),
    deleteSubscriptionProgress: (name) => exec(async () => (await query(`DELETE FROM ${SUBSCRIPTION_PROGRESS_TABLE} WHERE name = $1`, [name])).count === 1),
    firstOutboxRow: (after, before, listed, declared) => exec(async () => {
      const [row] = await query(
        `SELECT position FROM ${OUTBOX_TABLE}
         WHERE position > $1 AND position < $2
           AND (name IN (SELECT jsonb_array_elements_text($3::text::jsonb)) OR name NOT IN (SELECT jsonb_array_elements_text($4::text::jsonb)))
         ORDER BY position LIMIT 1`,
        [after, before, JSON.stringify(listed), JSON.stringify(declared)],
      );
      return row === undefined ? null : int8(row.position, "mesh_outbox.position");
    }),
    firstOutboxRowSince: (after, through, since, names) => exec(async () => {
      const [row] = names === undefined
        ? await query(
          `SELECT position FROM ${OUTBOX_TABLE} WHERE position > $1 AND position <= $2 AND occurred_at > $3::text::timestamptz ORDER BY position LIMIT 1`,
          [after, through, iso(since)],
        )
        : await query(
          `SELECT position FROM ${OUTBOX_TABLE}
           WHERE position > $1 AND position <= $2 AND occurred_at > $3::text::timestamptz AND name IN (SELECT jsonb_array_elements_text($4::text::jsonb))
           ORDER BY position LIMIT 1`,
          [after, through, iso(since), JSON.stringify(names)],
        );
      return row === undefined ? null : int8(row.position, "mesh_outbox.position");
    }),
    deleteOutboxRows: (after, through, names, since, limit) => exec(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new FrameworkError(`deleteOutboxRows takes a limit that is a whole number, 1 or more, and was given ${limit}`);
      const deleted = await query(
        `DELETE FROM ${OUTBOX_TABLE} WHERE position IN (
           SELECT position FROM ${OUTBOX_TABLE}
           WHERE position > $1 AND position <= $2 AND name IN (SELECT jsonb_array_elements_text($3::text::jsonb))
             AND ($4::text IS NULL OR occurred_at <= $4::text::timestamptz)
           ORDER BY position LIMIT $5)
         RETURNING name, position`,
        [after, through, JSON.stringify(names), iso(since), limit],
      );
      const highest: Record<string, number> = {};
      for (const row of deleted) {
        const position = int8(row.position, "mesh_outbox.position");
        highest[row.name as string] = Math.max(highest[row.name as string] ?? 0, position);
      }
      return Object.freeze({ deleted: deleted.length, highest: Object.freeze(highest) });
    }),
    writeHoles: (record) => exec(async () => {
      const stored = Object.keys(record).length === 0 ? null : JSON.stringify(record);
      await query(
        `INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through, holes) VALUES (1, 0, $1::text::jsonb) ON CONFLICT (id) DO UPDATE SET holes = excluded.holes`,
        [stored],
      );
    }),
  };
}

function failureOf(row: Record<string, unknown>): FailureRow {
  const error = JSON.parse(row.error as string) as { code: string | null; message: string };
  return Object.freeze({
    failure: int8(row.failure, "mesh_outbox_failures.failure"),
    handler: row.handler as string,
    position: int8(row.position, "mesh_outbox_failures.position"),
    id: row.id as string,
    name: row.name as string,
    entity: row.entity as string,
    action: row.action as string,
    key: JSON.parse(row.key as string),
    causedBy: (row.caused_by as string | null) ?? null,
    metadata: JSON.parse(row.metadata as string),
    occurredAt: date(row.occurred_at)!,
    payload: JSON.parse(row.payload as string),
    error: Object.freeze({ code: error.code, message: error.message }),
    failedAt: date(row.failed_at)!,
  });
}

const FAILURE_COLUMNS = `failure, handler, position, id, name, entity, action, key::text AS key, caused_by, metadata::text AS metadata, occurred_at,
  payload::text AS payload, error::text AS error, failed_at`;

/**
 * The dead-letter operations on Postgres (`FailureOperations`): `mesh_outbox_failures`, whose `failure` key is an
 * identity column, JSON written as text cast to `jsonb` and read from `::text`, `failed_at` from `clock_timestamp()`.
 * Only a project with a handler whose `onFailure` is `"skip"` calls them.
 */
export function failureOperations(query: Query): FailureOperations {
  const exec = <T>(statement: () => Promise<T>) => withTables(statement);
  return {
    writeFailure: (row) => exec(async () => {
      await query(
        `INSERT INTO ${FAILURES_TABLE} (handler, position, id, name, entity, action, key, caused_by, metadata, occurred_at, payload, error, failed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9::text::jsonb, $10::text::timestamptz, $11::text::jsonb, $12::text::jsonb, clock_timestamp())`,
        [row.handler, row.position, row.id, row.name, row.entity, row.action, JSON.stringify(row.key), row.causedBy, JSON.stringify(row.metadata ?? {}),
          row.occurredAt.toISOString(), JSON.stringify(row.payload), JSON.stringify({ code: row.error.code, message: row.error.message })],
      );
    }),
    readFailures: (handler, after, limit) => exec(async () => Object.freeze((after === null
      ? await query(`SELECT ${FAILURE_COLUMNS} FROM ${FAILURES_TABLE} WHERE handler = $1 ORDER BY position, failure LIMIT $2`, [handler, limit])
      : await query(
        `SELECT ${FAILURE_COLUMNS} FROM ${FAILURES_TABLE} WHERE handler = $1 AND (position, failure) > ($2::bigint, $3::bigint) ORDER BY position, failure LIMIT $4`,
        [handler, after.position, after.failure, limit],
      )).map(failureOf))),
    deleteFailure: (failure) => exec(async () => (await query(`DELETE FROM ${FAILURES_TABLE} WHERE failure = $1`, [failure])).count === 1),
    renameFailures: (from, to) => exec(async () => { await query(`UPDATE ${FAILURES_TABLE} SET handler = $1 WHERE handler = $2`, [to, from]); }),
  };
}

const leaseOf = (row: Record<string, unknown>): HandlerLeaseRow => Object.freeze({
  name: row.name as string,
  kind: row.kind as "process" | "listen",
  position: int8(row.position, "mesh_handler_progress.position"),
  events: Object.freeze(JSON.parse(row.events as string) as string[]),
  generation: int8(row.generation, "mesh_handler_progress.generation"),
  runId: (row.run_id as string | null) ?? null,
});
const LEASE_COLUMNS = "name, kind, position, events::text AS events, generation, run_id";

/**
 * The delivery operations of multi mode on Postgres (`MultiProcessOperations`): the process rows, the leases on the
 * progress rows, the subscription owners and the recorded `keep`, each in the running transaction. `lockDeliveryState`
 * and `lockHandlerProgress` take `FOR UPDATE` on their row, so a takeover, a handler transaction and a deletion batch
 * of other connections wait for each other. `readDeliveryStateUnlocked` (a handler transaction's claim check, a lease
 * take's clock) takes no lock, so a handler transaction holds only its progress row while the handler runs. At
 * `SERIALIZABLE` the side that waited fails with `40001` when the other changed the row (a `DatabaseBusyError`, reason
 * `serialization`) and never reads the row as it was. The pass's `moveHandler` and `moveSubscription` are one
 * conditional `UPDATE` each. Only a project whose bus declares `multi-process` calls them; on a schema without the table
 * and columns each fails with a `FrameworkError` naming
 * `mesh db push`.
 */
export function multiProcessOperations(query: Query, sequence: () => Promise<string>, holes: HolesColumn = new HolesColumn()): MultiProcessOperations {
  const exec = <T>(statement: () => Promise<T>) => withTables(statement, MULTI_MISSING);
  return {
    lockDeliveryState: () => exec(async () => {
      const row = await lockedState(query, sequence, holes, ", keep");
      return Object.freeze({ ...stateOf(row), keep: (row.keep as "until-delivered" | "all" | null) ?? null }) satisfies LockedDeliveryState;
    }),
    readDeliveryStateUnlocked: () => exec(async () => stateOf(await lockedState(query, sequence, holes, "", false))),
    writeKeep: (keep) => exec(async () => {
      await query(`INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through, keep) VALUES (1, 0, $1) ON CONFLICT (id) DO UPDATE SET keep = excluded.keep`, [keep]);
    }),
    lockHandlerProgress: (name) => exec(async () => {
      const [row] = await query(`SELECT ${LEASE_COLUMNS} FROM ${HANDLER_PROGRESS_TABLE} WHERE name = $1 FOR UPDATE`, [name]);
      return row === undefined ? undefined : leaseOf(row);
    }),
    readHandlerLeases: () => exec(async () =>
      Object.freeze((await query(`SELECT ${LEASE_COLUMNS} FROM ${HANDLER_PROGRESS_TABLE} ORDER BY name COLLATE "C"`)).map(leaseOf))),
    writeHandlerLease: (row) => exec(async () => {
      await query(
        `INSERT INTO ${HANDLER_PROGRESS_TABLE} (name, kind, position, events, generation, run_id) VALUES ($1, $2, $3, $4::text::jsonb, $5, $6)
         ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, position = excluded.position, events = excluded.events,
           generation = excluded.generation, run_id = excluded.run_id`,
        [row.name, row.kind, row.position, JSON.stringify(row.events), row.generation, row.runId],
      );
    }),
    moveHandler: (name, from, to, runId, generation) => exec(async () =>
      (await query(`UPDATE ${HANDLER_PROGRESS_TABLE} SET position = $1 WHERE name = $2 AND position = $3 AND run_id = $4 AND generation = $5`,
        [to, name, from, runId, generation])).count === 1),
    moveSubscription: (name, from, to) => exec(async () =>
      (await query(`UPDATE ${SUBSCRIPTION_PROGRESS_TABLE} SET position = $1 WHERE name = $2 AND position = $3`, [to, name, from])).count === 1),
    readProcesses: () => exec(async () =>
      Object.freeze((await query(
        `SELECT run_id, renewed_at, host, pid, started_at, keep, handlers::text AS handlers, declared::text AS declared
         FROM ${DELIVERY_PROCESS_TABLE} ORDER BY run_id COLLATE "C"`,
      )).map((row) => {
        const handlers = JSON.parse(row.handlers as string) as Record<string, string[]>;
        for (const name of Object.keys(handlers)) Object.freeze(handlers[name]);
        return Object.freeze({
          runId: row.run_id as string,
          renewedAt: date(row.renewed_at)!,
          host: (row.host as string | null) ?? null,
          pid: int8OrNull(row.pid, "mesh_delivery_process.pid"),
          startedAt: date(row.started_at),
          keep: row.keep as "until-delivered" | "all",
          handlers: Object.freeze(handlers),
          declared: Object.freeze(JSON.parse(row.declared as string) as string[]),
        }) satisfies DeliveryProcessRow;
      }))),
    writeProcess: (row) => exec(async () => {
      await query(
        `INSERT INTO ${DELIVERY_PROCESS_TABLE} (run_id, renewed_at, host, pid, started_at, keep, handlers, declared)
         VALUES ($1, clock_timestamp(), $2, $3, $4::text::timestamptz, $5, $6::text::jsonb, $7::text::jsonb)
         ON CONFLICT (run_id) DO UPDATE SET renewed_at = excluded.renewed_at, host = excluded.host, pid = excluded.pid,
           started_at = excluded.started_at, keep = excluded.keep, handlers = excluded.handlers, declared = excluded.declared`,
        [row.runId, row.host === undefined ? hostname() : row.host, row.pid, iso(row.startedAt), row.keep, JSON.stringify(row.handlers), JSON.stringify(row.declared)],
      );
    }),
    renewProcess: (runId, lapseMs) => exec(async () =>
      (await query(
        `UPDATE ${DELIVERY_PROCESS_TABLE} SET renewed_at = clock_timestamp()
         WHERE run_id = $1 AND clock_timestamp() - renewed_at < $2::text::float8 * interval '1 millisecond'`,
        [runId, String(lapseMs)],
      )).count === 1),
    deleteProcess: (runId) => exec(async () => (await query(`DELETE FROM ${DELIVERY_PROCESS_TABLE} WHERE run_id = $1`, [runId])).count === 1),
    readSubscriptionOwners: () => exec(async () =>
      Object.freeze((await query(
        `SELECT name, position, filter::text AS filter, seen_at, open, generation, run_id FROM ${SUBSCRIPTION_PROGRESS_TABLE} ORDER BY name COLLATE "C"`,
      )).map((row) => Object.freeze({
        name: row.name as string,
        position: int8(row.position, "mesh_subscription_progress.position"),
        filter: Object.freeze(JSON.parse(row.filter as string) as SubscriptionFilter),
        seenAt: date(row.seen_at)!,
        open: int8(row.open, "mesh_subscription_progress.open") !== 0,
        generation: int8(row.generation, "mesh_subscription_progress.generation"),
        runId: (row.run_id as string | null) ?? null,
      }) satisfies SubscriptionOwnerRow))),
    writeSubscriptionOwner: (row) => exec(async () => {
      await query(
        `INSERT INTO ${SUBSCRIPTION_PROGRESS_TABLE} (name, position, filter, seen_at, open, generation, run_id)
         VALUES ($1, $2, $3::text::jsonb, COALESCE($4::text::timestamptz, clock_timestamp()), $5, $6, $7)
         ON CONFLICT (name) DO UPDATE SET position = excluded.position, filter = excluded.filter, seen_at = excluded.seen_at,
           open = excluded.open, generation = excluded.generation, run_id = excluded.run_id`,
        [row.name, row.position, JSON.stringify(row.filter), iso(row.seenAt), row.open ? 1 : 0, row.generation, row.runId],
      );
    }),
  };
}
