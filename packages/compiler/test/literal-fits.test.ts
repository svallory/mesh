// literalFits' scalar matrix, called directly: each type with one literal that fits and the nearest one that does not.
// The build reaches these branches through `default=` (MESH_DEFAULT), but only some of them were pinned there.
import { describe, expect, test } from "bun:test";
import type { Attribute } from "@meshfw/model";
import { literalFits } from "../src/front-end/literal-types.ts";

type Field = Pick<Attribute, "type" | "nullable" | "values" | "concept">;
const field = (type: Attribute["type"], nullable = false): Field => ({ type, nullable });

describe("literalFits on a scalar", () => {
  test.each([
    ["null on a nullable field", null, field("date", true), true],
    ["null on a field that is not nullable", null, field("date"), false],
    ["true on boolean", true, field("boolean"), true],
    ["1 on boolean", 1, field("boolean"), false],
    ["a string on string", "x", field("string"), true],
    ["1 on string", 1, field("string"), false],
    ["1 on float", 1, field("float"), true],
    ["1.5 on float", 1.5, field("float"), true],
    ["\"1\" on float", "1", field("float"), false],
    ["Infinity on float", Number.POSITIVE_INFINITY, field("float"), false],
    ["1.5 on decimal", 1.5, field("decimal"), true],
    ["NaN on decimal", Number.NaN, field("decimal"), false],
    ["2 on integer", 2, field("integer"), true],
    ["1.5 on integer", 1.5, field("integer"), false],
    ["a timestamp on timestamp", "2026-01-02T03:04:05Z", field("timestamp"), true],
    ["a date on timestamp", "2026-01-02", field("timestamp"), false],
  ] as const)("%s", (_, value, shape, fits) => {
    expect(literalFits(value, shape)).toBe(fits);
  });
});
