import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterCommand } from "@meshfw/compiler";
import { FrameworkError, type TableHandle } from "@meshfw/runtime";
import { postgres, postgresState } from "./layer.ts";
import { checkTableNames, planSchemaPush, type DrizzleKitLoader } from "./push-schema.ts";

/**
 * `mesh db push [--force]`: apply the committed `<output>/schema.ts` to the configured database through the same
 * `planSchemaPush` that `createSchema` uses. The `mesh` command has already checked that the generated tree is up to
 * date. The database must hold this project's tables only. Statements that would lose data are printed and refused
 * unless `--force` is given.
 */
export const pushCommand: AdapterCommand = (context) => push(context);

/** The command, with the schema tool's loader replaceable for missing-tool tests. */
export async function push(
  { config, args, stdout, stderr }: Parameters<AdapterCommand>[0],
  loader?: DrizzleKitLoader,
): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length) {
    stderr(`Unknown argument "${unknown[0]}" for mesh db push; use mesh db push [--force]\n`);
    return 2;
  }
  const force = args.includes("--force");
  const url = config.data.options.url;
  if (typeof url !== "string" || url.trim() === "") {
    stderr("db push needs a database url: set data: postgres({ url: process.env.DATABASE_URL }) and define the variable\n");
    return 1;
  }
  const schemaFile = join(config.output, "schema.ts");
  let db: ReturnType<typeof postgres> | undefined;
  try {
    db = postgres({ url });
    const state = postgresState(db, "db push");
    const database = state.database;
    // A fresh read of the committed schema, also when called twice in one process.
    delete require.cache[schemaFile];
    const { tables } = await import(pathToFileURL(schemaFile).href) as { tables?: Record<string, TableHandle> };
    if (!tables || typeof tables !== "object") throw new FrameworkError(`${schemaFile} does not export tables; run mesh build`);
    checkTableNames(tables);
    return await state.exclusive(async ({ db: connection }) => {
      const plan = await planSchemaPush(connection, tables, "mesh db push", loader);
      if (plan.statements.length === 0) {
        stdout(`schema is up to date: ${database}\n`);
        return 0;
      }
      const listing = plan.statements.map((statement) => `${statement.trim()}\n`).join("");
      if (plan.losesData && !force) {
        stderr(`db push refuses statements that would lose data in ${database}:\n${listing}${plan.warnings.map((warning) => `${warning}\n`).join("")}Nothing was applied. Run mesh db push --force to apply them anyway.\n`);
        return 1;
      }
      await plan.apply();
      stdout(`${listing}applied ${plan.statements.length} statement${plan.statements.length === 1 ? "" : "s"} to ${database}\n`);
      return 0;
    });
  } catch (cause) {
    stderr(`db push failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  } finally {
    await db?.close();
  }
}
