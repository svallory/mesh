import { FrameworkError, type DataLayer, type TableHandle } from "@meshfw/runtime";
import { sqliteState } from "./layer.ts";
import { checkTableNames, planSchemaPush } from "./push-schema.ts";

export { sqlite, capabilities, type SQLiteLayer, type SQLiteOptions } from "./layer.ts";

/** Prepare the emitted schema (`tables` from `.mesh/schema.ts`) on this layer's own
 * connection. Tests and development only: production databases are prepared with
 * migrations. Statements that would lose data are refused, listed in the error.
 */
export async function createSchema(layer: DataLayer, tables: Readonly<Record<string, TableHandle>>): Promise<void> {
  const state = sqliteState(layer);
  checkTableNames(tables);
  await state.exclusive(async (db) => {
    const push = await planSchemaPush(db, tables, "createSchema");
    if (push.losesData) {
      throw new FrameworkError(`createSchema refuses statements that would lose data:\n${[...push.statements, ...push.warnings].join("\n")}`);
    }
    await push.apply();
  });
}
