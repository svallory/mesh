import { sql, type SQL, type Table } from "drizzle-orm";
import { alias, type PgTable } from "drizzle-orm/pg-core";
import type { SqlDialect } from "@meshfw/data-drizzle";
import type { Scalar, ValueClass } from "@meshfw/runtime";

/** The Postgres type of each value class, as data-postgres stores it (`POSTGRES_COLUMNS`). */
const CASTS: Readonly<Record<ValueClass, string>> = Object.freeze({
  string: "text",
  integer: "bigint",
  float: "double precision",
  boolean: "boolean",
  date: "timestamptz",
});

/**
 * How Postgres writes the parts of a condition that differ between databases. Every parameter is cast to the type its
 * class is stored as (`$1::bigint`, `::double precision`, `::boolean`, `::timestamptz`, `::text`), so one with no
 * column beside it (`CASE WHEN c THEN $1 ELSE $2 END`, `COALESCE($1, $2)`) is never inferred as text; a date is bound
 * as its ISO text. `length` is `char_length` of the operand as text (code points, as SQLite counts), division casts to `double precision`, and the order is
 * pinned to SQLite's: nulls as the smallest value (`NULLS FIRST` ascending, `NULLS LAST` descending) and strings by
 * code point (`COLLATE "C"`), whatever the database's collation. A policy guard raises by casting its marker to
 * `int` (ADR-0046, option B): the cast fails the statement with SQLSTATE 22P02 (`invalid input syntax for type
 * integer: "<marker>"`), so nothing is installed in the user's database. `raised` accepts only Bun's `PostgresError`
 * with that SQLSTATE, never a wrapper such as Drizzle's `DrizzleQueryError`, whose message echoes the bound
 * parameters; `guardDenialOf` walks to the wrapped error itself. The message text is not matched, since the server may
 * write it in another language; the marker and its nonce are what identify the guard.
 */
export const postgresDialect: SqlDialect = Object.freeze({
  param(value: Scalar, kind: ValueClass): SQL {
    const cast = sql.raw(CASTS[kind] ?? "text");
    const bound = value instanceof Date ? value.toISOString() : value;
    return sql`${bound}::${cast}`;
  },
  alias: (table: Table, name: string): Table => alias(table as PgTable, name),
  // Through text, as SQLite's `length` reads a number as its text; a null of any class is null.
  length: (operand: SQL): SQL => sql`char_length((${operand})::text)`,
  divide: (a: SQL, b: SQL): SQL => sql`(${a}::double precision / nullif(${b}, 0))`,
  nulls: (desc: boolean): SQL => desc ? sql`nulls last` : sql`nulls first`,
  collate: (key: SQL, kind: ValueClass): SQL => kind === "string" ? sql`${key} collate "C"` : key,
  raise: (marker: SQL): SQL => sql`((${marker})::int = 0)`,
  raised(error: unknown): string | undefined {
    const { errno, message } = (typeof error === "object" && error !== null ? error : {}) as { errno?: unknown; message?: unknown };
    return errno === "22P02" && typeof message === "string" ? message : undefined;
  },
});
