import type { DataOperations, Filter, Row, TableHandle } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { scope, type Clock } from "./expr.ts";

/**
 * Loading relationships and computed fields (M7). The compiler writes one `LoadPlan` for the
 * project (`<output>/load.ts`): plain data about each entity's table, key, relationships and
 * computed fields, plus the compiled body of each computed field. `loadRows` follows the plan
 * with the data layer's own operations, so the calls it makes are the ones a hand-written
 * loader would make, and nothing here knows a database.
 *
 * - A relationship is loaded by a second query for the whole list of rows: `belongs-to` selects
 *   the targets by key, `has-many` and `has-one` select the rows whose key column holds one of
 *   the keys. Each query names up to `CHUNK` keys, so a long list is a few queries, not one per row.
 * - A computed field with a body first loads what its body reads (its `needs`), then runs the body in
 *   memory once per row, with the scope the expression functions take.
 * - A `count` or `max` rollup calls the data layer's `count` and `max` once per row. That is one query
 *   per row until M10 translates rollups into one statement.
 */
export interface BelongsToPlan {
  kind: "belongs-to";
  target: string;
  /** The column on this entity that holds the target's key. */
  column: string;
  nullable: boolean;
}
export interface HasPlan {
  kind: "has-many" | "has-one";
  target: string;
  /** The column on the target that holds this entity's key; null when the target has no belongs-to back (loading it is an error). */
  column: string | null;
}
export type RelationPlan = BelongsToPlan | HasPlan;
export type ComputedPlan =
  | {
      kind: "body";
      /** Dotted paths of relationships and computed fields to load before the body runs. */
      needs: readonly string[];
      /** The compiled body: a function of the expression scope. */
      evaluate: (scope: never) => unknown;
    }
  | {
      kind: "rollup";
      fn: "count" | "sum" | "avg" | "min" | "max";
      /** The authored path split at the dots: a relationship, then optionally an attribute. */
      of: readonly string[];
    };
export interface EntityPlan {
  table: TableHandle;
  /** The primary key's attribute name. */
  key: string;
  relations: Readonly<Record<string, RelationPlan>>;
  computed: Readonly<Record<string, ComputedPlan>>;
}
export type LoadPlan = Readonly<Record<string, EntityPlan>>;

export interface LoadOptions {
  /** Read by a computed body as `actor`. */
  actor?: unknown;
  /** Read by a computed body as `context`. */
  context?: unknown;
  /** The clock `now()` reads, as everywhere an expression runs. */
  clock?: Clock;
}

/** Keys named by one query: SQLite allows 32,766 variables, older builds 999; 500 is under both. */
export const CHUNK = 500;
/** A path of computed fields that read themselves through rows (a cycle in the data) stops here. */
const MAX_DEPTH = 32;

type Work = Row;

export async function loadRows(
  plan: LoadPlan,
  entity: string,
  tx: DataOperations,
  rows: readonly Row[],
  names: readonly string[],
  options: LoadOptions = {},
): Promise<Row[]> {
  const entityPlan = planOf(plan, entity);
  for (const name of names)
    if (!Object.hasOwn(entityPlan.relations, name) && !Object.hasOwn(entityPlan.computed, name))
      throw new FrameworkError(unknownName(plan, entity, name));
  // Work on copies: the caller's rows are never changed, and a field a path loads only to evaluate a body stays off them.
  const work: Work[] = rows.map((row) => ({ ...row }));
  for (const name of names) await ensureField(plan, entity, tx, work, name, options, 0);
  return rows.map((row, index) => {
    const loaded: Row = { ...row };
    for (const name of names) loaded[name] = work[index]![name];
    return loaded;
  });
}

function planOf(plan: LoadPlan, entity: string): EntityPlan {
  const found = Object.hasOwn(plan, entity) ? plan[entity] : undefined;
  if (!found) throw new FrameworkError(`The load plan has no entity ${entity}`);
  return found;
}

