import { describe, expect, test } from "bun:test";
import { DECLARATION, FrameworkError, InvalidInputError, Mesh, checkFields, dispatchCommand, fqnOf, type StandardSchemaV1 } from "../src/index.ts";

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

describe("dispatchCommand", () => {
  class Pay {
    static readonly [DECLARATION] = { kind: "command" as const, fqn: "billing.Pay", is: (value: unknown): value is Pay => value instanceof Pay };
    constructor(readonly id: string, readonly note: string | null = null) {}
  }
  class Paid {
    static readonly [DECLARATION] = { kind: "event" as const, fqn: "billing.Paid", is: (value: unknown): value is Paid => value instanceof Paid };
  }
  const calls: { input: unknown; context: unknown }[] = [];
  const table = { "billing.Pay": { fields: ["id", "note"], run: async (input: Readonly<Record<string, unknown>>, context: object) => { calls.push({ input, context }); return "done"; } } };

  test("calls the action with exactly the declared fields as input and the context given, and resolves with its result", async () => {
    const context = { system: true };
    expect(await dispatchCommand(table, new Pay("a", "n"), context)).toBe("done");
    expect(calls.pop()).toEqual({ input: { id: "a", note: "n" }, context });
  });

  test("a value that is not an instance of a generated command class is a rejected FrameworkError: an event, a lookalike, the class itself, nothing", async () => {
    for (const value of [new Paid(), { id: "a" }, Pay, null, undefined, "billing.Pay"])
      await expect(dispatchCommand(table, value, {})).rejects.toBeInstanceOf(FrameworkError);
    expect(calls).toEqual([]);
  });

  test("a command with no entry in the table is a FrameworkError naming it, whatever the table inherits", async () => {
    await expect(dispatchCommand({}, new Pay("a"), {})).rejects.toThrow("dispatch: no action answers the command billing.Pay");
    class Inherited { static readonly [DECLARATION] = { kind: "command" as const, fqn: "constructor", is: (value: unknown): value is Inherited => value instanceof Inherited }; }
    await expect(dispatchCommand({}, new Inherited(), {})).rejects.toBeInstanceOf(FrameworkError);
  });
});
