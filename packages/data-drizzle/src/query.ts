import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type Column, type SQL, type Table } from "drizzle-orm";
import { FrameworkError, type Comparison, type Filter, type Query, type Scalar } from "@meshfw/runtime";

/** A read translated for Drizzle: conditions and order as SQL, paging as numbers. */
export interface DrizzleSelect {
  readonly where?: SQL;
  readonly orderBy: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

const OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nil"] as const;
const ALWAYS = sql`1 = 1`;
const NEVER = sql`1 = 0`;

/** The column an attribute name stands for; an unknown name is an error, never a no-op. */
export function columnOf(table: Table, name: string): Column {
  const columns = getTableColumns(table);
  if (!Object.hasOwn(columns, name)) throw new FrameworkError(`Unknown column "${name}"; use an attribute in the emitted table`);
  return columns[name]!;
}

function scalar(value: unknown, where: string): Exclude<Scalar, null> | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new FrameworkError(`${where} must be a string, finite number, boolean, valid Date or null, not ${value === undefined ? "undefined" : String(value)}`);
}

function comparison(column: Column, name: string, spec: unknown): SQL {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec) || spec instanceof Date) {
    throw new FrameworkError(`Filter on "${name}" must be an object such as { eq: value }, not a bare value`);
  }
  const given = Object.keys(spec);
  if (given.length === 0) throw new FrameworkError(`Filter on "${name}" has no operator; use one of ${OPERATORS.join(", ")}`);
  const parts: SQL[] = [];
  const op = spec as Record<string, unknown>;
  for (const key of given) {
    if (!(OPERATORS as readonly string[]).includes(key)) {
      throw new FrameworkError(`Unknown filter operator "${key}" on "${name}"; use one of ${OPERATORS.join(", ")}`);
    }
    const value = op[key];
    const at = `Filter ${name}.${key}`;
    if (key === "nil") {
      if (typeof value !== "boolean") throw new FrameworkError(`${at} must be true or false`);
      parts.push(value ? isNull(column) : isNotNull(column));
    } else if (key === "in") {
      if (!Array.isArray(value)) throw new FrameworkError(`${at} must be a list`);
      const items = value.map((item) => scalar(item, `${at} item`));
      if (items.includes(null)) throw new FrameworkError(`${at} must not contain null; combine it with nil: true under or`);
      parts.push(items.length === 0 ? NEVER : inArray(column, items as Exclude<Scalar, null>[]));
    } else {
      const operand = scalar(value, at);
      if (operand === null) {
        if (key === "eq") parts.push(isNull(column));
        else if (key === "ne") parts.push(isNotNull(column));
        else throw new FrameworkError(`${at} cannot compare with null; use nil`);
      } else {
        const build = { eq, ne, lt, lte, gt, gte }[key as "eq"];
        parts.push(build(column, operand));
      }
    }
  }
  return parts.length === 1 ? parts[0]! : and(...parts)!;
}

function filterSql(table: Table, filter: unknown, depth: number): SQL {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    throw new FrameworkError("A filter must be an object such as { title: { eq: 'x' } }");
  }
  if (depth > 64) throw new FrameworkError("Filter is nested more than 64 levels deep");
  const parts: SQL[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "and" || key === "or") {
      if (!Array.isArray(value)) throw new FrameworkError(`Filter "${key}" must be a list of filters`);
      const inner = value.map((item) => filterSql(table, item, depth + 1));
      parts.push(inner.length === 0 ? (key === "and" ? ALWAYS : NEVER) : (key === "and" ? and : or)(...inner)!);
    } else {
      parts.push(comparison(columnOf(table, key), key, value));
    }
  }
  return parts.length === 0 ? ALWAYS : parts.length === 1 ? parts[0]! : and(...parts)!;
}

/** Translate a plain-data filter. `undefined` and `{}` mean no condition (undefined result). */
export function filterCondition(table: Table, filter: Filter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  const condition = filterSql(table, filter, 0);
  return condition === ALWAYS ? undefined : condition;
}

function wholeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FrameworkError(`${name} must be a non-negative integer, not ${String(value)}`);
  }
  return value;
}

/** Translate a query: filter, sort (primary key last, so ties are stable) and paging. */
export function selectOptions(table: Table, query: Query | undefined): DrizzleSelect {
  if (query !== undefined && (typeof query !== "object" || query === null)) throw new FrameworkError("A query must be an object { filter, sort, limit, offset }");
  const columns = getTableColumns(table);
  const orderBy: SQL[] = [];
  const sorted = new Set<Column>();
  const sort = query?.sort;
  if (sort !== undefined && (!Array.isArray(sort) || sort.some((field) => typeof field !== "string"))) {
    throw new FrameworkError('sort must be a list of attribute names, "-name" for descending');
  }
  for (const field of sort ?? []) {
    const descending = field.startsWith("-");
    const name = descending ? field.slice(1) : field;
    if (name === "") throw new FrameworkError('A sort field needs a name: "title" or "-title"');
    const column = columnOf(table, name);
    sorted.add(column);
    orderBy.push(descending ? desc(column) : asc(column));
  }
  for (const column of Object.values(columns)) {
    if (column.primary && !sorted.has(column)) orderBy.push(asc(column));
  }
  return {
    where: filterCondition(table, query?.filter),
    orderBy,
    limit: wholeNumber(query?.limit, "limit"),
    offset: wholeNumber(query?.offset, "offset"),
  };
}
