/**
 * The tables core declares (spec, Events and commands, "The outbox"): Mesh's own state, kept in the project's
 * database beside the entities' tables. Core says what each table holds; the data adapter creates it (data-sqlite's
 * schema view maps each column to a Drizzle column as it maps an attribute of the same type) and refuses entity data
 * operations on it. A table is needed only when the project declares what it serves (`needs`), so a project without
 * events keeps its schema unchanged.
 */

/**
 * The column types core's tables use: a subset of the model's attribute types (`AttributeType`), so an adapter
 * stores a core column exactly as it stores an attribute of that type. The runtime imports nothing, so the subset is
 * spelled here; data-sqlite's schema view checks at the type level that it stays a subset.
 */
export type CoreColumnType = "integer" | "uuid" | "string" | "json" | "timestamp";

export interface CoreColumn {
  /** The column name as stored. */
  readonly name: string;
  readonly type: CoreColumnType;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /**
   * True for an integer primary key whose values the database assigns and never reuses, even after the row with the
   * highest value is deleted (SQLite's `AUTOINCREMENT`). An adapter that cannot promise it cannot store the table.
   */
  readonly neverReuse: boolean;
}

export interface CoreTable {
  /** The table name as stored; an entity whose table has this name is refused while the table is needed. */
  readonly name: string;
  /** What the project must declare for the table to exist: `events`, an event declaration. */
  readonly needs: "events";
  readonly columns: readonly CoreColumn[];
}

/** One row per published event, never updated; `position` is its place in the outbox's order. */
export const OUTBOX_TABLE = "mesh_outbox";
/** One row, `id` 1, written by the first delete: the highest deleted position (`deleted_through`). */
export const OUTBOX_STATE_TABLE = "mesh_outbox_state";

const column = (name: string, type: CoreColumnType, options: Partial<Omit<CoreColumn, "name" | "type">> = {}): CoreColumn =>
  Object.freeze({ name, type, nullable: false, primaryKey: false, neverReuse: false, ...options });
const table = (name: string, columns: CoreColumn[]): CoreTable => Object.freeze({ name, needs: "events" as const, columns: Object.freeze(columns) });

/** Every table core declares, in the order an adapter writes them after the entities' tables. */
export const CORE_TABLES: readonly CoreTable[] = Object.freeze([
  table(OUTBOX_TABLE, [
    column("position", "integer", { primaryKey: true, neverReuse: true }),
    column("id", "uuid"),
    column("name", "string"),
    column("entity", "string"),
    column("action", "string"),
    column("key", "json"),
    column("caused_by", "uuid", { nullable: true }),
    column("metadata", "json"),
    column("occurred_at", "timestamp"),
    column("payload", "json"),
  ]),
  table(OUTBOX_STATE_TABLE, [
    column("id", "integer", { primaryKey: true }),
    column("deleted_through", "integer"),
  ]),
]);

/** The names of every core table, needed or not: no entity data operation reaches one. */
export const CORE_TABLE_NAMES: ReadonlySet<string> = new Set(CORE_TABLES.map((core) => core.name));

/** The core tables a project needs: the outbox's when it declares an event, none otherwise. */
export function coreTablesFor(project: { readonly events?: readonly unknown[] }): readonly CoreTable[] {
  return project.events?.length ? CORE_TABLES.filter((core) => core.needs === "events") : [];
}
