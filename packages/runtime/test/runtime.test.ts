import { expect, test } from "bun:test";
import * as runtime from "@meshfw/runtime";
import { ForbiddenError, FrameworkError, InvalidInputError, MeshError, NotFoundError, parseInput } from "@meshfw/runtime";
import type { Issue, PolicyCheck, StandardSchemaV1 } from "@meshfw/runtime";

const cause = new Error("original");
const issue = (path: (string | number)[], message: string): Issue => ({ path, message, label: null, code: null, source: null, details: null });
test.each([
  [new FrameworkError("misconfigured", { cause }), "FrameworkError", "framework", "misconfigured"],
  [new InvalidInputError([issue(["items", 0, "name"], "required"), issue([], "bad input")], { cause }), "InvalidInputError", "invalid_input", "items.0.name: required\n(input): bad input"],
  [new NotFoundError("work.Task", { tenant: "one", id: 2 }, { cause }), "NotFoundError", "not_found", 'Entity work.Task not found for {"tenant":"one","id":2}'],
  [new ForbiddenError({ entity: "blog.Post", action: "publish", policies: ["owner"], breakdown: [] }, { cause }), "ForbiddenError", "forbidden", "blog.Post#publish is forbidden by policy :owner"],
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
  const source = { file: "src/domain/blog/post.mesh.mx", line: 14, column: 7 };
  const issues: Issue[] = [{ ...issue(["title"], "required"), label: "titlePresent", code: "required", source }];
  const error = new InvalidInputError(issues);
  expect(error.issues).not.toBe(issues);
  expect(Object.isFrozen(error.issues)).toBe(true);
  issues.push(issue([], "later"));
  expect(error.issues).toEqual([{ ...issue(["title"], "required"), label: "titlePresent", code: "required", source }]);
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

test("NotFoundError exposes entity and composite key", () => {
  const error = new NotFoundError("work.Task", { tenant: "a", id: 3 });
  expect(error.entity).toBe("work.Task");
  expect(error.key).toEqual({ tenant: "a", id: 3 });
});

test("ForbiddenError copies and freezes its policy breakdown, and names the entity, the action and the failed policies", () => {
  const checks: PolicyCheck[] = [
    { policy: "owner", kind: "authorize-if", check: "({ actor }) => &ownerId === actor.id", result: false, decisive: true },
    { policy: "notPaid", kind: "forbid-if", check: "() => &paid", result: null, decisive: true },
  ];
  const error = new ForbiddenError({ entity: "Invoice", action: "pay", policies: ["owner", "notPaid"], breakdown: checks });
  expect(error.message).toBe("Invoice#pay is forbidden by policies :owner, :notPaid");
  expect([error.entity, error.action, error.policies]).toEqual(["Invoice", "pay", ["owner", "notPaid"]]);
  expect(error.breakdown).toEqual(checks);
  expect(error.breakdown).not.toBe(checks);
  expect(Object.isFrozen(error.breakdown)).toBe(true);
  expect(Object.isFrozen(error.breakdown[0])).toBe(true);
  expect(Object.isFrozen(error.policies)).toBe(true);
  checks.pop();
  expect(error.breakdown).toHaveLength(2);
  expect(() => (error.breakdown as PolicyCheck[]).pop()).toThrow(TypeError);
  // Plain data: it survives a JSON round trip unchanged.
  expect(JSON.parse(JSON.stringify(error.breakdown))).toEqual(error.breakdown);
});

test("ForbiddenError for an action no policy covers shows an open policy to copy", () => {
  const error = new ForbiddenError({ entity: "work.Post", action: "archive", policies: [], breakdown: [] });
  expect(error.message).toBe("work.Post#archive is forbidden: no policy of work.Post covers it, and an action no policy covers is denied. "
    + "To let every caller run it, add to the entity's `policies`:\n  policy :open actions=[&archive] authorize-if=() => true");
});

test.each(["id", 42, null, undefined, 1n, Symbol("key")])("NotFoundError accepts an unknown scalar key %s", (key) => {
  const error = new NotFoundError("Todo", key);
  expect(error.key).toBe(key);
  expect(error.message).toStartWith("Entity Todo not found for ");
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

test("parseInput preserves numeric raw and wrapped keys and sets absent rule metadata to null", async () => {
  const validator = schema(() => ({ issues: [{ message: "wrong", path: ["items", 0, { key: "name" }, Symbol.for("field"), { key: 2 }] }] }));
  try {
    await parseInput(validator, {});
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues).toEqual([issue(["items", 0, "name", "Symbol(field)", 2], "wrong")]);
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

for (const asynchronous of [false, true]) {
  test.each([
    ["empty object", {}], ["null", null], ["undefined", undefined],
    ["number", 1], ["boolean", false], ["string", "bad"], ["array", []],
    ["function", () => ({ value: 1 })], ["undefined issues without value", { issues: undefined }],
    ["non-array issues", { issues: "bad" }],
  ] as const)(`parseInput rejects malformed Standard Schema result (%s, async=${asynchronous})`, async (_label, malformed) => {
    // Simulate an untyped or broken validator, which can violate the TS contract at run time.
    const result = malformed as StandardSchemaV1.Result<unknown>;
    const validator = schema(asynchronous ? async () => result : () => result);
    const parsed = parseInput(validator, {});
    await expect(parsed).rejects.toBeInstanceOf(FrameworkError);
    await expect(parsed).rejects.toThrow("Malformed Standard Schema result:");
  });
}

test("parseInput allows undefined output and main entry excludes conformance helper", async () => {
  expect(await parseInput(schema(() => ({ value: undefined })), {})).toBeUndefined();
  expect("dataLayerConformance" in runtime).toBe(false);
});
