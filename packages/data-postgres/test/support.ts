import { SQL } from "bun";
import { afterAll, beforeAll, describe } from "bun:test";
import { getTableName } from "drizzle-orm";
import { type TableHandle } from "@meshfw/runtime";
import { createSchema, postgres } from "../src/index.ts";
import { postgresTable, postgresWith, type PostgresLayer, type Tuning } from "../src/layer.ts";

/**
 * How the Postgres tests find a server: `MESH_TEST_POSTGRES_URL`, a server URL whose user may `CREATE DATABASE`. Not
 * set, the server tests are skipped with one line on stderr; not set while `CI` is, this module throws, so CI never
 * passes by skipping.
 */
export const serverUrl = process.env.MESH_TEST_POSTGRES_URL?.trim() || undefined;
if (serverUrl === undefined) {
  if (process.env.CI) throw new Error("data-postgres: MESH_TEST_POSTGRES_URL is not set while CI is: the Postgres tests must run against a server in CI");
  const announced = globalThis as { meshPostgresSkipAnnounced?: boolean };
  if (!announced.meshPostgresSkipAnnounced) {
    announced.meshPostgresSkipAnnounced = true;
    console.error("data-postgres: the Postgres tests are skipped because MESH_TEST_POSTGRES_URL is not set. Start a server with docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=mesh postgres:16.16 and set MESH_TEST_POSTGRES_URL=postgres://postgres:mesh@localhost:5432/postgres");
  }
}

/** `describe` when a server is configured, `describe.skip` otherwise. */
export const describeServer = serverUrl === undefined ? describe.skip : describe;

/** The URL of another database on the configured server. */
export function databaseUrl(name: string): string {
  const url = new URL(serverUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A layer over a schema of its own, with its tables cloned empty from `public`. */
export type FreshLayer = (tuning?: Omit<Tuning, "schema">) => Promise<PostgresLayer>;

export interface TestDatabase {
  /** The URL of the file's own database. */
  readonly url: string;
  /** A connection to it, for statements the tests make beside the layer (`pg_terminate_backend`, inspection). */
  readonly admin: SQL;
  readonly freshLayer: FreshLayer;
  /** A second layer object over the same schema as `layer`, so two transactions can run at once, as two processes would. */
  sibling(layer: PostgresLayer, tuning?: Omit<Tuning, "schema">): PostgresLayer;
}

let databases = 0;

/**
 * One database per test file, created in `beforeAll` with `tables` prepared in its `public` schema by `createSchema`,
 * and dropped in `afterAll`. Each `freshLayer()` clones every table into a new schema (`CREATE TABLE ... (LIKE ...
 * INCLUDING ALL)`, which gives an identity column a sequence of its own), about 10 ms instead of a push.
 */
export function testDatabase(tables: Readonly<Record<string, TableHandle>>): TestDatabase {
  const name = `mesh_t_${process.pid}_${++databases}_${Math.random().toString(36).slice(2, 8)}`;
  const names = Object.values(tables).map((handle) => getTableName(postgresTable(handle)));
  let server: SQL | undefined;
  let admin: SQL | undefined;
  let schemas = 0;
  const layers: PostgresLayer[] = [];
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    server = new SQL(serverUrl, { max: 1 });
    await server.unsafe(`CREATE DATABASE "${name}"`);
    admin = new SQL(databaseUrl(name), { max: 2 });
    const layer = postgres({ url: databaseUrl(name) });
    try { await createSchema(layer, tables); } finally { await layer.close(); }
  }, 60_000);
  afterAll(async () => {
    if (serverUrl === undefined) return;
    for (const layer of layers.splice(0)) await layer.close().catch(() => undefined);
    await admin?.close();
    await server?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server?.close();
  }, 60_000);
  return {
    get url() { return databaseUrl(name); },
    get admin() { return admin!; },
    async freshLayer(tuning = {}) {
      const schema = `c${++schemas}`;
      await admin!.unsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of names) await admin!.unsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      const layer = postgresWith({ url: databaseUrl(name) }, { ...tuning, schema });
      layers.push(layer);
      return layer;
    },
    sibling(layer, tuning = {}) {
      const schema = layer.database?.split("#")[1];
      if (schema === undefined) throw new Error("sibling needs a layer made by freshLayer");
      const other = postgresWith({ url: databaseUrl(name) }, { ...tuning, schema });
      layers.push(other);
      return other;
    },
  };
}

/**
 * Layers for tables that exist only once a test has run (the domain suites generate their schema in `beforeAll`): the
 * first `layerFor(tables)` creates a database with `tables` prepared in its `public` schema, and every call returns a
 * new layer over a clone of them in a schema of its own, as `freshLayer` does. One `afterAll` closes every layer and
 * drops every database.
 */
export function lazyDatabases(): { layerFor(tables: Readonly<Record<string, TableHandle>>): Promise<PostgresLayer> } {
  const made = new Map<Readonly<Record<string, TableHandle>>, Promise<{ name: string; admin: SQL; names: string[] }>>();
  const layers: PostgresLayer[] = [];
  let schemas = 0;
  afterAll(async () => {
    for (const layer of layers.splice(0)) await layer.close().catch(() => undefined);
    const server = serverUrl === undefined ? undefined : new SQL(serverUrl, { max: 1 });
    for (const pending of made.values()) {
      const { name, admin } = await pending;
      await admin.close();
      await server?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    made.clear();
    await server?.close();
  }, 60_000);
  const database = (tables: Readonly<Record<string, TableHandle>>) => {
    let pending = made.get(tables);
    if (pending === undefined) {
      pending = (async () => {
        const name = `mesh_t_${process.pid}_${++databases}_${Math.random().toString(36).slice(2, 8)}`;
        const server = new SQL(serverUrl!, { max: 1 });
        try { await server.unsafe(`CREATE DATABASE "${name}"`); } finally { await server.close(); }
        const layer = postgres({ url: databaseUrl(name) });
        try { await createSchema(layer, tables); } finally { await layer.close(); }
        return { name, admin: new SQL(databaseUrl(name), { max: 2 }), names: Object.values(tables).map((handle) => getTableName(postgresTable(handle))) };
      })();
      made.set(tables, pending);
    }
    return pending;
  };
  return {
    async layerFor(tables) {
      const { name, admin, names } = await database(tables);
      const schema = `c${++schemas}`;
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of names) await admin.unsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      const layer = postgresWith({ url: databaseUrl(name) }, { schema });
      layers.push(layer);
      return layer;
    },
  };
}
