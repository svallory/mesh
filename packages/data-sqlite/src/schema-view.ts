import { relative } from "node:path";
import { EmitError, type EmitInput } from "@meshfw/compiler";
import type { AttributeType, Entity, SourcePosition } from "@meshfw/model";
import { sqliteNameKey, sqliteNameProblem } from "./identifiers.ts";
import { OUTBOX_STATE_TABLE, OUTBOX_TABLE } from "./outbox.ts";

/**
 * What `schema.ts.jig` renders: the Drizzle SQLite table of every entity, the
 * `tables` map that `createSchema` and `mesh db push` take. Every string is final;
 * the template prints, loops and branches on these fields and computes nothing.
 * A project's own `schema.ts.jig` depends on this shape.
 */
export interface SchemaView {
  /** The column builders the tables use, sorted, for the `drizzle-orm/sqlite-core` import. */
  readonly builders: readonly string[];
  /**
   * One table per entity, sorted by entity name, module and file; then, when the project declares an event, core's
   * `mesh_outbox` and `mesh_outbox_state`.
   */
  readonly tables: readonly TableView[];
}

/** `<key>: _meshSqlite(<nameLiteral>, { ...columns }),`, one entry of the `tables` map. */
export interface TableView {
  /** The entity's name as authored, e.g. `Post`; for one of core's tables, the table's name, e.g. `mesh_outbox`. */
  readonly entity: string;
  /** The entity's `tables` key as printed: its table name as stored, quoted when not an identifier, e.g. `posts` or `"late-result"`. */
  readonly key: string;
  /** The SQL table name (the entity's `table`) as a string literal, e.g. `"posts"`. */
  readonly nameLiteral: string;
  /** The columns: the entity's attributes in authored order, then one key column per relationship that has one. */
  readonly columns: readonly ColumnView[];
}

/** `<key>: <builder>(<nameLiteral>[, <options>])[.notNull()][.primaryKey([{ autoIncrement: true }])][.unique()],` */
export interface ColumnView {
  /** The property key as printed: the attribute name, JSON-quoted when it is not an identifier. */
  readonly key: string;
  /** The `drizzle-orm/sqlite-core` builder: `text`, `integer` or `real`. */
  readonly builder: string;
  /** The SQL column name (the attribute name) as a string literal. */
  readonly nameLiteral: string;
  /** The builder's options object as printed, e.g. `{ mode: "boolean" }`, or `null` when it takes none. */
  readonly options: string | null;
  /** True when the column is not nullable; the template prints `.notNull()`. */
  readonly notNull: boolean;
  /** True for the entity's primary key; the template prints `.primaryKey()`. */
  readonly primaryKey: boolean;
  /**
   * True for an integer primary key whose values SQLite assigns with `AUTOINCREMENT`, never reusing one even after the
   * highest row is deleted; the template prints `.primaryKey({ autoIncrement: true })`. Only the outbox's `position`
   * has it: an entity's integer key is filled by the data layer (`integer-key-fill`).
   */
  readonly autoIncrement: boolean;
  /** True for an attribute declared `unique`; the template prints `.unique()`. */
  readonly unique: boolean;
}

/**
 * How each attribute type is stored. The TypeScript type Drizzle infers for each
 * column equals the record type the `types` generator writes for the attribute
 * (`string`, `number`, `boolean`, `Date`, `unknown` for `json`, or the union of an enum's values); a
 * type-level test checks every entry. No defaults: the generated actions write
 * every default, generated id and timestamp themselves (ADR-0003).
 */
export const SQLITE_COLUMNS = Object.freeze({
  uuid: { builder: "text", options: null },
  string: { builder: "text", options: null },
  integer: { builder: "integer", options: null },
  float: { builder: "real", options: null },
  decimal: { builder: "real", options: null },
  boolean: { builder: "integer", options: '{ mode: "boolean" }' },
  enum: { builder: "text", options: "enum" },
  date: { builder: "integer", options: '{ mode: "timestamp_ms" }' },
  datetime: { builder: "integer", options: '{ mode: "timestamp_ms" }' },
  timestamp: { builder: "integer", options: '{ mode: "timestamp_ms" }' },
  json: { builder: "text", options: '{ mode: "json" }' },
} as const satisfies Record<AttributeType, { builder: string; options: string | null }>);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// The compiler refuses `__proto__` as a name, so a quoted key always defines an own property.
const propertyKey = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

function fail(code: string, message: string, position: SourcePosition, fix: string): never {
  throw new EmitError({ severity: "error", code, message, position, fix });
}

function column(name: string, type: AttributeType, nullable: boolean, primaryKey: boolean, values: readonly string[], unique = false): ColumnView {
  const { builder, options } = SQLITE_COLUMNS[type];
  return {
    key: propertyKey(name),
    builder,
    nameLiteral: JSON.stringify(name),
    options: options === "enum" ? `{ enum: ${JSON.stringify(values)} }` : options,
    notNull: !nullable,
    primaryKey,
    autoIncrement: false,
    unique,
  };
}

