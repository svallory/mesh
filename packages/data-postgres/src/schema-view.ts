import { relative } from "node:path";
import { EmitError, conceptTypeImport, type EmitInput } from "@meshfw/compiler";
import type { Attribute, AttributeType, Entity, ModelDocument, SourcePosition } from "@meshfw/model";
import { coreTablesFor, type CoreColumnType, type CoreTable } from "@meshfw/runtime";
import { POSTGRES_NAME_BYTES, nameBytes, postgresNameProblem } from "./identifiers.ts";

/**
 * What `schema.ts.jig` renders: the Drizzle Postgres table of every entity, the `tables` map that `createSchema` and
 * `mesh db push` take. Every string is final; the template prints, loops and branches on these fields and computes
 * nothing. A project's own `schema.ts.jig` depends on this shape.
 */
export interface PostgresSchemaView {
  /** The column builders the tables use, sorted, for the `drizzle-orm/pg-core` import. */
  readonly builders: readonly string[];
  /**
   * One table per entity, sorted by entity name, module and file; then, when the project declares an event, core's
   * tables.
   */
  readonly tables: readonly PostgresTableView[];
  /**
   * The concepts a column holds, one type-only import per concept file, sorted by specifier:
   * `import type { Money as $Money$concept } from "./domain/money.concept";`. Type-only, so loading `schema.ts` (drizzle-kit
   * does) loads neither zod nor the concept module. Empty when no column holds a concept.
   */
  readonly typeImports: readonly { readonly names: string; readonly fromLiteral: string }[];
}

/** `<key>: _meshPg(<nameLiteral>, { ...columns }),`, one entry of the `tables` map. */
export interface PostgresTableView {
  /** The entity's name as authored, e.g. `Post`; for one of core's tables, the table's name, e.g. `mesh_outbox`. */
  readonly entity: string;
  /** The entity's `tables` key as printed: its table name, quoted when not an identifier, e.g. `posts` or `"late-result"`. */
  readonly key: string;
  /** The SQL table name (the entity's `table`) as a string literal, e.g. `"posts"`. */
  readonly nameLiteral: string;
  /** The columns: the entity's attributes in authored order, then one key column per relationship that has one. */
  readonly columns: readonly PostgresColumnView[];
}

/** `<key>: <builder>(<nameLiteral>[, <options>])[.notNull()][.primaryKey()][.generatedAlwaysAsIdentity()][.unique()],` */
export interface PostgresColumnView {
  /** The property key as printed: the attribute name, JSON-quoted when it is not an identifier. */
  readonly key: string;
  /** The `drizzle-orm/pg-core` builder: `text`, `bigint`, `doublePrecision`, `boolean`, `timestamp` or `jsonb`. */
  readonly builder: string;
  /** The SQL column name (the attribute name) as a string literal. */
  readonly nameLiteral: string;
  /** The builder's options object as printed, e.g. `{ mode: "number" }`, or `null` when it takes none. */
  readonly options: string | null;
  /** True when the column is not nullable; the template prints `.notNull()`. */
  readonly notNull: boolean;
  /** True for the entity's primary key; the template prints `.primaryKey()`. */
  readonly primaryKey: boolean;
  /**
   * True for an integer key whose values a Postgres sequence assigns and never hands out again, even after the highest
   * row is deleted; the template prints `.generatedAlwaysAsIdentity()`. Only the outbox's `position` has it: an
   * entity's integer key is filled by the data layer (`integer-key-fill`).
   */
  readonly identity: boolean;
  /** True for an attribute declared `unique`; the template prints `.unique()`. */
  readonly unique: boolean;
  /**
   * The TypeScript type the column holds, for a concept member (`$Money$concept`, the local `conceptTypeImport` gives),
   * printed as `.$type<$Money$concept>()` so Drizzle infers the concept's type; `null` for every other column.
   */
  readonly typeArgument: string | null;
}

/**
 * How each attribute type is stored. The TypeScript type Drizzle infers for each column equals the record type the
 * `types` generator writes for the attribute (`string`, `number`, `boolean`, `Date`, `unknown` for `json`, or the union
 * of an enum's values); a type-level test checks every entry. Every value SQLite stores, Postgres stores, except a
 * string holding NUL and a date before 4713 BC: `integer` is 64-bit as on SQLite, `uuid` is `text` so a malformed id in
 * a filter matches nothing instead of failing, and a date is `timestamp(3) with time zone`, a millisecond round trip.
 * No defaults: the generated actions write every default, generated id and timestamp themselves (ADR-0003).
 */
