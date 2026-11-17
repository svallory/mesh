import { describe, expect, test } from "bun:test";
import type { InferSelectModel } from "drizzle-orm";
import { bigint, boolean, doublePrecision, jsonb, text, timestamp, pgTable } from "drizzle-orm/pg-core";
import { ATTRIBUTE_TYPES, type ModelDocument } from "@meshfw/model";
import { EmitError, buildModel, generateFiles, type EmitInput, type ResolvedConfig } from "@meshfw/compiler";
import build, { POSTGRES_COLUMNS, schemaGenerator, schemaView } from "../src/build.ts";
import { truncatedName } from "../src/identifiers.ts";
import type { BusCapability } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";

const config: ResolvedConfig = {
  root: "/project", configFile: "/project/mesh.config.ts", entityFiles: [], domainRoot: "/project/src/domain",
  data: { kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", capabilities: { adapter: "postgres", capabilities: [] }, options: { url: undefined } },
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
const entity = (name: string, table: string, attributes = "") => `entity :${name} table="${table}"\n  attributes\n    uuid :id primary-key\n${attributes}`;

const post = `import { User } from "./user.mesh.mx"
entity :Post table="posts"
  attributes
    uuid :id primary-key
    string :title
    string :body nullable
    integer :views
    decimal :price
    boolean :featured default=false
    enum :state values=[:draft, :published] default=:draft
    datetime :publishedAt nullable
    json :extra
  relationships
    belongs-to :author entity=User
    belongs-to :editor entity=User nullable
`;
const user = `entity :User table="users"
  attributes
    uuid :id primary-key
    float :score
    date :born
    timestamp :seen
  actions auto=[:read]
`;
const TS = '{ mode: "date", precision: 3, withTimezone: true }';
const col = (key: string, builder: string, options: string | null, notNull = true, extra: Partial<{ primaryKey: boolean; identity: boolean; unique: boolean; typeArgument: string }> = {}) =>
  ({ key, builder, nameLiteral: JSON.stringify(key), options, notNull, primaryKey: false, identity: false, unique: false, typeArgument: null as string | null, ...extra });

describe("schemaView", () => {
  test("one table per entity, sorted by entity name, every attribute type in its Postgres column", () => {
    const view = schemaView(input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user }));
    expect(view.builders).toEqual(["bigint", "boolean", "doublePrecision", "jsonb", "text", "timestamp"]);
    expect(view.tables.map((table) => [table.entity, table.key, table.nameLiteral])).toEqual([["Post", "posts", '"posts"'], ["User", "users", '"users"']]);
    expect(view.tables[0]!.columns).toEqual([
      col("id", "text", null, true, { primaryKey: true }),
      col("title", "text", null),
      col("body", "text", null, false),
      col("views", "bigint", '{ mode: "number" }'),
      col("price", "doublePrecision", null),
      col("featured", "boolean", null),
      col("state", "text", '{ enum: ["draft","published"] }'),
      col("publishedAt", "timestamp", TS, false),
      // A json attribute is nullable in the model (ADR-0069).
      col("extra", "jsonb", null, false),
      col("authorId", "text", null),
      col("editorId", "text", null, false),
    ]);
    expect(view.tables[1]!.columns.map((column) => [column.key, column.builder, column.options])).toEqual([
      ["id", "text", null], ["score", "doublePrecision", null], ["born", "timestamp", TS], ["seen", "timestamp", TS],
    ]);
  });

  test("the type map covers every registered attribute type and nothing else", () => {
    expect(Object.keys(POSTGRES_COLUMNS).sort()).toEqual(ATTRIBUTE_TYPES.map((type) => type.name).sort());
  });

  test("a project that declares an event gets core's tables, the outbox position and the failure id as identity columns", () => {
    const view = schemaView(input({
      "billing/invoice.mesh.mx": 'entity :Invoice\n  attributes\n    uuid :id primary-key\n', "billing/invoice-paid.mesh.mx": "event :InvoicePaid\n  string :note\n",
    }));
    const outbox = view.tables.find((table) => table.entity === "mesh_outbox")!;
    expect(outbox.columns[0]).toEqual(col("position", "bigint", '{ mode: "number" }', true, { primaryKey: true, identity: true }));
    const failures = view.tables.find((table) => table.entity === "mesh_outbox_failures")!;
    expect(failures.columns[0]).toEqual(col("failure", "bigint", '{ mode: "number" }', true, { primaryKey: true, identity: true }));
    const keys = [outbox.columns[0], failures.columns[0]];
    expect(view.tables.filter((table) => table.entity !== "Invoice").every((table) => table.columns.every((column) => column.identity === keys.includes(column)))).toBe(true);
  });

  test("no defaults reach the schema", () => {
    expect(JSON.stringify(schemaView(input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user })))).not.toContain("default");
  });

  test("each column's inferred type is the record type the types generator writes", () => {
    const table = pgTable("t", {
      s: text("s").notNull(), i: bigint("i", { mode: "number" }).notNull(), f: doublePrecision("f").notNull(), b: boolean("b").notNull(),
      d: timestamp("d", { mode: "date", precision: 3, withTimezone: true }).notNull(), j: jsonb("j"), e: text("e", { enum: ["a", "b"] }).notNull(),
    });
    type Row = InferSelectModel<typeof table>;
    const exact: { s: string; i: number; f: number; b: boolean; d: Date; j: unknown; e: "a" | "b" } = {} as Row;
    const back: Row = {} as typeof exact;
    void exact; void back;
  });
});

