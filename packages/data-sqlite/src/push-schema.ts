import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { FrameworkError, type TableHandle } from "@meshfw/runtime";
import { sqliteNameProblem } from "./identifiers.ts";
import { sqliteTable } from "./layer.ts";

/** The pinned schema tool's message when it cannot be loaded; `mesh db push` reports it verbatim too. */
export const MISSING_DRIZZLE_KIT =
  "createSchema needs drizzle-kit, a development dependency. Run: bun add -d drizzle-kit@0.31.11. Production databases are prepared with migrations, not with createSchema.";

/** What pushing the emitted schema to one database would do. */
export interface SchemaPush {
  /** The SQL statements the push would run, in order; empty when the schema is up to date. */
  readonly statements: readonly string[];
  /** The tool's data-loss warnings; non-empty exactly when `losesData` is true. */
  readonly warnings: readonly string[];
  /** True when a statement would drop a table, a column or rows. */
  readonly losesData: boolean;
  /** Run the statements. */
  apply(): Promise<void>;
}

/** Refuse names the pinned schema tool cannot quote, before any connection or DDL. */
export function checkTableNames(tables: Readonly<Record<string, TableHandle>>): void {
  for (const handle of Object.values(tables)) {
    const table = sqliteTable(handle);
    const problem = sqliteNameProblem(getTableName(table), "table");
    if (problem) throw new FrameworkError(problem);
    for (const column of Object.values(getTableColumns(table))) {
      const problem = sqliteNameProblem(column.name, "column");
      if (problem) throw new FrameworkError(problem);
    }
  }
}

/** The single compatibility bridge for the pinned development-tool API: the one
 * place that loads `drizzle-kit`, by dynamic import, and calls it. `createSchema`
 * and `mesh db push` both plan through here. The importer is injectable here
 * (not in the public API) for missing-tool tests.
 */
export async function planSchemaPush(
  db: BunSQLiteDatabase,
  tables: Readonly<Record<string, TableHandle>>,
  importer = () => import("drizzle-kit/api"),
): Promise<SchemaPush> {
  let kit: Awaited<ReturnType<typeof importer>>;
  try { kit = await importer(); }
  catch (cause) { throw new FrameworkError(MISSING_DRIZZLE_KIT, { cause }); }
  // SAFETY: Kit declares LibSQLDatabase, but its push path uses operations also provided
  // by Bun's wrapper. The create/insert/select regression test guards this bridge.
  const plan = await kit.pushSQLiteSchema({ ...tables }, db as unknown as Parameters<typeof kit.pushSQLiteSchema>[1]);
  return {
    statements: [...plan.statementsToExecute],
    warnings: [...plan.warnings],
    losesData: plan.hasDataLoss,
    apply: () => plan.apply(),
  };
}
