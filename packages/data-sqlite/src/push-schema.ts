import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { FrameworkError, type TableHandle } from "@mesh/runtime";

/** The single compatibility bridge for the pinned development-tool API.
 * The importer is injectable here (not in the public API) for missing-tool tests.
 */
export async function pushSchema(
  db: BunSQLiteDatabase,
  tables: Record<string, TableHandle>,
  importer = () => import("drizzle-kit/api"),
): Promise<void> {
  let kit: Awaited<ReturnType<typeof importer>>;
  try { kit = await importer(); }
  catch (cause) {
    throw new FrameworkError("createSchema needs drizzle-kit, a development dependency. Run: bun add -d drizzle-kit@0.31.11. Production databases are prepared with migrations, not with createSchema.", { cause });
  }
  // SAFETY: Kit declares LibSQLDatabase, but its push path uses operations also provided
  // by Bun's wrapper. The create/insert/select regression test guards this bridge.
  const plan = await kit.pushSQLiteSchema(tables, db as unknown as Parameters<typeof kit.pushSQLiteSchema>[1]);
  if (plan.hasDataLoss) {
    throw new FrameworkError(`createSchema refuses statements that would lose data:\n${plan.statementsToExecute.join("\n")}\n${plan.warnings.join("\n")}`);
  }
  await plan.apply();
}
