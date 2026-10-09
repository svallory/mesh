import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { FrameworkError, type TableHandle } from "@meshfw/runtime";
import { sqliteNameProblem } from "./identifiers.ts";
import { sqliteTable } from "./layer.ts";

/** Who asked for the push; named in the missing-tool message. */
export type PushCaller = "createSchema" | "mesh db push";

/** The pinned schema tool's message when it is not installed. */
export function missingDrizzleKit(caller: PushCaller): string {
  return `${caller} needs drizzle-kit, a development dependency. Run: bun add -d drizzle-kit@0.31.11. Production databases are prepared with migrations, not with ${caller}.`;
}

/**
 * The slice of drizzle-kit 0.31.11's `drizzle-kit/api` that Mesh calls, declared here
 * so that type-checking a project without drizzle-kit installed never resolves it.
 */
export interface DrizzleKitApi {
  pushSQLiteSchema(imports: Record<string, unknown>, drizzleInstance: unknown): Promise<{
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

// drizzle-kit's push draws a "Pulling schema from database..." spinner on standard output
// and has no option to turn it off. Pushes on different layers can overlap (each layer's
// queue orders its own work only), so the mute is counted: the first push in saves and
// patches `write`, the last one out restores it.
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

/** Refuse names the pinned schema tool cannot quote, before any connection or DDL. */
export function checkTableNames(tables: Readonly<Record<string, TableHandle>>): void {
  for (const handle of Object.values(tables)) {
    const table = sqliteTable(handle);
    const problem = sqliteNameProblem(getTableName(table), "table");
    if (problem) throw new FrameworkError(problem);
    for (const column of Object.values(getTableColumns(table))) {
      const problem = sqliteNameProblem(column.name, "column");
      if (problem) throw new FrameworkError(problem);
    }
  }
}

/** The single compatibility bridge for the pinned development-tool API: the one
 * place that loads `drizzle-kit`, by dynamic import, and calls it. `createSchema`
 * and `mesh db push` both plan through here. The loader is injectable here (not in
 * the public API) for missing-tool tests.
 */
export async function planSchemaPush(
  db: BunSQLiteDatabase,
  tables: Readonly<Record<string, TableHandle>>,
  caller: PushCaller,
  loader?: DrizzleKitLoader,
): Promise<SchemaPush> {
  const kit = await loadDrizzleKit(caller, loader);
  // SAFETY: Kit declares LibSQLDatabase, but its push path uses operations also provided
  // by Bun's wrapper. The create/insert/select regression test guards this bridge.
  const plan = await withStdoutMuted(() => kit.pushSQLiteSchema({ ...tables }, db));
  return {
    statements: [...plan.statementsToExecute],
    warnings: [...plan.warnings],
    losesData: plan.hasDataLoss,
    apply: () => plan.apply(),
  };
}
