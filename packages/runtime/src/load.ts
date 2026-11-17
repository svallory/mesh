import { whereFor, type Condition, type Hop, type TableOf } from "./condition.ts";
import { ROLLUP_ANCHORS, type DataOperations, type Filter, type RollupQuery, type Row, type Scalar, type TableHandle } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { pinClock, scope, type Clock } from "./expr.ts";
import type { ActionFrame } from "./entity.ts";
import { authorizer, type PolicySpec } from "./policy.ts";

/**
 * The computed field being evaluated right now, synchronously: a computed body is a synchronous function, so an
 * entity call or a `privileged` read made from it, directly or through a helper, starts while this is set, with or
 * without a binding's frame. `entity.ts` refuses such a call.
 */
let current: string | undefined;
export const evaluatingNow = (): string | undefined => current;
function evaluating<T>(what: string, fn: () => T): T {
  const before = current;
  current = what;
  try {
    return fn();
  } finally {
    current = before;
  }
}

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
 *   A `has-many` through a link entity makes two queries: the link rows whose entry column holds one of
 *   the keys, sorted by their exit column, then the far rows whose key is one of their exit keys.
 * - A computed field with a body first loads what its body reads (its `needs`), then runs the body in
 *   memory once per row, with the scope the expression functions take.
 * - A `count` or `max` rollup over one has-many or has-one calls the data layer's `count` and `max` once per row. Every
 *   other rollup (`sum`, `avg`, `min`, any rollup over a belongs-to, over several relationships or through a link
 *   entity) is one `rollup` call for the whole list of rows, per `ROLLUP_ANCHORS` anchors: over one relationship, the
 *   target's rows grouped by the column the relationship follows; over a longer path, the route's hops, joined by the
 *   data layer, with each row the path reaches counted once per owner row.
 * - What a caller loads (`policies: true`: a read's `load`, a write's `load` step) runs the read policies of each entity it
 *   reaches, and of the link entity of a `through`, with the caller's scope: a relationship to an entity they do not admit is `[]` (has-many) or `null`
 *   (belongs-to, has-one), and a rollup whose path reaches one (any entity of the path, a link entity included) counts no
 *   row (`0`, or `null` for the others). The policies are decided first,
 *   so a denied name is not queried at all. A policy that reads the record admits row by row instead (M10): its condition
 *   goes into the query of the related rows (`where`), so a has-many lists only the rows it admits, a belongs-to or has-one
 *   it does not admit is `null`, and a rollup counts or takes the maximum over the admitted rows only. What a computed
 *   field's body reads, and anything read through `privileged`, runs no policy: a body is the entity's own rule, so it
 *   sees every related row.
 */
export interface BelongsToPlan {
  kind: "belongs-to";
  /** The target entity's FQN (a key of the plan). */
  target: string;
  /** The column on this entity that holds the target's key. */
  column: string;
  nullable: boolean;
}
export interface HasPlan {
  kind: "has-many" | "has-one";
  /** The target entity's FQN (a key of the plan). */
  target: string;
  /**
   * The column on the target, or, with `through`, on the link entity, that holds this entity's key; null when there is no
   * belongs-to back (loading it is an error).
   */
  column: string | null;
  /**
   * `has-many` only: the relationship reaches `target` through a link entity. `target` here is the link entity's FQN (a key
   * of the plan); `exit` is the link's column that holds the far entity's key, null when the link has not exactly one
   * belongs-to to the far entity (loading it is an error).
   */
  through?: { target: string; exit: string | null };
}
export type RelationPlan = BelongsToPlan | HasPlan;
export type ComputedPlan =
  | {
      kind: "body";
      /** Dotted paths of relationships and computed fields to load before the body runs. */
      needs: readonly string[];
      /** The body runs as authored TypeScript, so what it reads is not known; it gets a guarded record (see `guarded`). */
      plain?: boolean;
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
  /**
   * The read policies a load of this entity runs: those that cover its reads by type (`types=[:read]`, or no
   * scope). Left out or empty, no policy covers a load of it, and a caller's load of it gives nothing.
   */
  reads?: readonly PolicySpec[];
  /** The primary key's attribute name. */
  key: string;
  relations: Readonly<Record<string, RelationPlan>>;
  computed: Readonly<Record<string, ComputedPlan>>;
}
/** The plan of every entity, keyed by the entity's FQN (e.g. `blog.Post`); `entity` and `target` arguments of the functions below are FQNs too. */
export type LoadPlan = Readonly<Record<string, EntityPlan>>;

