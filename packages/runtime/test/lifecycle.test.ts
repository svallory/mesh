import { describe, expect, test } from "bun:test";
import { checkScope, expr, FrameworkError, readOnlyRecord, runCheck, scope, type CheckSpec, type Issue } from "../src/index.ts";

const source = { file: "t.mesh.mx", line: 3, column: 7 };
const spec = (over: Partial<CheckSpec>): CheckSpec => ({ label: "l", code: "c", message: "m", source, that: () => true, ...over });
async function run(over: Partial<CheckSpec>): Promise<Issue[]> {
  const issues: Issue[] = [];
  await runCheck(issues, {}, spec(over));
  return issues;
}

describe("runCheck", () => {
  test("a true result passes and adds nothing", async () => expect(await run({})).toEqual([]));
  test("false fails with label, code, message, source, an empty path and null details", async () =>
    expect(await run({ that: () => false })).toEqual([{ label: "l", code: "c", message: "m", path: [], source, details: null }]));
  test("an unknown result (null) fails: a rule over a missing value must not pass silently (ADR-0012, D1)", async () =>
    expect(await run({ that: () => null })).toHaveLength(1));
  test("an async function is awaited", async () => expect(await run({ that: async () => false })).toHaveLength(1));
  test("`when` that is false, null or undefined skips the check; true runs it", async () => {
    for (const skipped of [false, null, undefined]) expect(await run({ that: () => false, when: () => skipped })).toEqual([]);
    expect(await run({ that: () => false, when: () => true })).toHaveLength(1);
  });
  test("details run only for a failed check, and undefined becomes null", async () => {
    let calls = 0;
    const details = () => { calls++; return { n: calls }; };
    expect(await run({ details })).toEqual([]);
    expect(calls).toBe(0);
    expect((await run({ that: () => false, details }))[0]!.details).toEqual({ n: 1 });
    expect((await run({ that: () => false, details: () => undefined }))[0]!.details).toBeNull();
  });
  test("a throw in a function propagates; the failed checks already collected are not the caller's problem", async () => {
    await expect(run({ that: () => { throw new Error("boom"); } })).rejects.toThrow("boom");
  });
  test("checks append in call order to the same list", async () => {
    const issues: Issue[] = [];
    await runCheck(issues, {}, spec({ label: "a", that: () => false }));
    await runCheck(issues, {}, spec({ label: "b", that: () => false }));
    expect(issues.map((issue) => issue.label)).toEqual(["a", "b"]);
  });
});

describe("checkScope", () => {
  test("the checks' scope is the action's without before, null or not; the rest is the same values, and the action's scope is untouched", () => {
    const self = { id: "1" };
    for (const before of [{ id: "1" }, null]) {
      const action = scope({ self, input: { id: "1" }, actor: null, context: {}, before }, { clock: () => new Date(0) });
      const checks = checkScope(action);
      expect("before" in checks).toBe(false);
      expect(Object.keys(checks).sort()).toEqual(["actor", "clock", "context", "input", "self"]);
      expect(checks.self).toBe(self);
      expect(checks.input).toBe(action.input);
      expect(checks.context).toBe(action.context);
      expect(action.before).toBe(before);
    }
  });
  test("a check and a step read the action's one instant: the clock is read once, whichever reads first", () => {
    for (const checkFirst of [true, false]) {
      let reads = 0;
      // A clock that jumps two hours on every read.
      const action = scope({ self: {}, before: null }, { clock: () => new Date(Date.UTC(2026, 9, 11, 2 * reads++)) });
      const checks = checkScope(action);
      const [first, second] = checkFirst ? [expr.now(checks), expr.now(action)] : [expr.now(action), expr.now(checks)];
      expect(second.getTime(), String(checkFirst)).toBe(first.getTime());
      expect(expr.now(checks).getTime()).toBe(first.getTime());
      expect(reads).toBe(1);
    }
  });
});

describe("readOnlyRecord", () => {
  test("reads pass through; set, delete and defineProperty throw a FrameworkError that names the action and `set`", () => {
    const row = readOnlyRecord({ title: "t" }, "Task.scribble") as Record<string, unknown>;
    expect(row.title).toBe("t");
    expect(() => { row.title = "x"; }).toThrow(FrameworkError);
    expect(() => { delete row.title; }).toThrow("Task.scribble");
    expect(() => Object.defineProperty(row, "title", { value: "x" })).toThrow("`set`");
    expect(row.title).toBe("t");
  });

  test("it is deep: nested objects, arrays, dates and related records throw too, and a Date is a copy that cannot reach the stored value", () => {
    const stored = { when: new Date("2026-01-01T00:00:00.000Z"), meta: { list: [1, { n: 1 }] }, owner: { name: "Ada" } };
    const row = readOnlyRecord(stored, "Task.go") as any;
    expect(() => { row.meta.x = 1; }).toThrow(FrameworkError);
    expect(() => row.meta.list.push(2)).toThrow(FrameworkError);
    expect(() => { row.meta.list[1].n = 2; }).toThrow(FrameworkError);
    expect(() => { row.owner.name = "x"; }).toThrow(FrameworkError);
    expect(() => Object.freeze(row.meta)).toThrow(FrameworkError);
    expect(() => row.when.setUTCFullYear(2000)).toThrow("Task.go");
    expect(() => { row.when.foo = 1; }).toThrow(FrameworkError);
    expect(row.when.getTime()).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
    expect(row.when instanceof Date).toBe(true);
    expect(JSON.stringify(row)).toBe(JSON.stringify(stored));
    expect(stored.when.getUTCFullYear()).toBe(2026);
    expect(stored.meta.list).toEqual([1, { n: 1 }]);
    expect({ ...row }.owner.name).toBe("Ada");
  });
});