/**
 * A model with concept members, written out (the build needs concept files on disk, which data-sqlite's domain suite
 * `concepts.ts` covers end to end, run here by `domain.test.ts`): `Invoice` holds `Money :total`, `Money :refund nullable`
 * and `billing.Status :status`.
 */
const conceptDocument = (): ModelDocument => {
  const position = { file: "src/domain/billing/invoice.mesh.mx", line: 1, column: 0, offset: 0 };
  const member = (name: string, concept: string, nullable = false) => ({ name, type: "concept" as const, concept, nullable, primaryKey: false, unique: false, position });
  return {
    entities: [{
      name: "Invoice", fqn: "billing.Invoice", table: "invoices", file: position.file, module: "billing", imports: [],
      attributes: [{ name: "id", type: "uuid", nullable: false, primaryKey: true, unique: false, position }, member("total", "Money"), member("refund", "Money", true), member("status", "billing.Status")],
      relationships: [], computed: [], actions: [], auto: ["read"], always: [], policies: [], position,
    }],
    concepts: [
      { name: "Status", fqn: "billing.Status", file: "src/domain/billing/concepts/Status.mesh.mx", module: "billing", fields: [{ name: "state", type: "string", nullable: false, position }], position },
      { name: "Money", fqn: "Money", file: "src/domain/concepts/Money.mesh.mx", module: "", fields: [{ name: "amount", type: "integer", nullable: false, position }], position },
    ],
  };
};

