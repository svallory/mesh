/**
 * The build half of `@meshfw/data-sqlite`, named by `sqlite().build`. The compiler
 * imports it at build time only; the main entry never imports it (ADR-0033).
 */
import { resolve } from "node:path";
import type { AdapterBuild, Generator } from "@meshfw/compiler";
import { schemaPath, schemaView, type SchemaView } from "./schema-view.ts";

export { SQLITE_COLUMNS, camelCase, schemaView, type ColumnView, type SchemaView, type TableView } from "./schema-view.ts";

/** `<output>/schema.ts`: one Drizzle table per entity and the `tables` map. */
export const schemaGenerator: Generator<SchemaView> = {
  name: "sqlite-schema",
  template: "schema.ts.jig",
  templateDir: resolve(import.meta.dir, "../templates"),
  requires: ["drizzle-orm"],
  views(input) {
    return [{ path: schemaPath(input), view: schemaView(input) }];
  },
};

const build: AdapterBuild = { generators: [schemaGenerator] };
export default build;