export const POSTGRES_COLUMNS = Object.freeze({
  uuid: { builder: "text", options: null },
  string: { builder: "text", options: null },
  integer: { builder: "bigint", options: '{ mode: "number" }' },
  float: { builder: "doublePrecision", options: null },
  decimal: { builder: "doublePrecision", options: null },
  boolean: { builder: "boolean", options: null },
  enum: { builder: "text", options: "enum" },
  date: { builder: "timestamp", options: '{ mode: "date", precision: 3, withTimezone: true }' },
  datetime: { builder: "timestamp", options: '{ mode: "date", precision: 3, withTimezone: true }' },
  timestamp: { builder: "timestamp", options: '{ mode: "date", precision: 3, withTimezone: true }' },
  json: { builder: "jsonb", options: null },
} as const satisfies Record<AttributeType, { builder: string; options: string | null }>);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// The compiler refuses `__proto__` as a name, so a quoted key always defines an own property.
const propertyKey = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

function fail(code: string, message: string, position: SourcePosition, fix: string): never {
  throw new EmitError({ severity: "error", code, message, position, fix });
}

/** A concept member is one JSON value (ADR-0092), stored as a `json` attribute is (`jsonb`) and typed with the concept's type. */
const CONCEPT_COLUMN = { builder: "jsonb", options: null } as const;

function column(name: string, type: AttributeType, nullable: boolean, primaryKey: boolean, values: readonly string[], unique = false): PostgresColumnView {
  const { builder, options } = POSTGRES_COLUMNS[type];
  return {
    key: propertyKey(name),
    builder,
    nameLiteral: JSON.stringify(name),
    options: options === "enum" ? `{ enum: ${JSON.stringify(values)} }` : options,
    notNull: !nullable,
    primaryKey,
    identity: false,
    unique,
    typeArgument: null,
  };
}

/** The column of a concept member: `jsonb(name).$type<local>()`. */
function conceptColumn(attribute: Attribute, local: string): PostgresColumnView {
  return { ...column(attribute.name, "json", attribute.nullable, false, []), ...CONCEPT_COLUMN, typeArgument: local };
}

// Core's column types must stay attribute types, so each maps through `POSTGRES_COLUMNS` as an attribute would.
const coreTypeIsAttributeType: CoreColumnType extends AttributeType ? true : never = true;
void coreTypeIsAttributeType;

/**
 * One of core's tables (`CORE_TABLES` in `@meshfw/runtime`) as a table view: each column is stored as an attribute of
 * its type, and a `neverReuse` key is an identity column, so Postgres never hands out a position again.
 */
function coreTableView(core: CoreTable): PostgresTableView {
  return {
    entity: core.name, key: propertyKey(core.name), nameLiteral: JSON.stringify(core.name),
    columns: core.columns.map((spec) => ({ ...column(spec.name, spec.type, spec.nullable, spec.primaryKey, []), identity: spec.neverReuse })),
  };
}