export interface LoadOptions {
  /** Read by a computed body as `actor`. */
  actor?: unknown;
  /** Read by a computed body as `context`. */
  context?: unknown;
  /** The clock `%.now` reads, as everywhere an expression runs. */
  clock?: Clock | undefined;
  /**
   * `loadRows` only: the names are what a caller asked for, so each relationship and rollup runs the read policies of the
   * entity it reaches, with `actor` and `context`. A `privileged` read and a computed field's own loads leave it out.
   */
  policies?: boolean | undefined;
  /**
   * The binding's frame: each computed body runs marked with it, so a `privileged` read made while one is
   * evaluated throws, and so do the read policies a load runs. Left out (a `load<Entity>Fields` call), a computed body is
   * still marked while it runs synchronously, which is all a computed body does.
   */
  frame?: Pick<ActionFrame, "marked"> | undefined;
  /**
   * `loadRows` only: the data layer `tx` belongs to. A condition a read policy gives a name the caller loads goes to it
   * only if its capability manifest declares `conditions` (and `joins`, for one that crosses a relationship), as a read's
   * own does (`whereFor`): a layer that ignored it would return rows the policy excludes. The build refuses both first;
   * this is the defence behind it. The generated actions pass it.
   */
  layer?: object | undefined;
  /**
   * `loadInto` only: the record is a create's new instance before the input is applied, so a required
   * `belongs-to` whose key the input has not filled yet is null on it instead of an error.
   */
  newInstance?: boolean | undefined;
}
/** The options as loading passes them down: with the new instance whose required relationships may have no key yet. */
type Options = LoadOptions & { readonly pending?: object };

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
  given: LoadOptions = {},
): Promise<Row[]> {
  // One instant for the whole call: every row and computed field reads the same `%.now`.
  const options = { ...given, clock: pinClock(given.clock) };
  const entityPlan = planOf(plan, entity);
  for (const name of names)
    if (!Object.hasOwn(entityPlan.relations, name) && !Object.hasOwn(entityPlan.computed, name))
      throw new FrameworkError(unknownName(plan, entity, name));
  // Decided before anything loads: a name the caller is not admitted to is not queried, so a denied caller learns
  // nothing from it, not even that a required belongs-to points at a row that is gone. A name admitted row by row
  // (`narrowed`) is loaded with its condition.
  const { denied, narrowed } = options.policies ? await admissions(plan, entity, names, options) : { denied: new Map<string, unknown>(), narrowed: new Map<string, Narrowing>() };
  // Unless a computed body the caller named reads it for itself: it is loaded for the body, and taken off (or narrowed) below.
  const forBodies = denied.size || narrowed.size ? readByBodies(entityPlan, names) : new Set<string>();
  if (rows.length) for (const name of names) if (denied.has(name) && !forBodies.has(name)) assertServable(plan, entity, entityPlan, name);
  const loads = names.filter((name) => (!denied.has(name) && !narrowed.has(name)) || forBodies.has(name));
  // Work on copies: the caller's rows are never changed, and a field a path loads only to evaluate a body stays off them.
  const work: Work[] = rows.map((row) => ({ ...row }));
  // Rollups last: one over a has-many that the same call loaded is worked out from those rows (below), with no query of its own.
  const isRollup = (name: string) => Object.hasOwn(entityPlan.computed, name) && entityPlan.computed[name]!.kind === "rollup" && !Object.hasOwn(entityPlan.relations, name);
  for (const name of [...loads.filter((n) => !isRollup(n)), ...loads.filter(isRollup)]) await ensureField(plan, entity, tx, work, name, options, 0);
  // What the caller gets of each name admitted row by row: never the bodies' copy, which no policy filtered.
  const admitted = new Map<string, unknown[]>();
  for (const [name, narrowing] of narrowed)
    admitted.set(name, await admittedValues(plan, entity, entityPlan, name, narrowing, tx, work, forBodies.has(name)));
  return rows.map((row, index) => {
    const loaded: Row = { ...row };
    for (const name of names) loaded[name] = denied.has(name) ? emptied(denied.get(name)) : admitted.has(name) ? admitted.get(name)![index] : work[index]![name];
    return loaded;
  });
}

/**
 * The names of this entity that the computed bodies among `names` read for themselves: the first step of each of their
 * `needs`, followed through the entity's own computed bodies.
 */
function readByBodies(entityPlan: EntityPlan, names: readonly string[]): Set<string> {
  const read = new Set<string>();
  const visit = (name: string) => {
    const computed = Object.hasOwn(entityPlan.computed, name) ? entityPlan.computed[name] : undefined;
    if (computed?.kind !== "body") return;
    for (const path of computed.needs) {
      const head = path.split(".")[0]!;
      if (read.has(head)) continue;
      read.add(head);
      visit(head);
    }
  };
  for (const name of names) visit(name);
  return read;
}

/**
 * The errors a load of `name` gives whatever the rows hold. A denied name skips its query, but a load that cannot be
 * served is still an error, never skipped, for every caller alike.
 */
function assertServable(plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string): void {
  const relation = Object.hasOwn(entityPlan.relations, name) ? entityPlan.relations[name] : undefined;
  if (relation) {
    if (relation.kind !== "belongs-to" && relation.column === null) throw new FrameworkError(noBelongsToBack(entity, name, relation));
    if (relation.kind !== "belongs-to" && relation.through?.exit === null) throw new FrameworkError(noExit(entity, name, relation));
    return;
  }
  const computed = Object.hasOwn(entityPlan.computed, name) ? entityPlan.computed[name] : undefined;
  if (computed?.kind === "rollup") rollupRoute(plan, entity, name, computed);
}

/** A fresh empty value for each row, so that no two rows share one list. */
const emptied = (value: unknown) => (Array.isArray(value) ? [] : value);

/** The conditions a name admitted row by row carries: on the rows of the entity it reaches, and on the link rows of a `through`. */
interface Narrowing {
  readonly target?: Condition | undefined;
  readonly link?: Condition | undefined;
}

/**
 * What each name a caller asked for is admitted to, by the read policies of the entity it reaches (for a `through`, the
 * link entity and the far entity): `denied`, the names no row of which is admitted, each with what it gives instead
 * (`[]` for a has-many, `null` for a belongs-to or has-one, `0` for a count and `null` for a max); `narrowed`, those
 * admitted row by row, with the conditions. The read policies are decided (and their conditions bound) once per entity
 * per call.
 */