function unknownName(plan: LoadPlan, entity: string, name: string): string {
  const entityPlan = planOf(plan, entity);
  const all = [...Object.keys(entityPlan.relations), ...Object.keys(entityPlan.computed)];
  return `${entity} has no relationship or computed field "${name}" to load${all.length ? ` (it has ${all.join(", ")})` : ""}`;
}

async function ensureField(
  plan: LoadPlan, entity: string, tx: DataOperations, rows: Work[], name: string, options: LoadOptions, depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH)
    throw new FrameworkError(`Loading ${entity}.${name} went more than ${MAX_DEPTH} levels deep: a computed field reads itself through rows that lead back to each other`);
  const todo = rows.filter((row) => !(name in row));
  if (todo.length === 0) return;
  const entityPlan = planOf(plan, entity);
  if (Object.hasOwn(entityPlan.relations, name)) {
    await loadRelation(plan, entity, entityPlan, name, entityPlan.relations[name]!, tx, todo);
    return;
  }
  const computed = Object.hasOwn(entityPlan.computed, name) ? entityPlan.computed[name] : undefined;
  if (!computed) throw new FrameworkError(unknownName(plan, entity, name));
  if (computed.kind === "rollup") {
    for (const row of todo) row[name] = await rollup(plan, entity, entityPlan, name, computed, tx, row);
    return;
  }
  for (const path of computed.needs) await ensurePath(plan, entity, tx, todo, path.split("."), options, depth + 1);
  for (const row of todo) {
    const value = computed.evaluate(scope({ self: row, input: undefined, actor: options.actor, context: options.context ?? {}, before: null, tx }, options.clock ? { clock: options.clock } : {}) as never);
    row[name] = value === undefined ? null : value;
  }
}

/** Load the first segment on `rows`, then the rest of the path on the rows it brought in. */
async function ensurePath(
  plan: LoadPlan, entity: string, tx: DataOperations, rows: Work[], path: readonly string[], options: LoadOptions, depth: number,
): Promise<void> {
  const [head, ...rest] = path as [string, ...string[]];
  await ensureField(plan, entity, tx, rows, head, options, depth);
  if (rest.length === 0) return;
  const relation = planOf(plan, entity).relations[head];
  if (!relation) throw new FrameworkError(`${entity}.${head} is a computed field, and nothing can be loaded through it (${path.join(".")})`);
  const next: Work[] = [];
  for (const row of rows) {
    const value = row[head];
    if (Array.isArray(value)) next.push(...(value as Work[]));
    else if (value !== null && value !== undefined) next.push(value as Work);
  }
  await ensurePath(plan, relation.target, tx, [...new Set(next)], rest, options, depth);
}

const describe = (entity: string, name: string, relation: RelationPlan) => `${relation.kind} :${name} of :${entity}`;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += CHUNK) out.push(list.slice(at, at + CHUNK));
  return out;
}

async function loadRelation(
  plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string, relation: RelationPlan, tx: DataOperations, rows: Work[],
): Promise<void> {
  const target = planOf(plan, relation.target);
  if (relation.kind === "belongs-to") {
    const keys = [...new Set(rows.map((row) => row[relation.column]).filter((key) => key !== null && key !== undefined))];
    const found = new Map<unknown, Work>();
    for (const chunk of chunks(keys))
      for (const row of await tx.select(target.table, { filter: { [target.key]: { in: chunk as never } } })) found.set(row[target.key], row);
    for (const row of rows) {
      const key = row[relation.column];
      if (key === null || key === undefined) {
        if (!relation.nullable) throw new FrameworkError(`${describe(entity, name, relation)} has no key in ${relation.column}, and it is not nullable`);
        row[name] = null;
        continue;
      }
      const related = found.get(key);
      if (!related) throw new FrameworkError(`${describe(entity, name, relation)} points at ${relation.target} ${JSON.stringify(key)}, which does not exist`);
      row[name] = related;
    }
    return;
  }
  if (relation.column === null)
    throw new FrameworkError(`${describe(entity, name, relation)} cannot be loaded: :${relation.target} has no belongs-to back to :${entity}. Declare one in :${relation.target}, and name it with via=:name if there are several`);
  const keys = [...new Set(rows.map((row) => row[entityPlan.key]))];
  const grouped = new Map<unknown, Work[]>();
  for (const chunk of chunks(keys))
    for (const row of await tx.select(target.table, { filter: { [relation.column]: { in: chunk as never } } })) {
      const group = grouped.get(row[relation.column]);
      if (group) group.push(row);
      else grouped.set(row[relation.column], [row]);
    }
  for (const row of rows) {
    const group = grouped.get(row[entityPlan.key]) ?? [];
    if (relation.kind === "has-many") row[name] = group;
    else if (group.length > 1)
      throw new FrameworkError(`${describe(entity, name, relation)} found ${group.length} rows for ${JSON.stringify(row[entityPlan.key])}, and a has-one is for at most one; use has-many and choose the row in code`);
    else row[name] = group[0] ?? null;
  }
}

