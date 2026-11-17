import { describe, expect, test } from "bun:test";
import { ATTRIBUTE_TYPES, type ModelDocument } from "@meshfw/model";
import { EmitError, buildModel, generateFiles, type EmitInput, type ResolvedConfig } from "@meshfw/compiler";
import { CORE_TABLES, CORE_TABLE_NAMES, DELIVERY_PROCESS_TABLE, MULTI_PROCESS_CORE, coreTablesFor, type BusCapability } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import build, { SQLITE_COLUMNS, schemaGenerator, schemaView } from "../src/build.ts";

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
  actions auto=[:read]
`;

describe("schemaView", () => {
  test("one table per entity, sorted by entity name, with every column printed from the view", () => {
    const view = schemaView(input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user }));
    expect(view.builders).toEqual(["integer", "real", "text"]);
    expect(view.tables.map((table) => [table.entity, table.key, table.nameLiteral])).toEqual([
      ["Post", "posts", '"posts"'],
      ["User", "users", '"users"'],
    ]);
    expect(view.tables[0]!.columns).toEqual([
      { key: "id", builder: "text", nameLiteral: '"id"', options: null, notNull: true, primaryKey: true, autoIncrement: false, unique: false },
      { key: "title", builder: "text", nameLiteral: '"title"', options: null, notNull: true, primaryKey: false, autoIncrement: false, unique: false },
      // @if(column.notNull) false branch: a nullable attribute.
      { key: "body", builder: "text", nameLiteral: '"body"', options: null, notNull: false, primaryKey: false, autoIncrement: false, unique: false },
      // @if(column.options) true branch.
      { key: "featured", builder: "integer", nameLiteral: '"featured"', options: '{ mode: "boolean" }', notNull: true, primaryKey: false, autoIncrement: false, unique: false },
      { key: "state", builder: "text", nameLiteral: '"state"', options: '{ enum: ["draft","published"] }', notNull: true, primaryKey: false, autoIncrement: false, unique: false },
      { key: "publishedAt", builder: "integer", nameLiteral: '"publishedAt"', options: '{ mode: "timestamp_ms" }', notNull: false, primaryKey: false, autoIncrement: false, unique: false },
      // Relationship key columns follow the attributes; computed members have no column.
      { key: "authorId", builder: "text", nameLiteral: '"authorId"', options: null, notNull: true, primaryKey: false, autoIncrement: false, unique: false },
      { key: "editorId", builder: "text", nameLiteral: '"editorId"', options: null, notNull: false, primaryKey: false, autoIncrement: false, unique: false },
    ]);
  });

  test("a unique attribute prints unique, and only that one", () => {
    const view = schemaView(input({ "t.mesh.mx": "entity :T table=\"ts\"\n  attributes\n    uuid :id primary-key\n    string :slug unique\n    string :other\n    string :maybe unique nullable\n" }));
    expect(view.tables[0]!.columns.map((column) => [column.key, column.unique])).toEqual([["id", false], ["slug", true], ["other", false], ["maybe", true]]);
  });

  test("only the builders the tables use are imported", () => {
    expect(schemaView(input({ "user.mesh.mx": "entity :User\n  attributes\n    uuid :id primary-key\n" })).builders).toEqual(["text"]);
  });

  test("the key is the table name as stored: the default table, a table= that differs from the entity name, and one that is not an identifier", () => {
    const view = schemaView(input({
      "blog_post.mesh.mx": "entity :BlogPost\n  attributes\n    uuid :id primary-key\n",
      "claim.mesh.mx": 'entity :Claim table="claim"\n  attributes\n    uuid :id primary-key\n',
      "late.mesh.mx": 'entity :LateResult table="late-result"\n  attributes\n    uuid :id primary-key\n',
      "odd.mesh.mx": 'entity :Odd table="2 odd"\n  attributes\n    uuid :id primary-key\n',
    }));
    expect(view.tables.map((table) => [table.entity, table.key, table.nameLiteral])).toEqual([
      ["BlogPost", "blog_post", '"blog_post"'],
      ["Claim", "claim", '"claim"'],
      ["LateResult", '"late-result"', '"late-result"'],
      ["Odd", '"2 odd"', '"2 odd"'],
    ]);
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
      message: 'Entities b.Note (src/domain/b/note.mesh.mx) and a.Post (src/domain/a/post.mesh.mx) both use the SQLite table "posts"',
      position: { file: "src/domain/a/post.mesh.mx", line: 1, column: 0, offset: 0 },
      fix: 'Set table="..." on one of the two entities',
    });
  });

  test("same-named entities in two modules build when their tables differ: nothing is exported under the entity name", () => {
    const view = schemaView(input({
      "sales/post.mesh.mx": 'entity :Post table="sales_posts"\n  attributes\n    uuid :id primary-key\n',
      "blog/post.mesh.mx": 'entity :Post table="blog_posts"\n  attributes\n    uuid :id primary-key\n',
    }));
    expect(view.tables.map((table) => table.key)).toEqual(["blog_posts", "sales_posts"]);
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

  test("a table name longer than Postgres's 63 bytes still builds on SQLite: the length rule is Postgres's", () => {
    const name = "t".repeat(64);
    expect(schemaView(input({ "post.mesh.mx": `entity :Post table="${name}"\n  attributes\n    uuid :id primary-key\n` })).tables[0]!.nameLiteral).toBe(JSON.stringify(name));
  });

  test("negative: distinct tables and distinct columns build", () => {
    const view = schemaView(input({
      "sales/order.mesh.mx": 'entity :Order table="sales_orders"\n  attributes\n    uuid :id primary-key\n    string :title\n    string :subtitle\n',
      "blog/post.mesh.mx": 'entity :Post table="posts_2"\n  attributes\n    uuid :id primary-key\n',
    }));
    expect(view.tables.map((table) => table.key)).toEqual(["sales_orders", "posts_2"]);
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

export const tables = {
  posts: _meshSqlite("posts", {
    id: text("id").notNull().primaryKey(),
    title: text("title").notNull(),
    body: text("body"),
    featured: integer("featured", { mode: "boolean" }).notNull(),
    state: text("state", { enum: ["draft", "published"] }).notNull(),
    publishedAt: integer("publishedAt", { mode: "timestamp_ms" }),
    authorId: text("authorId").notNull(),
    editorId: text("editorId"),
  }),
  users: _meshSqlite("users", {
    id: text("id").notNull().primaryKey(),
    score: real("score").notNull(),
  }),
};
`);
  });
});

