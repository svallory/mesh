import { FrameworkError, type DataLayer, type TableHandle } from "@mesh/runtime";
import { getTableColumns, getTableName } from "drizzle-orm";
import { sqliteState, sqliteTable } from "./layer.ts";
import { pushSchema } from "./push-schema.ts";
import { sqliteNameProblem } from "./identifiers.ts";

export { sqlite, type SQLiteLayer, type SQLiteOptions } from "./layer.ts";

/** Prepare an emitted schema on this layer's own connection. Tests/development
 * only: production databases are prepared with migrations. Data loss is refused.
 */
export async function createSchema(layer: DataLayer, tables: Record<string, TableHandle>): Promise<void> {
  const state = sqliteState(layer);
  for (const handle of Object.values(tables)) {
    const table = sqliteTable(handle);
    const problem = sqliteNameProblem(getTableName(table), "table");
    if (problem) throw new FrameworkError(problem);
    for (const column of Object.values(getTableColumns(table))) {
      const problem = sqliteNameProblem(column.name, "column");
      if (problem) throw new FrameworkError(problem);
    }
  }
  await state.exclusive((db) => pushSchema(db, tables));
}
