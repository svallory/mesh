import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildModel, EmitError, generatedImportDiagnostics, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@mesh/compiler";
import { ATTRIBUTE_TYPES, type ModelDocument } from "@mesh/model";
import type { TableHandle } from "@mesh/runtime";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { SQLITE_TYPES, sqliteSchemaEmitter } from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
// The temporary project lives in this package so its generated imports resolve
// through the adapter's explicitly declared development dependencies.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const configOf = (root = "/project"): ResolvedConfig => ({ root, output: resolve(root, "generated"), configFile: resolve(root, "mesh.config.ts"), resourceFiles: [] });
function documentOf(...sources: string[]): ModelDocument {
  const result = buildModel({ root: "/project", files: sources.map((source, index) => ({ file: `resources/${index}.mx`, source })) });
  expect(result.diagnostics).toEqual([]);
  if (!result.document) throw new Error("expected model");
  return result.document;
}
const resource = (name: string, table?: string) => `resource=${JSON.stringify(name)}${table === undefined ? "" : ` table=${JSON.stringify(table)}`}\n  attributes\n    uuid-primary-key="id"\n`;
async function emit(document: ModelDocument) { return (await sqliteSchemaEmitter.emit({ document, config: configOf() }))[0]!; }

async function fails(document: ModelDocument, message: string, file: string, line: number, column: number) {
  try { await emit(document); throw new Error("emitter did not reject"); }
  catch (error) {
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({ message, position: { file, line, column } });
  }
}

