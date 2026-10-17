import { describe, expect, test } from "bun:test";
import { DECLARATION, FrameworkError, InvalidInputError, Mesh, checkFields, fqnOf, type StandardSchemaV1 } from "../src/index.ts";

const schema = (validate: (value: unknown) => StandardSchemaV1.Result<{ n: number }> | Promise<StandardSchemaV1.Result<{ n: number }>>): StandardSchemaV1<unknown, { n: number }> =>
  ({ "~standard": { version: 1, vendor: "test", validate } });

describe("Mesh.fqnOf", () => {
  const declared = { [DECLARATION]: { kind: "event" as const, fqn: "billing.InvoicePaid", is: (_: unknown): _ is object => true } };
  test("answers the FQN a class carries under the runtime's symbol, and is a member of Mesh", () => {
    expect(fqnOf(declared)).toBe("billing.InvoicePaid");
    expect(Mesh.fqnOf(declared)).toBe("billing.InvoicePaid");
    expect(Object.isFrozen(Mesh)).toBe(true);
  });
  test("anything else is a FrameworkError", () => {
    for (const value of [class {}, {}, null, undefined, 3, "billing.InvoicePaid", { [DECLARATION]: { fqn: 1 } }])
      expect(() => fqnOf(value as never)).toThrow(FrameworkError);
  });
});

describe("checkFields", () => {
  test("returns the checked value", () => {
    expect(checkFields(schema((value) => ({ value: value as { n: number } })), { n: 1 }, "event", "a.B")).toEqual({ n: 1 });
  });
  test("throws one InvalidInputError with every issue, each naming the declaration and its path", () => {
    const failing = schema(() => ({ issues: [{ message: "bad", path: ["n"] }, { message: "worse", path: [{ key: 0 }, "x"] }, { message: "top" }] }));
    try { checkFields(failing, {}, "command", "a.Pay"); throw new Error("no throw"); } catch (cause) {
      expect(cause).toBeInstanceOf(InvalidInputError);
      expect((cause as InvalidInputError).issues.map((i) => [i.path, i.message])).toEqual([
        [["n"], "bad (command a.Pay)"], [[0, "x"], "worse (command a.Pay)"], [[], "top (command a.Pay)"],
      ]);
    }
  });
  test("a schema that answers with a promise, or a malformed result, is a FrameworkError", () => {
    expect(() => checkFields(schema(async () => ({ value: { n: 1 } })), {}, "event", "a.B")).toThrow(FrameworkError);
    expect(() => checkFields(schema(() => 1 as never), {}, "event", "a.B")).toThrow(FrameworkError);
  });
});
