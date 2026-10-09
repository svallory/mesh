import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import build from "../src/build.ts";
import { push, pushCommand } from "../src/push-command.ts";
import { MISSING_DRIZZLE_KIT } from "../src/push-schema.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A project inside this package (so schema.ts resolves drizzle-orm) with its schema built for `file`. */
async function project(file: unknown): Promise<ResolvedConfig> {
  const root = await mkdtemp(join(import.meta.dir, ".emitted-push-"));
  dirs.push(root);
  const config: ResolvedConfig = {
    root, configFile: join(root, "mesh.config.ts"), entityFiles: [], domainRoot: join(root, "src/domain"), output: join(root, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", options: { file } },
  };
  const built = buildModel({ root, domainRoot: join(root, "src/domain"), files: [{ file: "src/domain/note.mesh.mx",
    source: 'entity :Note table="notes"\n  attributes\n    uuid :id primary-key\n    string :text\n' }] });
  expect(built.diagnostics).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  return config;
}
function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } };
}
const tables = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name); }
  finally { db.close(); }
};

test("a relative file is resolved from the project root, not the working directory", async () => {
  const config = await project("app.db");
  const streams = io();
  expect(await pushCommand({ projectRoot: config.root, config, args: [], ...streams })).toBe(0);
  expect(streams.err).toEqual([]);
  expect(streams.out.join("")).toMatch(/^CREATE TABLE `notes` \([^]*\);\napplied 1 statement to app\.db\n$/);
  expect(tables(join(config.root, "app.db"))).toEqual(["notes"]);
  expect(existsSync(join(process.cwd(), "app.db"))).toBe(false);
  const again = io();
  expect(await pushCommand({ projectRoot: config.root, config, args: [], ...again })).toBe(0);
  expect(again.out).toEqual(["schema is up to date: app.db\n"]);
});

test("an absolute file path is used as given", async () => {
  const config = await project("");
  const file = join(config.root, "absolute.db");
  const withFile = { ...config, data: { ...config.data, options: { file } } };
  expect(await pushCommand({ projectRoot: config.root, config: withFile, args: [], ...io() })).toBe(0);
  expect(tables(file)).toEqual(["notes"]);
});

test.each([[":memory:", "an in-memory database ends with the process; use createSchema in tests"], ["", 'set data: sqlite({ file: "app.db" }) in mesh.config.ts'], [3, 'set data: sqlite({ file: "app.db" }) in mesh.config.ts']])(
  "db push needs a database file: %j", async (file, reason) => {
    const config = await project(file);
    const streams = io();
    expect(await pushCommand({ projectRoot: config.root, config, args: ["--force"], ...streams })).toBe(1);
    expect(streams.err).toEqual([`db push needs a database file: ${reason}\n`]);
    expect(streams.out).toEqual([]);
  },
);

test("an unknown argument is a usage error and opens nothing", async () => {
  const config = await project("app.db");
  const streams = io();
  expect(await pushCommand({ projectRoot: config.root, config, args: ["--yes"], ...streams })).toBe(2);
  expect(streams.err).toEqual(['Unknown argument "--yes" for mesh db push; use mesh db push [--force]\n']);
  expect(existsSync(join(config.root, "app.db"))).toBe(false);
});

test("a missing drizzle-kit reports the same message as createSchema, exit 1", async () => {
  const config = await project("app.db");
  const streams = io();
  expect(await push({ projectRoot: config.root, config, args: [], ...streams }, async () => { throw new Error("Cannot find package"); })).toBe(1);
  expect(streams.err).toEqual([`db push failed: ${MISSING_DRIZZLE_KIT}\n`]);
});

test("a schema.ts without tables is reported, exit 1", async () => {
  const config = await project("app.db");
  await writeFile(join(config.output, "schema.ts"), "export const nothing = 1;\n");
  const streams = io();
  expect(await pushCommand({ projectRoot: config.root, config, args: [], ...streams })).toBe(1);
  expect(streams.err).toEqual([`db push failed: ${join(config.output, "schema.ts")} does not export tables; run mesh build\n`]);
});
