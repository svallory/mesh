import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterCommand } from "@meshfw/compiler";
import { FrameworkError, type TableHandle } from "@meshfw/runtime";
import { sqlite, sqliteState } from "./layer.ts";
import { checkTableNames, planSchemaPush } from "./push-schema.ts";

/**
 * `mesh db push [--force]`: apply the committed `<output>/schema.ts` to the configured
 * database file through the same `planSchemaPush` that `createSchema` uses. The
 * `mesh` command has already checked that the generated tree is up to date.
 * Statements that would lose data are printed and refused unless `--force` is given.
 */
export const pushCommand: AdapterCommand = (context) => push(context);

/** The command, with the schema tool's importer replaceable for missing-tool tests. */
export async function push(
  { projectRoot, config, args, stdout, stderr }: Parameters<AdapterCommand>[0],
  importer?: Parameters<typeof planSchemaPush>[2],
): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length) {
    stderr(`Unknown argument "${unknown[0]}" for mesh db push; use mesh db push [--force]\n`);
    return 2;
  }
  const force = args.includes("--force");
  const file = config.data.options.file;
  if (typeof file !== "string" || file.trim() === "") {
    stderr("db push needs a database file: set data: sqlite({ file: \"app.db\" }) in mesh.config.ts\n");
    return 1;
  }
  if (file === ":memory:") {
    stderr("db push needs a database file: an in-memory database ends with the process; use createSchema in tests\n");
    return 1;
  }
  const schemaFile = join(config.output, "schema.ts");
  const path = isAbsolute(file) ? file : resolve(projectRoot, file);
  const db = sqlite({ file: path });
  try {
    // A fresh read of the committed schema, also when called twice in one process.
    delete require.cache[schemaFile];
    const { tables } = await import(pathToFileURL(schemaFile).href) as { tables?: Record<string, TableHandle> };
    if (!tables || typeof tables !== "object") throw new FrameworkError(`${schemaFile} does not export tables; run mesh build`);
    checkTableNames(tables);
    return await sqliteState(db, "db push").exclusive(async (database) => {
      const plan = await planSchemaPush(database, tables, importer);
      if (plan.statements.length === 0) {
        stdout(`schema is up to date: ${file}\n`);
        return 0;
      }
      const listing = plan.statements.map((statement) => `${statement.trim()}\n`).join("");
      if (plan.losesData && !force) {
        stderr(`db push refuses statements that would lose data in ${file}:\n${listing}${plan.warnings.map((warning) => `${warning}\n`).join("")}Nothing was applied. Run mesh db push --force to apply them anyway.\n`);
        return 1;
      }
      await plan.apply();
      stdout(`${listing}applied ${plan.statements.length} statement${plan.statements.length === 1 ? "" : "s"} to ${file}\n`);
      return 0;
    });
  } catch (cause) {
    stderr(`db push failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  } finally {
    await db.close();
  }
}
