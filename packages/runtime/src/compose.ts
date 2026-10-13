import type { DataLayer, DataOperations, Key, Row, TableHandle } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { parseInput } from "./input.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * What the generated actions share when one action calls another inside its transaction (M5, CMP-16): a failed cast or
 * denial fails the running transaction (`failJoined`, `castInput`), and an update re-reads its row before its write when
 * a call made during its earlier phases wrote (`noteWrite`, `checkUnchanged`). A nested call is an entity value's
 * method (`Task.touch(input, context)`), which `entity.ts` runs on the binding in scope.
 */

/**
 * Reject with `cause`, failing the running transaction first when there is one: the rejection passes through the
 * layer's `transaction`, which joins it and marks it. At top level it passes through an empty transaction that rolls
 * back. Either way the caller gets `cause` itself.
 */
export function failJoined(layer: DataLayer, cause: unknown): Promise<never> {
  const rethrow = (): never => { throw cause; };
  return layer.transaction(() => Promise.reject(cause)).then(rethrow, rethrow);
}

/** A plain object: one an object literal, `JSON.parse` or `Object.create(null)` makes, not an instance of a class. */
function isPlain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of a caller's input for the validator, in which every plain object, at any depth, has no prototype; arrays are
 * copied around their items and anything else (a `Date`) is kept. A member input may be named like a member of
 * `Object.prototype` (`toString`, `constructor`: ENT-18), and so may a key of a read's `filter`. On a plain object a key
 * the caller left out reads as the inherited method, which the validator would refuse ("expected string, received
 * function"); on the copy it reads `undefined`, as any other name does.
 */
function withoutPrototypes(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const list: unknown[] = [];
    seen.set(value, list);
    for (const item of value) list.push(withoutPrototypes(item, seen));
    return list;
  }
  if (!isPlain(value)) return value;
  const copy: Record<string, unknown> = Object.create(null);
  seen.set(value, copy);
  // `defineProperty`, not `copy[key] = ...`: a `json` value may hold an own `__proto__` key (ENT-19), and on an object that
  // has a prototype an assignment to that name would change the prototype instead of making a property. This copy has
  // none, so the assignment would be safe here today; the definition stays safe whatever the copy becomes.
  for (const [key, member] of Object.entries(value))
    Object.defineProperty(copy, key, { value: withoutPrototypes(member, seen), writable: true, enumerable: true, configurable: true });
  return copy;
}

/**
 * The validator's output with the ordinary prototype at any depth: the action gets ordinary objects, as the caller would
 * write them (`input.hasOwnProperty(...)`, `String(input)` and `input instanceof Object` work). Zod 4, which the generated
 * validators use, already rebuilds every object it hands back with that prototype, `z.strictObject` and a `json` value
 * (`jsonValue`) alike, so for them this changes nothing. It is a safety net for a validator that hands back objects of the copy
 * `withoutPrototypes` made, which have none. Those are the cast's own copies, so they are changed in place, with no copy.
 * Only prototypes change, never keys; an own `__proto__` key of a `json` value (ENT-19) stays the data property it is, and
 * `Object.setPrototypeOf` sets the object's prototype, never that key.
 */
function ordinary(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) ordinary(item, seen);
    return value;
  }
  if (!isPlain(value)) return value;
  if (Object.getPrototypeOf(value) === null) Object.setPrototypeOf(value, Object.prototype);
  for (const member of Object.values(value)) ordinary(member, seen);
  return value;
}

/**
 * Cast a generated function's input. The cast runs before the function opens or joins a transaction. First the layer
 * says whether the call runs inside a transaction, and refuses it if that transaction has already failed
 * (`DataLayer.refuseIfFailed`), so such a call does nothing. Inside a running transaction, called directly from its module
 * (`#mesh/domain/<module>`) or from a function of an entity file, a failed cast goes through `failJoined`: it fails that transaction like any other failed call,
 * even when the caller catches it. At top level the caller gets the cast error at once, as from `parseInput`: no
 * transaction opens and no lock is taken.
 *
 * The validator sees the input's own members only (`withoutPrototypes`); the action gets ordinary objects (`ordinary`).
 * There a member input named like a member of `Object.prototype` that the caller left out reads as the inherited member
 * (ENT-18's accepted cost), so generated code tells a given member by `$Object.hasOwn`.
 */
export async function castInput<T>(layer: DataLayer, schema: StandardSchemaV1<unknown, T>, input: unknown): Promise<T> {
  const joined = layer.refuseIfFailed();
  // An `await`, not `.catch`: the error's async stack then keeps the generated function that called this, so its first
  // frame outside Mesh's packages is still the generated action (blog acceptance 3).
  try {
    return ordinary(await parseInput(schema, withoutPrototypes(input))) as T;
  } catch (cause) {
    if (!joined) throw cause;
    return failJoined(layer, cause);
  }
}

/** What `castInput` gives for a schema: a read action that has cast its input for its policies hands it to the read's body, which does not cast it again. */
export type CastOutput<S> = S extends StandardSchemaV1<unknown, infer T> ? T : never;

const writes = new WeakMap<DataOperations, number>();

/** Count one write a generated action made through `operations`, the running transaction's. */
export function noteWrite(operations: DataOperations): void {
  writes.set(operations, (writes.get(operations) ?? 0) + 1);
}

/** How many writes generated actions have made through `operations` so far. */
export function writeCount(operations: DataOperations): number {
  return writes.get(operations) ?? 0;
}

/**
 * Before an update's own write: when a call made during the update's earlier phases wrote anything (`writeCount` moved
 * past `since`), re-read the row by key and compare it with `before`, the copy read under the lock. A difference means
 * a nested call changed or deleted this very row, so the update's checks and steps decided on a stale row: it is a
 * `FrameworkError` that says to move the call after the write.
 */
export async function checkUnchanged(operations: DataOperations, since: number, table: TableHandle, key: Key, before: Row, where: string): Promise<void> {
  if (writeCount(operations) === since) return;
  const now = await operations.selectByKey(table, key);
  if (now !== undefined && sameValue(now, before)) return;
  throw new FrameworkError(`${where}: a call made before this action's write ${now === undefined ? "deleted" : "changed"} the row this action is updating (${JSON.stringify(key)}), so this action's checks and steps decided on a stale row. Make the call from a step that runs after the write: run [after=:write]`);
}

/**
 * Equal stored values: dates by time, byte arrays by content, objects and arrays member by member. The contract v1
 * suite uses it too, to check that an adapter's two reads by key decode a row identically.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((byte, index) => byte === right[index]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