function checkName(name: string, kind: "table" | "column", position: SourcePosition): void {
  const problem = postgresNameProblem(name, kind);
  if (!problem) return;
  const fix = nameBytes(name) > POSTGRES_NAME_BYTES && !/["\x00-\x1f\x7f]/.test(name)
    ? (kind === "table" ? 'Give the table a name of at most 63 bytes with table="..."' : "Give the attribute a name of at most 63 bytes")
    : `Remove double quotes and ASCII control characters from the ${kind} name`;
  fail("MESH_SCHEMA_IDENTIFIER", problem, position, fix);
}

function tableView(entity: Entity, conceptLocalOf: (fqn: string) => string): PostgresTableView {
  checkName(entity.table, "table", entity.position);
  const columns: PostgresColumnView[] = [];
  const owners = new Set<string>();
  const add = (name: string, position: SourcePosition, view: PostgresColumnView) => {
    checkName(name, "column", position);
    // Postgres compares quoted identifiers exactly, so only the same name twice is one column.
    if (owners.has(name)) {
      fail("MESH_SCHEMA_DUPLICATE_COLUMN", `"${name}" and "${name}" in entity ${entity.fqn} are the same Postgres column`, position, "Rename one");
    }
    if (view.unique) {
      // Drizzle names the constraint itself; a name Postgres cuts would differ from Drizzle's on every push.
      const constraint = `${entity.table}_${name}_unique`;
      if (nameBytes(constraint) > POSTGRES_NAME_BYTES) {
        fail("MESH_SCHEMA_IDENTIFIER",
          `The unique constraint of ${entity.fqn}.${name} would be named "${constraint}", ${nameBytes(constraint)} bytes; Postgres keeps the first ${POSTGRES_NAME_BYTES}, so every push would see a difference`,
          position, "Shorten the table or the attribute name");
      }
    }
    owners.add(name);
    columns.push(view);
  };
  for (const attribute of entity.attributes) {
    if (attribute.type === "concept") {
      add(attribute.name, attribute.position, conceptColumn(attribute, conceptLocalOf(attribute.concept!)));
      continue;
    }
    add(attribute.name, attribute.position, column(attribute.name, attribute.type, attribute.nullable, attribute.primaryKey,
      (attribute.values ?? []).map((atom) => atom.value), attribute.unique));
  }
  for (const relation of entity.relationships) {
    if (relation.keyColumn) add(relation.keyColumn, relation.position, column(relation.keyColumn, relation.keyType ?? "string", relation.nullable, false, []));
  }
  return { entity: entity.name, key: propertyKey(entity.table), nameLiteral: JSON.stringify(entity.table), columns };
}

/** The schema view of the whole model. Pure and synchronous; a model it cannot store is an `EmitError`. */
export function schemaView({ document }: EmitInput): PostgresSchemaView {
  // Each concept a column holds is imported into `schema.ts` by the compiler's one naming rule (`conceptTypeImport`).
  const imports = new Map<string, { local: string; specifier: string; name: string }>();
  const conceptLocalOf = (fqn: string): string => {
    const found = conceptTypeImport(document, fqn, "schema.ts");
    imports.set(fqn, { ...found, name: conceptName(document, fqn) });
    return found.local;
  };
  const sorted = [...document.entities].sort((a, b) =>
    compare(a.name, b.name) || compare(a.module, b.module) || compare(a.file, b.file));
  const tables: PostgresTableView[] = [];
  const tableOwners = new Map<string, Entity>();
  const describe = (entity: Entity) => `${entity.fqn} (${entity.file})`;
  for (const entity of sorted) {
    const view = tableView(entity, conceptLocalOf);
    const sameTable = tableOwners.get(entity.table);
    if (sameTable) {
      fail("MESH_SCHEMA_DUPLICATE_TABLE",
        `Entities ${describe(sameTable)} and ${describe(entity)} both use the Postgres table "${entity.table}"`,
        entity.position, 'Set table="..." on one of the two entities');
    }
    tableOwners.set(entity.table, entity);
    tables.push(view);
  }
  for (const core of coreTablesFor(document)) {
    const entity = tableOwners.get(core.name);
    if (entity) {
      fail("MESH_SCHEMA_DUPLICATE_TABLE",
        `Entity ${describe(entity)} uses the Postgres table "${entity.table}", which is Mesh's own once the project declares an event: it holds the outbox`,
        entity.position, 'Set table="..." on the entity to another name');
    }
    tables.push(coreTableView(core));
  }
  const builders = [...new Set(tables.flatMap((table) => table.columns.map((column) => column.builder)))].sort(compare);
  return { builders, tables, typeImports: typeImportsOf(imports) };
}

/** A concept's exported type name: its declared name (the compiler checked it is PascalCase). */
function conceptName(document: Pick<ModelDocument, "concepts">, fqn: string): string {
  return document.concepts!.find((concept) => concept.fqn === fqn)!.name;
}

/** One `import type { A as $A$concept } from "<specifier>"` per concept file, sorted by specifier. */
function typeImportsOf(imports: ReadonlyMap<string, { local: string; specifier: string; name: string }>): { names: string; fromLiteral: string }[] {
  return [...imports.values()]
    .sort((a, b) => compare(a.specifier, b.specifier))
    .map(({ local, specifier, name }) => ({ names: `${name} as ${local}`, fromLiteral: JSON.stringify(specifier) }));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `<output>/schema.ts`, project-relative with `/` separators. */
export function schemaPath({ config }: EmitInput): string {
  return `${relative(config.root, config.output).split("\\").join("/")}/schema.ts`;
}
