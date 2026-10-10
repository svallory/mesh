import { FrameworkError } from "./errors.ts";

/**
 * The in-memory half of Mesh's expressions (M4, ADR-0010, ADR-0012 option A).
 *
 * A value is `true`, `false` or unknown, and unknown is `null`; `undefined` is read as `null`.
 * Every function is total: it accepts null and never throws on one, so evaluating both
 * operands of `and` is the same as short-circuiting and is what SQL does. The meaning of
 * each function is its table in `EXPRESSION_TABLES` (`@meshfw/runtime/testing`); the M10
 * SQL evaluator must give the same answers.
 */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** The roots an expression reads (`self`, `input`, ...) and the clock `now()` reads. */
export type Scope<T extends object = Record<string, unknown>> = T & { readonly clock: Clock };

const instants = new WeakMap<object, Date>();

/** A scope for one evaluation run: `now()` is read from `clock` once and then fixed. */
export function scope<T extends object>(roots: T, options: { clock?: Clock } = {}): Scope<T> {
  return { ...roots, clock: options.clock ?? systemClock };
}

const isNull = (v: unknown): v is null | undefined => v === null || v === undefined;
const key = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

function bool(v: unknown, fn: string): boolean | null {
  if (v === true || v === false) return v;
  if (isNull(v)) return null;
  throw new FrameworkError(`expression ${fn}: operand is not a boolean (${typeof v}); write a comparison`);
}
const num = (v: unknown): unknown => key(v);

function list(v: unknown, fn: string): readonly unknown[] | null {
  if (v === undefined) throw new FrameworkError(`expression ${fn}: the list was not loaded`);
  if (v === null) return null;
  if (!Array.isArray(v)) throw new FrameworkError(`expression ${fn}: operand is not a list`);
  return v;
}

export const eq = (a: unknown, b: unknown): boolean | null => (isNull(a) || isNull(b) ? null : key(a) === key(b));
export const ne = (a: unknown, b: unknown): boolean | null => not(eq(a, b));
export const isNullFn = (a: unknown): boolean => isNull(a);
export const isNotNull = (a: unknown): boolean => !isNull(a);
const order = (a: unknown, b: unknown, test: (x: number, y: number) => boolean): boolean | null =>
  isNull(a) || isNull(b) ? null : test(num(a) as number, num(b) as number);
export const lt = (a: unknown, b: unknown) => order(a, b, (x, y) => x < y);
export const lte = (a: unknown, b: unknown) => order(a, b, (x, y) => x <= y);
export const gt = (a: unknown, b: unknown) => order(a, b, (x, y) => x > y);
export const gte = (a: unknown, b: unknown) => order(a, b, (x, y) => x >= y);

export function and(a: unknown, b: unknown): boolean | null {
  const x = bool(a, "and"), y = bool(b, "and");
  if (x === false || y === false) return false;
  return x === null || y === null ? null : true;
}
export function or(a: unknown, b: unknown): boolean | null {
  const x = bool(a, "or"), y = bool(b, "or");
  if (x === true || y === true) return true;
  return x === null || y === null ? null : false;
}
export function not(a: unknown): boolean | null {
  const x = bool(a, "not");
  return x === null ? null : !x;
}

const arithmetic = (a: unknown, b: unknown, f: (x: number, y: number) => number | null): number | null =>
  isNull(a) || isNull(b) ? null : f(a as number, b as number);
export const add = (a: unknown, b: unknown) => arithmetic(a, b, (x, y) => x + y);
export const sub = (a: unknown, b: unknown) => arithmetic(a, b, (x, y) => x - y);
export const mul = (a: unknown, b: unknown) => arithmetic(a, b, (x, y) => x * y);
export const div = (a: unknown, b: unknown) => arithmetic(a, b, (x, y) => (y === 0 ? null : x / y));
/** Integer division, truncating toward zero (`7/2` is 3, `-7/2` is -3), as SQLite and Postgres divide two integers. */
export const idiv = (a: unknown, b: unknown) => arithmetic(a, b, (x, y) => (y === 0 ? null : Math.trunc(x / y) + 0));
export const neg = (a: unknown): number | null => (isNull(a) ? null : -(a as number) + 0);

/** String: Unicode code points (what SQLite `length()` and Postgres `char_length()` count). List: its size. */
export function length(a: unknown): number | null {
  if (a === undefined) throw new FrameworkError("expression length: the list was not loaded");
  if (a === null) return null;
  if (typeof a === "string") { let n = 0; for (const _ of a) n++; return n; }
  if (Array.isArray(a)) return a.length;
  throw new FrameworkError("expression length: operand is not a string or a list");
}

/** The scope's one instant: the clock is read on the first call and the result reused. */
export function now(s: Scope): Date {
  let at = instants.get(s);
  if (!at) { at = s.clock(); instants.set(s, at); }
  return new Date(at.getTime());
}
export function today(s: Scope): Date {
  return new Date(Math.floor(now(s).getTime() / 86_400_000) * 86_400_000);
}

export const coalesce = <T>(a: T | null | undefined, b: T): T | null => (isNull(a) ? (isNull(b) ? null : b) : a);
export function cond<T>(c: unknown, a: T, b: T): T {
  return bool(c, "cond") === true ? a : b;
}

const holdsTest = (v: unknown, fn: string) => bool(v, fn) === true;
/** `true` iff some element's predicate is true; an unknown predicate does not count. */
export function some<T>(items: readonly T[] | null | undefined, p: (item: T) => unknown): boolean | null {
  const l = list(items, "some") as readonly T[] | null;
  return l === null ? null : l.some((x) => holdsTest(p(x), "some"));
}
/** `true` iff every element's predicate is true; an unknown predicate makes it false (M10: `NOT EXISTS (... WHERE p IS NOT TRUE)`). */
export function every<T>(items: readonly T[] | null | undefined, p: (item: T) => unknown): boolean | null {
  const l = list(items, "every") as readonly T[] | null;
  return l === null ? null : l.every((x) => holdsTest(p(x), "every"));
}
export function find<T>(items: readonly T[] | null | undefined, p: (item: T) => unknown): T | null {
  const l = list(items, "find") as readonly T[] | null;
  return l === null ? null : (l.find((x) => holdsTest(p(x), "find")) ?? null);
}
export function filter<T>(items: readonly T[] | null | undefined, p: (item: T) => unknown): T[] | null {
  const l = list(items, "filter") as readonly T[] | null;
  return l === null ? null : l.filter((x) => holdsTest(p(x), "filter"));
}

/** A value used in a boolean position, from code Mesh does not control (an imported helper): booleans and null pass, anything else throws. */
export const asBool = (v: unknown): boolean | null => bool(v, "helper");
/** A rule holds only when it is `true`: unknown fails a `check`, skips a `when`, excludes a row. */
export const holds = (v: unknown): boolean => v === true;

/** The namespace generated code calls: `$.gte(a, b)`. */
export const expr = Object.freeze({
  eq, ne, isNull: isNullFn, isNotNull, lt, lte, gt, gte, and, or, not,
  add, sub, mul, div, idiv, neg, length, now, today, coalesce, cond,
  some, every, find, filter, asBool, holds,
});
