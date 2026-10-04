import { relative, sep } from "node:path";
import { EmitError, formatTypescript, type Emitter } from "@mesh/compiler";
import type { Attribute, AttributeTypeName, Resource, SourcePosition } from "@mesh/model";
import { sqliteNameKey, sqliteNameProblem } from "./identifiers.ts";

/** Exhaustive over the model registry; the drift test checks the runtime keys too. */
export const SQLITE_TYPES = {
  string: "text", integer: "integer", float: "real", boolean: "integer",
  uuid: "text", datetime: "integer", atom: "text",
} as const satisfies Record<AttributeTypeName, string>;

function fail(message: string, position: SourcePosition, fix: string): never {
  throw new EmitError({ severity: "error", code: "MESH_SQLITE_SCHEMA", message, position, fix });
}

/** Same ASCII word/leading-underscore rule as the compiler's types emitter,
 * with the first word lower-cased for a value export rather than a type export.
 */
export function tableExportName(resource: Resource): string {
  const name = resource.name.value;
  const leading = /^_*/.exec(name)?.[0] ?? "";
  const words = name.slice(leading.length).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const base = leading + words.map((word, index) =>
    (index === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1)).join("");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) {
    fail(`Resource "${name}" does not become a valid TypeScript table name ("${base}")`, resource.name.position,
      "Rename the resource so it reads as an identifier, for example post or _post");
  }
  return `${base}Table`;
}

function column(attribute: Attribute): string {
  const name = JSON.stringify(attribute.name.value);
  const builder = SQLITE_TYPES[attribute.type];
  let options = "";
  if (attribute.type === "boolean") options = ', { mode: "boolean" }';
  if (attribute.type === "datetime") options = ', { mode: "timestamp_ms" }';
  if (attribute.type === "atom" && attribute.constraints?.oneOf.length) {
    options = `, { enum: ${JSON.stringify(attribute.constraints.oneOf.map((item) => item.value))} }`;
  }
  const property = attribute.name.value === "__proto__" ? `[${name}]` : name;
  return `${property}: ${builder}(${name}${options})${attribute.allowNil ? "" : ".notNull()"}${attribute.primaryKey ? ".primaryKey()" : ""}`;
}

/** Pure build half: the CLI registers this emitter in the next M2 task. */
export const sqliteSchemaEmitter: Emitter = {
  name: "sqlite-schema",
  requires: ["drizzle-orm"],
  async emit({ document, config }) {
    const resources = [...document.resources].sort((a, b) => a.name.value < b.name.value ? -1 : a.name.value > b.name.value ? 1 : 0);
    const tableOwners = new Map<string, string>();
    const exportOwners = new Map<string, string>();
    const definitions: string[] = [];
    const entries: string[] = [];
    for (const resource of resources) {
      const name = resource.name.value;
      if (!resource.table) fail(`resource "${name}" has no table; add table="..."`, resource.position, 'Add table="..." to the resource tag');
      const tableName = resource.table.value;
      const problem = sqliteNameProblem(tableName, "table");
      if (problem) fail(problem, resource.table.position, "Remove backticks and ASCII control characters from the table name");
      const columnOwners = new Map<string, string>();
      for (const attribute of resource.attributes) {
        const columnName = attribute.name.value;
        const problem = sqliteNameProblem(columnName, "column");
        if (problem) fail(problem, attribute.name.position, "Remove backticks and ASCII control characters from the column name");
        const key = sqliteNameKey(columnName);
        const previous = columnOwners.get(key);
        if (previous !== undefined) fail(`Attributes "${previous}" and "${columnName}" in resource "${name}" both use the SQLite column "${columnName}"`, attribute.name.position, "Give each attribute a name that differs by more than ASCII letter case");
        columnOwners.set(key, columnName);
      }
      const exported = tableExportName(resource);
      const tableKey = sqliteNameKey(tableName);
      const previousTable = tableOwners.get(tableKey);
      if (previousTable !== undefined) fail(`Resources "${previousTable}" and "${name}" both use table "${tableName}"`, resource.position, "Give each resource a distinct table");
      const previousExport = exportOwners.get(exported);
      if (previousExport !== undefined) fail(`Resources "${previousExport}" and "${name}" both generate the table export "${exported}"`, resource.position, "Rename one resource so their table exports differ");
      tableOwners.set(tableKey, name);
      exportOwners.set(exported, name);
      definitions.push(`export const ${exported} = _meshSqlite(${JSON.stringify(tableName)}, {\n${resource.attributes.map(column).join(",\n")}\n});`);
      entries.push(`${name === "__proto__" ? `[${JSON.stringify(name)}]` : JSON.stringify(name)}: ${exported}`);
    }
    const source = [
      "// Do not edit this file by hand.\n// It is generated by `mesh build` from resource files; change those files and rebuild.",
      'import { sqliteTable as _meshSqlite, text, integer, real } from "drizzle-orm/sqlite-core";',
      ...definitions,
      `export const tables = { ${entries.join(", ")} };`,
    ].join("\n\n");
    const prefix = relative(config.root, config.output).split(sep).join("/");
    return [{ path: `${prefix}/schema.ts`, contents: await formatTypescript(source) }];
  },
};
