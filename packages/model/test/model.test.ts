import { describe, expect, test } from "bun:test";
import { isAttributeTypeName } from "../src/index.ts";
import { bareDocument, postDocument } from "./sample.ts";

/** Fails on anything JSON would drop or change: undefined, functions, Maps, class instances. */
function assertPlainData(value: unknown, path = "$"): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${path}: non-finite number`);
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertPlainData(v, `${path}[${i}]`));
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${path}: not a plain object`);
      }
      for (const [k, v] of Object.entries(value)) assertPlainData(v, `${path}.${k}`);
      return;
    }
    default:
      throw new Error(`${path}: ${typeof value} is not plain data`);
  }
}

describe("model documents", () => {
  test.each([
    ["post", postDocument],
    ["bare", bareDocument],
  ])("%s document round-trips through JSON unchanged", (_n, doc) => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(JSON.stringify(JSON.parse(JSON.stringify(doc)))).toBe(JSON.stringify(doc));
  });

  test.each([
    ["post", postDocument],
    ["bare", bareDocument],
  ])("%s document is plain data", (_n, doc) => {
    expect(() => assertPlainData(doc)).not.toThrow();
  });

  test("assertPlainData catches what JSON would lose", () => {
    expect(() => assertPlainData({ a: undefined })).toThrow("$.a: undefined");
    expect(() => assertPlainData({ a: () => 1 })).toThrow("$.a: function");
    expect(() => assertPlainData({ a: new Map() })).toThrow("$.a: not a plain object");
  });

  test("sample attribute types are all registered", () => {
    for (const r of postDocument.resources)
      for (const a of r.attributes) expect(isAttributeTypeName(a.type)).toBe(true);
  });

  test("every position has 1-based line, 0-based column and a non-negative offset", () => {
    const r = postDocument.resources[0]!;
    const positions = [
      r.position,
      r.primaryKey!.position,
      r.createTimestamp!.position,
      r.updateTimestamp!.position,
      r.defaults!.position,
      ...r.attributes.map((a) => a.position),
      ...r.actions.map((a) => a.position),
    ];
    for (const p of positions) {
      expect(p.file).toBe("resources/post.mx");
      expect(p.line).toBeGreaterThanOrEqual(1);
      expect(p.column).toBeGreaterThanOrEqual(0);
      expect(p.offset).toBeGreaterThanOrEqual(0);
    }
    expect(r.position).toEqual({ file: "resources/post.mx", line: 1, column: 0, offset: 0 });
  });
});