describe("a concept member's column (ADR-0092)", () => {
  test("is one jsonb column typed with the concept's type, imported type-only by the compiler's naming rule", () => {
    const view = schemaView({ document: conceptDocument(), config });
    expect(view.tables[0]!.columns.slice(1)).toEqual([
      col("total", "jsonb", null, true, { typeArgument: "$Money$concept" }),
      col("refund", "jsonb", null, false, { typeArgument: "$Money$concept" }),
      col("status", "jsonb", null, true, { typeArgument: "$billing$Status$concept" }),
    ]);
    expect(view.typeImports).toEqual([
      { names: "Status as $billing$Status$concept", fromLiteral: '"./domain/billing/status.concept"' },
      { names: "Money as $Money$concept", fromLiteral: '"./domain/money.concept"' },
    ]);
  });

  test("schema.ts prints `.$type<...>()` and the type-only imports; a project with no concept prints neither", async () => {
    const rendered = (await generateFiles({ document: conceptDocument(), config }, build)).find((generated) => generated.path.endsWith("schema.ts"))!.contents;
    expect(rendered).toContain('import type { Money as $Money$concept } from "./domain/money.concept";');
    expect(rendered).toContain('import type { Status as $billing$Status$concept } from "./domain/billing/status.concept";');
    const flat = rendered.replace(/\s+/g, "");
    for (const line of ['total: jsonb("total").$type<$Money$concept>().notNull(),', 'refund: jsonb("refund").$type<$Money$concept>(),', 'status: jsonb("status").$type<$billing$Status$concept>().notNull(),'])
      expect(flat).toContain(line.replace(/\s+/g, ""));
    const plain = (await generateFiles(input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user }), build)).find((generated) => generated.path.endsWith("schema.ts"))!.contents;
    expect(plain).not.toContain("$type");
    expect(plain).not.toContain("import type");
  });
});

