// What a surface's generated manifest (`<output>/surfaces/<name>/index.ts`) calls, and the manifest's types: readers
// (adapters such as `@meshfw/jsonrpc`) read a manifest at run time and import nothing of the model (ADR-0077).
import { InvalidInputError, type Issue } from "./errors.ts";
import type { ContextArgument } from "./index.ts";

/** An action's type. The model package's `ActionType`, declared here because the runtime depends on no package. */
export type SurfaceActionKind = "create" | "read" | "update" | "destroy";

/** The properties of `T` named in `F`, through arrays; `void`, `undefined` and `null` stay as they are. What leaves through a surface. */
export type Projected<T, F extends string> =
  [T] extends [void | undefined | null] ? T
  : T extends readonly (infer E)[] ? Projected<E, F>[]
  : { readonly [K in Extract<keyof T, F>]: T[K] };

const own = (record: object, name: string) => Object.prototype.hasOwnProperty.call(record, name);

function projectOne(record: unknown, fields: readonly string[]): unknown {
  if (record === null || typeof record !== "object") return record;
  const copy: { [name: string]: unknown } = {};
  for (const name of fields)
    if (own(record, name)) Object.defineProperty(copy, name, { value: (record as { [name: string]: unknown })[name], enumerable: true, writable: true, configurable: true });
  return Object.freeze(copy);
}

/**
 * Copies the own properties named in `fields` from a record, or from each record of an array; `undefined` and `null`
 * pass through. A property the record does not hold (a computed field not loaded) is left out. The copy is frozen.
 * Every other property, a loaded related record included, stays behind.
 */
export function project<T, const F extends string>(value: T, fields: readonly F[]): Projected<T, F> {
  if (Array.isArray(value)) return Object.freeze(value.map((record) => projectOne(record, fields))) as unknown as Projected<T, F>;
  return projectOne(value, fields) as Projected<T, F>;
}

const isObject = (value: unknown): value is { [key: string]: unknown } => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * R14a: refuses a read input whose `filter` (at any depth of `and`/`or`, read the way the data layer reads a filter: a
 * key given as `undefined` is left out), `sort` (a key with its leading `-` removed) or `load` names anything outside
 * `fields` (for filter and sort) or `loadable` (for load: the listed computed fields). Throws `InvalidInputError` with
 * every such name as an issue (`path` `["filter", "body"]`, `["filter", "and", 0, "body"]`, `["sort", 1]`, `["load", 0]`;
 * `code` `"not_exposed"`). An input that is not an object, or a malformed filter, sort or load, is left to the
 * action's own cast. Runs before the action, so no policy runs and no row is read for a refused input.
 */
export function checkRead(input: unknown, fields: readonly string[], loadable: readonly string[]): void {
  if (!isObject(input)) return;
  const issues: Issue[] = [];
  const refuse = (path: (string | number)[], message: string) =>
    issues.push({ label: null, code: "not_exposed", path, message, source: null, details: null });
  const notField = (name: string, verb: string) => fields.length
    ? `\`${name}\` is not a field of this surface: ${verb} by one of ${fields.join(", ")}`
    : `\`${name}\` is not a field of this surface, which lets no field leave`;
  const walk = (filter: unknown, path: (string | number)[]) => {
    if (!isObject(filter)) return;
    for (const [key, value] of Object.entries(filter)) {
      // `and` and `or` are the filter's combinators, never fields; one that holds no list is the cast's to refuse.
      if (key === "and" || key === "or") { if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, key, index])); }
      else if (value !== undefined && !fields.includes(key)) refuse([...path, key], notField(key, "filter"));
    }
  };
  walk(input.filter, ["filter"]);
  if (Array.isArray(input.sort))
    input.sort.forEach((key, index) => {
      if (typeof key !== "string") return;
      const name = key.startsWith("-") ? key.slice(1) : key;
      if (!fields.includes(name)) refuse(["sort", index], notField(name, "sort"));
    });
  if (Array.isArray(input.load))
    input.load.forEach((name, index) => {
      if (typeof name !== "string" || loadable.includes(name)) return;
      refuse(["load", index], loadable.length
        ? `\`${name}\` is not a computed field this surface lists: load one of ${loadable.join(", ")}`
        : `\`${name}\` is not a computed field this surface lists, and it lists none to load`);
    });
  if (issues.length) throw new InvalidInputError(issues);
}

/** The leaf of a generated filter union (`PostFilter` without its `and`/`or` arms). */
type FilterLeaf<U> = Exclude<U, { and: unknown } | { or: unknown }>;
/** A generated filter narrowed to the properties `F`, through `and`/`or`. */
export type NarrowedFilter<U, F extends string> =
  | { and: readonly NarrowedFilter<U, F>[] }
  | { or: readonly NarrowedFilter<U, F>[] }
  | { [K in Extract<keyof FilterLeaf<U>, F>]?: FilterLeaf<U>[K] };
/** A generated sort narrowed to the properties `F`, ascending or descending. */
export type NarrowedSort<S, F extends string> = S extends readonly (infer E)[] ? readonly Extract<E, F | `-${F}`>[] : never;
/** A read's input (without `load`, which the manifest types itself) with `filter` and `sort` narrowed to `F`. */
export type SurfaceReadInput<I extends { filter?: unknown; sort?: unknown }, F extends string> =
  Omit<I, "filter" | "sort"> & {
    filter?: NarrowedFilter<NonNullable<I["filter"]>, F> | undefined;
    sort?: NarrowedSort<NonNullable<I["sort"]>, F> | undefined;
  };

/** One action a surface lets its audience call. */
export interface SurfaceAction<I = never, O = unknown> {
  /** The action's type: `create`, `read`, `update` or `destroy`. */
  readonly kind: SurfaceActionKind;
  /** Runs the entity's action with the caller's context and returns its result projected to the expose line's fields. */
  run(input: I, ...context: ContextArgument): Promise<O>;
}
/** One expose line, as generated. */
export interface SurfaceExposure {
  /** The exposed entity's FQN (`work.Task`). */
  readonly entity: string;
  /** `label=`, or the exposed name. */
  readonly label: string;
  /** The record properties that leave, in declaration order (a belongs-to as its key column, `authorId`). */
  readonly fields: readonly string[];
  /** One entry per action line; an action the line does not list has none. */
  readonly actions: { readonly [name: string]: SurfaceAction<any, unknown> };
}
/** A surface's manifest: what one audience may call and see. Readers (adapters) read it at run time. */
export interface Surface {
  /** The surface's name (`admin`). */
  readonly name: string;
  /** One entry per expose line, under its exposed name. */
  readonly expose: { readonly [name: string]: SurfaceExposure };
  /** The FQNs of the events the surface sends out: pass them as `names` to `subscribe`. */
  readonly publishes: readonly string[];
}

function freezeDeep(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) freezeDeep((value as { [key: PropertyKey]: unknown })[key], seen);
}

/** Freezes a generated manifest, deeply (functions are not walked into), and returns it with its literal type. */
export function defineSurface<const S extends Surface>(surface: S): S {
  freezeDeep(surface, new WeakSet());
  return surface;
}
