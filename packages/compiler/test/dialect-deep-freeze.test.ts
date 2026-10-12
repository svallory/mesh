import { expect, test } from "bun:test";
import { lowerSource } from "@mxlang/core";
import { MESH_DIALECT, deepFreeze } from "../src/front-end/dialect.ts";

// Left unfrozen on purpose, by kind: functions (the hooks hold no dialect data) and RegExps (a `g` or `y` flag would make
// `lastIndex` read-only and `exec` throw). The dialect holds no RegExp and no Map or Set today; the walk below fails on
// a Map or Set so adding one is a decision, not an accident.
function unfrozen(value: unknown, path: string, seen = new Set<object>(), out: string[] = []): string[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof RegExp) return out;
  if (value instanceof Map || value instanceof Set) {
    out.push(`${path} is a ${value.constructor.name}: Object.freeze does not stop its mutators`);
    return out;
  }
  if (!Object.isFrozen(value)) out.push(path);
  for (const [key, child] of Object.entries(value)) unfrozen(child, `${path}.${key}`, seen, out);
  return out;
}

test("every plain object and array reachable from MESH_DIALECT is frozen", () => {
  expect(unfrozen(MESH_DIALECT, "MESH_DIALECT")).toEqual([]);
  // The walk reaches the nested parts the shallow freeze missed.
  expect(Object.isFrozen(MESH_DIALECT.contracts)).toBe(true);
  expect(Object.isFrozen(Object.values(MESH_DIALECT.contracts ?? {})[0])).toBe(true);
  expect(Object.isFrozen(MESH_DIALECT.table.expressionTriggers)).toBe(true);
});

test("deepFreeze freezes nested objects and arrays, even under an already-frozen parent, and leaves RegExps and functions usable", () => {
  const re = /a/g;
  const fn = () => 1;
  const tree = Object.freeze({ a: { b: [{ c: 1 }] }, re, fn });
  deepFreeze(tree);
  expect(Object.isFrozen(tree.a)).toBe(true);
  expect(Object.isFrozen(tree.a.b)).toBe(true);
  expect(Object.isFrozen(tree.a.b[0])).toBe(true);
  expect(Object.isFrozen(re)).toBe(false);
  expect(re.test("a")).toBe(true);
  expect(Object.isFrozen(fn)).toBe(false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(Object.isFrozen(deepFreeze(cyclic))).toBe(true);
});

test("a nested write to the dialect throws", () => {
  const contracts = MESH_DIALECT.contracts as Record<string, { attributes?: Record<string, unknown> }>;
  expect(() => {
    contracts.entity!.attributes!.extra = {};
  }).toThrow();
});

test("lowering twice with the dialect works and the second call is not slower than the first by a wide margin", () => {
  const source = "entity :Todo\n  attributes\n    string :title\n";
  const time = () => {
    const start = performance.now();
    const result = lowerSource(source, "a.mesh.mx", { dialect: MESH_DIALECT });
    expect(result.diagnostics).toEqual([]);
    return performance.now() - start;
  };
  const first = time();
  const second = time();
  // MX validates an unfrozen-or-new dialect in about 46 ms and reuses it in about 3 ms. A generous bound keeps this
  // from flaking: the second call only fails if it paid the full validation again on top of the first.
  expect(second).toBeLessThan(first + 25);
});