describe("MESH_SCHEMA_* build errors, in Postgres's words", () => {
  const long = "t".repeat(64);
  test.each([
    ['po"sts', "double quote"],
    ["po\\u0001sts", "control character"],
  ])("MESH_SCHEMA_IDENTIFIER: a table name the schema tools cannot quote (%s)", (written) => {
    const name = JSON.parse(`"${written.replace(/"/g, '\\"').replace("\\\\u", "\\u")}"`) as string;
    const source = `entity :Post table=${JSON.stringify(name)}\n  attributes\n    uuid :id primary-key\n`;
    const error = emitError(() => schemaView(input({ "post.mesh.mx": source })));
    expect(error.diagnostic).toEqual({
      severity: "error", code: "MESH_SCHEMA_IDENTIFIER",
      message: `"${name}" cannot be used as a Postgres table name: it contains a character that the schema tools cannot quote safely (double quote or control character)`,
      position: { file: "src/domain/post.mesh.mx", line: 1, column: 0, offset: 0 },
      fix: "Remove double quotes and ASCII control characters from the table name",
    });
  });

  test("MESH_SCHEMA_IDENTIFIER: a table name longer than 63 bytes; 63 bytes is legal", () => {
    const error = emitError(() => schemaView(input({ "post.mesh.mx": entity("Post", long) })));
    expect(error.diagnostic).toMatchObject({
      code: "MESH_SCHEMA_IDENTIFIER",
      message: `"${long}" cannot be used as a Postgres table name: Postgres keeps the first 63 bytes of a name and would store it as "${"t".repeat(63)}"`,
      fix: 'Give the table a name of at most 63 bytes with table="..."',
    });
    expect(schemaView(input({ "post.mesh.mx": entity("Post", "t".repeat(63)) })).tables[0]!.nameLiteral).toBe(JSON.stringify("t".repeat(63)));
  });

  test("bytes, not characters, count: a name of 32 two-byte letters is 64 bytes and cut at a character boundary", () => {
    const name = "é".repeat(32);
    const error = emitError(() => schemaView(input({ "post.mesh.mx": entity("Post", name) })));
    expect(error.diagnostic.message).toContain(`would store it as "${"é".repeat(31)}"`);
    expect(truncatedName(`${"a".repeat(62)}é`)).toBe("a".repeat(62));
    expect(schemaView(input({ "post.mesh.mx": entity("Post", "é".repeat(31)) })).tables).toHaveLength(1);
  });

  test("MESH_SCHEMA_IDENTIFIER: a column name longer than 63 bytes, at the attribute", () => {
    const document = input({ "user.mesh.mx": user }).document;
    const changed = structuredClone(document.entities[0]!);
    changed.attributes[1]!.name = "s".repeat(64);
    const error = emitError(() => schemaView({ document: { entities: [changed] }, config }));
    expect(error.diagnostic).toMatchObject({
      code: "MESH_SCHEMA_IDENTIFIER", position: { file: "src/domain/user.mesh.mx", line: 4, column: 4 },
      message: `"${"s".repeat(64)}" cannot be used as a Postgres column name: Postgres keeps the first 63 bytes of a name and would store it as "${"s".repeat(63)}"`,
      fix: "Give the attribute a name of at most 63 bytes",
    });
    changed.attributes[1]!.name = 's"core';
    expect(emitError(() => schemaView({ document: { entities: [changed] }, config })).diagnostic.fix).toBe("Remove double quotes and ASCII control characters from the column name");
  });

  test("MESH_SCHEMA_IDENTIFIER: a unique constraint whose derived name is over 63 bytes while each part is under it", () => {
    const table = "t".repeat(30);
    const attribute = "s".repeat(30);
    const error = emitError(() => schemaView(input({ "post.mesh.mx": entity("Post", table, `    string :${attribute} unique\n`) })));
    expect(error.diagnostic).toMatchObject({
      code: "MESH_SCHEMA_IDENTIFIER",
      message: `The unique constraint of Post.${attribute} would be named "${table}_${attribute}_unique", 68 bytes; Postgres keeps the first 63, so every push would see a difference`,
      fix: "Shorten the table or the attribute name",
      position: { line: 4, column: 4 },
    });
    // The same lengths without unique, and a unique whose name fits, build.
    expect(schemaView(input({ "post.mesh.mx": entity("Post", table, `    string :${attribute}\n`) })).tables).toHaveLength(1);
    expect(schemaView(input({ "post.mesh.mx": entity("Post", "t".repeat(25), `    string :${"s".repeat(30)} unique\n`) })).tables[0]!.columns[1]!.unique).toBe(true);
  });

  test("MESH_SCHEMA_DUPLICATE_TABLE: two entities on one table name", () => {
    const error = emitError(() => schemaView(input({
      "a/post.mesh.mx": entity("Post", "posts"),
      "b/note.mesh.mx": entity("Note", "posts"),
    })));
    expect(error.diagnostic).toEqual({
      severity: "error", code: "MESH_SCHEMA_DUPLICATE_TABLE",
      message: 'Entities b.Note (src/domain/b/note.mesh.mx) and a.Post (src/domain/a/post.mesh.mx) both use the Postgres table "posts"',
      position: { file: "src/domain/a/post.mesh.mx", line: 1, column: 0, offset: 0 },
      fix: 'Set table="..." on one of the two entities',
    });
  });

  test("MESH_SCHEMA_DUPLICATE_TABLE: an entity on a core table of a project that declares an event", () => {
    const error = emitError(() => schemaView(input({
      "billing/invoice.mesh.mx": 'entity :Invoice\n  attributes\n    uuid :id primary-key\n', "billing/invoice-paid.mesh.mx": "event :InvoicePaid\n  string :note\n",
      "billing/log.mesh.mx": entity("Log", "mesh_outbox"),
    })));
    expect(error.diagnostic).toMatchObject({
      code: "MESH_SCHEMA_DUPLICATE_TABLE",
      message: 'Entity billing.Log (src/domain/billing/log.mesh.mx) uses the Postgres table "mesh_outbox", which is Mesh\'s own once the project declares an event: it holds the outbox',
      fix: 'Set table="..." on the entity to another name',
    });
  });

  test("names that differ only in letter case are two tables and two columns on Postgres (they are one on SQLite)", () => {
    const view = schemaView(input({
      "a/post.mesh.mx": entity("Post", "posts", "    string :title\n    string :Title\n"),
      "b/note.mesh.mx": entity("Note", "POSTS"),
    }));
    expect(view.tables.map((table) => table.nameLiteral)).toEqual(['"POSTS"', '"posts"']);
    expect(view.tables[1]!.columns.map((column) => column.key)).toEqual(["id", "title", "Title"]);
  });

  test("MESH_SCHEMA_DUPLICATE_COLUMN: an attribute and a relationship key column of one exact name", () => {
    const document = input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user }).document;
    const changed = structuredClone(document.entities.find((e) => e.name === "Post")!);
    changed.attributes[1]!.name = "authorId";
    const error = emitError(() => schemaView({ document: { entities: [changed] }, config }));
    expect(error.diagnostic).toMatchObject({
      code: "MESH_SCHEMA_DUPLICATE_COLUMN", message: '"authorId" and "authorId" in entity blog.Post are the same Postgres column', fix: "Rename one",
    });
  });
});

