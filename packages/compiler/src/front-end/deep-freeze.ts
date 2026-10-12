/**
 * Freezes `value` and every plain object and array reachable from it, in place, and returns it. MX core reuses its
 * validation of a dialect whenever the top object is frozen, so a nested object that stayed mutable could change
 * after that and be silently ignored. Functions (the hooks) and `RegExp`s are left alone: freezing a RegExp with the
 * `g` or `y` flag makes `lastIndex` read-only and `exec` throw, and a function holds no dialect data. `Map` and `Set`
 * are not plain objects and `Object.freeze` would not stop `.set()`/`.add()` anyway; the dialect holds none.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  // Already-frozen objects are walked too: a shallow `Object.freeze` can hide mutable children.
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (!Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return value;
}
