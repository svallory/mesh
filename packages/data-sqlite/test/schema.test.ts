import { describe, expect, test } from "bun:test";
import { ATTRIBUTE_TYPES, type ModelDocument } from "@meshfw/model";
import { EmitError, buildModel, generateFiles, type EmitInput, type ResolvedConfig } from "@meshfw/compiler";
import build, { SQLITE_COLUMNS, camelCase, schemaGenerator, schemaView } from "../src/build.ts";

const config: ResolvedConfig = {
  root: "/project", configFile: "/project/mesh.config.ts", entityFiles: [], domainRoot: "/project/src/domain",
  data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  output: "/project/.mesh",
};

/** Build entity files (path → source) under `src/domain`, expecting no build diagnostics. */
function input(files: Record<string, string>): EmitInput {
  const built = buildModel({ root: "/project", domainRoot: "/project/src/domain",
    files: Object.entries(files).map(([file, source]) => ({ file: `src/domain/${file}`, source })) });
  expect(built.diagnostics).toEqual([]);
  return { document: built.document as ModelDocument, config };
}
function emitError(run: () => unknown): EmitError {
  try { run(); } catch (cause) { if (cause instanceof EmitError) return cause; throw cause; }
  throw new Error("expected an EmitError");
}

const post = `import { User } from "./user.mesh.mx"
entity :Post table="posts"
  attributes
    uuid :id primary-key
    string :title
    string :body nullable
    boolean :featured default=false
    enum :state values=[:draft, :published] default=:draft
    datetime :publishedAt nullable
  relationships
    belongs-to :author entity=User
    belongs-to :editor entity=User nullable
  computed
    string :excerpt() { return &title }
`;
const user = `entity :User table="users"
  attributes
    uuid :id primary-key
    float :score
`;

describe("schemaView", () => {
  test("one table per entity, sorted by export, with every column printed from the view", () => {
    const view = schemaView(input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user }));
    expect(view.builders).toEqual(["integer", "real", "text"]);
    expect(view.tables.map((table) => [table.entity, table.exportName, table.key, table.nameLiteral])).toEqual([
      ["Post", "postTable", "post", '"posts"'],
      ["User", "userTable", "user", '"users"'],
    ]);
    expect(view.tables[0]!.columns).toEqual([
      { key: "id", builder: "text", nameLiteral: '"id"', options: null, notNull: true, primaryKey: true, unique: false },
      { key: "title", builder: "text", nameLiteral: '"title"', options: null, notNull: true, primaryKey: false, unique: false },
      // @if(column.notNull) false branch: a nullable attribute.
      { key: "body", builder: "text", nameLiteral: '"body"', options: null, notNull: false, primaryKey: false, unique: false },
      // @if(column.options) true branch.
      { key: "featured", builder: "integer", nameLiteral: '"featured"', options: '{ mode: "boolean" }', notNull: true, primaryKey: false, unique: false },
      { key: "state", builder: "text", nameLiteral: '"state"', options: '{ enum: ["draft","published"] }', notNull: true, primaryKey: false, unique: false },
      { key: "publishedAt", builder: "integer", nameLiteral: '"publishedAt"', options: '{ mode: "timestamp_ms" }', notNull: false, primaryKey: false, unique: false },
      // Relationship key columns follow the attributes; computed members have no column.
      { key: "authorId", builder: "text", nameLiteral: '"authorId"', options: null, notNull: true, primaryKey: false, unique: false },
      { key: "editorId", builder: "text", nameLiteral: '"editorId"', options: null, notNull: false, primaryKey: false, unique: false },
    ]);
  });

  test("only the builders the tables use are imported", () => {
    expect(schemaView(input({ "user.mesh.mx": "entity :User\n  attributes\n    uuid :id primary-key\n" })).builders).toEqual(["text"]);
  });

  test("the entity's default table is used, and the export is the camelCase entity name", () => {
    const view = schemaView(input({ "blog_post.mesh.mx": "entity :BlogPost\n  attributes\n    uuid :id primary-key\n" }));
    expect(view.tables[0]).toMatchObject({ entity: "BlogPost", exportName: "blogPostTable", key: "blogPost", nameLiteral: '"blog_post"' });
    expect(camelCase("_Post")).toBe("_post");
    expect(camelCase("first-name")).toBe("firstName");
  });

  test("the type map covers every registered attribute type and nothing else", () => {
    expect(Object.keys(SQLITE_COLUMNS).sort()).toEqual(ATTRIBUTE_TYPES.map((type) => type.name).sort());
  });

  test("no defaults reach the schema", () => {
    const view = schemaView(input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user }));
    expect(JSON.stringify(view)).not.toContain("default");
  });
});