async function admissions(plan: LoadPlan, entity: string, names: readonly string[], options: LoadOptions): Promise<{ denied: Map<string, unknown>; narrowed: Map<string, Narrowing> }> {
  const entityPlan = planOf(plan, entity);
  const decided = new Map<string, boolean | Condition>();
  const tableOf: TableOf = (fqn) => planOf(plan, fqn).table;
  const admits = async (target: string) => {
    if (!decided.has(target)) {
      const policies = planOf(plan, target).reads ?? [];
      const roots = { input: Object.freeze({}), actor: options.actor, context: options.context ?? {} };
      const where = await authorizer(target, "read", policies, options.frame).admitsRows(scope(roots, options.clock ? { clock: options.clock } : {}), tableOf);
      if (where !== true && where !== false && options.layer !== undefined) whereFor(options.layer, where);
      decided.set(target, where);
    }
    return decided.get(target)!;
  };
  const condition = (where: boolean | Condition) => (where === true ? undefined : (where as Condition));
  const denied = new Map<string, unknown>();
  const narrowed = new Map<string, Narrowing>();
  for (const name of names) {
    const relation = Object.hasOwn(entityPlan.relations, name) ? entityPlan.relations[name] : undefined;
    if (relation) {
      const link = relation.kind === "has-many" ? relation.through?.target : undefined;
      const linkWhere = link === undefined ? true : await admits(link);
      const targetWhere = linkWhere === false ? false : await admits(relation.target);
      if (linkWhere === false || targetWhere === false) denied.set(name, relation.kind === "has-many" ? [] : null);
      else if (linkWhere !== true || targetWhere !== true) narrowed.set(name, { target: condition(targetWhere), link: condition(linkWhere) });
      continue;
    }
    const computed = Object.hasOwn(entityPlan.computed, name) ? entityPlan.computed[name] : undefined;
    if (computed?.kind !== "rollup") continue;
    const over = Object.hasOwn(entityPlan.relations, computed.of[0]!) ? entityPlan.relations[computed.of[0]!] : undefined;
    if (!over) continue;
    // Every entity the path reaches must admit the caller, the link entity of a `through` included (ruling D33, OD2).
    const reached = routeEntities(plan, entity, computed.of);
    const joined = reached.length > 1;
    let narrowedBy: { target: string; where: Condition } | undefined;
    let refused = false;
    for (const target of reached) {
      const where = await admits(target);
      if (where === false) { refused = true; break; }
      if (where !== true) narrowedBy ??= { target, where };
    }
    if (refused) denied.set(name, computed.fn === "count" ? 0 : null);
    else if (narrowedBy) {
      // The batched `rollup` takes no row condition yet; the build refuses such a rollup first (MESH_NOT_IMPLEMENTED).
      if (!perRow(computed, { relation: over, joined }))
        throw new FrameworkError(`${computed.fn} :${name} of=&${computed.of.join(".")} on ${entity} reaches ${narrowedBy.target}, whose read policy reads the record; a rollup restricted row by row arrives with M10's SQL rollups, and only a count or max over one has-many or has-one runs under such a policy now`);
      narrowed.set(name, { target: narrowedBy.where });
    }
  }
  return { denied, narrowed };
}

/**
 * The caller's value of a name admitted row by row, one per row. A rollup is counted (or its maximum taken) over the
 * admitted rows by a query of its own. A relationship the bodies did not load for themselves is loaded with the
 * conditions; one they did is narrowed: the related rows they loaded, less those the conditions do not admit, in order.
 */
async function admittedValues(
  plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string, narrowing: Narrowing, tx: DataOperations, work: Work[], loadedForBodies: boolean,
): Promise<unknown[]> {
  // No row, nothing to load: as for any name, a load that could not be served is not reached.
  if (work.length === 0) return [];
  const relation = Object.hasOwn(entityPlan.relations, name) ? entityPlan.relations[name] : undefined;
  if (!relation) {
    const computed = entityPlan.computed[name] as Extract<ComputedPlan, { kind: "rollup" }>;
    const values: unknown[] = [];
    for (const row of work) values.push(await rollupOneRow(plan, entity, entityPlan, name, computed, tx, row, narrowing.target));
    return values;
  }
  if (!loadedForBodies) {
    const into: Work[] = work.map((row) => ({ ...row }));
    await loadRelation(plan, entity, entityPlan, name, relation, tx, into, undefined, narrowing);
    return into.map((row) => row[name]);
  }
  const target = planOf(plan, relation.target);
  // The related rows the bodies loaded that the target's condition admits, by key.
  let keep: ((owner: Work, related: Work) => boolean) = () => true;
  if (narrowing.target) {
    const keys = [...new Set(work.flatMap((row) => related(row[name])).map((r) => r[target.key]))];
    const admittedKeys = new Set<unknown>();
    for (const chunk of chunks(keys))
      for (const row of await tx.select(target.table, { filter: { [target.key]: { in: chunk as never } }, where: narrowing.target })) admittedKeys.add(row[target.key]);
    keep = (_owner, r) => admittedKeys.has(r[target.key]);
  }
  if (narrowing.link && relation.kind === "has-many" && relation.through && relation.column !== null && relation.through.exit !== null) {
    // A far row is the caller's only through a link row the link entity's condition admits.
    const link = planOf(plan, relation.through.target);
    const exit = relation.through.exit;
    const column = relation.column;
    const owners = [...new Set(work.map((row) => row[entityPlan.key]).filter((key) => key !== null && key !== undefined))];
    const pairs = new Map<unknown, Set<unknown>>();
    for (const chunk of chunks(owners))
      for (const row of await tx.select(link.table, { filter: { [column]: { in: chunk as never }, [exit]: { nil: false } }, where: narrowing.link })) {
        const set = pairs.get(row[column]) ?? new Set<unknown>();
        set.add(row[exit]);
        pairs.set(row[column], set);
      }
    const byTarget = keep;
    keep = (owner, r) => byTarget(owner, r) && (pairs.get(owner[entityPlan.key])?.has(r[target.key]) ?? false);
  }
  return work.map((row) => {
    const value = row[name];
    if (Array.isArray(value)) return (value as Work[]).filter((r) => keep(row, r));
    return value === null || value === undefined ? null : keep(row, value as Work) ? value : null;
  });
}

