import { sql, type SQL, type Table } from "drizzle-orm";
import { alias, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SqlDialect } from "../src/index.ts";

/** SQLite's way of writing the parts of a condition a dialect owns, for these tests (data-sqlite ships the real one). */
export const testDialect: SqlDialect = {
  param: (value, kind) => sql`${value === null ? null : kind === "boolean" ? (value ? 1 : 0) : kind === "date" ? (value as Date).getTime() : value}`,
  alias: (table: Table, name: string) => alias(table as SQLiteTable, name),
  length: (operand: SQL) => sql`length(${operand})`,
  divide: (a: SQL, b: SQL) => sql`(cast(${a} as real) / nullif(${b}, 0))`,
  nulls: () => undefined,
};
