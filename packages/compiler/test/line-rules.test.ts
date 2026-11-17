// Line rules (`min`, `max`, `match` on an attribute, argument or field line) in the generated validators: Zod's own
// checks, each with Mesh's standard message, and the `$ruled` table that gives each rule its code and line.
import { describe, expect, test } from "bun:test";
import type { SourcePosition } from "@meshfw/model";
import { fieldRuleTable, fieldSchema, ruleTable } from "../src/typescript/views/validators.ts";
import type { FieldShape } from "../src/typescript/views/inputs.ts";

const at: SourcePosition = { file: "src/domain/todo/todo.mesh.mx", line: 4, column: 4, offset: 40 };
const source = '{ file: "src/domain/todo/todo.mesh.mx", line: 4, column: 5 }';
const field = (shape: Partial<FieldShape> & Pick<FieldShape, "type">): FieldShape =>
  ({ name: "x", nullable: false, position: at, ...shape }) as FieldShape;

describe("fieldSchema: each line rule is Zod's own check with Mesh's standard message", () => {
  test.each([
    ["string min=1", { type: "string", min: 1 }, 'z.string().min(1, "must be at least 1 character")'],
    ["string min=0", { type: "string", min: 0 }, 'z.string().min(0, "must be at least 0 characters")'],
    ["string min=2", { type: "string", min: 2 }, 'z.string().min(2, "must be at least 2 characters")'],
    ["string max=1", { type: "string", max: 1 }, 'z.string().max(1, "must be at most 1 character")'],
    ["string max=80", { type: "string", max: 80 }, 'z.string().max(80, "must be at most 80 characters")'],
    ["integer min=1", { type: "integer", min: 1 }, 'z.int().min(1, "must be at least 1")'],
    ["integer max=10", { type: "integer", max: 10 }, 'z.int().max(10, "must be at most 10")'],
    ["float min=0.5", { type: "float", min: 0.5 }, 'z.number().min(0.5, "must be at least 0.5")'],
    ["float max=-2", { type: "float", max: -2 }, 'z.number().max(-2, "must be at most -2")'],
    ["decimal min=0 max=100", { type: "decimal", min: 0, max: 100 }, 'z.number().min(0, "must be at least 0").max(100, "must be at most 100")'],
    ["string match=/^a/i", { type: "string", match: { pattern: "^a", flags: "i" } }, 'z.string().regex(new $RegExp("^a", "i"), "must match /^a/i")'],
    ["string match with a quote and a backslash", { type: "string", match: { pattern: '^"\\d', flags: "" } }, 'z.string().regex(new $RegExp("^\\"\\\\d", ""), "must match /^\\"\\\\d/")'],
  ] as const)("%s", (_name, shape, expected) => {
    expect(fieldSchema(field(shape as Partial<FieldShape> & Pick<FieldShape, "type">), false)).toBe(expected);
  });

  test("the rules print min, max, match in that order whatever order the line wrote them, then nullable and optional", () => {
    // The model holds no option order; the fixed order is the view's (C3). `match=/x/ max=3 min=1` builds this shape.
    const shape = field({ type: "string", match: { pattern: "x", flags: "" }, max: 3, min: 1, nullable: true });
    expect(fieldSchema(shape, true)).toBe(
      'z.string().min(1, "must be at least 1 character").max(3, "must be at most 3 characters").regex(new $RegExp("x", ""), "must match /x/").nullable().optional()',
    );
  });

  test("a field with no rule is printed as before", () => {
    expect(fieldSchema(field({ type: "string" }), false)).toBe("z.string()");
    expect(fieldSchema(field({ type: "integer", nullable: true }), true)).toBe("z.int().nullable().optional()");
  });
});

describe("fieldRuleTable and ruleTable: the code and line of each rule, keyed by Zod's issue code", () => {
  test("a string's three rules", () => {
    expect(fieldRuleTable(field({ type: "string", match: { pattern: "x", flags: "g" }, max: 3, min: 1 }))).toBe(
      `{ too_small: { code: "too_short", source: ${source} }, too_big: { code: "too_long", source: ${source} }, regex: { code: "no_match", source: ${source} } }`,
    );
  });

  test.each(["integer", "float", "decimal"] as const)("a %s's bounds are too_small and too_big", (type) => {
    expect(fieldRuleTable(field({ type, min: 0, max: 1 }))).toBe(
      `{ too_small: { code: "too_small", source: ${source} }, too_big: { code: "too_big", source: ${source} } }`,
    );
  });

  test("a field with no rule has no entry, and a schema whose fields have none has no table", () => {
    expect(fieldRuleTable(field({ type: "string", nullable: true }))).toBeUndefined();
    expect(ruleTable([field({ type: "string" }), field({ type: "boolean" })])).toBeNull();
    expect(ruleTable([])).toBeNull();
  });

  test("the table keys each field by its printed property key, and leaves out the fields with no rule", () => {
    const fields = [field({ name: "title", type: "string", min: 1 }), field({ name: "done", type: "boolean" }), field({ name: "two words", type: "integer", max: 2 })];
    expect(ruleTable(fields)).toBe(
      `{ title: { too_small: { code: "too_short", source: ${source} } }, "two words": { too_big: { code: "too_big", source: ${source} } } }`,
    );
  });

  test("the source's file is printed as a string literal, so any path survives", () => {
    const odd = { ...at, file: 'a "b"\\c.mesh.mx' };
    expect(fieldRuleTable(field({ type: "string", min: 1, position: odd }))).toBe(
      '{ too_small: { code: "too_short", source: { file: "a \\"b\\"\\\\c.mesh.mx", line: 4, column: 5 } } }',
    );
  });
});
