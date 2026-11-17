/**
 * The build half of `@meshfw/data-postgres`, named by `postgres().build`. The compiler imports it at build time only;
 * the main entry never imports it (ADR-0033).
 */
import { resolve } from "node:path";
import type { AdapterBuild, Generator } from "@meshfw/compiler";
import { pushCommand } from "./push-command.ts";
import { schemaPath, schemaView, type PostgresSchemaView } from "./schema-view.ts";

export { POSTGRES_COLUMNS, schemaView, type PostgresColumnView, type PostgresSchemaView, type PostgresTableView } from "./schema-view.ts";

/** `<output>/schema.ts`: one Drizzle Postgres table per entity and the `tables` map. */
export const schemaGenerator: Generator<PostgresSchemaView> = {
  name: "postgres-schema",
  template: "schema.ts.jig",
  templateDir: resolve(import.meta.dir, "../templates"),
  requires: ["drizzle-orm"],
  views(input) {
    return [{ path: schemaPath(input), view: schemaView(input) }];
  },
};

const build: AdapterBuild = { generators: [schemaGenerator], commands: { "db push": pushCommand } };
export default build;
