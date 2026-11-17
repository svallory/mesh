import { and, eq, getTableColumns, inArray, is, sql, type Column, type DrizzleEntityClass, type SQL, type Table } from "drizzle-orm";
import { FrameworkError, MeshError, PolicyGuardDenial, ROLLUP_ANCHORS, guardDenialOf, uuidv7, type CapabilityManifest, type Condition, type DataOperations, type Filter, type Key, type Query, type RollupQuery, type RollupRow, type Row, type TableHandle, type WriteGuard } from "@meshfw/runtime";
import { columnOf, selectOptions, whereOf, type DrizzleSelect } from "./query.ts";
import { conditionSql, hopLink, type ConditionSqlOptions, type SqlDialect } from "./condition.ts";

export { columnOf, filterCondition, selectOptions, whereOf, type DrizzleSelect } from "./query.ts";
export { classOfNode, conditionSql, hopLink, orderSql, type ConditionSqlOptions, type SqlDialect } from "./condition.ts";
export { serialTransactions, type Deadline, type SerialTransactions, type TransactionDriver } from "./transactions.ts";

/** Dialect-specific query builders; shared validation and key semantics stay here.
 * Both synchronous and asynchronous Drizzle drivers can implement these calls.
 */
export interface DrizzleCommands<T extends Table> {
  /** How the dialect writes the parts of a condition that differ between databases (`conditionSql`). */
  readonly dialect: SqlDialect;
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
  /**
   * Optional: run one select statement built by the shared code and return its rows as the driver gives them (the shared
   * code decodes them). Without it, `rollup` is a `FrameworkError` naming the dialect.
   */
  rows?(statement: SQL): Row[] | Promise<Row[]>;
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

/**
 * The row an insert hands Drizzle: every column the row leaves out is given as `undefined`, which Drizzle writes as the
 * column's default, as it does for a left-out column. Drizzle reads `row[column]` for every column of the table, so a
 * column named like a member of `Object.prototype` (`toString`, `constructor`) would otherwise read as the
 * method every object inherits.
 */
function insertRow(table: Table, row: Row): Row {
  const full: Row = { ...row };
  for (const name of Object.keys(getTableColumns(table))) if (!Object.hasOwn(full, name)) full[name] = undefined;
  return full;
}

/**
 * The changes an update hands Drizzle: a column the changes leave out that is named like a member of `Object.prototype`
 * is set to itself, which changes nothing. Drizzle reads `set[column]` for every column of the table on an ordinary
 * object, where such a column would read as the inherited method; an `undefined` there is dropped before that read.
 */
function updateSet(table: Table, changes: Row): Row {
  const set: Row = { ...changes };
  for (const [name, column] of Object.entries(getTableColumns(table))) if (!Object.hasOwn(set, name) && name in set) set[name] = column;
  return set;
}

/**
 * What a rollup's value is aggregated as: `operand` is the value column (or the derived table's column that holds it), and
 * a text column goes through the dialect's `collate` for `min` and `max`.
 */
function rollupValue(fn: RollupQuery["fn"], operand: SQL, column: Column, dialect: SqlDialect): SQL {
  if (fn === "count") return sql`count(${operand})`;
  if (fn === "sum") return sql`sum(${operand})`;
  if (fn === "avg") return sql`avg(${operand})`;
  const key = dialect.collate && column.dataType === "string" ? dialect.collate(operand, "string") : operand;
  return fn === "min" ? sql`min(${key})` : sql`max(${key})`;
}

/** A guard check's value as SQL: its condition, or the constant it folded to. */
function checkSql(table: Table, check: WriteGuard["checks"][number], options: ConditionSqlOptions): SQL {
  if (check === true) return sql`true`;
  if (check === false) return sql`false`;
  if (check === null) return sql`null`;
  return conditionSql(table, check, options);
}

/**
 * The guard's part of a one-statement delete (ADR-0046, option B), for its `WHERE` beside the key condition `keyed`:
 * `case when <keyed> and not (<admits>) then <raise(marker)> else true end`. `admits` is, over the policies, every
 * `forbid` check IS FALSE and, unless `authorize` is null, one `authorize` check IS TRUE; the marker is
 * `mesh:forbidden:<nonce>:<one letter per check>:<the row's key as text>`. The key condition is repeated inside the
 * `CASE` so the raise happens only on the keyed row, whatever order the database evaluates the terms in, and the key
 * column makes the marker depend on the row, so no database folds the raise as a constant. `IS TRUE`/`IS FALSE` make an
 * unknown check fail closed.
 */
function guardSql(table: Table, keyed: SQL, guard: WriteGuard, nonce: string, options: ConditionSqlOptions, raise: (marker: SQL) => SQL): SQL {
  if (typeof guard !== "object" || guard === null || !Array.isArray(guard.checks) || !Array.isArray(guard.policies))
    throw new FrameworkError("A policy guard must be { checks, policies } with two lists");
  const key = soleKey(table);
  if (!key) throw new FrameworkError("A guarded delete needs a table with a single-column primary key");
  const checks = guard.checks.map((check) => checkSql(table, check, options));
  const at = (index: unknown): SQL => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= checks.length)
      throw new FrameworkError(`A policy guard's policy points at check ${String(index)}, and the guard has ${checks.length}`);
    return checks[index]!;
  };
  const policies = guard.policies.map((policy) => {
    if (typeof policy !== "object" || policy === null || !Array.isArray(policy.forbid) || (policy.authorize !== null && !Array.isArray(policy.authorize)))
      throw new FrameworkError("Each policy of a policy guard must be { forbid, authorize } with forbid a list and authorize a list or null");
    const parts = policy.forbid.map((index: number) => sql`((${at(index)}) is false)`);
    if (policy.authorize !== null)
      parts.push(policy.authorize.length === 0 ? sql`false` : sql`(${sql.join(policy.authorize.map((index: number) => sql`((${at(index)}) is true)`), sql` or `)})`);
    return parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;
  });
  const admits = policies.length === 0 ? sql`true` : sql.join(policies, sql` and `);
  const letters = checks.map((check) => sql`(case when (${check}) is true then 't' when (${check}) is false then 'f' else 'n' end)`);
  const marker = sql`'mesh:forbidden:' || ${options.dialect.param(nonce, "string")} || ':' || ${letters.length === 0 ? sql`''` : sql.join(letters, sql` || `)} || ':' || cast(${key.column} as text)`;
  return sql`(case when ${keyed} and not (${admits}) then ${raise(marker)} else true end)`;
}

