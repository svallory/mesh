import { and, eq, getTableColumns, is, type Column, type DrizzleEntityClass, type SQL, type Table } from "drizzle-orm";
import { FrameworkError, uuidv7, type DataOperations, type Filter, type Key, type Query, type Row, type TableHandle } from "@meshfw/runtime";
import { columnOf, filterCondition, selectOptions, type DrizzleSelect } from "./query.ts";

export { columnOf, filterCondition, selectOptions, type DrizzleSelect } from "./query.ts";

/** Dialect-specific query builders; shared validation and key semantics stay here.
 * Both synchronous and asynchronous Drizzle drivers can implement these calls.
 */
export interface DrizzleCommands<T extends Table> {
  table(handle: TableHandle): T;
  insert(table: T, row: Row): Row | Promise<Row>;
  select(table: T, options?: DrizzleSelect): Row[] | Promise<Row[]>;
  /**
   * Optional: the same read, locking the matching rows (`SELECT ... FOR UPDATE`). A dialect
   * whose transactions do not already hold an exclusive write lock must provide it; without
   * it, `selectByKeyForUpdate` is a plain read. SQLite leaves it out: `BEGIN IMMEDIATE`
   * holds the single write lock for the whole transaction.
   */
  selectForUpdate?(table: T, options: DrizzleSelect): Row[] | Promise<Row[]>;
  /** `max(column)` or `count(column)` over rows matching `where`, decoded as the column decodes. */
  aggregate(table: T, kind: "max" | "count", column: Column, where?: SQL): unknown | Promise<unknown>;
  update(table: T, condition: SQL, changes: Row): Row[] | Promise<Row[]>;
  delete(table: T, condition: SQL): Row[] | Promise<Row[]>;
}

/** Narrow an opaque handle to the dialect's Drizzle table class, or fail: a handle
 * that did not come from the emitted schema is a programming error, never a silent no-op.
 */
export function drizzleTable<T extends Table>(handle: TableHandle, kind: DrizzleEntityClass<T>, dialect: string): T {
  if (!is(handle, kind)) throw new FrameworkError(`Expected a Drizzle ${dialect} table from the emitted schema`);
  return handle as T;
}

function checkNames(table: Table, row: Key): void {
  const columns = getTableColumns(table);
  for (const name of Object.keys(row)) {
    if (!Object.hasOwn(columns, name)) throw new FrameworkError(`Unknown column "${name}"; use an attribute in the emitted table`);
  }
}

export function keyCondition(table: Table, key: Key): SQL {
  const names = Object.keys(key);
  if (names.length === 0) throw new FrameworkError("A row key must contain at least one column");
  checkNames(table, key);
  const columns = getTableColumns(table);
  const condition = and(...names.map((name) => {
    const column = columns[name];
    if (!column) throw new FrameworkError(`Unknown column "${name}"`);
    return eq(column, key[name]);
  }));
  if (!condition) throw new FrameworkError("A row key must contain at least one column");
  return condition;
}

/** The single-column primary key of a table, or undefined for a composite or absent key. */
function soleKey(table: Table): { name: string; column: Column } | undefined {
  const keys = Object.entries(getTableColumns(table)).filter(([, column]) => column.primary);
  return keys.length === 1 ? { name: keys[0]![0], column: keys[0]![1] } : undefined;
}

/** The guard revokes operations as soon as their transaction callback settles. */
export function drizzleOperations<T extends Table>(commands: DrizzleCommands<T>, guard: () => void): DataOperations {
  const execute = async <R>(run: () => R | Promise<R>): Promise<R> => {
    guard();
    try { return await run(); }
    catch (cause) {
      if (cause instanceof FrameworkError) throw cause;
      // M2: typed constraint errors arrive with the M3 contract.
      throw new FrameworkError("Database operation failed", { cause });
    }
  };
  const byKey = async (handle: TableHandle, key: Key, lock: boolean) => {
    const table = commands.table(handle);
    const options = { where: keyCondition(table, key), orderBy: [] };
    return (await (lock && commands.selectForUpdate ? commands.selectForUpdate(table, options) : commands.select(table, options)))[0];
  };
  // Inserts into one table run one at a time, so two parallel inserts never read the same
  // highest key. The queue lives as long as these operations, that is, one transaction.
  const inserts = new Map<Table, Promise<unknown>>();
  const serial = <R>(table: Table, run: () => Promise<R>): Promise<R> => {
    const result = (inserts.get(table) ?? Promise.resolve()).then(run);
    inserts.set(table, result.then(() => undefined, () => undefined));
    return result;
  };
  const aggregate = (kind: "max" | "count", handle: TableHandle, attribute: string, filter: Filter | undefined) => {
    const table = commands.table(handle);
    const column = columnOf(table, attribute);
    return commands.aggregate(table, kind, column, filterCondition(table, filter));
  };
  /** The generated key of a row that lacks one: a UUIDv7 for text, highest plus one for integers. */
  const withKey = async (table: T, row: Row): Promise<Row> => {
    const key = soleKey(table);
    if (!key || (row[key.name] !== undefined && row[key.name] !== null)) return row;
    if (key.column.dataType === "string") return { ...row, [key.name]: uuidv7() };
    if (key.column.dataType === "number") {
      const highest = await commands.aggregate(table, "max", key.column);
      return { ...row, [key.name]: (typeof highest === "number" ? highest : 0) + 1 };
    }
    return row;
  };
  return {
    insert: (handle: TableHandle, row: Row) => execute(async () => {
      const table = commands.table(handle);
      checkNames(table, row);
      return serial(table, async () => commands.insert(table, await withKey(table, row)));
    }),
    select: (handle: TableHandle, query?: Query) => execute(() => {
      const table = commands.table(handle);
      return commands.select(table, selectOptions(table, query));
    }),
    selectAll: (handle: TableHandle) => execute(() => {
      const table = commands.table(handle);
      return commands.select(table, selectOptions(table, undefined));
    }),
    selectByKey: (handle: TableHandle, key: Key) => execute(() => byKey(handle, key, false)),
    // Locks through the dialect's `selectForUpdate` when it has one; SQLite does not need it.
    selectByKeyForUpdate: (handle: TableHandle, key: Key) => execute(() => byKey(handle, key, true)),
    updateByKey: (handle: TableHandle, key: Key, changes: Row) => execute(async () => {
      const table = commands.table(handle);
      const condition = keyCondition(table, key);
      checkNames(table, changes);
      return (await (Object.keys(changes).length === 0
        ? commands.select(table, { where: condition, orderBy: [] })
        : commands.update(table, condition, changes)))[0];
    }),
    deleteByKey: (handle: TableHandle, key: Key) => execute(async () => {
      const table = commands.table(handle);
      return (await commands.delete(table, keyCondition(table, key))).length > 0;
    }),
    max: (handle: TableHandle, attribute: string, filter?: Filter) => execute(async () => {
      const value = await aggregate("max", handle, attribute, filter);
      return (value ?? null) as never;
    }),
    count: (handle: TableHandle, attribute: string, filter?: Filter) => execute(async () => Number(await aggregate("count", handle, attribute, filter))),
  };
}
