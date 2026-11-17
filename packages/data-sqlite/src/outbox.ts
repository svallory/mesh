import type { Database } from "bun:sqlite";
import { FrameworkError, OUTBOX_STATE_TABLE, OUTBOX_TABLE, type OutboxAppend, type OutboxPage, type OutboxRow } from "@meshfw/runtime";

interface StoredRow {
  position: number;
  id: string;
  name: string;
  entity: string;
  action: string;
  key: string;
  caused_by: string | null;
  metadata: string;
  occurred_at: number;
  payload: string;
}

function json(value: unknown, what: string): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new FrameworkError(`An outbox row's ${what} must be JSON; got ${typeof value}`);
  return text;
}

function missingTable(cause: unknown): unknown {
  const message = cause instanceof Error ? cause.message : "";
  return /no such table: (main\.)?(mesh_outbox|sqlite_sequence)/.test(message)
    ? new FrameworkError("The outbox table mesh_outbox does not exist in this database: prepare the schema with `mesh db push` (or createSchema in a test) after building a project that declares an event", { cause })
    : cause;
}

/** Runs `statement`, turning a missing outbox table into an error that says how to create it. */
function withTables<T>(statement: () => T): T {
  try { return statement(); } catch (cause) { throw missingTable(cause); }
}

function checkPosition(value: number, what: string, smallest: number): void {
  if (!Number.isSafeInteger(value) || value < smallest) {
    throw new FrameworkError(`${what} must be an integer of at least ${smallest}; got ${typeof value === "number" ? value : typeof value}`);
  }
}

/** Inserts one row in the running transaction; `AUTOINCREMENT` gives its position, which is never reused. */
export function appendEvent(client: Database, row: OutboxAppend): number {
  if (!(row.occurredAt instanceof Date) || Number.isNaN(row.occurredAt.getTime())) throw new FrameworkError("An outbox row's occurredAt must be a valid Date");
  const stored = withTables(() => client.query(
    `INSERT INTO ${OUTBOX_TABLE} (id, name, entity, action, key, caused_by, metadata, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING position`,
  ).get(row.id, row.name, row.entity, row.action, json(row.key, "key"), row.causedBy, json(row.metadata, "metadata"), row.occurredAt.getTime(), json(row.payload, "payload")) as { position: number });
  return stored.position;
}

/** The connections whose `mesh_outbox_state` was seen to have the `holes` column: only a positive answer is kept. */
const withHoles = new WeakSet<Database>();

/**
 * True when `mesh_outbox_state` has the `holes` column (the hole record of a per-event `events.keep`). A database not
 * pushed since the column was added has none, and then no hole can have been written, so every read reports none.
 * Asked once per connection once true; while false it is asked again, so a `mesh db push` that adds it is seen.
 */
export function hasHolesColumn(client: Database): boolean {
  if (withHoles.has(client)) return true;
  const columns = client.query(`PRAGMA table_info(${OUTBOX_STATE_TABLE})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === "holes")) return false;
  withHoles.add(client);
  return true;
}

/** The hole record as stored (JSON text, or null for none), as `OutboxPage.holes` and `DeliveryState.holes` carry it. */
export function holesOf(stored: string | null | undefined): Readonly<Record<string, number>> {
  if (stored === null || stored === undefined) return Object.freeze({});
  return Object.freeze(JSON.parse(stored) as Record<string, number>);
}

/**
 * The rows after `after` and both positions in one statement. Outside `BEGIN` a statement is its own transaction on
 * SQLite, so the rows, the deleted-through position and the highest position describe one state of the database: a
 * delete can never commit between them. `sqlite_sequence` keeps the highest position `AUTOINCREMENT` ever gave. One
 * writer at a time means every position ever given is final once a read outside it sees it, so `settled` is `highest`.
 * The hole record comes from the same statement, when the database has its column.
 */
export function readOutbox(client: Database, after: number, limit: number): OutboxPage {
  checkPosition(after, "readOutbox's after", 0);
  checkPosition(limit, "readOutbox's limit", 1);
  const holes = withTables(() => hasHolesColumn(client));
  const result = withTables(() => client.query(
    `SELECT s.deleted_through AS s_deleted_through, s.highest AS s_highest${holes ? ", s.holes AS s_holes" : ""}, o.* FROM (
       SELECT COALESCE((SELECT deleted_through FROM ${OUTBOX_STATE_TABLE} WHERE id = 1), 0) AS deleted_through,
              COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${OUTBOX_TABLE}'), 0) AS highest${holes ? `,
              (SELECT holes FROM ${OUTBOX_STATE_TABLE} WHERE id = 1) AS holes` : ""}
     ) AS s
     LEFT JOIN (SELECT * FROM ${OUTBOX_TABLE} WHERE position > ? ORDER BY position LIMIT ?) AS o ON 1
     ORDER BY o.position`,
  ).all(after, limit) as (StoredRow & { s_deleted_through: number; s_highest: number; s_holes?: string | null })[]);
  const first = result[0]!;
  const rows: OutboxRow[] = [];
  for (const stored of result) {
    if (stored.position === null) continue;
    rows.push(Object.freeze({
      position: stored.position,
      id: stored.id,
      name: stored.name,
      entity: stored.entity,
      action: stored.action,
      key: JSON.parse(stored.key),
      causedBy: stored.caused_by,
      metadata: JSON.parse(stored.metadata),
      occurredAt: new Date(stored.occurred_at),
      payload: JSON.parse(stored.payload),
    }));
  }
  return Object.freeze({
    rows: Object.freeze(rows), deletedThrough: first.s_deleted_through, highest: first.s_highest, settled: first.s_highest,
    ...(holes ? { holes: holesOf(first.s_holes) } : {}),
  });
}

/**
 * In the running transaction: deletes every row at or below `position` and records it as the deleted-through position.
 * A position at or below the recorded one is a no-op; one above the highest position ever given is refused, since a
 * deleted-through position above it would make every later row read as deleted.
 */
export function deleteOutboxThrough(client: Database, position: number): number {
  checkPosition(position, "deleteOutboxThrough's position", 0);
  return withTables(() => {
    const { deleted_through: current, highest } = client.query(
      `SELECT COALESCE((SELECT deleted_through FROM ${OUTBOX_STATE_TABLE} WHERE id = 1), 0) AS deleted_through,
              COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${OUTBOX_TABLE}'), 0) AS highest`,
    ).get() as { deleted_through: number; highest: number };
    if (position > highest) {
      throw new FrameworkError(`deleteOutboxThrough(${position}) is above the highest outbox position ever assigned, ${highest}: only delivered rows, which have positions, can be deleted`);
    }
    if (position <= current) return 0;
    const { changes } = client.query(`DELETE FROM ${OUTBOX_TABLE} WHERE position <= ?`).run(position);
    client.query(
      `INSERT INTO ${OUTBOX_STATE_TABLE} (id, deleted_through) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET deleted_through = excluded.deleted_through`,
    ).run(position);
    return changes;
  });
}