describe("the schema generator", () => {
  test("is the build half's one generator, with its template beside the package, and contributes db push", async () => {
    expect(build.generators).toEqual([schemaGenerator]);
    expect(Object.keys(build.commands!)).toEqual(["db push"]);
    expect(schemaGenerator).toMatchObject({ name: "postgres-schema", template: "schema.ts.jig", requires: ["drizzle-orm"] });
    expect(await Bun.file(`${schemaGenerator.templateDir}/schema.ts.jig`).exists()).toBe(true);
  });

  test("renders <output>/schema.ts through the core generateFiles, byte-identical across builds", async () => {
    const emit = input({ "blog/post.mesh.mx": post, "blog/user.mesh.mx": user });
    const first = await generateFiles(emit, build);
    expect(await generateFiles(emit, build)).toEqual(first);
    expect(first.find((file) => file.path === ".mesh/schema.ts")!.contents).toBe(`// Do not edit this file by hand.
// It is generated by \`mesh build\` from the entity files; change them and rebuild.

import {
  pgTable as _meshPg,
  bigint,
  boolean,
  doublePrecision,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const tables = {
  posts: _meshPg("posts", {
    id: text("id").notNull().primaryKey(),
    title: text("title").notNull(),
    body: text("body"),
    views: bigint("views", { mode: "number" }).notNull(),
    price: doublePrecision("price").notNull(),
    featured: boolean("featured").notNull(),
    state: text("state", { enum: ["draft", "published"] }).notNull(),
    publishedAt: timestamp("publishedAt", { mode: "date", precision: 3, withTimezone: true }),
    extra: jsonb("extra"),
    authorId: text("authorId").notNull(),
    editorId: text("editorId"),
  }),
  users: _meshPg("users", {
    id: text("id").notNull().primaryKey(),
    score: doublePrecision("score").notNull(),
    born: timestamp("born", { mode: "date", precision: 3, withTimezone: true }).notNull(),
    seen: timestamp("seen", { mode: "date", precision: 3, withTimezone: true }).notNull(),
  }),
};
`);
  });

  test("the outbox's position renders as an identity primary key", async () => {
    const files = await generateFiles(input({
      "billing/invoice.mesh.mx": 'entity :Invoice\n  attributes\n    uuid :id primary-key\n', "billing/invoice-paid.mesh.mx": "event :InvoicePaid\n  string :note\n",
    }), build);
    const contents = files.find((file) => file.path === ".mesh/schema.ts")!.contents.replace(/\s+/g, "");
    expect(contents).toContain('position:bigint("position",{mode:"number"}).notNull().primaryKey().generatedAlwaysAsIdentity(),');
  });
});

