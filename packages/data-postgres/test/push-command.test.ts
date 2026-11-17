import { SQL } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import build from "../src/build.ts";
import { createSchema, postgres } from "../src/index.ts";
import { push, pushCommand } from "../src/push-command.ts";
import { missingDrizzleKit } from "../src/push-schema.ts";
import type { BusCapability } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { databaseUrl, describeServer, serverUrl } from "./support.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const NOTE = 'entity :Note table="notes"\n  attributes\n    uuid :id primary-key\n    string :text\n';

/** A project inside this package (so schema.ts resolves drizzle-orm) with its schema built for `url`. */
async function project(url: unknown, source = NOTE): Promise<ResolvedConfig> {
  const root = await mkdtemp(join(import.meta.dir, ".scratch-emitted-push-"));
  dirs.push(root);
  const config: ResolvedConfig = {
    root, configFile: join(root, "mesh.config.ts"), entityFiles: [], domainRoot: join(root, "src/domain"), output: join(root, ".mesh"),
    data: { kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", capabilities: { adapter: "postgres", capabilities: [] }, options: { url } },
  };
  const built = buildModel({ root, domainRoot: join(root, "src/domain"), files: [{ file: "src/domain/note.mesh.mx", source }] });
  expect(built.diagnostics).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  return config;
}
function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } };
}

test.each([undefined, "", "  "])("a missing url is refused before anything connects (%p)", async (url) => {
  const config = await project(url);
  const streams = io();
  expect(await pushCommand({ projectRoot: config.root, config, args: [], ...streams })).toBe(1);
  expect(streams.err).toEqual(["db push needs a database url: set data: postgres({ url: process.env.DATABASE_URL }) and define the variable\n"]);
});

test("an unknown argument is a usage error", async () => {
  const config = await project("postgres://h/d");
  const streams = io();
  expect(await pushCommand({ projectRoot: config.root, config, args: ["--yes"], ...streams })).toBe(2);
  expect(streams.err).toEqual(['Unknown argument "--yes" for mesh db push; use mesh db push [--force]\n']);
});