/**
 * Core's outbox tables (spec, Events and commands, "The outbox"). `mesh_outbox` holds one row per published event,
 * never updated; `position` uses `AUTOINCREMENT`, so a position is never reused. `mesh_outbox_state` has one row,
 * `id` 1, written by the first delete: the deleted-through position. The deliverer's claim (M6 PR 3) adds nullable
 * columns to it, which a push adds without loss.
 */
function coreTables(): TableView[] {
  const plain = (name: string, type: AttributeType, nullable = false) => column(name, type, nullable, false, []);
  return [
    {
      entity: OUTBOX_TABLE, key: OUTBOX_TABLE, nameLiteral: JSON.stringify(OUTBOX_TABLE),
      columns: [
        { ...column("position", "integer", false, true, []), autoIncrement: true },
        plain("id", "uuid"),
        plain("name", "string"),
        plain("entity", "string"),
        plain("action", "string"),
        plain("key", "json"),
        plain("caused_by", "uuid", true),
        plain("metadata", "json"),
        plain("occurred_at", "timestamp"),
        plain("payload", "json"),
      ],
    },
    {
      entity: OUTBOX_STATE_TABLE, key: OUTBOX_STATE_TABLE, nameLiteral: JSON.stringify(OUTBOX_STATE_TABLE),
      columns: [column("id", "integer", false, true, []), plain("deleted_through", "integer")],
    },
  ];
}

function checkName(name: string, kind: "table" | "column", position: SourcePosition): void {
  const problem = sqliteNameProblem(name, kind);
  if (problem) fail("MESH_SCHEMA_IDENTIFIER", problem, position, `Remove backticks and ASCII control characters from the ${kind} name`);
}

function tableView(entity: Entity): TableView {
  checkName(entity.table, "table", entity.position);
  const columns: ColumnView[] = [];
  const owners = new Map<string, string>();
  const add = (name: string, position: SourcePosition, view: ColumnView) => {
    checkName(name, "column", position);
    const previous = owners.get(sqliteNameKey(name));
    if (previous !== undefined) {
      fail("MESH_SCHEMA_DUPLICATE_COLUMN",
        `"${previous}" and "${name}" in entity ${entity.fqn} are the same SQLite column: SQLite compares column names without ASCII letter case`,
        position, "Rename one so the names differ by more than letter case");
    }
    owners.set(sqliteNameKey(name), name);
    columns.push(view);
  };
  for (const attribute of entity.attributes) {
    add(attribute.name, attribute.position, column(attribute.name, attribute.type, attribute.nullable, attribute.primaryKey,
      (attribute.values ?? []).map((atom) => atom.value), attribute.unique));
  }
  for (const relation of entity.relationships) {
    if (relation.keyColumn) add(relation.keyColumn, relation.position, column(relation.keyColumn, relation.keyType ?? "string", relation.nullable, false, []));
  }
  return { entity: entity.name, key: propertyKey(entity.table), nameLiteral: JSON.stringify(entity.table), columns };
}

/** The schema view of the whole model. Pure and synchronous; a model it cannot store is an `EmitError`. */
export function schemaView({ document }: EmitInput): SchemaView {
  const sorted = [...document.entities].sort((a, b) =>
    compare(a.name, b.name) || compare(a.module, b.module) || compare(a.file, b.file));
  const tables: TableView[] = [];
  const tableOwners = new Map<string, Entity>();
  const describe = (entity: Entity) => `${entity.fqn} (${entity.file})`;
  for (const entity of sorted) {
    const view = tableView(entity);
    const sameTable = tableOwners.get(sqliteNameKey(entity.table));
    if (sameTable) {
      fail("MESH_SCHEMA_DUPLICATE_TABLE",
        `Entities ${describe(sameTable)} and ${describe(entity)} both use the SQLite table "${entity.table}"`,
        entity.position, 'Set table="..." on one of the two entities');
    }
    tableOwners.set(sqliteNameKey(entity.table), entity);
    tables.push(view);
  }
  if (document.events?.length) {
    for (const core of coreTables()) {
      const entity = tableOwners.get(sqliteNameKey(core.entity));
      if (entity) {
        fail("MESH_SCHEMA_DUPLICATE_TABLE",
          `Entity ${describe(entity)} uses the SQLite table "${entity.table}", which is Mesh's own once the project declares an event: it holds the outbox`,
          entity.position, 'Set table="..." on the entity to another name');
      }
      tables.push(core);
    }
  }
  const builders = [...new Set(tables.flatMap((table) => table.columns.map((column) => column.builder)))].sort(compare);
  return { builders, tables };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `<output>/schema.ts`, project-relative with `/` separators. */
export function schemaPath({ config }: EmitInput): string {
  return `${relative(config.root, config.output).split("\\").join("/")}/schema.ts`;
}