/** The related rows a loaded relationship holds: a list, one row, or none. */
const related = (value: unknown): Work[] => (Array.isArray(value) ? (value as Work[]) : value === null || value === undefined ? [] : [value as Work]);

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
    throw new FrameworkError(`Loading ${entity}#${name} went more than ${MAX_DEPTH} levels deep: a computed field reads itself through rows that lead back to each other`);
  // Own members only: a field may be named like a member of `Object.prototype` (`toString`), which every row inherits.
  const todo = rows.filter((row) => !Object.hasOwn(row, name));
  if (todo.length === 0) return;
  const entityPlan = planOf(plan, entity);
  if (Object.hasOwn(entityPlan.relations, name)) {
    await loadRelation(plan, entity, entityPlan, name, entityPlan.relations[name]!, tx, todo, (options as Options).pending);
    return;
  }
  const computed = Object.hasOwn(entityPlan.computed, name) ? entityPlan.computed[name] : undefined;
  if (!computed) throw new FrameworkError(unknownName(plan, entity, name));
  if (computed.kind === "rollup") {
    const route = rollupRoute(plan, entity, name, computed);
    if (perRow(computed, route)) for (const row of todo) row[name] = await rollupOneRow(plan, entity, entityPlan, name, computed, tx, row);
    else await rollupRows(plan, entity, entityPlan, name, computed, route, tx, todo, (options as Options).pending);
    return;
  }
  for (const path of computed.needs) await ensurePath(plan, entity, tx, todo, path.split("."), options, depth + 1);
  for (const row of todo) {
    const self = computed.plain ? guarded(plan, entity, row) : row;
    const fieldScope = scope({ self, input: undefined, actor: options.actor, context: options.context ?? {}, before: null }, options.clock ? { clock: options.clock } : {}) as never;
    const what = `computed :${name} of ${entity}`;
    const value = evaluating(what, () => options.frame ? options.frame.marked(what, () => computed.evaluate(fieldScope)) : computed.evaluate(fieldScope));
    // A body that returns a promise (one that calls an async helper) is refused, so no row holds one; its own outcome
    // is dropped, as `expr.pure` drops it, since the field has already failed.
    if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
      (value as PromiseLike<unknown>).then(undefined, () => {});
      throw new FrameworkError(`${what} returned a promise: a computed field is synchronous, and reads only its record and what it loads. Compute it from them; a read through \`privileged\` or anything else that awaits belongs in a step or a check`);
    }
    // A translated body gives unknown as null; a plain body's result is what it returned.
    row[name] = value === undefined && !computed.plain ? null : value;
  }
}

/**
 * A record handed to a body that runs as plain code. Mesh cannot see everything such a body reads (a read through a
 * variable, a deeper chain than the text shows), so a read of a relationship or computed field that is not loaded
 * throws instead of coming back as `undefined`, which the body would turn into a wrong answer. Related rows are guarded the same way.
 *
 * `in` on such a name throws too. `Object.keys`, spreading and `Object.entries` list what is loaded and nothing else (an
 * unloaded name is not a property of the record), and what they hand back for a related row is guarded like the row itself.
 *
 * A guard is made once per row, and a loaded list is guarded once, so a body that reads the same list many times
 * (`for (let i = 0; i < list.length; i++) list[i]`) costs one pass over it, not one per read.
 */
const guards = new WeakMap<object, { plan: LoadPlan; what: string; guard: Work }>();
const guardedLists = new WeakMap<object, { plan: LoadPlan; what: string; list: Work[] }>();

/**
 * `what` names the plain code in the error ("computed body" for a computed field; an action's functions say "action function").
 * Exported for the generated actions, which guard the `self` of every function they run (M5).
 */
export function guarded(plan: LoadPlan, entity: string, row: Work, what = "computed body"): Work {
  const known = guards.get(row);
  if (known?.plan === plan && known.what === what) return known.guard;
  const entityPlan = planOf(plan, entity);
  const names = (key: string) => Object.hasOwn(entityPlan.relations, key) || Object.hasOwn(entityPlan.computed, key);
  const unloaded = (key: string) =>
    what === "before"
      ? new FrameworkError(`\`before\` holds the stored columns of ${entity} only, so ${entity}#${key} is not on it: Mesh never loads a relationship or computed field onto \`before\`. Compare the stored key (\`before.${key}Id\` for a relationship), or read the proposed record's in an expression Mesh can see (\`&${key}\`)`)
      : new FrameworkError(`A plain ${what} read ${entity}#${key}, which was not loaded: Mesh could not tell from the body that it reads it. Read it as \`&${key}\` in the same body (a related record's as the whole chain, \`&relationship.${key}\`) so Mesh loads what it reads: \`self.${key}\` and a read through a variable are not followed`);
  const wrap = (key: string, value: unknown): unknown => {
    const relation = Object.hasOwn(entityPlan.relations, key) ? entityPlan.relations[key] : undefined;
    if (!relation || value === null || typeof value !== "object") return value;
    if (!Array.isArray(value)) return guarded(plan, relation.target, value as Work, what);
    const list = guardedLists.get(value);
    if (list?.plan === plan && list.what === what) return list.list;
    const made = value.map((item) => guarded(plan, relation.target, item as Work, what));
    guardedLists.set(value, { plan, what, list: made });
    return made;
  };
  const guard: Work = new Proxy(row, {
    // A field is loaded when the row holds it as its own: a relationship or computed field named like a member of
    // `Object.prototype` (`constructor`, `toString`) is not loaded because every row inherits that member.
    get(target, key, receiver) {
      if (typeof key !== "string") return Reflect.get(target, key, receiver);
      if (!Object.hasOwn(target, key)) {
        if (names(key)) throw unloaded(key);
        return Reflect.get(target, key, receiver);
      }
      return wrap(key, target[key]);
    },
    has(target, key) {
      if (typeof key === "string" && !Object.hasOwn(target, key) && names(key)) throw unloaded(key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor && typeof key === "string" && "value" in descriptor) return { ...descriptor, value: wrap(key, descriptor.value) };
      return descriptor;
    },
  });
  guards.set(row, { plan, what, guard });
  originals.set(guard, row);
  return guard;
}

/** `T` with every property, element and nested object read-only; a `Date` loses its setters. `any` stays `any`. */
export type DeepReadonly<T> = 0 extends 1 & T ? T
  : T extends Date ? Readonly<Omit<Date, `set${string}`>>
    : T extends (...args: never[]) => unknown ? T
      : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
        : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

const readOnlyViews = new WeakMap<object, { where: string; view: object }>();
/** Every guard and read-only view handed to a function, mapped to the value it stands for, so `cloneValue` can copy it. */
const originals = new WeakMap<object, object>();

/**
 * A read-only view of a record (or of a value reached through one) that a plain action function is handed as `self` or
 * `before`. The work of an action is its `set` steps, so a change made inside a function is never persisted, and Mesh says
 * so wherever JavaScript lets it: `set`, `deleteProperty`, `defineProperty`, `preventExtensions` and `setPrototypeOf` throw
 * on the record and on every object, array and related record reached through it. A `Date` is handed out as a copy whose
 * setters throw, so nothing written through a path a proxy cannot trap reaches the stored row.
 */
