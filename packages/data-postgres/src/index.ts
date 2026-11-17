import { FrameworkError, type DataLayer, type TableHandle } from "@meshfw/runtime";
import { postgresState } from "./layer.ts";
import { checkTableNames, planSchemaPush } from "./push-schema.ts";

export { postgres, capabilities, type PostgresLayer, type PostgresOptions } from "./layer.ts";
export { postgresDialect } from "./dialect.ts";

/**
 * Prepare the emitted schema (`tables` from `.mesh/schema.ts`) in the `public` schema of this layer's database, on its
 * own pool. Tests and development only: production databases are prepared with migrations. The database must hold this
 * project's tables only (another table, view or sequence in `public` is refused, listed in the error), and statements
 * that would lose data are refused, listed in the error.
 */
export async function createSchema(layer: DataLayer, tables: Readonly<Record<string, TableHandle>>): Promise<void> {
  const state = postgresState(layer);
  state.url("createSchema");
  if (state.schema !== undefined) throw new FrameworkError(`createSchema prepares the public schema only; clone it into ${state.schema} in the test`);
  checkTableNames(tables);
  await state.exclusive(async ({ db }) => {
    const push = await planSchemaPush(db, tables, "createSchema");
    if (push.losesData) {
      throw new FrameworkError(`createSchema refuses statements that would lose data:\n${[...push.statements, ...push.warnings].join("\n")}`);
    }
    await push.apply();
  });
}
