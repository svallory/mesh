/**
 * Path (`$.resources[0].attributes[2].default`) of the first value in `value` that
 * would not survive `JSON.stringify`/`JSON.parse` unchanged, or null when there is
 * none. Offenders: `undefined` (also as an object value), functions, symbols, bigint,
 * non-finite numbers (`Infinity` becomes `null` in JSON), and anything that is not a
 * plain object or array (Map, Set, Date, class instances).
 *
 * The builder runs this on the document before it is written, so a model that cannot
 * round-trip is a build error, not a silently different `model.json`.
 */
export function findNonJsonValue(value: unknown, path = "$"): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : path;
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const bad = findNonJsonValue(value[i], `${path}[${i}]`);
          if (bad !== null) return bad;
        }
        return null;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return path;
      for (const [k, v] of Object.entries(value)) {
        const bad = findNonJsonValue(v, `${path}.${k}`);
        if (bad !== null) return bad;
      }
      return null;
    }
    default:
      return path;
  }
}
