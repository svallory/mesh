import { sql, type SQL, type Table } from "drizzle-orm";
import { alias, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SqlDialect } from "@meshfw/data-drizzle";
import type { Scalar, ValueClass } from "@meshfw/runtime";

/**
 * How SQLite writes the parts of a condition that differ between databases. A value is a plain binding, stored as
 * the columns store it: a boolean as 1 or 0 (`{ mode: "boolean" }`), a date as epoch milliseconds
 * (`{ mode: "timestamp_ms" }`). `length` counts code points, division casts to REAL, and the defaults already order
 * nulls as the smallest value and strings by code point (BINARY collation), so `nulls` adds nothing and there is no
 * `collate`.
 */
export const sqliteDialect: SqlDialect = Object.freeze({
  param(value: Scalar, kind: ValueClass): SQL {
    if (value === null) return sql`${null}`;
    if (kind === "boolean" && typeof value === "boolean") return sql`${value ? 1 : 0}`;
    if (kind === "date" && value instanceof Date) return sql`${value.getTime()}`;
    return sql`${value}`;
  },
  alias: (table: Table, name: string): Table => alias(table as SQLiteTable, name),
  length: (operand: SQL): SQL => sql`length(${operand})`,
  divide: (a: SQL, b: SQL): SQL => sql`(cast(${a} as real) / nullif(${b}, 0))`,
  nulls: (): undefined => undefined,
});
