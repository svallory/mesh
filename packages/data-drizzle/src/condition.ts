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
  /** `length` of a string in code points. SQLite `length(x)`; Postgres `char_length((x)::text)`, so a number reads as its text, as SQLite's length does. */
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
  /**
   * Optional: a boolean SQL expression that fails the statement with `marker` (a text expression) in the driver's error,
   * for a policy guard (ADR-0046, option B). SQLite `(json_extract('{}', marker) is null)`, whose bad JSON path error
   * carries the path. With `raised`, `drizzleOperations` gives `deleteByKeyGuarded` (when `policy-guards` is declared).
   */
  raise?(marker: SQL): SQL;
  /** With `raise`: the driver's message when `error` is the error `raise` produces, else undefined. */
  raised?(error: unknown): string | undefined;
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
/** Most relationships a rollup in a condition crosses, as a rollup's route in the data layer does. */
const MAX_ROUTE = 64;

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
    case "rollup": return node.class;
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

/**
 * The condition that relates the rows of `far` (an alias of the hop's table) to the row of `outer` (the table, or alias,
 * the hop starts from): `far.column = outer.outer`, or, through a link entity,
 * `far.column in (select exit from link as <linkAlias> where entry = outer.outer and exit is not null)`, so a far row
 * counts once however many link rows lead to it and a link row with no exit leads nowhere (D14). A condition's hop
 * subqueries and a rollup's joined route both print their hops with it; `linkWhere`, a rollup's only, narrows the link
 * rows a through hop follows.
 */
export function hopLink(hop: Hop, outer: Table, far: Table, linkAlias: string, options: Pick<ConditionSqlOptions, "dialect" | "resolve">, linkWhere?: Condition): SQL {
  const from = sql`${columnOf(outer, hop.outer)}`;
  const column = sql`${columnOf(far, hop.column)}`;
  if (!hop.through) return sql`${column} = ${from}`;
  if (typeof hop.through !== "object") throw new FrameworkError("A hop's through must be an object { table, entry, exit }");
  const linkOriginal = options.resolve(hop.through.table);
  const link = options.dialect.alias(linkOriginal, linkAlias);
  const exit = sql`${columnOf(link, hop.through.exit)}`;
  // A rollup's route may narrow the link rows it follows (`RollupHop.linkWhere`), printed against the link's alias.
  const admitted = linkWhere === undefined ? sql`` : sql` and (${conditionSql(link, linkWhere, options)})`;
  return sql`${column} in (select ${exit} from ${linkOriginal} as ${sql.identifier(linkAlias)} where ${columnOf(link, hop.through.entry)} = ${from} and ${exit} is not null${admitted})`;
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
    const link = hopLink(hop, tables[depth]!, far, `${linkPrefix}${n}`, options);
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
      case "rollup": return rollup(node, depth);
      default: throw new FrameworkError(`Unknown condition node kind ${JSON.stringify((node as { kind?: unknown }).kind)}`);
    }
  };

  /**
   * `(select fn(r.value) from last as r where <r reached from the row at node.depth> [and (filter) is true])`. One hop is
   * its link; more are `r.key in (select key from <the hops joined from that row>)`, so a row of the last table counts
   * once however many paths reach it (no derived table, which would need a correlated FROM). The last table is the alias
   * of the next depth (`t<n>`), the route's other tables `t<n>r1`, `t<n>r2`, ..., and the filter is a condition of its
   * own over the last table (its own hops would alias `t<n>w1`, ...).
   */
  const rollup = (node: Extract<Condition, { kind: "rollup" }>, depth: number): SQL => {
    if (!Number.isInteger(node.depth) || node.depth < 0 || node.depth > depth) {
      throw new FrameworkError(`A condition's rollup starts at depth ${String(node.depth)}, where only depths 0 to ${depth} are open`);
    }
    if (!Array.isArray(node.hops) || node.hops.length === 0) throw new FrameworkError("A condition's rollup needs a non-empty list of hops");
    if (node.hops.length > MAX_ROUTE) throw new FrameworkError(`A condition's rollup crosses at most ${MAX_ROUTE} relationships, and this one crosses ${node.hops.length}`);
    for (const hop of node.hops) if (typeof hop !== "object" || hop === null) throw new FrameworkError("A rollup's hop must be an object { table, column, outer, key }");
    const n = depth + 1;
    const name = `${prefix}${n}`;
    const last = node.hops[node.hops.length - 1]!;
    const lastOriginal = options.resolve(last.table);
    const reached = options.dialect.alias(lastOriginal, name);
    const outer = tables[node.depth]!;
    let reach: SQL;
    if (node.hops.length === 1) reach = hopLink(last, outer, reached, `${linkPrefix}${n}`, options);
    else {
      let from: Table = outer;
      let start: SQL | undefined;
      const joins: SQL[] = [];
      node.hops.forEach((hop, i) => {
        const route = `${prefix}${n}r${i + 1}`;
        const original = options.resolve(hop.table);
        const far = options.dialect.alias(original, route);
        const link = hopLink(hop, from, far, `${linkPrefix}${n}r${i + 1}`, options);
        if (i === 0) { start = link; joins.push(sql`${original} as ${sql.identifier(route)}`); }
        else joins.push(sql` inner join ${original} as ${sql.identifier(route)} on ${link}`);
        from = far;
      });
      reach = sql`${columnOf(reached, last.key)} in (select ${columnOf(from, last.key)} from ${sql.join(joins)} where ${start!})`;
    }
    const column = columnOf(reached, node.value);
    const operand = sql`${column}`;
    const value = node.fn === "count" ? sql`count(${operand})`
      : node.fn === "sum" ? sql`sum(${operand})`
        : node.fn === "avg" ? sql`avg(${operand})`
          : node.fn === "min" || node.fn === "max"
            ? sql`${sql.raw(node.fn)}(${options.dialect.collate && column.dataType === "string" ? options.dialect.collate(operand, "string") : operand})`
            : undefined;
    if (value === undefined) throw new FrameworkError(`A condition's rollup has the unknown function ${JSON.stringify(node.fn)}; use count, sum, avg, min or max`);
    const filter = node.where === undefined ? sql`` : sql` and (${conditionSql(reached, node.where, { ...options, aliasPrefix: `${prefix}${n}w` })}) is true`;
    return sql`(select ${value} from ${lastOriginal} as ${sql.identifier(name)} where ${reach}${filter})`;
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