test("schema emitter requires Drizzle and the compiler reports a missing consumer dependency", async () => {
  expect(sqliteSchemaEmitter.requires).toEqual(["drizzle-orm"]);
  expect(generatedImportDiagnostics(packageRoot, [sqliteSchemaEmitter])).toEqual([]);
  const root = await mkdtemp(resolve(tmpdir(), "mesh-schema-import-"));
  try {
    expect(generatedImportDiagnostics(root, [sqliteSchemaEmitter])).toEqual([{
      severity: "error", code: "MESH_GENERATED_IMPORT",
      message: 'generated code imports "drizzle-orm", which is not installed in this project. Run: bun add drizzle-orm',
      position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 }, fix: null,
    }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema type mapping covers every registered attribute type", () => {
  expect(Object.keys(SQLITE_TYPES).sort()).toEqual(ATTRIBUTE_TYPES.map((type) => type.name).sort());
});

test("emitted blog schema type-checks, is byte-identical, and runs insert/select as-is", async () => {
  const root = await mkdtemp(resolve(packageRoot, ".schema-test-"));
  const layer = sqlite({ file: ":memory:" });
  try {
    const source = await readFile(resolve(workspace, "examples/blog/resources/post.mx"), "utf8");
    const document = documentOf(source);
    const config = configOf(root);
    const files = await sqliteSchemaEmitter.emit({ document, config });
    expect(await sqliteSchemaEmitter.emit({ document: structuredClone(document), config })).toEqual(files);
    await writeGeneratedFiles([...files, ...await generateFiles({ document, config })], config);
    await writeFile(resolve(root, "consumer.ts"), `import type { Post } from "./generated/blog/post.types";
import { postTable } from "./generated/schema";
export const readRow = (row: typeof postTable.$inferSelect): Post => row;
export const writeRow = (row: Post): typeof postTable.$inferInsert => row;
`);
    const typecheck = Bun.spawnSync([resolve(workspace, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--target", "es2022",
      "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "consumer.ts", "generated/schema.ts", "generated/blog/post.types.ts"], { cwd: root });
    expect(new TextDecoder().decode(typecheck.stderr) + new TextDecoder().decode(typecheck.stdout)).toBe("");
    expect(typecheck.exitCode).toBe(0);
    const schema: { tables: Record<string, TableHandle>; postTable: TableHandle } = await import(pathToFileURL(resolve(root, "generated/schema.ts")).href);
    expect(Object.keys(schema.tables)).toEqual(["post"]);
    expect(schema.tables.post).toBe(schema.postTable);
    await createSchema(layer, schema.tables);
    const row = { id: "00000000-0000-4000-8000-000000000001", title: "Hello", body: null, views: 42, rating: 1.25,
      featured: true, token: "00000000-0000-4000-8000-000000000002", publishedAt: new Date("2026-10-04T01:02:03.456Z"),
      state: "draft", insertedAt: new Date("2026-10-04T00:00:00.123Z"), updatedAt: new Date("2026-10-04T00:00:01.234Z") };
    await layer.transaction(async (tx) => {
      expect(await tx.insert(schema.postTable, row)).toEqual(row);
      expect(await tx.selectByKey(schema.postTable, { id: row.id })).toEqual(row);
    });
    const text = files[0]!.contents;
    expect(text).toContain('publishedAt: integer("publishedAt", { mode: "timestamp_ms" })');
    expect(text).toContain('featured: integer("featured", { mode: "boolean" })');
    expect(text).toContain('enum: ["draft", "published"]');
    expect(text).not.toContain(".default(");
    expect(text).not.toContain("$default");
  } finally { await layer.close(); await rm(root, { recursive: true, force: true }); }
});

async function withEmittedSchema(document: ModelDocument, run: (schema: { tables: Record<string, SQLiteTable>; sqliteTable?: SQLiteTable }, layer: ReturnType<typeof sqlite>) => Promise<void>) {
  const root = await mkdtemp(resolve(packageRoot, ".schema-test-"));
  const layer = sqlite({ file: ":memory:" });
  try {
    const config = configOf(root);
    await writeGeneratedFiles(await sqliteSchemaEmitter.emit({ document, config }), config);
    const typecheck = Bun.spawnSync([resolve(workspace, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--target", "es2022",
      "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "generated/schema.ts"], { cwd: root });
    expect(new TextDecoder().decode(typecheck.stderr) + new TextDecoder().decode(typecheck.stdout)).toBe("");
    expect(typecheck.exitCode).toBe(0);
    const schema = await import(pathToFileURL(resolve(root, "generated/schema.ts")).href);
    await createSchema(layer, schema.tables);
    await run(schema, layer);
  } finally { await layer.close(); await rm(root, { recursive: true, force: true }); }
}

test("resource sqlite has a collision-free builder alias and its emitted schema type-checks and runs", async () => {
  await withEmittedSchema(documentOf(resource("sqlite", "items")), async (schema, layer) => {
    expect(schema.sqliteTable).toBe(schema.tables.sqlite);
    const table = schema.tables.sqlite!;
    await layer.transaction(async (tx) => {
      expect(await tx.insert(table, { id: "id" })).toEqual({ id: "id" });
      expect(await tx.selectAll(table)).toEqual([{ id: "id" }]);
    });
  });
});

test("double quotes, spaces, dots and other safe punctuation round-trip as declared names", async () => {
  const tableName = 'has "quotes" spaces.dots; -- punctuation []';
  const columnName = 'field "quoted" with.dots; -- []';
  const document = documentOf(resource("post", tableName) + `    attribute=${JSON.stringify(columnName)} type="string"\n`);
  await withEmittedSchema(document, async ({ tables }, layer) => {
    const table = tables.post!;
    expect(getTableName(table)).toBe(tableName);
    expect(getTableColumns(table)[columnName]?.name).toBe(columnName);
    const row = { id: "id", [columnName]: 'value with quotes " and backticks `' };
    await layer.transaction(async (tx) => {
      expect(await tx.insert(table, row)).toEqual(row);
      expect(await tx.selectByKey(table, { id: "id" })).toEqual(row);
    });
  });
});

test("schema emitter rejects backticks and every ASCII control at the authored table or column name", async () => {
  const names = ["injected` (id text, hacked text); --", ...Array.from({ length: 32 }, (_, i) => `bad${String.fromCharCode(i)}name`), "bad\x7fname"];
  for (const name of names) {
    const suffix = "name: it contains a character that the schema tools cannot quote safely (backtick or control character)";
    await fails(documentOf(resource("post", name)), `"${name}" cannot be used as a SQLite table ${suffix}`, "resources/0.mx", 1, 22);
    await fails(documentOf(resource("post", "posts") + `    attribute=${JSON.stringify(name)} type="string"\n`),
      `"${name}" cannot be used as a SQLite column ${suffix}`, "resources/0.mx", 4, 14);
  }
});

test("ASCII-case table collisions name both resources", async () => {
  await fails(documentOf(resource("first", "Items"), resource("second", "items")),
    'Resources "first" and "second" both use table "items"', "resources/1.mx", 1, 0);
});

test("ASCII-case column collisions name both attributes at the later name", async () => {
  await fails(documentOf(resource("post", "items") + '    attribute="ID" type="string"\n'),
    'Attributes "id" and "ID" in resource "post" both use the SQLite column "ID"', "resources/0.mx", 4, 14);
});

test("SQLite physical-name comparison folds ASCII only and preserves Unicode spelling", async () => {
  const document = documentOf(resource("first", "Ä") + '    attribute="İ" type="string"\n    attribute="i" type="string"\n', resource("second", "ä"));
  await withEmittedSchema(document, async ({ tables }, layer) => {
    expect(getTableName(tables.first!)).toBe("Ä");
    expect(getTableName(tables.second!)).toBe("ä");
    await layer.transaction(async (tx) => {
      expect(await tx.insert(tables.first!, { id: "id", İ: "upper", i: "lower" })).toEqual({ id: "id", İ: "upper", i: "lower" });
      expect(await tx.selectAll(tables.second!)).toEqual([]);
    });
  });
});

test("missing table is positioned at the resource tag", async () => {
  await fails(documentOf(resource("post")), 'resource "post" has no table; add table="..."', "resources/0.mx", 1, 0);
});

test("duplicate physical tables name both resources", async () => {
  await fails(documentOf(resource("a", "same"), resource("b", "same")), 'Resources "a" and "b" both use table "same"', "resources/1.mx", 1, 0);
});

test("duplicate table export names name both resources", async () => {
  await fails(documentOf(resource("blog-post", "first"), resource("blog_post", "second")), 'Resources "blog-post" and "blog_post" both generate the table export "blogPostTable"', "resources/1.mx", 1, 0);
});

test("invalid identifier names are positioned build errors", async () => {
  const doc = documentOf(resource("123", "numbers"));
  await fails(doc, 'Resource "123" does not become a valid TypeScript table name ("123")', "resources/0.mx", 1, 9);
});

test("resource order is stable and names use the types emitter's ASCII word rule", async () => {
  const document = documentOf(resource("zebra", "z"), resource("_blog-post", "b"), resource("café", "c"));
  const first = await emit(document);
  expect(await emit({ resources: [...document.resources].reverse() })).toEqual(first);
  expect(first.contents).toContain("export const _blogPostTable");
  expect(first.contents).toContain("export const cafTable");
  expect(first.contents.indexOf("_blogPostTable")).toBeLessThan(first.contents.indexOf("cafTable"));
  expect(first.path).toBe("generated/schema.ts");
});

test("column names preserve punctuation and prototype-like resource names remain own table keys", async () => {
  const root = await mkdtemp(resolve(packageRoot, ".schema-test-"));
  const layer = sqlite({ file: ":memory:" });
  try {
    const document = documentOf('resource="__proto__" table="odd"\n  attributes\n    uuid-primary-key="id"\n    attribute="some-text" type="string"\n    attribute="due-on" type="datetime"\n');
    const config = configOf(root);
    const files = await sqliteSchemaEmitter.emit({ document, config });
    await writeGeneratedFiles(files, config);
    const schema = await import(pathToFileURL(resolve(root, "generated/schema.ts")).href);
    expect(Object.hasOwn(schema.tables, "__proto__")).toBe(true);
    const table = schema.tables["__proto__"];
    expect(Object.keys(getTableColumns(table))).toEqual(["id", "some-text", "due-on"]);
    await createSchema(layer, schema.tables);
    const row = { id: "id", "some-text": "ordinary text", "due-on": new Date(1234) };
    await layer.transaction(async (tx) => {
      expect(await tx.insert(table, row)).toEqual(row);
      expect(await tx.selectAll(table)).toEqual([row]);
    });
  } finally { await layer.close(); await rm(root, { recursive: true, force: true }); }
});