export function readOnlyRecord(row: Work, where: string): Work {
  const refuse = (): never => {
    throw new FrameworkError(`${where}: a function cannot change the record. Use a \`set\` step (\`set &field=...\`) to change a field; \`run\` is for work outside the record`);
  };
  const wrap = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) {
      const copy = new Date(value.getTime());
      const date = new Proxy(copy, {
        get(target, key) {
          const found = Reflect.get(target, key, target);
          if (typeof found !== "function") return found;
          return typeof key === "string" && key.startsWith("set") ? refuse : (found as (...args: unknown[]) => unknown).bind(target);
        },
        set: refuse, defineProperty: refuse, deleteProperty: refuse, preventExtensions: refuse, setPrototypeOf: refuse,
      });
      originals.set(date, copy);
      return date;
    }
    return readOnlyRecord(value as Work, where);
  };
  const known = readOnlyViews.get(row);
  if (known?.where === where) return known.view as Work;
  const view: Work = new Proxy(row, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof key === "string" ? wrap(value) : value;
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor && typeof key === "string" && "value" in descriptor && descriptor.configurable) return { ...descriptor, value: wrap(descriptor.value) };
      return descriptor;
    },
    set: refuse, defineProperty: refuse, deleteProperty: refuse, preventExtensions: refuse, setPrototypeOf: refuse,
  });
  readOnlyViews.set(row, { where, view });
  originals.set(view, row);
  return view;
}

/**
 * A plain, mutable deep copy of a value a function was handed: what `structuredClone` means inside the functions of an
 * entity file (the generated expressions file binds that name to this function). The read-only views Mesh hands out are
 * proxies, which the global `structuredClone` refuses to copy; this copies the values they stand for, at any depth,
 * with the same options. Anything else is copied as `structuredClone` copies it.
 */
export function cloneValue<T>(value: T, options?: Parameters<typeof structuredClone>[1]): Writable<T> {
  return structuredClone(unwrapped(value, new Map()), options) as Writable<T>;
}

/** What `cloneValue` returns: the type with `DeepReadonly` taken off, since the copy is the function's own to change. */
export type Writable<T> = 0 extends 1 & T ? T
  : T extends Date | Readonly<Omit<Date, `set${string}`>> ? Date
    : T extends (...args: never[]) => unknown ? T
      : T extends readonly (infer U)[] ? Writable<U>[]
        : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> }
          : T;

/** The value without Mesh's views: arrays and plain objects are rebuilt around unwrapped members, the rest kept as is. */
function unwrapped(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  let original: object = value;
  for (let next = originals.get(original); next !== undefined; next = originals.get(original)) original = next;
  if (seen.has(original)) return seen.get(original);
  if (Array.isArray(original)) {
    const list: unknown[] = [];
    seen.set(original, list);
    for (const item of original) list.push(unwrapped(item, seen));
    return list;
  }
  const prototype: unknown = Object.getPrototypeOf(original);
  if (prototype !== Object.prototype && prototype !== null) return original;
  const object: Record<string, unknown> = {};
  seen.set(original, object);
  // `defineProperty`, not `object[key] = ...`: a `json` value may hold an own `__proto__` key, and assigning to that
  // name on an ordinary object changes its prototype instead of making a property (and drops the key).
  for (const [key, member] of Object.entries(original))
    Object.defineProperty(object, key, { value: unwrapped(member, seen), writable: true, enumerable: true, configurable: true });
  return object;
}

/** Load the first segment on `rows`, then the rest of the path on the rows it brought in. */
async function ensurePath(
  plan: LoadPlan, entity: string, tx: DataOperations, rows: Work[], path: readonly string[], options: LoadOptions, depth: number,
): Promise<void> {
  const [head, ...rest] = path as [string, ...string[]];
  await ensureField(plan, entity, tx, rows, head, options, depth);
  if (rest.length === 0) return;
  const relations = planOf(plan, entity).relations;
  const relation = Object.hasOwn(relations, head) ? relations[head] : undefined;
  if (!relation) throw new FrameworkError(`${entity}#${head} is a computed field, and nothing can be loaded through it (${path.join(".")})`);
  const next: Work[] = [];
  for (const row of rows) {
    const value = row[head];
    if (Array.isArray(value)) next.push(...(value as Work[]));
    else if (value !== null && value !== undefined) next.push(value as Work);
  }
  await ensurePath(plan, relation.target, tx, [...new Set(next)], rest, options, depth);
}

const describe = (entity: string, name: string, relation: RelationPlan) => `${relation.kind} :${name} of ${entity}`;
/** The entity whose belongs-to a has-many or has-one follows: the link entity of a `through`, the target otherwise. */
const keyHolder = (relation: RelationPlan) => (relation.kind === "has-many" && relation.through ? relation.through.target : relation.target);
const noBelongsToBack = (entity: string, name: string, relation: RelationPlan) =>
  `${describe(entity, name, relation)} cannot be loaded: ${keyHolder(relation)} has no belongs-to back to ${entity}. Declare one in ${keyHolder(relation)}, and name it with inverse=:name if there are several`;
const noExit = (entity: string, name: string, relation: RelationPlan) =>
  `${describe(entity, name, relation)} cannot be loaded: ${keyHolder(relation)}, the link entity, has not exactly one belongs-to to ${relation.target} to leave by`;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += CHUNK) out.push(list.slice(at, at + CHUNK));
  return out;
}

/**
 * Load one relationship onto `rows`. With `narrowing` (a caller's load the read policies admit row by row), each query
 * of related rows carries the condition as `where`: a has-many lists only the admitted rows, and a belongs-to or has-one
 * whose row is not admitted is `null`. A belongs-to key, or a through's exit key, that the query left unanswered is
 * looked up once more without the condition, so a row the policies exclude (`null`, or left out of the list) is told
 * from a key that names no row (the error it always is).
 */
