import { expect, test } from "bun:test";
import * as runtime from "@mesh/runtime";
import { FrameworkError, InvalidInputError, MeshError, NotFoundError, parseInput } from "@mesh/runtime";
import type { Issue, StandardSchemaV1 } from "@mesh/runtime";

const cause = new Error("original");
test.each([
  [new FrameworkError("misconfigured", { cause }), "FrameworkError", "framework", "misconfigured"],
  [new InvalidInputError([{ path: ["items", "0", "name"], message: "required" }, { path: [], message: "bad input" }], { cause }), "InvalidInputError", "invalid_input", "items.0.name: required\n(input): bad input"],
  [new NotFoundError("post", { tenant: "one", id: 2 }, { cause }), "NotFoundError", "not_found", 'post not found for {"tenant":"one","id":2}'],
] as const)("errors preserve name, code, message, cause and inheritance: %s", (error, name, code, message) => {
  expect(error.name).toBe(name);
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
  expect(error.cause).toBe(cause);
  expect(error).toBeInstanceOf(MeshError);
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(runtime[name]);
});

test("InvalidInputError copies and freezes its issues array and preserves declared source", () => {
  const source = { file: "resources/post.mx", line: 14, column: 7 };
  const issues: Issue[] = [{ path: ["title"], message: "required", source }];
  const error = new InvalidInputError(issues);
  expect(error.issues).not.toBe(issues);
  expect(Object.isFrozen(error.issues)).toBe(true);
  issues.push({ path: [], message: "later" });
  expect(error.issues).toEqual([{ path: ["title"], message: "required", source }]);
  expect(() => (error.issues as Issue[]).push(issues[0]!)).toThrow(TypeError);
  expect(error.cause).toBeUndefined();
});

test("InvalidInputError rejects an empty issue array with FrameworkError", () => {
  try {
    new InvalidInputError([], { cause });
    throw new Error("expected construction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as FrameworkError).message).toBe("InvalidInputError requires at least one issue");
    expect((error as FrameworkError).cause).toBe(cause);
  }
});

test("NotFoundError exposes resource and composite key", () => {
  const error = new NotFoundError("post", { tenant: "a", id: 3 });
  expect(error.resource).toBe("post");
  expect(error.key).toEqual({ tenant: "a", id: 3 });
});

function schema<T>(validate: StandardSchemaV1.Props<unknown, T>["validate"]): StandardSchemaV1<unknown, T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

test("parseInput returns transformed synchronous output and passes input unchanged", async () => {
  const input = { count: "2" };
  const output = { count: 2 };
  const validator = schema((value) => {
    expect(value).toBe(input);
    return { value: output };
  });
  expect(await parseInput(validator, input)).toBe(output);
});

test("parseInput awaits asynchronous validation", async () => {
  expect(await parseInput(schema(async () => ({ value: 42 })), "42")).toBe(42);
});

test("parseInput maps nested raw and wrapped path keys to strings without source", async () => {
  const validator = schema(() => ({ issues: [{ message: "wrong", path: ["items", 0, { key: "name" }, Symbol.for("field"), { key: 2 }] }] }));
  try {
    await parseInput(validator, {});
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues).toEqual([{ message: "wrong", path: ["items", "0", "name", "Symbol(field)", "2"] }]);
  }
});

test("parseInput maps missing and empty paths to input issues for async failures", async () => {
  const validator = schema(async () => ({ issues: [{ message: "required" }, { message: "wrong", path: [] }] }));
  await expect(parseInput(validator, null)).rejects.toThrow("(input): required\n(input): wrong");
});

test.each([false, true])("parseInput propagates validator exceptions unchanged (async=%s)", async (async) => {
  const validator = schema(async ? () => Promise.reject(cause) : () => { throw cause; });
  await expect(parseInput(validator, {})).rejects.toBe(cause);
});

test("parseInput rejects malformed failure with no issues rather than accepting input", async () => {
  await expect(parseInput(schema(() => ({ issues: [] })), {})).rejects.toBeInstanceOf(FrameworkError);
});

test("parseInput allows undefined output and main entry excludes conformance helper", async () => {
  expect(await parseInput(schema(() => ({ value: undefined })), {})).toBeUndefined();
  expect("dataLayerConformance" in runtime).toBe(false);
});
