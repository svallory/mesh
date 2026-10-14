import { FrameworkError } from "./errors.ts";

/**
 * The in-memory half of Mesh's expressions (M4, ADR-0010, ADR-0012 option A).
 *
 * A value is `true`, `false` or unknown, and unknown is `null`; `undefined` is read as `null`.
 * Every function is total: it accepts null and never throws on one. The right side of `and`, `or`
 * and `coalesce` and both branches of `cond` are thunks (`FunctionSpec.lazy`), called only when the
 * left side lets them, so an imported helper behind a guard runs only then (EXP-03); an unknown
 * (null) guard still calls them, as SQL would. The meaning of each function is its table in
 * `EXPRESSION_TABLES` (`@meshfw/runtime/testing`), whose rows hold plain values; the M10 SQL
 * evaluator must give the same answers.
 */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** The roots an expression reads (`self`, `input`, ...) and the clock `%.now` and `%.today` read. */
export type Scope<T extends object = Record<string, unknown>> = T & { readonly clock: Clock };

/**
 * A clock that reads `clock` on its first call and gives that same instant (a fresh `Date` each time) after: one instant
 * per transaction. `ActionFrame.clock` keeps the pinned clock in the frame's store, so every call and read joined to the
 * transaction shares it; a call or read outside any transaction pins its own.
 */
export function pinClock(clock: Clock = systemClock): Clock {
  let at: number | undefined;
  return () => new Date(at ??= clock().getTime());
}

const instants = new WeakMap<object, Date>();

/** A scope for one evaluation run: `now()` is read from `clock` once and then fixed. */
export function scope<T extends object>(roots: T, options: { clock?: Clock | undefined } = {}): Scope<T> {
  return { ...roots, clock: options.clock ?? systemClock };
}

/**
 * The same scope with some roots replaced: the functions that run after the write see the stored record as `self`.
 * `now()` in the new scope is the instant of `from`, so one action reads one instant before and after its write.
 */
export function rescope<S extends { readonly clock: Clock }>(from: S, roots: object): S {
  return { ...from, ...roots, clock: () => now(from as unknown as Scope) };
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

/** A definitely false `a` is the answer and `b` is not called; an unknown `a` calls it, as SQL would. */
export function and(a: unknown, b: () => unknown): boolean | null {
  const x = bool(a, "and");
  if (x === false) return false;
  const y = bool(b(), "and");
  if (y === false) return false;
  return x === null || y === null ? null : true;
}
/** A definitely true `a` is the answer and `b` is not called; an unknown `a` calls it, as SQL would. */
export function or(a: unknown, b: () => unknown): boolean | null {
  const x = bool(a, "or");
  if (x === true) return true;
  const y = bool(b(), "or");
  if (y === true) return true;
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

/** `b` is called only when `a` is null. */
export function coalesce<T>(a: T | null | undefined, b: () => T): T | null {
  if (!isNull(a)) return a;
  const y = b();
  return isNull(y) ? null : y;
}
/** Only the branch taken is called; an unknown test takes the else branch. */
export function cond<T>(c: unknown, a: () => T, b: () => T): T {
  return bool(c, "cond") === true ? a() : b();
}

/**
 * `Mesh.isSystem(context)`: true only when the value is an object whose `system` key is `true` (ADR-0071). Never unknown: a missing
 * context, a missing key or any other value is false, so a policy that admits internal writes with it fails closed.
 */
export const isSystem = (context: unknown): boolean =>
  context !== null && typeof context === "object" && (context as { system?: unknown }).system === true;

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
/**
 * What an imported function a translated expression calls returned (EXP-03): such a call is synchronous and pure, so a
 * promise is refused. The type checker refuses it where the function's type says it returns one (the parameter is then
 * `never`); this refuses it at run time where its type does not (`any`, `unknown`). The promise's own outcome is dropped:
 * the expression has already failed.
 */
export function pure<T>(value: T & (T extends PromiseLike<unknown> ? never : unknown), name: string): T {
  const v = value as unknown;
  if (v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function") {
    (v as PromiseLike<unknown>).then(undefined, () => {});
    throw new FrameworkError(`expression helper ${name}() returned a promise: a translated expression calls an imported function synchronously. Await it inside an async arrow (\`async (...) => ... await ${name}(...)\`), which makes the function plain code`);
  }
  return value;
}
/** A rule holds only when it is `true`: unknown fails a `check`, skips a `when`, excludes a row. */
export const holds = (v: unknown): boolean => v === true;

/** The namespace generated code calls: `$.gte(a, b)`. */
export const expr = Object.freeze({
  eq, ne, isNull: isNullFn, isNotNull, lt, lte, gt, gte, and, or, not,
  add, sub, mul, div, idiv, neg, length, now, today, coalesce, cond, isSystem,
  some, every, find, filter, asBool, holds, pure,
});
