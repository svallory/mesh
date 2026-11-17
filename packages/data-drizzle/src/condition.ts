import { sql, type SQL, type Table } from "drizzle-orm";
import { FrameworkError, SQL_FUNCTION_ARITY, type Condition, type Hop, type OrderKey, type Scalar, type TableHandle, type ValueClass } from "@meshfw/runtime";
import { columnOf } from "./query.ts";

/** What a dialect writes its own way; everything else in a condition is shared SQL. */
export interface SqlDialect {
  /**
   * A bound value, typed. Every `value` node is printed through it, `null` included. SQLite: a plain binding, with
   * boolean as 1/0 and a date as epoch milliseconds (its `timestamp_ms` columns). A server dialect casts each
   * parameter to its class, so one with no column beside it (`CASE WHEN c THEN $1 ELSE $2 END`) is never inferred as text.
   */
  param(value: Scalar, kind: ValueClass): SQL;
  /** Drizzle's `alias(table, name)` of the dialect's core (`sqlite-core`, `pg-core`): each depth's table. */
  alias(table: Table, name: string): Table;
  /** `length` of a string in code points. SQLite `length(x)`; Postgres `char_length(x)`. */
  length(operand: SQL): SQL;
  /** Exact division (`div`), null for a zero divisor. SQLite `(CAST(a AS REAL) / NULLIF(b, 0))`. */
  divide(a: SQL, b: SQL): SQL;
  /** What follows `ASC`/`DESC` so nulls sort as the smallest value; SQLite needs nothing. */
  nulls(desc: boolean): SQL | undefined;
  /**
   * A string sort key, or the left side of a range comparison (`lt`, `lte`, `gt`, `gte`), wrapped so strings order and
   * compare by code point; a key of another class is returned as it is. SQLite's BINARY already does, so it has none.
   */
  collate?(key: SQL, kind: ValueClass): SQL;
}

export interface ConditionSqlOptions {
  readonly dialect: SqlDialect;
  /** Turns handles into the dialect's tables. */
  readonly resolve: (handle: TableHandle) => Table;
  /**
   * Prefix of the aliases of depths 1 and deeper (`t` by default: `t1`, `t2`, ...; a link table of a through hop is
   * `l1`, or `<prefix>l1` with another prefix), so a caller that already aliases tables avoids collisions.
   */
  readonly aliasPrefix?: string;
}

const COMPARISONS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=", add: "+", sub: "-", mul: "*" } as const;
const BOOLEAN_FNS = new Set(["eq", "ne", "isNull", "isNotNull", "lt", "lte", "gt", "gte", "and", "or", "not", "isTrue", "isFalse"]);
const MAX_DEPTH = 256;

/** The class a node's value has, for a dialect's `collate`; undefined where nothing says. */
export function classOfNode(node: Condition): ValueClass | undefined {
  switch (node.kind) {
    case "column":
    case "value": return node.class;
    case "some":
    case "every": return "boolean";
    case "count": return "integer";
    case "one":
    case "first": return classOfNode(node.value);
    case "call": {
      if (BOOLEAN_FNS.has(node.fn)) return "boolean";
      if (node.fn === "div") return "float";
      if (node.fn === "idiv" || node.fn === "length") return "integer";
      if (node.fn === "cond") return classOfNode(node.args[1]!) ?? classOfNode(node.args[2]!);
      const classes = node.args.map(classOfNode);
      if (node.fn === "coalesce") return classes.find((c) => c !== undefined);
      return classes.includes("float") ? "float" : classes[0];
    }
  }
}