async function loadRelation(
  plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string, relation: RelationPlan, tx: DataOperations, rows: Work[], pending?: object, narrowing?: Narrowing,
): Promise<void> {
  const target = planOf(plan, relation.target);
  const where = narrowing?.target;
  if (relation.kind === "belongs-to") {
    const keys = [...new Set(rows.map((row) => row[relation.column]).filter((key) => key !== null && key !== undefined))];
    const found = new Map<unknown, Work>();
    for (const chunk of chunks(keys))
      for (const row of await tx.select(target.table, { filter: { [target.key]: { in: chunk as never } }, ...(where ? { where } : {}) })) found.set(row[target.key], row);
    const excluded = where ? await existing(tx, target, keys.filter((key) => !found.has(key))) : new Set<unknown>();
    for (const row of rows) {
      const key = row[relation.column];
      if (key === null || key === undefined) {
        if (!relation.nullable && row !== pending) throw new FrameworkError(`${describe(entity, name, relation)} has no key in ${relation.column}, and it is not nullable`);
        row[name] = null;
        continue;
      }
      const related = found.get(key);
      if (!related && excluded.has(key)) {
        row[name] = null;
        continue;
      }
      if (!related) throw new FrameworkError(`${describe(entity, name, relation)} points at ${relation.target} ${JSON.stringify(key)}, which does not exist`);
      row[name] = related;
    }
    return;
  }
  if (relation.column === null) throw new FrameworkError(noBelongsToBack(entity, name, relation));
  // A row with no key yet (a create's pending record) has nothing pointing at it.
  const keys = [...new Set(rows.map((row) => row[entityPlan.key]).filter((key) => key !== null && key !== undefined))];
  if (relation.kind === "has-many" && relation.through) {
    await loadThrough(entity, entityPlan, name, relation as HasPlan & { column: string; through: object }, planOf(plan, relation.through.target), target, tx, rows, keys, narrowing);
    return;
  }
  const grouped = new Map<unknown, Work[]>();
  for (const chunk of chunks(keys))
    for (const row of await tx.select(target.table, { filter: { [relation.column]: { in: chunk as never } }, ...(where ? { where } : {}) })) {
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

/** Of `keys`, those that name a row of `target`, looked up with no condition. */
async function existing(tx: DataOperations, target: EntityPlan, keys: readonly unknown[]): Promise<Set<unknown>> {
  const found = new Set<unknown>();
  for (const chunk of chunks(keys))
    for (const row of await tx.select(target.table, { filter: { [target.key]: { in: chunk as never } } })) found.add(row[target.key]);
  return found;
}

/**
 * A has-many through a link entity: the link rows whose entry column holds one of the keys, with a key in their exit column,
 * sorted by it; then the far rows those exit keys name. One chunk holds every link row of an owner, so each owner's exit
 * keys arrive in the order the database gives the exit column, which is the far key's own; equal keys are neighbours, so
 * comparing with the last one kept leaves each far record once. A link row with no exit key contributes nothing; one whose
 * exit key names no far row is an error. With `narrowing`, the link rows and the far rows are each selected with their
 * entity's condition: a link row it excludes contributes nothing, and a far row it excludes is left out of the list.
 */
async function loadThrough(
  entity: string, entityPlan: EntityPlan, name: string, relation: HasPlan & { column: string; through: { target: string; exit: string | null } },
  link: EntityPlan, far: EntityPlan, tx: DataOperations, rows: Work[], keys: unknown[], narrowing?: Narrowing,
): Promise<void> {
  const exit = relation.through.exit;
  if (exit === null) throw new FrameworkError(noExit(entity, name, relation));
  const exits = new Map<unknown, unknown[]>();
  const linkWhere = narrowing?.link;
  const farWhere = narrowing?.target;
  for (const chunk of chunks(keys))
    for (const row of await tx.select(link.table, { filter: { [relation.column]: { in: chunk as never }, [exit]: { nil: false } }, sort: [exit], ...(linkWhere ? { where: linkWhere } : {}) })) {
      const list = exits.get(row[relation.column]);
      if (!list) exits.set(row[relation.column], [row[exit]]);
      else if (list[list.length - 1] !== row[exit]) list.push(row[exit]);
    }
  const wanted = [...new Set([...exits.values()].flat())];
  const found = new Map<unknown, Work>();
  for (const chunk of chunks(wanted))
    for (const row of await tx.select(far.table, { filter: { [far.key]: { in: chunk as never } }, ...(farWhere ? { where: farWhere } : {}) })) found.set(row[far.key], row);
  const excluded = farWhere ? await existing(tx, far, wanted.filter((key) => !found.has(key))) : new Set<unknown>();
  for (const row of rows)
    row[name] = (exits.get(row[entityPlan.key]) ?? []).flatMap((key) => {
      const related = found.get(key);
      if (!related && excluded.has(key)) return [];
      if (!related) throw new FrameworkError(`${describe(entity, name, relation)} goes through a row of ${relation.through.target} that points at ${relation.target} ${JSON.stringify(key)}, which does not exist`);
      return [related];
    });
}

/**
 * Does the rollup keep its per-row `count`/`max` call (one has-many or has-one with no link entity, ruling D33 OD3), or go
 * through `rollup`?
 */
const perRow = (computed: Extract<ComputedPlan, { kind: "rollup" }>, route: Pick<RollupRoute, "relation" | "joined">) =>
  (computed.fn === "count" || computed.fn === "max") && !route.joined && route.relation.kind !== "belongs-to";

/** One relationship of a rollup's path: `name` of `from` (an FQN), and what it is. */
interface RollupStep {
  from: string;
  name: string;
  relation: RelationPlan;
}

/**
 * What a rollup aggregates: the rows of `target` that its path reaches, and `column`, the value (the target's key for a
 * count). `relation` (named `path`) is the first relationship. A one-table route is a single relationship with no link
 * entity; every other route is `joined`. `required`: every relationship is a belongs-to that is not nullable, so the route
 * reaches exactly one row per owner row. Or the error that says why it cannot be loaded, the same for every row and caller.
 */
interface RollupRoute {
  path: string;
  relation: RelationPlan;
  steps: readonly RollupStep[];
  joined: boolean;
  required: boolean;
  targetName: string;
  target: EntityPlan;
  column: string;
}
function rollupRoute(
  plan: LoadPlan, entity: string, name: string, computed: Extract<ComputedPlan, { kind: "rollup" }>,
): RollupRoute {
  const label = `${computed.fn} :${name} of=&${computed.of.join(".")} on ${entity}`;
  const steps: RollupStep[] = [];
  let current = entity;
  let attribute: string | undefined;
  for (let index = 0; index < computed.of.length; index++) {
    const segment = computed.of[index]!;
    const relations = planOf(plan, current).relations;
    const relation = Object.hasOwn(relations, segment) ? relations[segment] : undefined;
    if (!relation) {
      if (index === 0) throw new FrameworkError(`${label} cannot be loaded: ${entity} has no relationship ${segment}`);
      if (index !== computed.of.length - 1) throw new FrameworkError(`${label} cannot be loaded: ${current} has no relationship ${segment}`);
      attribute = segment;
      break;
    }
    if (relation.kind !== "belongs-to" && relation.column === null)
      throw new FrameworkError(`${label} cannot be loaded: ${keyHolder(relation)} has no belongs-to back to ${current}`);
    if (relation.kind !== "belongs-to" && relation.through?.exit === null) throw new FrameworkError(`${label} cannot be loaded: ${keyHolder(relation)}, the link entity, has not exactly one belongs-to to ${relation.target} to leave by`);
    steps.push({ from: current, name: segment, relation });
    current = relation.target;
  }
  const target = planOf(plan, current);
  const first = steps[0]!;
  return {
    path: first.name, relation: first.relation, steps,
    joined: steps.length > 1 || (first.relation.kind === "has-many" && first.relation.through !== undefined),
    required: steps.every((step) => step.relation.kind === "belongs-to" && !step.relation.nullable),
    targetName: current, target, column: attribute ?? target.key,
  };
}

/** The entities a rollup's path reaches, in order (each relationship's target, after the link entity of a `through`), as far as the plan has them. */
function routeEntities(plan: LoadPlan, entity: string, of: readonly string[]): string[] {
  const reached: string[] = [];
  let current = entity;
  for (const segment of of) {
    const relations = Object.hasOwn(plan, current) ? plan[current]!.relations : {};
    const relation = Object.hasOwn(relations, segment) ? relations[segment] : undefined;
    if (!relation) break;
    if (relation.kind === "has-many" && relation.through) reached.push(relation.through.target);
    reached.push(relation.target);
    current = relation.target;
  }
  return reached;
}

/** A step of a route as the data layer's `Hop`: from the row of `step.from` to the rows of its target. */
function hopOf(plan: LoadPlan, step: RollupStep): Hop {
  const from = planOf(plan, step.from);
  const target = planOf(plan, step.relation.target);
  const { relation } = step;
  if (relation.kind === "belongs-to") return { table: target.table, column: target.key, outer: relation.column, key: target.key };
  const column = relation.column!;
  if (relation.kind === "has-many" && relation.through)
    return { table: target.table, column: target.key, outer: from.key, key: target.key, through: { table: planOf(plan, relation.through.target).table, entry: column, exit: relation.through.exit! } };
  return { table: target.table, column, outer: from.key, key: target.key };
}

/** What a rollup gives when it reaches no row: `0` for a count, `null` for the others. */
const nothing = (computed: Extract<ComputedPlan, { kind: "rollup" }>) => (computed.fn === "count" ? 0 : null);

/**
 * A rollup served by the data layer's `rollup` for every row at once. Each row's anchor is the value its first
 * relationship starts from (its key for a has-many or has-one, its key column for a belongs-to); the anchors are
 * distinct, so rows that share a target ask once. A one-table route asks the target's table grouped by the column the
 * relationship follows. A joined route asks with `hops`: from the first belongs-to's target (anchored on its key), or from
 * the entity's own table (anchored on its key) when the path starts at a has-many or has-one. A row with no anchor reaches
 * nothing (a create's new instance, a nullable belongs-to with a null key), except a stored row with a null key on a
 * required belongs-to, which is an error as its load is. An anchor the result leaves out reached no row: `0` or `null`,
 * except over a route of required belongs-to only, where a key on the path then points at a row that does not exist, an
 * error as its load is. `count`, `min` and `max` over the one relationship of a one-table route that the row already
 * holds are worked out from it; `sum` and `avg` always ask the database, so the value never depends on what was loaded
 * (JavaScript's sum of floats is not SQL's; ruling D33 OD4).
 */
async function rollupRows(
  plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string, computed: Extract<ComputedPlan, { kind: "rollup" }>, route: RollupRoute, tx: DataOperations, rows: Work[], pending?: object,
): Promise<void> {
  const { path, relation, target, column } = route;
  const owned = relation.kind === "belongs-to";
  const anchorOf = (row: Work) => row[owned ? relation.column : entityPlan.key];
  const asked: Work[] = [];
  for (const row of rows) {
    if (!route.joined && computed.fn !== "sum" && computed.fn !== "avg" && Object.hasOwn(row, path)) {
      row[name] = fromLoaded(computed, related(row[path]), column);
      continue;
    }
    const anchor = anchorOf(row);
    if (anchor === null || anchor === undefined) {
      if (owned && !relation.nullable && row !== pending) throw new FrameworkError(`${describe(entity, path, relation)} has no key in ${relation.column}, and it is not nullable`);
      row[name] = nothing(computed);
      continue;
    }
    asked.push(row);
  }
  const anchors = [...new Set(asked.map(anchorOf))] as RollupQuery["anchors"][number][];
  const found = new Map<unknown, unknown>();
  let query: Omit<RollupQuery, "anchors">;
  if (!route.joined) query = { fn: computed.fn, table: target.table, anchor: owned ? target.key : (relation as HasPlan & { column: string }).column, value: column };
  else {
    const start = owned ? planOf(plan, relation.target) : entityPlan;
    const hops = (owned ? route.steps.slice(1) : route.steps).map((step) => ({ hop: hopOf(plan, step) }));
    query = { fn: computed.fn, table: start.table, anchor: start.key, value: column, hops, key: target.key };
  }
  for (let at = 0; at < anchors.length; at += ROLLUP_ANCHORS)
    for (const result of await tx.rollup({ ...query, anchors: anchors.slice(at, at + ROLLUP_ANCHORS) })) found.set(result.anchor, result.value);
  for (const row of asked) {
    const anchor = anchorOf(row);
    if (found.has(anchor)) row[name] = found.get(anchor);
    else if (route.required)
      throw new FrameworkError(`\`${computed.fn} :${name} of=&${computed.of.join(".")}\` on ${entity} ${JSON.stringify(row[entityPlan.key])} reaches no ${route.targetName} row: a key on its path points at a row that does not exist`);
    else row[name] = nothing(computed);
  }
}

/** A `count`, `min` or `max` over rows already loaded: the answer the data layer gives (nulls skipped; none is null, a count 0). */
function fromLoaded(computed: Extract<ComputedPlan, { kind: "rollup" }>, rows: Row[], column: string): unknown {
  const values = rows.map((r) => r[column]).filter((value) => value !== null && value !== undefined) as Exclude<Scalar, null>[];
  if (computed.fn === "count") return values.length;
  const rank = (value: unknown) => (value instanceof Date ? value.getTime() : (value as number | string));
  const better = computed.fn === "min" ? (a: unknown, b: unknown) => rank(a) < rank(b) : (a: unknown, b: unknown) => rank(a) > rank(b);
  return values.reduce<unknown>((best, value) => (best === undefined || better(value, best) ? value : best), undefined) ?? null;
}

/**
 * One row's `count` or `max` over a has-many or has-one. With `where` (a caller's load the read policies admit row by
 * row) it is always queried with it: the rows loaded on `row` may be the copy the computed bodies loaded, which no
 * policy filtered.
 */
async function rollupOneRow(
  plan: LoadPlan, entity: string, entityPlan: EntityPlan, name: string, computed: Extract<ComputedPlan, { kind: "rollup" }>, tx: DataOperations, row: Work, where?: Condition,
): Promise<unknown> {
  const { path, relation, target, column } = rollupRoute(plan, entity, name, computed);
  // The rows are already here: the same answer the data layer gives (nulls are skipped; none is null, a count is 0), with no query.
  if (!where && Object.hasOwn(row, path)) return fromLoaded(computed, related(row[path]), column);
  if (row[entityPlan.key] === null || row[entityPlan.key] === undefined) return nothing(computed);
  const filter: Filter = { [(relation as HasPlan & { column: string }).column]: { eq: row[entityPlan.key] as never } };
  if (where) return computed.fn === "count" ? tx.count(target.table, column, filter, where) : tx.max(target.table, column, filter, where);
  return computed.fn === "count" ? tx.count(target.table, column, filter) : tx.max(target.table, column, filter);
}

/**
 * A caller's `filter` or `sort` naming a computed field or rollup of the entity fails here, with the milestone
 * that brings it, because the SQL evaluator (M10) is what filters and sorts by one. A read does it before
 * it touches the database, so a wrong result is never returned.
 *
 * Returns the filter to hand the data layer: the caller's, less every computed field whose comparison is `undefined`,
 * at any depth under `and` and `or`. Such a field is one left out: a generated filter type writes it as
 * `toString?: $Comparison<string> | undefined`, and a filter literal leaves out one named like a member of the Object
 * interface (`toString`, `valueOf`) only by giving it as `undefined`. The data layer has no column for it, so it
 * never sees it. A stored column given as `undefined` stays: the data layer leaves it out (`Filter`). A filter with
 * nothing to take out is returned as it is.
 */
export function rejectComputedQuery<F>(entity: string, computed: readonly string[], query: { readonly filter?: F | undefined; readonly sort?: unknown }): F | undefined {
  const fail = (name: string, what: "filter" | "sort") => {
    throw new FrameworkError(`A ${what} by ${entity}#${name} is not available yet: ${name} is a computed field or rollup, and filtering and sorting by one is evaluated by the SQL evaluator, which arrives in M10`);
  };
  const clean = (filter: unknown): unknown => {
    if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return filter;
    const kept: [string, unknown][] = [];
    let changed = false;
    for (const [key, value] of Object.entries(filter)) {
      if ((key === "and" || key === "or") && Array.isArray(value)) {
        const items = value.map(clean);
        const inner = items.some((item, index) => item !== value[index]);
        changed ||= inner;
        kept.push([key, inner ? items : value]);
      } else if (computed.includes(key)) {
        if (value !== undefined) fail(key, "filter");
        changed = true;
      } else kept.push([key, value]);
    }
    return changed ? Object.fromEntries(kept) : filter;
  };
  const filter = clean(query.filter) as F | undefined;
  if (Array.isArray(query.sort))
    for (const key of query.sort) {
      const name = typeof key === "string" && key.startsWith("-") ? key.slice(1) : key;
      if (typeof name === "string" && computed.includes(name)) fail(name, "sort");
    }
  return filter;
}

/**
 * Load the relationships and computed fields a function reads onto one record, in place (M5). Each path is dotted,
 * `owner` or `owner.todoCount`; a path that is already loaded costs nothing, so an action calls this before
 * each function that reads the record and pays for what is not there yet. `record` must be the plain row, not its guard.
 */
export async function loadInto(
  plan: LoadPlan, entity: string, tx: DataOperations, record: Row, paths: readonly string[], given: LoadOptions = {},
): Promise<void> {
  const options = { ...given, clock: pinClock(given.clock) };
  const passed: Options = options.newInstance ? { ...options, pending: record } : options;
  for (const path of paths) await ensurePath(plan, entity, tx, [record], path.split("."), passed, 0);
}

/**
 * Drop everything `loadInto` attached to a record. A `set` changes the columns a loaded relationship or
 * computed field was worked out from, so an action calls this after one and the next function reloads what it reads.
 */
export function unloadFrom(plan: LoadPlan, entity: string, record: Row): void {
  const entityPlan = planOf(plan, entity);
  for (const name of [...Object.keys(entityPlan.relations), ...Object.keys(entityPlan.computed)]) delete record[name];
}
