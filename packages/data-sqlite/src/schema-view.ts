import { relative } from "node:path";
import { EmitError, type EmitInput } from "@meshfw/compiler";
import type { AttributeType, Entity, SourcePosition } from "@meshfw/model";
import { sqliteNameKey, sqliteNameProblem } from "./identifiers.ts";

/**
 * What `schema.ts.jig` renders: the Drizzle SQLite table of every entity and the
 * `tables` map that `createSchema` and `mesh db push` take. Every string is final;
 * the template prints, loops and branches on these fields and computes nothing.
 * A project's own `schema.ts.jig` depends on this shape.
 */
export interface SchemaView {
  /** The column builders the tables use, sorted, for the `drizzle-orm/sqlite-core` import. */
  readonly builders: readonly string[];
  /** One table per entity, sorted by `exportName`. */
  readonly tables: readonly TableView[];
}

/** `export const <exportName> = _meshSqlite(<nameLiteral>, { ...columns });` and its `tables` entry. */
export interface TableView {
  /** The entity's name as authored, e.g. `Post`. */
  readonly entity: string;
  /** The exported table constant: the entity name, camelCase, plus `Table`, e.g. `postTable`. */
  readonly exportName: string;
  /** The entity's `tables` key as printed: the camelCase entity name, e.g. `post`. */
  readonly key: string;
  /** The SQL table name (the entity's `table`) as a string literal, e.g. `"posts"`. */
  readonly nameLiteral: string;
  /** The columns: the entity's attributes in authored order, then one key column per relationship that has one. */
  readonly columns: readonly ColumnView[];
}

/** `<key>: <builder>(<nameLiteral>[, <options>])[.notNull()][.primaryKey()][.unique()],` */
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

/** The same word rule as the `types` generator's PascalCase, with the first letter lower-cased. */
export function camelCase(name: string): string {
  const leading = /^_*/.exec(name)?.[0] ?? "";
  const words = name.slice(leading.length).split(/[^A-Za-z0-9]+/).filter(Boolean);
  return leading + words.map((word, index) =>
    (index === 0 ? word[0]!.toLowerCase() : word[0]!.toUpperCase()) + word.slice(1)).join("");
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
    unique,
  };
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
        `"${previous}" and "${name}" in entity ${entity.name} are the same SQLite column: SQLite compares column names without ASCII letter case`,
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
    if (relation.keyColumn) add(relation.keyColumn, relation.position, column(relation.keyColumn, "string", relation.nullable, false, []));
  }
  // Entity names are MX identifiers (`:blog-post`), so the camelCase name always is one.
  const key = camelCase(entity.name);
  return { entity: entity.name, exportName: `${key}Table`, key: propertyKey(key), nameLiteral: JSON.stringify(entity.table), columns };
}

/** The schema view of the whole model. Pure and synchronous; a model it cannot store is an `EmitError`. */
export function schemaView({ document }: EmitInput): SchemaView {
  const sorted = [...document.entities].sort((a, b) =>
    compare(a.name, b.name) || compare(a.module, b.module) || compare(a.file, b.file));
  const tables: TableView[] = [];
  const tableOwners = new Map<string, Entity>();
  const exportOwners = new Map<string, Entity>();
  const describe = (entity: Entity) => `${entity.name} (${entity.file})`;
  for (const entity of sorted) {
    const view = tableView(entity);
    const sameTable = tableOwners.get(sqliteNameKey(entity.table));
    if (sameTable) {
      fail("MESH_SCHEMA_DUPLICATE_TABLE",
        `Entities ${describe(sameTable)} and ${describe(entity)} both use the SQLite table "${entity.table}"`,
        entity.position, 'Give each entity its own table="..."');
    }
    const sameExport = exportOwners.get(view.exportName);
    if (sameExport) {
      fail("MESH_SCHEMA_DUPLICATE_EXPORT",
        `Entities ${describe(sameExport)} and ${describe(entity)} both become the schema export ${view.exportName}`,
        entity.position, "Rename one entity: schema.ts exports one table per entity name");
    }
    tableOwners.set(sqliteNameKey(entity.table), entity);
    exportOwners.set(view.exportName, entity);
    tables.push(view);
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