/** A printer over one root: a stack of each depth's table, depth 0 the root. */
function printer(root: Table, options: ConditionSqlOptions) {
  const prefix = options.aliasPrefix ?? "t";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new FrameworkError(`aliasPrefix must be an identifier, not ${JSON.stringify(prefix)}`);
  const linkPrefix = prefix === "t" ? "l" : `${prefix}l`;
  const tables: Table[] = [root];

  const enter = (hop: Hop, depth: number, body: (from: SQL, link: SQL, key: SQL) => SQL): SQL => {
    if (typeof hop !== "object" || hop === null) throw new FrameworkError("A condition's hop must be an object { table, column, outer, key }");
    const n = depth + 1;
    const original = options.resolve(hop.table);
    const far = options.dialect.alias(original, `${prefix}${n}`);
    const outer = sql`${columnOf(tables[depth]!, hop.outer)}`;
    const column = sql`${columnOf(far, hop.column)}`;
    let link: SQL;
    if (hop.through) {
      const linkOriginal = options.resolve(hop.through.table);
      const linkAlias = options.dialect.alias(linkOriginal, `${linkPrefix}${n}`);
      const exit = sql`${columnOf(linkAlias, hop.through.exit)}`;
      link = sql`${column} in (select ${exit} from ${linkOriginal} as ${sql.identifier(`${linkPrefix}${n}`)} where ${columnOf(linkAlias, hop.through.entry)} = ${outer} and ${exit} is not null)`;
    } else link = sql`${column} = ${outer}`;
    const key = sql`${columnOf(far, hop.key)}`;
    tables.push(far);
    try {
      return body(sql`${original} as ${sql.identifier(`${prefix}${n}`)}`, link, key);
    } finally { tables.pop(); }
  };

  const print = (node: Condition, depth: number): SQL => {
    if (depth >= MAX_DEPTH) throw new FrameworkError(`A condition crosses more than ${MAX_DEPTH} relationships`);
    if (typeof node !== "object" || node === null) throw new FrameworkError("A condition node must be an object");
    switch (node.kind) {
      case "column": {
        if (!Number.isInteger(node.depth) || node.depth < 0 || node.depth > depth) {
          throw new FrameworkError(`A condition reads column "${node.name}" at depth ${String(node.depth)}, where only depths 0 to ${depth} are open`);
        }
        return sql`${columnOf(tables[node.depth]!, node.name)}`;
      }
      case "value": return options.dialect.param(node.value, node.class);
      case "call": return call(node, depth);
      case "one": return enter(node.hop, depth, (from, link, key) => sql`(select ${print(node.value, depth + 1)} from ${from} where ${link} order by ${key} limit 1)`);
      case "some": return enter(node.hop, depth, (from, link) => sql`(exists (select 1 from ${from} where ${link} and (${print(node.where, depth + 1)}) is true))`);
      case "every": return enter(node.hop, depth, (from, link) => sql`(not exists (select 1 from ${from} where ${link} and (${print(node.where, depth + 1)}) is not true))`);
      case "count": return enter(node.hop, depth, (from, link) => node.where === undefined
        ? sql`(select count(*) from ${from} where ${link})`
        : sql`(select count(*) from ${from} where ${link} and (${print(node.where, depth + 1)}) is true)`);
      case "first": return enter(node.hop, depth, (from, link, key) =>
        sql`(select ${print(node.value, depth + 1)} from ${from} where ${link} and (${print(node.where, depth + 1)}) is true order by ${key} limit 1)`);
      default: throw new FrameworkError(`Unknown condition node kind ${JSON.stringify((node as { kind?: unknown }).kind)}`);
    }
  };

  const call = (node: Extract<Condition, { kind: "call" }>, depth: number): SQL => {
    const arity = Object.hasOwn(SQL_FUNCTION_ARITY, node.fn) ? SQL_FUNCTION_ARITY[node.fn] : undefined;
    if (arity === undefined) throw new FrameworkError(`A condition calls ${JSON.stringify(node.fn)}, which is no SQL function`);
    const many = node.fn === "and" || node.fn === "or";
    if (!Array.isArray(node.args) || (many ? node.args.length < 2 : node.args.length !== arity)) {
      throw new FrameworkError(`A condition calls ${node.fn} with ${Array.isArray(node.args) ? node.args.length : "no"} arguments`);
    }
    const a = node.args.map((arg) => print(arg, depth));
    switch (node.fn) {
      case "lt": case "lte": case "gt": case "gte": {
        // Strings compare by code point on every database: the left side goes through the dialect's `collate`, as a
        // sort key does (an explicit collation on one operand decides the comparison). Equality needs none.
        const kind = classOfNode(node.args[0]!) ?? classOfNode(node.args[1]!);
        const left = options.dialect.collate && kind !== undefined ? options.dialect.collate(a[0]!, kind) : a[0];
        return sql`(${left} ${sql.raw(COMPARISONS[node.fn])} ${a[1]})`;
      }
      case "eq": case "ne": case "add": case "sub": case "mul":
        return sql`(${a[0]} ${sql.raw(COMPARISONS[node.fn])} ${a[1]})`;
      case "isNull": return sql`(${a[0]} is null)`;
      case "isNotNull": return sql`(${a[0]} is not null)`;
      case "and": return sql`(${sql.join(a, sql` and `)})`;
      case "or": return sql`(${sql.join(a, sql` or `)})`;
      case "not": return sql`(not ${a[0]})`;
      case "isTrue": return sql`((${a[0]}) is true)`;
      case "isFalse": return sql`((${a[0]}) is false)`;
      case "neg": return sql`(- ${a[0]})`;
      case "idiv": return sql`(${a[0]} / nullif(${a[1]}, 0))`;
      case "div": return options.dialect.divide(a[0]!, a[1]!);
      case "length": return options.dialect.length(a[0]!);
      case "coalesce": return sql`coalesce(${a[0]}, ${a[1]})`;
      case "cond": return sql`(case when (${a[0]}) is true then ${a[1]} else ${a[2]} end)`;
    }
  };

  return { print: (node: Condition) => print(node, 0) };
}

/**
 * A bound condition as Drizzle SQL. `root` is depth 0: the table itself, or an alias of it; columns of depth 0 are read
 * through whatever name `root` carries. Each hop is a correlated subquery over an alias of its table per depth
 * (`t1`, `t2`, ...), so a relationship back to the same table reads the right row. Columns go through `columnOf`, so
 * a column's database name may differ from its attribute name.
 */
export function conditionSql(root: Table, condition: Condition, options: ConditionSqlOptions): SQL {
  return printer(root, options).print(condition);
}

/** An order as Drizzle SQL keys, first key first: `<key> asc|desc [nulls]`, nulls sorting as the smallest value. */
export function orderSql(root: Table, order: readonly OrderKey[], options: ConditionSqlOptions): SQL[] {
  if (!Array.isArray(order)) throw new FrameworkError("order must be a list of { by, desc }");
  const print = printer(root, options).print;
  return order.map((key) => {
    if (typeof key !== "object" || key === null || typeof key.desc !== "boolean") throw new FrameworkError("An order key must be { by, desc } with desc a boolean");
    let by = print(key.by);
    const kind = classOfNode(key.by);
    if (options.dialect.collate && kind !== undefined) by = options.dialect.collate(by, kind);
    const nulls = options.dialect.nulls(key.desc);
    const direction = key.desc ? sql`desc` : sql`asc`;
    return nulls ? sql`${by} ${direction} ${nulls}` : sql`${by} ${direction}`;
  });
}