async function rollup(
  plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string, computed: Extract<ComputedPlan, { kind: "rollup" }>, tx: DataOperations, row: Work,
): Promise<unknown> {
  const label = `${computed.fn} :${name} of="${computed.of.join(".")}" on :${entity}`;
  if (computed.fn !== "count" && computed.fn !== "max")
    throw new FrameworkError(`${label} cannot be loaded: only count and max rollups run before Mesh 1.0; sum, avg and min come after it`);
  const [path, attribute, ...more] = computed.of as [string, string?, ...string[]];
  const relation = Object.hasOwn(entityPlan.relations, path) ? entityPlan.relations[path] : undefined;
  if (!relation) throw new FrameworkError(`${label} cannot be loaded: :${entity} has no relationship ${path}`);
  const through = relation.kind === "belongs-to" || more.length > 0 || (attribute !== undefined && Object.hasOwn(planOf(plan, relation.target).relations, attribute));
  if (through)
    throw new FrameworkError(`${label} cannot be loaded yet: a rollup over ${relation.kind === "belongs-to" ? "a belongs-to" : "more than one relationship"} needs a join, which arrives with the SQL evaluator (M10); only a count or max over one has-many or has-one runs now`);
  if (relation.column === null)
    throw new FrameworkError(`${label} cannot be loaded: :${relation.target} has no belongs-to back to :${entity}`);
  const target = planOf(plan, relation.target);
  const filter: Filter = { [relation.column]: { eq: row[entityPlan.key] as never } };
  const column = attribute ?? target.key;
  return computed.fn === "count" ? tx.count(target.table, column, filter) : tx.max(target.table, column, filter);
}

/**
 * A caller's `filter` or `sort` naming a computed field or rollup of the entity fails here, with the milestone
 * that brings it, because the SQL evaluator (M10) is what filters and sorts by one. A read does it before
 * it touches the database, so a wrong result is never returned.
 */
export function rejectComputedQuery(entity: string, computed: readonly string[], query: { filter?: unknown; sort?: unknown }): void {
  const fail = (name: string, what: "filter" | "sort") => {
    throw new FrameworkError(`A ${what} by ${entity}.${name} is not available yet: ${name} is a computed field or rollup, and filtering and sorting by one is evaluated by the SQL evaluator, which arrives in M10`);
  };
  const walk = (filter: unknown): void => {
    if (filter === null || typeof filter !== "object") return;
    for (const [key, value] of Object.entries(filter)) {
      if ((key === "and" || key === "or") && Array.isArray(value)) value.forEach(walk);
      else if (computed.includes(key)) fail(key, "filter");
    }
  };
  walk(query.filter);
  if (Array.isArray(query.sort))
    for (const key of query.sort) {
      const name = typeof key === "string" && key.startsWith("-") ? key.slice(1) : key;
      if (typeof name === "string" && computed.includes(name)) fail(name, "sort");
    }
}
