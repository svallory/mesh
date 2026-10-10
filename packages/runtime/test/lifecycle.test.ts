import { describe, expect, test } from "bun:test";
import { runCheck, type CheckSpec, type Issue } from "../src/index.ts";

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