/** Most hops a rollup's route takes, as a condition's depth is bounded. */
const ROLLUP_HOPS = 64;

/**
 * The guard revokes operations as soon as their transaction callback settles. `capabilities` is the adapter's manifest:
 * an operation that needs an optional capability it does not declare (`rollup` without `aggregates`) is refused with a
 * `FrameworkError`; left out, no optional capability is declared.
 */
export function drizzleOperations<T extends Table>(commands: DrizzleCommands<T>, guard: () => void, capabilities?: CapabilityManifest): DataOperations {
  const declared = (name: string) => (capabilities?.capabilities as readonly string[] | undefined)?.includes(name) ?? false;
  const execute = async <R>(run: () => R | Promise<R>): Promise<R> => {
    guard();
    try { return await run(); }
    catch (cause) {
      // A Mesh error is the adapter's own report (a DatabaseBusyError from a command that mapped its driver's failure),
      // so it reaches the caller unchanged, as does a policy guard's denial; anything else is a raw driver error.
      if (cause instanceof MeshError || cause instanceof PolicyGuardDenial) throw cause;
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
    // The guard runs again when the queued step starts: its transaction may have ended while it waited.
    const result = (inserts.get(table) ?? Promise.resolve()).then(() => { guard(); return run(); });
    inserts.set(table, result.then(() => undefined, () => undefined));
    return result;
  };
  const conditions: ConditionSqlOptions = { dialect: commands.dialect, resolve: (handle) => commands.table(handle) };
  const aggregate = (kind: "max" | "count", handle: TableHandle, attribute: string, filter: Filter | undefined, where: Condition | undefined) => {
    const table = commands.table(handle);
    const column = columnOf(table, attribute);
    return commands.aggregate(table, kind, column, whereOf(table, filter, where, conditions));
  };
  /** The generated key of a row that lacks one: a UUIDv7 for text, highest plus one for integers. */
  const withKey = async (table: T, row: Row): Promise<Row> => {
    const key = soleKey(table);
    if (!key || (Object.hasOwn(row, key.name) && row[key.name] !== undefined && row[key.name] !== null)) return row;
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
      return serial(table, async () => commands.insert(table, insertRow(table, await withKey(table, row))));
    }),
    select: (handle: TableHandle, query?: Query) => execute(() => {
      const table = commands.table(handle);
      return commands.select(table, selectOptions(table, query, conditions));
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
        : commands.update(table, condition, updateSet(table, changes))))[0];
    }),
    deleteByKey: (handle: TableHandle, key: Key) => execute(async () => {
      const table = commands.table(handle);
      return (await commands.delete(table, keyCondition(table, key))).length > 0;
    }),
    // A delete that checks the policies in its own statement (ADR-0046, option B): only with the capability declared and a
    // dialect that can raise, so the method is present exactly when the manifest says so.
    ...(declared("policy-guards") && commands.dialect.raise && commands.dialect.raised ? {
      deleteByKeyGuarded: (handle: TableHandle, key: Key, guard: WriteGuard) => execute(async () => {
        const { raise, raised } = commands.dialect as Required<Pick<SqlDialect, "raise" | "raised">>;
        const table = commands.table(handle);
        const keyed = keyCondition(table, key);
        // Drawn after the input is fixed, so no input value can carry it into an error message.
        const nonce = crypto.randomUUID().replaceAll("-", "");
        const statement = and(keyed, guardSql(table, keyed, guard, nonce, conditions, raise))!;
        try {
          return (await commands.delete(table, statement)).length > 0;
        } catch (error) {
          throw guardDenialOf(error, { checks: guard.checks.length, nonce, raised: (e) => raised(e) }) ?? error;
        }
      }),
    } : {}),
    max: (handle: TableHandle, attribute: string, filter?: Filter, where?: Condition) => execute(async () => {
      const value = await aggregate("max", handle, attribute, filter, where);
      return (value ?? null) as never;
    }),
    count: (handle: TableHandle, attribute: string, filter?: Filter, where?: Condition) => execute(async () => Number(await aggregate("count", handle, attribute, filter, where))),
    // One grouped statement: `select anchor, fn(value) from table where anchor in (...) group by anchor`. An anchor that
    // reaches no row has no group, so it is left out; the driver's values are decoded here, as the columns decode.
    rollup: (query: RollupQuery) => execute(async (): Promise<RollupRow[]> => {
      if (!declared("aggregates")) throw new FrameworkError(`rollup needs the aggregates capability, and the ${capabilities?.adapter ?? "Drizzle"} data layer does not declare it`);
      if (!commands.rows) throw new FrameworkError(`rollup is not available: the ${capabilities?.adapter ?? "Drizzle"} dialect has no rows command to run its grouped statement`);
      if (!(["count", "sum", "avg", "min", "max"] as readonly string[]).includes(query.fn)) throw new FrameworkError(`Unknown rollup function "${String(query.fn)}"; use count, sum, avg, min or max`);
      if (!Array.isArray(query.anchors)) throw new FrameworkError("A rollup's anchors must be a list");
      if (query.anchors.length > ROLLUP_ANCHORS) throw new FrameworkError(`A rollup takes at most ${ROLLUP_ANCHORS} anchors, and this one has ${query.anchors.length}: ask in chunks`);
      // A row condition (a read policy folded into a caller's load) on the start or on a hop runs only where conditions do.
      const narrowed = query.where !== undefined || (Array.isArray(query.hops) && query.hops.some((step) => step?.where !== undefined || step?.linkWhere !== undefined));
      if (narrowed && !declared("conditions")) throw new FrameworkError(`A rollup with a where runs a condition as SQL, and the ${capabilities?.adapter ?? "Drizzle"} data layer does not declare the conditions capability`);
      const where = (root: Table, condition: Condition | undefined) => (condition === undefined ? sql`` : sql` and (${conditionSql(root, condition, conditions)})`);
      const table = commands.table(query.table);
      const anchor = columnOf(table, query.anchor);
      let value: Column;
      let statement: SQL;
      if (query.hops === undefined) {
        value = columnOf(table, query.value);
        if (query.anchors.length === 0) return [];
        statement = sql`select ${anchor} as "anchor", ${rollupValue(query.fn, sql`${value}`, value, commands.dialect)} as "value" from ${table} where ${inArray(anchor, query.anchors as never[])}${where(table, query.where)} group by ${anchor}`;
      } else {
        // A joined route: the owner table is `h0`, each hop's table `h1`, `h2`, ... (a link table `hl1`, ...), joined by
        // the hop printer of conditions, each hop's `where` in its `on` and its `linkWhere` in the link's subquery (their
        // own subqueries alias `t1`, `l1`, ..., which no route alias takes). The distinct derived table keeps each last row once per anchor (R12), however
        // many paths reach it; an inner join drops a hop that matches nothing.
        if (!declared("joins")) throw new FrameworkError(`A rollup with hops crosses relationships, which runs as a join, and the ${capabilities?.adapter ?? "Drizzle"} data layer does not declare the joins capability`);
        if (!Array.isArray(query.hops) || query.hops.length === 0) throw new FrameworkError("A rollup's hops must be a non-empty list of { hop }; a rollup over one table has none");
        if (query.hops.length > ROLLUP_HOPS) throw new FrameworkError(`A rollup crosses at most ${ROLLUP_HOPS} relationships, and this one crosses ${query.hops.length}`);
        if (typeof query.key !== "string") throw new FrameworkError("A rollup with hops needs key, the primary key of the last hop's table");
        const aliases: Table[] = [commands.dialect.alias(table, "h0")];
        const joins: SQL[] = [];
        let last: Table = table;
        query.hops.forEach((step, index) => {
          const hop = typeof step === "object" && step !== null ? step.hop : undefined;
          if (typeof hop !== "object" || hop === null) throw new FrameworkError("Each of a rollup's hops must be { hop: { table, column, outer, key } }");
          const n = index + 1;
          last = commands.table(hop.table);
          const far = commands.dialect.alias(last, `h${n}`);
          joins.push(sql` inner join ${last} as ${sql.identifier(`h${n}`)} on ${hopLink(hop, aliases[index]!, far, `hl${n}`, conditions, step.linkWhere)}${where(far, step.where)}`);
          aliases.push(far);
        });
        const reached = aliases[aliases.length - 1]!;
        const from = columnOf(aliases[0]!, query.anchor);
        const key = columnOf(reached, query.key);
        value = columnOf(last, query.value);
        const v = columnOf(reached, query.value);
        if (query.anchors.length === 0) return [];
        statement = sql`select "anchor", ${rollupValue(query.fn, sql`"v"`, value, commands.dialect)} as "value" from (select distinct ${from} as "anchor", ${key} as "k", ${v} as "v" from ${table} as ${sql.identifier("h0")}${sql.join(joins)} where ${inArray(from, query.anchors as never[])}${where(aliases[0]!, query.where)}) as "reached" group by "anchor"`;
      }
      const numeric = query.fn === "count" || query.fn === "sum" || query.fn === "avg";
      return (await commands.rows(statement)).map((row) => ({
        anchor: anchor.mapFromDriverValue(row.anchor) as RollupRow["anchor"],
        value: row.value === null || row.value === undefined ? (query.fn === "count" ? 0 : null) : numeric ? Number(row.value) : value.mapFromDriverValue(row.value) as RollupRow["value"],
      }));
    }),
  };
}
