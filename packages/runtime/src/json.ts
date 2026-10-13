/** What `jsonValue` needs of the context Zod hands a `transform`: a list that takes an issue. */
export interface JsonContext {
  readonly issues: { push(issue: { code: "custom"; message: string; input: unknown }): unknown };
}

const REFUSED = Symbol("refused");

/**
 * A plain object, as Zod 4.6.5 reads it (`isPlainObject`, which `z.json()` uses): not an instance of a class. The test
 * is Zod's own, so the values `jsonValue` accepts are those `z.json()` accepted: an object literal, `JSON.parse`'s,
 * `Object.create(null)`'s, one from another realm.
 */
function isPlain(value: object): boolean {
  const constructor = (value as { constructor?: unknown }).constructor;
  if (constructor === undefined || typeof constructor !== "function") return true;
  const prototype: unknown = constructor.prototype;
  if (prototype === null || typeof prototype !== "object" || Array.isArray(prototype)) return false;
  return Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf");
}

/** Write an own data property, whatever its name. An assignment `object[key] = value` with `key` `__proto__` would change the prototype instead (ENT-19). */
function define(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

function copy(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : REFUSED;
  if (typeof value !== "object") return REFUSED;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const list: unknown[] = [];
    seen.set(value, list);
    // By index, as `z.array` does: a hole reads `undefined`, which is refused.
    for (let index = 0; index < value.length; index++) {
      const item = copy(value[index], seen);
      if (item === REFUSED) return REFUSED;
      list.push(item);
    }
    return list;
  }
  if (!isPlain(value)) return REFUSED;
  const object: Record<string, unknown> = {};
  seen.set(value, object);
  // Own enumerable keys, as `z.record` reads them; one that is a symbol is refused. `__proto__` is a key like any other.
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
    if (typeof key !== "string") return REFUSED;
    const member = copy((value as Record<string, unknown>)[key], seen);
    if (member === REFUSED) return REFUSED;
    define(object, key, member);
  }
  return object;
}

/**
 * The validator of a `json` attribute or argument, for Zod's `transform` (`z.unknown().transform(jsonValue)`). It accepts
 * what `z.json()` of Zod 4.6.5 accepted, and gives back a copy of the value in which every own key is kept, an own
 * `__proto__` key included, as data (ENT-19): strings, booleans, `null`, finite numbers, arrays and plain objects, at any
 * depth. Anything else (`undefined`, a function, a `Date`, a non-finite number, a hole in an array, a symbol key, an
 * instance of a class) is one issue, "Invalid input", at the path of the value itself, as `z.json()` reported it.
 * A cycle and a shared reference are kept in the copy, as `z.json()` kept them. Every object of the copy has the
 * ordinary prototype, and no prototype is ever taken from the data.
 */
export function jsonValue(value: unknown, context: JsonContext): unknown {
  const result = copy(value, new Map());
  if (result === REFUSED) {
    context.issues.push({ code: "custom", message: "Invalid input", input: value });
    return undefined;
  }
  return result;
}
