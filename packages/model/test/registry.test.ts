import { describe, expect, test } from "bun:test";
import {
  ATTRIBUTE_TYPES,
  attributeTypeInfo,
  isAttributeTypeName,
} from "../src/index.ts";

const NAMES = ["string", "integer", "float", "boolean", "uuid", "datetime", "atom"];

describe("ATTRIBUTE_TYPES", () => {
  test("lists exactly the aligned names", () => {
    expect(ATTRIBUTE_TYPES.map((t): string => t.name)).toEqual(NAMES);
  });

  test("is frozen, entries included", () => {
    expect(Object.isFrozen(ATTRIBUTE_TYPES)).toBe(true);
    for (const t of ATTRIBUTE_TYPES) expect(Object.isFrozen(t)).toBe(true);
    expect(() => (ATTRIBUTE_TYPES as unknown as unknown[]).push({})).toThrow();
  });

  test("has no duplicate names", () => {
    const names = ATTRIBUTE_TYPES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("only atom takes constraints", () => {
    expect(ATTRIBUTE_TYPES.filter((t) => t.takesConstraints).map((t) => t.name)).toEqual([
      "atom",
    ]);
  });

  test("maps each type to its generated TypeScript type", () => {
    const ts = Object.fromEntries(ATTRIBUTE_TYPES.map((t) => [t.name, t.tsType]));
    expect(ts).toEqual({
      string: "string",
      integer: "number",
      float: "number",
      boolean: "boolean",
      uuid: "string",
      datetime: "string",
      atom: "string",
    });
  });
});

describe("isAttributeTypeName", () => {
  test("accepts every registered name", () => {
    for (const t of ATTRIBUTE_TYPES) expect(isAttributeTypeName(t.name)).toBe(true);
  });

  test.each([
    ["number (replaced by integer and float, D8)", "number"],
    ["enum (replaced by atom with one-of, D9)", "enum"],
    ["wrong case", "String"],
    ["upper case", "UUID"],
    ["leading space", " string"],
    ["trailing space", "string "],
    ["trailing newline", "atom\n"],
    ["empty", ""],
    ["plural", "strings"],
    ["prototype key", "constructor"],
    ["prototype key toString", "toString"],
    ["Ash name not registered", "decimal"],
  ])("rejects %s", (_label, value) => {
    expect(isAttributeTypeName(value)).toBe(false);
  });

  test.each([[undefined], [null], [1], [{}], [["string"]], [true]])(
    "rejects non-string %p",
    (value) => {
      expect(isAttributeTypeName(value)).toBe(false);
    },
  );
});

describe("attributeTypeInfo", () => {
  test("returns the registry entry", () => {
    expect(attributeTypeInfo("atom")).toEqual({
      name: "atom",
      tsType: "string",
      takesConstraints: true,
    });
  });

  test("throws for an unregistered name, listing the registered ones", () => {
    expect(() => attributeTypeInfo("number" as never)).toThrow(
      '"number" is not a registered attribute type; registered: string, integer, float, boolean, uuid, datetime, atom',
    );
  });
});
