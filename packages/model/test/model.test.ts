import { describe, expect, test } from "bun:test";
import { findNonJsonValue, isProjectRelativePath } from "../src/index.ts";
import { bareDocument, postDocument, postFile } from "./sample.ts";
import { positionOf } from "./source.ts";

describe("v4 model", () => {
  for (const document of [postDocument, bareDocument]) {
    test("round trips as plain JSON, with absent properties omitted", () => {
      expect(findNonJsonValue(document)).toBeNull();
      expect(JSON.parse(JSON.stringify(document))).toStrictEqual(document);
    });
  }
  test("reference represents the complete Invoice, including expressions and imports", () => {
    const entity = postDocument.entities[0]!;
    expect(entity.name).toBe("Invoice");
    expect(entity.module).toBe("billing");
    expect(entity.imports).toHaveLength(4);
    expect(entity.attributes).toHaveLength(12);
    expect(entity.relationships.map((r) => r.kind)).toEqual([
      "belongs-to",
      "has-many",
      "has-one",
    ]);
    expect(entity.relationships.map((r) => r.keyColumn)).toEqual([
      "customerId",
      undefined,
      undefined,
    ]);
    expect(entity.computed).toHaveLength(4);
    expect(entity.actions).toHaveLength(7);
    expect(entity.always).toHaveLength(1);
    expect(entity.policies).toHaveLength(3);
    expect(entity.auto).toEqual(["read", "destroy"]);
    expect(entity.onLoad?.name).toBe("visible");
    expect(entity.actions[2]!.do.map((s) => s.kind)).toEqual([
      "set",
      "when",
      "load",
    ]);
    expect(entity.actions[3]!.input[0]).toMatchObject({
      kind: "argument",
      name: "percent",
      min: 0,
      max: 100,
    });
    expect(entity.attributes[0]).toMatchObject({
      primaryKey: true,
      nullable: false,
    });
    expect(entity.attributes[10]).toMatchObject({
      type: "timestamp",
      on: "create",
    });
    expect(entity.attributes[2]!.default).toEqual({ value: "draft" });
  });
  test("every position is project-relative", () => {
    JSON.stringify(postDocument, (_key, value) => {
      if (value && typeof value === "object" && "offset" in value) {
        expect(value.file).toBe(postFile);
        expect(isProjectRelativePath(value.file)).toBe(true);
        expect(value.line).toBeGreaterThan(0);
        expect(value.column).toBeGreaterThanOrEqual(0);
      }
      return value;
    });
  });
});
describe("findNonJsonValue", () => {
  test.each([
    ["undefined", { a: undefined }, "$.a"],
    ["nested undefined", { a: [{ b: undefined }] }, "$.a[0].b"],
    ["array hole", [1, undefined], "$[1]"],
    ["function", { a: () => 1 }, "$.a"],
    ["Infinity", { a: Infinity }, "$.a"],
    ["negative infinity", [-Infinity], "$[0]"],
    ["NaN", { a: NaN }, "$.a"],
    ["bigint", { a: 1n }, "$.a"],
    ["symbol", { a: Symbol() }, "$.a"],
    ["Map", { a: new Map() }, "$.a"],
    ["Set", { a: new Set() }, "$.a"],
    ["Date", { a: new Date() }, "$.a"],
    ["class", { a: new (class X {})() }, "$.a"],
    ["RegExp", { a: /x/ }, "$.a"],
  ])("rejects %s", (_name, value, path) =>
    expect(findNonJsonValue(value)).toBe(path),
  );
  test.each(
    [
      null,
      0,
      -0.5,
      1e300,
      "",
      false,
      [],
      {},
      { a: [1, "x", null] },
      Object.create(null),
    ].map((value) => [value]),
  )("accepts %p", (value) => expect(findNonJsonValue(value)).toBeNull());
});
describe("positions and paths", () => {
  test("UTF-16 offsets, 1-based line and 0-based column", () => {
    expect(positionOf("ab\ncd", "f.mx", "d")).toEqual({
      file: "f.mx",
      line: 2,
      column: 1,
      offset: 4,
    });
    expect(positionOf("😀x", "f.mx", "x").offset).toBe(2);
    expect(positionOf("a a a", "f.mx", "a", 2).offset).toBe(4);
    expect(() => positionOf("a", "f.mx", "b")).toThrow();
  });
  test.each([
    "src/domain/todo/todo.mesh.mx",
    "todo.mesh.mx",
    "a/b/c.mesh.mx",
    "with space/a.mesh.mx",
  ])("accepts %s", (p) => expect(isProjectRelativePath(p)).toBe(true));
  test.each([
    "/Users/me/app",
    "C:/app/post",
    "c:\\app",
    "a\\b",
    "../post",
    "a/../post",
    "./post",
    "a//post",
    "a/",
    "",
  ])("rejects %s", (p) => expect(isProjectRelativePath(p)).toBe(false));
});