describeServer("mesh db push against a server", () => {
  const server = serverUrl === undefined ? undefined : new SQL(serverUrl, { max: 1 });
  const created: string[] = [];
  afterAll(async () => {
    for (const name of created) await server?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server?.close();
  });
  const emptyDatabase = async () => {
    const name = `mesh_push_${process.pid}_${created.length}_${Math.random().toString(36).slice(2, 8)}`;
    await server!.unsafe(`CREATE DATABASE "${name}"`);
    created.push(name);
    return databaseUrl(name);
  };
  const run = async (sql: string, url: string) => {
    const client = new SQL(url, { max: 1 });
    try { return await client.unsafe(sql); } finally { await client.close(); }
  };

  test("creates the tables, then finds the schema up to date", async () => {
    const url = await emptyDatabase();
    const config = await project(url);
    const name = postgres({ url }).database!;
    const streams = io();
    expect(await pushCommand({ projectRoot: config.root, config, args: [], ...streams })).toBe(0);
    expect(streams.err).toEqual([]);
    expect(streams.out.join("")).toMatch(new RegExp(`^CREATE TABLE "notes" \\([^]*\\);\\napplied 1 statement to ${name.replace(/[/.]/g, "\\$&")}\\n$`));
    const again = io();
    expect(await pushCommand({ projectRoot: config.root, config, args: [], ...again })).toBe(0);
    expect(again.out).toEqual([`schema is up to date: ${name}\n`]);
    expect(again.err).toEqual([]);
  }, 60_000);

  test("statements that would lose data are refused unless --force, and nothing is applied", async () => {
    const url = await emptyDatabase();
    expect(await pushCommand({ projectRoot: (await project(url)).root, config: await project(url), args: [], ...io() })).toBe(0);
    await run(`INSERT INTO notes (id, text) VALUES ('n1', 'kept')`, url);
    const narrower = await project(url, 'entity :Note table="notes"\n  attributes\n    uuid :id primary-key\n');
    const refused = io();
    expect(await pushCommand({ projectRoot: narrower.root, config: narrower, args: [], ...refused })).toBe(1);
    expect(refused.err.join("")).toContain("db push refuses statements that would lose data in");
    expect(refused.err.join("")).toContain("Nothing was applied. Run mesh db push --force to apply them anyway.");
    expect((await run(`SELECT text FROM notes`, url))[0]).toEqual({ text: "kept" });
    const forced = io();
    expect(await pushCommand({ projectRoot: narrower.root, config: narrower, args: ["--force"], ...forced })).toBe(0);
    expect(forced.out.join("")).toContain('ALTER TABLE "notes" DROP COLUMN "text"');
  }, 60_000);

  test("a table, view or sequence in public that is not the project's is refused, by db push and by createSchema", async () => {
    const url = await emptyDatabase();
    await run(`CREATE TABLE other_app (id int); CREATE SEQUENCE other_seq; CREATE VIEW other_view AS SELECT 1 AS one`, url);
    const config = await project(url);
    const streams = io();
    expect(await pushCommand({ projectRoot: config.root, config, args: [], ...streams })).toBe(1);
    expect(streams.err).toEqual(["db push failed: mesh db push prepares a Postgres schema that holds only this project's tables, and public also holds table other_app, sequence other_seq, view other_view: use a database of its own for this project, or drop them\n"]);
    const layer = postgres({ url });
    try {
      await expect(createSchema(layer, { notes: pgTable("notes", { id: text("id").primaryKey() }) })).rejects.toThrow("createSchema prepares a Postgres schema that holds only this project's tables, and public also holds table other_app");
    } finally { await layer.close(); }
  }, 60_000);

  test("the project's own identity sequence is not foreign: a project with events pushes twice cleanly", async () => {
    const url = await emptyDatabase();
    const root = await mkdtemp(join(import.meta.dir, ".scratch-emitted-push-"));
    dirs.push(root);
    const config: ResolvedConfig = {
      root, configFile: join(root, "mesh.config.ts"), entityFiles: [], domainRoot: join(root, "src/domain"), output: join(root, ".mesh"),
      data: { kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", capabilities: { adapter: "postgres", capabilities: [] }, options: { url } },
    };
    const built = buildModel({ root, domainRoot: join(root, "src/domain"), files: [
      { file: "src/domain/billing/invoice.mesh.mx", source: 'entity :Invoice\n  attributes\n    uuid :id primary-key\n' },
      { file: "src/domain/billing/invoice-paid.mesh.mx", source: "event :InvoicePaid\n  string :note\n" },
    ] });
    expect(built.diagnostics).toEqual([]);
    await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
    const first = io();
    expect(await pushCommand({ projectRoot: root, config, args: [], ...first })).toBe(0);
    expect(first.err).toEqual([]);
    expect(first.out.join("")).toContain("GENERATED ALWAYS AS IDENTITY");
    const again = io();
    expect(await pushCommand({ projectRoot: root, config, args: [], ...again })).toBe(0);
    expect(again.out.join("")).toStartWith("schema is up to date: ");
  }, 60_000);

  test("switching the bus to multi-process adds the process table and three columns, and switching back drops them", async () => {
    const url = await emptyDatabase();
    const root = await mkdtemp(join(import.meta.dir, ".scratch-emitted-push-"));
    dirs.push(root);
    const built = buildModel({ root, domainRoot: join(root, "src/domain"), files: [
      { file: "src/domain/billing/invoice.mesh.mx", source: 'entity :Invoice\n  attributes\n    uuid :id primary-key\n' },
      { file: "src/domain/billing/invoice-paid.mesh.mx", source: "event :InvoicePaid\n  string :note\n" },
    ] });
    expect(built.diagnostics).toEqual([]);
    const configFor = async (capabilities: readonly BusCapability[]) => {
      const config: ResolvedConfig = {
        root, configFile: join(root, "mesh.config.ts"), entityFiles: [], domainRoot: join(root, "src/domain"), output: join(root, ".mesh"),
        data: { kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", capabilities: { adapter: "postgres", capabilities: [] }, options: { url } },
        events: { bus: testBus({ capabilities }) },
      };
      await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
      return config;
    };
    const pushed = async (config: ResolvedConfig) => {
      const streams = io();
      const code = await pushCommand({ projectRoot: root, config, args: [], ...streams });
      return { code, out: streams.out.join(""), err: streams.err.join("") };
    };
    const columns = async () => (await run(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND (column_name IN ('run_id', 'keep') OR table_name = 'mesh_delivery_process') ORDER BY 1`, url)).map((row: { c: string }) => row.c);
    const single = await configFor(["ordered-delivery", "replay", "subscribe"]);
    expect(await pushed(single)).toMatchObject({ code: 0, err: "" });
    expect(await columns()).toEqual(["mesh_outbox_state.run_id"]);
    // a single-mode database that has delivered: the state row and a progress row exist
    await run(`INSERT INTO mesh_outbox_state (id, deleted_through) VALUES (1, 0); INSERT INTO mesh_handler_progress (name, kind, position, events, generation) VALUES ('notify', 'process', 0, '[]', 1)`, url);
    const multi = await configFor(["ordered-delivery", "replay", "subscribe", "multi-process"]);
    const added = await pushed(multi);
    expect(added).toMatchObject({ code: 0, err: "" });
    expect(added.out).toContain('CREATE TABLE "mesh_delivery_process"');
    expect(await columns()).toEqual([
      "mesh_delivery_process.declared", "mesh_delivery_process.handlers", "mesh_delivery_process.host", "mesh_delivery_process.keep",
      "mesh_delivery_process.pid", "mesh_delivery_process.renewed_at", "mesh_delivery_process.run_id", "mesh_delivery_process.started_at",
      "mesh_handler_progress.run_id", "mesh_outbox_state.keep", "mesh_outbox_state.run_id", "mesh_subscription_progress.run_id",
    ]);
    expect((await pushed(multi)).out).toStartWith("schema is up to date: ");
    // back to single mode: the process table is Mesh's own, not a foreign table, and goes with the three columns
    // the build writes schema.ts again, without the additions
    const back = await pushed(await configFor(["ordered-delivery", "replay", "subscribe"]));
    // the columns hold the state row and a progress row, so dropping them is refused until --force, like any column
    expect(back.code).toBe(1);
    expect(back.err).not.toContain("holds only this project's tables");
    expect(back.err).toContain('DROP TABLE "mesh_delivery_process" CASCADE;');
    expect(back.err).toContain('ALTER TABLE "mesh_outbox_state" DROP COLUMN "keep";');
    expect(back.err).toContain('ALTER TABLE "mesh_handler_progress" DROP COLUMN "run_id";');
    expect(back.err).toContain('ALTER TABLE "mesh_subscription_progress" DROP COLUMN "run_id";');
    expect(await pushCommand({ projectRoot: root, config: single, args: ["--force"], ...io() })).toBe(0);
    expect(await columns()).toEqual(["mesh_outbox_state.run_id"]);
    expect((await run(`SELECT name FROM mesh_handler_progress`, url))).toEqual([{ name: "notify" }]);
    expect((await pushed(single)).out).toStartWith("schema is up to date: ");
  }, 60_000);

  test("a missing drizzle-kit names the command and the version to install", async () => {
    const url = await emptyDatabase();
    const config = await project(url);
    const streams = io();
    const loader = { resolve: () => { throw new Error("Cannot find module"); }, load: async () => ({}) };
    expect(await push({ projectRoot: config.root, config, args: [], ...streams }, loader)).toBe(1);
    expect(streams.err).toEqual([`db push failed: ${missingDrizzleKit("mesh db push")}\n`]);
  }, 60_000);
});