describe("the multi-process core tables", () => {
  const event = "event :Paid\n  integer :n\n";
  const account = "entity :Account table=\"accounts\"\n  attributes\n    uuid :id primary-key\n";
  const MULTI: readonly BusCapability[] = ["ordered-delivery", "replay", "subscribe", "multi-process"];
  const withBus = (emit: EmitInput, capabilities: readonly BusCapability[] | undefined): EmitInput =>
    ({ document: emit.document, config: capabilities === undefined ? config : { ...config, events: { bus: testBus({ capabilities }) } } });

  test("schema.ts is byte-identical with no bus and a bus without multi-process; a multi-process bus adds the table and three columns only", async () => {
    const emit = input({ "account.mesh.mx": account, "paid.mesh.mx": event });
    const render = async (capabilities: readonly BusCapability[] | undefined) =>
      (await generateFiles(withBus(emit, capabilities), build)).find((file) => file.path === ".mesh/schema.ts")!.contents;
    const none = await render(undefined);
    expect(await render(["ordered-delivery", "replay", "subscribe"])).toBe(none);
    expect(await render(["ordered-delivery"])).toBe(none);
    expect(none).not.toContain("mesh_delivery_process");
    expect(none).not.toContain('run_id: text("run_id"),\n  }),\n  mesh_subscription_progress');
    const multi = await render(MULTI);
    expect(multi).toContain(`mesh_delivery_process: _meshPg("mesh_delivery_process", {
    run_id: text("run_id").notNull().primaryKey(),
    renewed_at: timestamp("renewed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    host: text("host"),
    pid: bigint("pid", { mode: "number" }),
    started_at: timestamp("started_at", { mode: "date", precision: 3, withTimezone: true }),
    keep: text("keep").notNull(),
    handlers: jsonb("handlers").notNull(),
    declared: jsonb("declared").notNull(),
  }),`);
    // the only other difference: one nullable column at the end of three of core's tables
    const added = multi.split("\n").filter((line) => !none.split("\n").includes(line));
    expect(added.filter((line) => !line.includes("mesh_delivery_process") && !/^\s+(run_id|renewed_at|host|pid|started_at|keep|handlers|declared): /.test(line) && line.trim() !== "}),")).toEqual([]);
    const view = schemaView(withBus(emit, MULTI));
    expect(view.tables.map((table) => table.entity)).toEqual(["Account", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures", "mesh_delivery_process"]);
    const last = (entity: string) => view.tables.find((table) => table.entity === entity)!.columns.at(-1);
    expect(last("mesh_outbox_state")).toMatchObject({ key: "keep", builder: "text", notNull: false });
    expect(last("mesh_handler_progress")).toMatchObject({ key: "run_id", builder: "text", notNull: false });
    expect(last("mesh_subscription_progress")).toMatchObject({ key: "run_id", builder: "text", notNull: false });
    expect(view.tables.flatMap((table) => table.columns).filter((column) => column.identity).map((column) => column.key)).toEqual(["position", "failure"]);
    // with no event declared, a multi-process bus adds nothing either
    expect(schemaView(withBus(input({ "account.mesh.mx": account }), MULTI)).tables.map((table) => table.entity)).toEqual(["Account"]);
  });

  test("an entity whose table is mesh_delivery_process is MESH_SCHEMA_DUPLICATE_TABLE only in a project whose bus declares multi-process", () => {
    const clash = "entity :Proc table=\"mesh_delivery_process\"\n  attributes\n    uuid :id primary-key\n";
    const emit = input({ "proc.mesh.mx": clash, "paid.mesh.mx": event });
    expect(emitError(() => schemaView(withBus(emit, MULTI))).diagnostic).toMatchObject({
      code: "MESH_SCHEMA_DUPLICATE_TABLE",
      message: 'Entity Proc (src/domain/proc.mesh.mx) uses the Postgres table "mesh_delivery_process", which is Mesh\'s own once the project\'s bus declares multi-process: it holds the processes that deliver',
      fix: 'Set table="..." on the entity to another name',
    });
    expect(schemaView(withBus(emit, ["ordered-delivery", "replay", "subscribe"])).tables.map((table) => table.entity)).toContain("Proc");
    expect(schemaView(withBus(emit, undefined)).tables.map((table) => table.entity)).toContain("Proc");
    // Postgres compares names exactly: another letter case is another table, even in a multi-process project
    const upper = input({ "proc.mesh.mx": clash.replace("mesh_delivery_process", "MESH_DELIVERY_PROCESS"), "paid.mesh.mx": event });
    expect(schemaView(withBus(upper, MULTI)).tables.map((table) => table.entity)).toContain("Proc");
  });
});
