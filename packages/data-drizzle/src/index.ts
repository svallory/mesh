import { and, eq, getTableColumns, type SQL, type Table } from "drizzle-orm";
import { FrameworkError, type DataOperations, type Key, type Row, type TableHandle } from "@mesh/runtime";

/** Dialect-specific query builders; shared validation and key semantics stay here.
 * Both synchronous and asynchronous Drizzle drivers can implement these calls.
 */
export interface DrizzleCommands<T extends Table> {
  table(handle: TableHandle): T;
  insert(table: T, row: Row): Row | Promise<Row>;
  select(table: T, condition?: SQL): Row[] | Promise<Row[]>;
  update(table: T, condition: SQL, changes: Row): Row[] | Promise<Row[]>;
  delete(table: T, condition: SQL): Row[] | Promise<Row[]>;
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
  return {
    insert: (handle: TableHandle, row: Row) => execute(() => {
      const table = commands.table(handle);
      checkNames(table, row);
      return commands.insert(table, row);
    }),
    selectAll: (handle: TableHandle) => execute(() => commands.select(commands.table(handle))),
    selectByKey: (handle: TableHandle, key: Key) => execute(async () => {
      const table = commands.table(handle);
      return (await commands.select(table, keyCondition(table, key)))[0];
    }),
    updateByKey: (handle: TableHandle, key: Key, changes: Row) => execute(async () => {
      const table = commands.table(handle);
      const condition = keyCondition(table, key);
      checkNames(table, changes);
      return (await (Object.keys(changes).length === 0
        ? commands.select(table, condition)
        : commands.update(table, condition, changes)))[0];
    }),
    deleteByKey: (handle: TableHandle, key: Key) => execute(async () => {
      const table = commands.table(handle);
      return (await commands.delete(table, keyCondition(table, key))).length > 0;
    }),
  };
}
