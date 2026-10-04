import { describe, expect, test } from "bun:test";
import { ACTION_TYPES, isActionKind } from "../src/index.ts";

describe("ACTION_TYPES", () => {
  test("lists the four kinds", () => {
    expect([...ACTION_TYPES]).toEqual(["create", "read", "update", "destroy"]);
  });

  test("is frozen and has no duplicates", () => {
    expect(Object.isFrozen(ACTION_TYPES)).toBe(true);
    expect(() => (ACTION_TYPES as unknown as string[]).push("x")).toThrow();
    expect(new Set(ACTION_TYPES).size).toBe(ACTION_TYPES.length);
  });
});

describe("isActionKind", () => {
  test("accepts every registered kind", () => {
    for (const k of ACTION_TYPES) expect(isActionKind(k)).toBe(true);
  });

  test.each([["Create"], ["READ"], [" read"], ["read "], ["upsert"], [""], ["constructor"], ["toString"]])(
    "rejects %p",
    (v) => expect(isActionKind(v)).toBe(false),
  );

  test.each([[undefined], [null], [1], [["read"]]])("rejects non-string %p", (v) =>
    expect(isActionKind(v)).toBe(false),
  );
});