describe("the multi-process core tables", () => {
  const event = "event :Paid\n  integer :n\n";
  const account = "entity :Account table=\"accounts\"\n  attributes\n    uuid :id primary-key\n";
  const bus = (capabilities: readonly BusCapability[]) => testBus({ capabilities });
  const MULTI: readonly BusCapability[] = ["ordered-delivery", "replay", "subscribe", "multi-process"];
  const withBus = (emit: EmitInput, capabilities: readonly BusCapability[] | undefined): EmitInput =>
    ({ document: emit.document, config: capabilities === undefined ? config : { ...config, events: { bus: bus(capabilities) } } });

  test("coreTablesFor without multiProcess returns CORE_TABLES as before; with it, the three columns are added and the process table follows", () => {
    const project = { events: [{}] };
    expect(coreTablesFor(project)).toEqual(CORE_TABLES);
    expect(coreTablesFor(project, { multiProcess: false })).toEqual(CORE_TABLES);
    expect(coreTablesFor({ events: [] }, { multiProcess: true })).toEqual([]);
    expect(coreTablesFor({}, { multiProcess: true })).toEqual([]);
    const multi = coreTablesFor(project, { multiProcess: true });
    expect(multi.map((core) => core.name)).toEqual([...CORE_TABLES.map((core) => core.name), DELIVERY_PROCESS_TABLE]);
    const columns = (name: string) => multi.find((core) => core.name === name)!.columns.map((column) => `${column.name}:${column.type}${column.nullable ? "?" : ""}`);
    expect(columns("mesh_outbox")).toEqual(CORE_TABLES[0]!.columns.map((column) => `${column.name}:${column.type}${column.nullable ? "?" : ""}`));
    expect(columns("mesh_outbox_state").at(-1)).toBe("keep:string?");
    expect(columns("mesh_handler_progress").at(-1)).toBe("run_id:uuid?");
    expect(columns("mesh_subscription_progress").at(-1)).toBe("run_id:uuid?");
    expect(columns(DELIVERY_PROCESS_TABLE)).toEqual(["run_id:uuid", "renewed_at:timestamp", "host:string?", "pid:integer?", "started_at:timestamp?", "keep:string", "handlers:json", "declared:json"]);
    // CORE_TABLES itself is untouched, and so is the set of names whose entity data operations are refused
    expect(CORE_TABLES.map((core) => core.name)).toEqual(["mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
    expect(CORE_TABLE_NAMES.has(DELIVERY_PROCESS_TABLE)).toBe(false);
    expect(MULTI_PROCESS_CORE.tables.map((core) => core.name)).toEqual([DELIVERY_PROCESS_TABLE]);
  });

  test("schema.ts is byte-identical with no bus, a single-process bus, and localBus's capabilities; a multi-process bus adds the table and columns only", async () => {
    const emit = input({ "account.mesh.mx": account, "paid.mesh.mx": event });
    const render = async (capabilities: readonly BusCapability[] | undefined) =>
      (await generateFiles(withBus(emit, capabilities), build)).find((file) => file.path === ".mesh/schema.ts")!.contents;
    const none = await render(undefined);
    expect(await render(["ordered-delivery", "replay", "subscribe"])).toBe(none);
    expect(await render(["ordered-delivery"])).toBe(none);
    expect(none).not.toContain("mesh_delivery_process");
    expect(none).not.toContain("run_id: text(\"run_id\"),\n  }),\n  mesh_subscription_progress");
    const multi = await render(MULTI);
    expect(multi).not.toBe(none);
    expect(multi).toContain(`mesh_delivery_process: _meshSqlite("mesh_delivery_process", {
    run_id: text("run_id").notNull().primaryKey(),
    renewed_at: integer("renewed_at", { mode: "timestamp_ms" }).notNull(),
    host: text("host"),
    pid: integer("pid"),
    started_at: integer("started_at", { mode: "timestamp_ms" }),
    keep: text("keep").notNull(),
    handlers: text("handlers", { mode: "json" }).notNull(),
    declared: text("declared", { mode: "json" }).notNull(),
  }),`);
    const view = schemaView(withBus(emit, MULTI));
    expect(view.tables.map((table) => table.entity)).toEqual(["Account", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_delivery_process"]);
    expect(view.tables.find((table) => table.entity === "mesh_handler_progress")!.columns.at(-1)).toMatchObject({ key: "run_id", builder: "text", notNull: false });
    // with no event declared, a multi-process bus adds nothing either
    const plain = input({ "account.mesh.mx": account });
    expect(schemaView(withBus(plain, MULTI)).tables.map((table) => table.entity)).toEqual(["Account"]);
  });

  test("an entity whose table is mesh_delivery_process is MESH_SCHEMA_DUPLICATE_TABLE only in a project whose bus declares multi-process", () => {
    const clash = "entity :Proc table=\"mesh_delivery_process\"\n  attributes\n    uuid :id primary-key\n";
    const emit = input({ "proc.mesh.mx": clash, "paid.mesh.mx": event });
    const error = emitError(() => schemaView(withBus(emit, MULTI)));
    expect(error.diagnostic).toMatchObject({ code: "MESH_SCHEMA_DUPLICATE_TABLE", message: expect.stringContaining("once the project's bus declares multi-process") });
    expect(schemaView(withBus(emit, ["ordered-delivery", "replay", "subscribe"])).tables.map((table) => table.entity)).toContain("Proc");
    expect(schemaView(withBus(emit, undefined)).tables.map((table) => table.entity)).toContain("Proc");
    // the letter case is SQLite's, as for the outbox's tables
    const upper = input({ "proc.mesh.mx": clash.replace("mesh_delivery_process", "MESH_DELIVERY_PROCESS"), "paid.mesh.mx": event });
    expect(emitError(() => schemaView(withBus(upper, MULTI))).diagnostic.code).toBe("MESH_SCHEMA_DUPLICATE_TABLE");
  });
});
