import { expect, test } from "bun:test";
import {
  ATTRIBUTE_TYPES,
  attributeTypeInfo,
  isAttributeTypeName,
} from "../src/index.ts";
test("registry defines exactly the eleven v4 tags", () => {
  expect(ATTRIBUTE_TYPES.map((t) => t.name)).toEqual([
    "uuid",
    "string",
    "integer",
    "float",
    "decimal",
    "boolean",
    "enum",
    "date",
    "datetime",
    "timestamp",
    "json",
  ]);
  expect(new Set(ATTRIBUTE_TYPES.map((t) => t.name)).size).toBe(11);
  expect(Object.isFrozen(ATTRIBUTE_TYPES)).toBe(true);
  for (const entry of ATTRIBUTE_TYPES) {
    expect(isAttributeTypeName(entry.name)).toBe(true);
    expect(attributeTypeInfo(entry.name)).toBe(entry);
  }
});
test.each(
  [
    "atom",
    "number",
    "String",
    "UUID",
    " string",
    "enum\n",
    "",
    "constructor",
    "toString",
    undefined,
    null,
    1,
    {},
    [],
    true,
  ].map((value) => [value]),
)("rejects %p", (value) => expect(isAttributeTypeName(value)).toBe(false));
test("registry type mappings", () => {
  expect(
    Object.fromEntries(ATTRIBUTE_TYPES.map((t) => [t.name, t.tsType])),
  ).toEqual({
    uuid: "string",
    string: "string",
    integer: "number",
    float: "number",
    decimal: "number",
    boolean: "boolean",
    enum: "string",
    date: "Date",
    datetime: "Date",
    timestamp: "Date",
    json: "unknown",
  });
  expect(() => attributeTypeInfo("atom" as never)).toThrow(
    "not a registered attribute type",
  );
});
