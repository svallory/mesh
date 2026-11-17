import { getTableColumns, getTableName, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { FrameworkError, type TableHandle } from "@meshfw/runtime";
import { postgresNameProblem } from "./identifiers.ts";
import { postgresTable } from "./layer.ts";

/** Who asked for the push; named in the messages. */
export type PushCaller = "createSchema" | "mesh db push";

/** The pinned schema tool's message when it is not installed. */
export function missingDrizzleKit(caller: PushCaller): string {
  return `${caller} needs drizzle-kit, a development dependency. Run: bun add -d drizzle-kit@0.31.11. Production databases are prepared with migrations, not with ${caller}.`;
}

/**
 * The slice of drizzle-kit 0.31.11's `drizzle-kit/api` that Mesh calls, declared here so that type-checking a project
 * without drizzle-kit installed never resolves it.
 */
export interface DrizzleKitApi {
  pushSchema(imports: Record<string, unknown>, drizzleInstance: unknown, schemaFilters?: string[], tablesFilter?: string[]): Promise<{
    hasDataLoss: boolean;
    warnings: string[];
    statementsToExecute: string[];
    apply(): Promise<void>;
  }>;
}

/** Resolving and importing the tool, replaceable for tests (not part of the public API). */
export interface DrizzleKitLoader {
  /** Throws when the module cannot be resolved from this package, that is when it is not installed. */
  resolve(specifier: string): string;
  /** Imports the resolved module. */
  load(path: string): Promise<unknown>;
}

// A variable, not a literal: TypeScript resolves literal `import()` specifiers.
const KIT_API = "drizzle-kit/api";
const defaultLoader: DrizzleKitLoader = {
  resolve: (specifier) => Bun.resolveSync(specifier, import.meta.dir),
  load: (path) => import(path),
};

/** Load the pinned API: not installed and installed-but-broken are different errors. */
export async function loadDrizzleKit(caller: PushCaller, loader: DrizzleKitLoader = defaultLoader): Promise<DrizzleKitApi> {
  let path: string;
  try { path = loader.resolve(KIT_API); }
  catch (cause) { throw new FrameworkError(missingDrizzleKit(caller), { cause }); }
  try { return await loader.load(path) as DrizzleKitApi; }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new FrameworkError(`${caller} cannot load drizzle-kit, which is installed (${path}): ${reason}`, { cause });
  }
}

// drizzle-kit's push draws a "Pulling schema from database..." spinner on standard output and has no option to turn it
// off. Pushes on different layers can overlap, so the mute is counted: the first push in saves and patches `write`, the
// last one out restores it.
let mutedPushes = 0;
let unmutedWrite: typeof process.stdout.write | undefined;
async function withStdoutMuted<T>(run: () => Promise<T>): Promise<T> {
  if (mutedPushes++ === 0) {
    unmutedWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
  }
  try { return await run(); }
  finally {
    if (--mutedPushes === 0) {
      process.stdout.write = unmutedWrite!;
      unmutedWrite = undefined;
    }
  }
}

/** What pushing the emitted schema to one database would do. */
export interface SchemaPush {
  /** The SQL statements the push would run, in order; empty when the schema is up to date. */
  readonly statements: readonly string[];
  /** The tool's data-loss warnings; non-empty exactly when `losesData` is true. */
  readonly warnings: readonly string[];
  /** True when a statement would drop a table, a column or rows. */
  readonly losesData: boolean;
  /** Run the statements. */
  apply(): Promise<void>;
}

/** Refuse names the pinned schema tool cannot quote or Postgres would cut, before any connection or DDL. */
export function checkTableNames(tables: Readonly<Record<string, TableHandle>>): void {
  for (const handle of Object.values(tables)) {
    const table = postgresTable(handle);
    const problem = postgresNameProblem(getTableName(table), "table");
    if (problem) throw new FrameworkError(problem);
    for (const column of Object.values(getTableColumns(table))) {
      const problem = postgresNameProblem(column.name, "column");
      if (problem) throw new FrameworkError(problem);
    }
  }
}

/**
 * The relations and sequences of `public` that are not one of `tables` and not owned by one of them (an identity
 * column's sequence). drizzle-kit 0.31.11 drops sequences outside its table filter and asks interactive rename questions
 * about foreign tables, so a push runs only on a schema that holds this project's tables alone.
 */
async function foreignObjects(db: BunSQLDatabase, names: readonly string[]): Promise<string[]> {
  // Bound as text, then read as JSON: a parameter Postgres infers as json, Bun would encode as a JSON string.
  const listed = JSON.stringify(names);
  const rows = [...await db.execute(sql`
    SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT (c.relkind IN ('r', 'p') AND c.relname IN (SELECT json_array_elements_text(${listed}::text::json)))
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')
          AND t.relname IN (SELECT json_array_elements_text(${listed}::text::json))))
    ORDER BY c.relname`)] as unknown as { name: string; kind: string }[];
  const kinds: Record<string, string> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table", S: "sequence" };
  return rows.map((row) => `${kinds[row.kind] ?? "relation"} ${row.name}`);
}

/**
 * The single compatibility bridge for the pinned development-tool API: the one place that loads `drizzle-kit`, by
 * dynamic import, and calls it. `createSchema` and `mesh db push` both plan through here. drizzle-kit reads
 * `execute(...).rows` (the `node-postgres` shape), and Drizzle's `bun-sql` driver returns an array, so the push runs
 * through a bridge that wraps it.
 */
export async function planSchemaPush(
  db: BunSQLDatabase,
  tables: Readonly<Record<string, TableHandle>>,
  caller: PushCaller,
  loader?: DrizzleKitLoader,
): Promise<SchemaPush> {
  const names = Object.values(tables).map((handle) => getTableName(postgresTable(handle)));
  const foreign = await foreignObjects(db, names);
  if (foreign.length > 0) {
    throw new FrameworkError(`${caller} prepares a Postgres schema that holds only this project's tables, and public also holds ${foreign.join(", ")}: use a database of its own for this project, or drop them`);
  }
  const kit = await loadDrizzleKit(caller, loader);
  const bridge = { execute: async (query: unknown) => ({ rows: [...await db.execute(query as never)] }) };
  const plan = await withStdoutMuted(() => kit.pushSchema({ ...tables }, bridge, ["public"], names));
  return {
    statements: [...plan.statementsToExecute],
    warnings: [...plan.warnings],
    losesData: plan.hasDataLoss,
    apply: () => withStdoutMuted(() => plan.apply()),
  };
}