describe("MESH_SCHEMA_* build errors", () => {
  test.each([
    ['entity :Post table="po`sts"\n  attributes\n    uuid :id primary-key\n', "po`sts"],
    ['entity :Post table="po\\u0001sts"\n  attributes\n    uuid :id primary-key\n', "po\u0001sts"],
  ])("MESH_SCHEMA_IDENTIFIER: an unsafe table name is refused at the entity tag (%#)", (source, name) => {
    const error = emitError(() => schemaView(input({ "blog/post.mesh.mx": source })));
    expect(error.diagnostic).toEqual({
      severity: "error", code: "MESH_SCHEMA_IDENTIFIER",
      message: `"${name}" cannot be used as a SQLite table name: it contains a character that the schema tools cannot quote safely (backtick or control character)`,
      position: { file: "src/domain/blog/post.mesh.mx", line: 1, column: 0, offset: 0 },
      fix: "Remove backticks and ASCII control characters from the table name",
    });
  });

  test("MESH_SCHEMA_IDENTIFIER: an unsafe column name is refused at the attribute", () => {
    // MX names are identifiers, so this only guards a model built by other means.
    const document = input({ "user.mesh.mx": user }).document;
    const entity = structuredClone(document.entities[0]!);
    entity.attributes[1]!.name = "sc`ore";
    const error = emitError(() => schemaView({ document: { entities: [entity] }, config }));
    expect(error.diagnostic).toMatchObject({ code: "MESH_SCHEMA_IDENTIFIER", position: { file: "src/domain/user.mesh.mx", line: 4, column: 4 } });
  });

  test("MESH_SCHEMA_DUPLICATE_TABLE: two entities on one table, compared without ASCII case", () => {
    const error = emitError(() => schemaView(input({
      "a/post.mesh.mx": 'entity :Post table="posts"\n  attributes\n    uuid :id primary-key\n',
      "b/note.mesh.mx": 'entity :Note table="POSTS"\n  attributes\n    uuid :id primary-key\n',
    })));
    expect(error.diagnostic).toEqual({
      severity: "error", code: "MESH_SCHEMA_DUPLICATE_TABLE",
      message: 'Entities Note (src/domain/b/note.mesh.mx) and Post (src/domain/a/post.mesh.mx) both use the SQLite table "posts"',
      position: { file: "src/domain/a/post.mesh.mx", line: 1, column: 0, offset: 0 },
      fix: 'Give each entity its own table="..."',
    });
  });

  test("MESH_SCHEMA_DUPLICATE_EXPORT: same-named entities in two modules", () => {
    const error = emitError(() => schemaView(input({
      "sales/post.mesh.mx": 'entity :Post table="sales_posts"\n  attributes\n    uuid :id primary-key\n',
      "blog/post.mesh.mx": 'entity :Post table="blog_posts"\n  attributes\n    uuid :id primary-key\n',
    })));
    expect(error.diagnostic).toEqual({
      severity: "error", code: "MESH_SCHEMA_DUPLICATE_EXPORT",
      message: "Entities Post (src/domain/blog/post.mesh.mx) and Post (src/domain/sales/post.mesh.mx) both become the schema export postTable",
      position: { file: "src/domain/sales/post.mesh.mx", line: 1, column: 0, offset: 0 },
      fix: "Rename one entity: schema.ts exports one table per entity name",
    });
  });

  test("MESH_SCHEMA_DUPLICATE_COLUMN: names that differ only in ASCII case", () => {
    const error = emitError(() => schemaView(input({
      "post.mesh.mx": "entity :Post\n  attributes\n    uuid :id primary-key\n    string :title\n    string :Title\n",
    })));
    expect(error.diagnostic).toEqual({
      severity: "error", code: "MESH_SCHEMA_DUPLICATE_COLUMN",
      message: '"title" and "Title" in entity Post are the same SQLite column: SQLite compares column names without ASCII letter case',
      position: { file: "src/domain/post.mesh.mx", line: 5, column: 4, offset: expect.any(Number) },
      fix: "Rename one so the names differ by more than letter case",
    });
  });

  test("negative: case-distinct tables, distinct exports and distinct columns build", () => {
    const view = schemaView(input({
      "sales/order.mesh.mx": 'entity :Order table="sales_orders"\n  attributes\n    uuid :id primary-key\n    string :title\n    string :subtitle\n',
      "blog/post.mesh.mx": 'entity :Post table="posts_2"\n  attributes\n    uuid :id primary-key\n',
    }));
    expect(view.tables.map((table) => table.exportName)).toEqual(["orderTable", "postTable"]);
  });
});

describe("the schema generator", () => {
  test("is the build half's one generator, with its template beside the package", async () => {
    expect(build.generators).toEqual([schemaGenerator]);
    expect(Object.keys(build.commands!)).toEqual(["db push"]);
    expect(schemaGenerator).toMatchObject({ name: "sqlite-schema", template: "schema.ts.jig", requires: ["drizzle-orm"] });
    expect(await Bun.file(`${schemaGenerator.templateDir}/schema.ts.jig`).exists()).toBe(true);
  });

  test("renders <output>/schema.ts through the core generateFiles, byte-identical across builds", async () => {
    const emit = input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user });
    const first = await generateFiles(emit, build);
    const second = await generateFiles(emit, build);
    expect(first).toEqual(second);
    const schema = first.find((file) => file.path === ".mesh/schema.ts")!;
    expect(schema.contents).toBe(`// Do not edit this file by hand.
// It is generated by \`mesh build\` from the entity files; change them and rebuild.

import { sqliteTable as _meshSqlite, integer, real, text } from "drizzle-orm/sqlite-core";

export const postTable = _meshSqlite("posts", {
  id: text("id").notNull().primaryKey(),
  title: text("title").notNull(),
  body: text("body"),
  featured: integer("featured", { mode: "boolean" }).notNull(),
  state: text("state", { enum: ["draft", "published"] }).notNull(),
  publishedAt: integer("publishedAt", { mode: "timestamp_ms" }),
  authorId: text("authorId").notNull(),
  editorId: text("editorId"),
});

export const userTable = _meshSqlite("users", {
  id: text("id").notNull().primaryKey(),
  score: real("score").notNull(),
});

export const tables = {
  post: postTable,
  user: userTable,
};
`);
  });
});
