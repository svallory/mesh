import type { DataLayer, TableHandle } from "@mesh/runtime";
import { sqliteState, sqliteTable } from "./layer.ts";
import { pushSchema } from "./push-schema.ts";

export { sqlite, type SQLiteLayer, type SQLiteOptions } from "./layer.ts";

/** Prepare an emitted schema on this layer's own connection. Tests/development
 * only: production databases are prepared with migrations. Data loss is refused.
 */
export async function createSchema(layer: DataLayer, tables: Record<string, TableHandle>): Promise<void> {
  const state = sqliteState(layer);
  for (const table of Object.values(tables)) sqliteTable(table);
  await state.exclusive((db) => pushSchema(db, tables));
}
