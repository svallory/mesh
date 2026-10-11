import { describe, expect, test } from "bun:test";
import { authorizer, ForbiddenError, FrameworkError, isSystem, type DataLayer, type PolicySpec } from "@meshfw/runtime";

/** A layer outside any transaction: `before` and `filter` then reject at once. */
const layer = { refuseIfFailed: () => false } as unknown as DataLayer;
type Check = PolicySpec["checks"][number];
const check = (kind: Check["kind"], value: unknown, record = false): Check => ({ kind, check: `${kind} ${String(value)}`, record, run: () => value });
const allow = (value: unknown, record = false) => check("authorize-if", value, record);
const forbid = (value: unknown, record = false) => check("forbid-if", value, record);
const policy = (name: string, checks: Check[], when: PolicySpec["when"] = null): PolicySpec => ({ name, when, checks });
const when = (value: unknown, record = false): PolicySpec["when"] => ({ check: `when ${String(value)}`, record, run: () => value });

/** The decision for a write: the pre-check, then the checks inside the transaction. */
async function decide(policies: PolicySpec[]): Promise<ForbiddenError | "allowed"> {
  const auth = authorizer("Post", "publish", policies);
  try {
    await auth.before(layer, {});
    await auth.inside({});
    return "allowed";
  } catch (error) {
    if (error instanceof ForbiddenError) return error;
    throw error;
  }
}

describe("POL-03: policies combine without order", () => {
  test("no policy: forbidden, and the error shows an open policy", async () => {
    const error = await decide([]);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).policies).toEqual([]);
    expect((error as ForbiddenError).message).toContain("policy :open actions=[&publish] authorize-if=() => true");
  });

  const cases: [string, Check[], boolean][] = [
    ["one authorize-if that holds", [allow(true)], true],
    ["one authorize-if that fails", [allow(false)], false],
    ["an unknown authorize-if does not authorize", [allow(null)], false],
    ["a non-boolean from plain code is unknown", [allow(1)], false],
    ["any authorize-if that holds is enough", [allow(false), allow(true)], true],
    ["only a forbid-if that does not hold: passes", [forbid(false)], true],
    ["a forbid-if that holds forbids", [forbid(true)], false],
    ["an unknown forbid-if forbids (POL-04)", [forbid(null)], false],
    ["a forbid-if that holds beats an authorize-if that holds", [allow(true), forbid(true)], false],
    ["authorize-if holds and forbid-if does not", [allow(true), forbid(false)], true],
    ["a policy with no check passes", [], true],
  ];
  for (const [name, checks, allowed] of cases)
    test(name, async () => {
      const result = await decide([policy("p", checks)]);
      expect(result === "allowed").toBe(allowed);
      // Moving a check changes no decision.
      const reversed = await decide([policy("p", [...checks].reverse())]);
      expect(reversed === "allowed").toBe(allowed);
    });

  test("every covering policy must pass, in any order, and the error names each that failed", async () => {
    const policies = [policy("a", [allow(true)]), policy("b", [allow(false)]), policy("c", [forbid(true)])];
    for (const order of [policies, [...policies].reverse(), [policies[1]!, policies[0]!, policies[2]!]]) {
      const error = (await decide(order)) as ForbiddenError;
      expect(error).toBeInstanceOf(ForbiddenError);
      expect([...error.policies].sort()).toEqual(["b", "c"]);
    }
    expect(await decide([policy("a", [allow(true)]), policy("b", [forbid(false)])])).toBe("allowed");
  });

  test("a policy whose when is false does not cover; with none left, the action is forbidden", async () => {
    expect(await decide([policy("a", [allow(false)], when(false)), policy("b", [allow(true)])])).toBe("allowed");
    const error = (await decide([policy("a", [allow(true)], when(false))])) as ForbiddenError;
    expect(error.policies).toEqual([]);
  });

  test("an unknown when fails its policy", async () => {
    const error = (await decide([policy("a", [allow(true)], when(null))])) as ForbiddenError;
    expect(error.policies).toEqual(["a"]);
    expect(error.breakdown).toEqual([
      { policy: "a", kind: "when", check: "when null", result: null, decisive: true },
      { policy: "a", kind: "authorize-if", check: "authorize-if true", result: true, decisive: false },
    ]);
  });
});

describe("where the checks run", () => {
  test("an actor-only denial is decided before the transaction: the record checks never run", async () => {
    const ran: string[] = [];
    const record: Check = { kind: "authorize-if", check: "record", record: true, run: () => { ran.push("record"); return true; } };
    const auth = authorizer("Post", "publish", [policy("a", [forbid(true)]), policy("b", [record])]);
    await expect(auth.before(layer, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(ran).toEqual([]);
  });

  test("a policy decided by an actor-only authorize-if still waits for its record-reading forbid-if", async () => {
    const auth = authorizer("Post", "publish", [policy("a", [allow(true), forbid(true, true)])]);
    await auth.before(layer, {});
    await expect(auth.inside({})).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("every actor-only authorize-if failed: denied before the transaction, whatever the record checks would say", async () => {
    const auth = authorizer("Post", "publish", [policy("a", [allow(false), forbid(false, true)])]);
    await expect(auth.before(layer, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an actor-only check runs once, before the transaction, and not again inside it", async () => {
    let calls = 0;
    const counted: Check = { kind: "authorize-if", check: "counted", record: false, run: () => { calls += 1; return true; } };
    const auth = authorizer("Post", "publish", [policy("a", [counted, forbid(false, true)])]);
    await auth.before(layer, {});
    await auth.inside({});
    expect(calls).toBe(1);
  });

  test("the scope reaches the check, and an async check is awaited", async () => {
    const seen: unknown[] = [];
    const async: Check = { kind: "authorize-if", check: "async", record: true, run: async (scope) => { seen.push(scope); return true; } };
    const auth = authorizer("Post", "publish", [policy("a", [async])]);
    await auth.before(layer, { phase: "before" });
    await auth.inside({ phase: "inside" });
    expect(seen).toEqual([{ phase: "inside" }]);
  });

  test("inside a running transaction, a denial before the transaction fails that transaction", async () => {
    const failed: unknown[] = [];
    const joined = {
      refuseIfFailed: () => true,
      transaction: (fn: () => Promise<unknown>) => fn().catch((cause) => { failed.push(cause); throw cause; }),
    } as unknown as DataLayer;
    await expect(authorizer("Post", "publish", [policy("a", [allow(false)])]).before(joined, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(failed[0]).toBeInstanceOf(ForbiddenError);
  });
});

describe("the breakdown", () => {
  test("is plain data: per policy, per check, the result and whether it decided", async () => {
    const error = (await decide([
      policy("owner", [allow(false), allow(null)]),
      policy("open", [allow(true)]),
      policy("paid", [forbid(true), forbid(false)]),
    ])) as ForbiddenError;
    expect(error.policies).toEqual(["owner", "paid"]);
    expect(error.breakdown).toEqual([
      { policy: "owner", kind: "authorize-if", check: "authorize-if false", result: false, decisive: true },
      { policy: "owner", kind: "authorize-if", check: "authorize-if null", result: null, decisive: true },
      { policy: "open", kind: "authorize-if", check: "authorize-if true", result: true, decisive: false },
      { policy: "paid", kind: "forbid-if", check: "forbid-if true", result: true, decisive: true },
      { policy: "paid", kind: "forbid-if", check: "forbid-if false", result: false, decisive: false },
    ]);
    expect(JSON.parse(JSON.stringify(error.breakdown))).toEqual(error.breakdown);
    expect(error.message).toBe("Post.publish is forbidden by policies :owner, :paid");
  });
});

describe("a read's policies are a filter", () => {
  test("covering policies that pass: true; one that fails: false, never an error", async () => {
    expect(await authorizer("Post", "read", [policy("a", [allow(true)])]).filter(layer, {})).toBe(true);
    expect(await authorizer("Post", "read", [policy("a", [allow(false)])]).filter(layer, {})).toBe(false);
    expect(await authorizer("Post", "read", [policy("a", [forbid(null)])]).filter(layer, {})).toBe(false);
  });

  test("a read no policy covers is forbidden", async () => {
    await expect(authorizer("Post", "read", []).filter(layer, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizer("Post", "read", [policy("a", [allow(true)], when(false))]).filter(layer, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a read policy that reads the record is the M10 error", async () => {
    const auth = authorizer("Post", "read", [policy("public", [allow(true, true)])]);
    await expect(auth.filter(layer, {})).rejects.toThrow(FrameworkError);
    await expect(auth.filter(layer, {})).rejects.toThrow(/M10/);
  });
});

test("isSystem is true only for a context whose system key is true", () => {
  expect(isSystem({ system: true })).toBe(true);
  for (const value of [{ system: false }, { system: "true" }, {}, null, undefined, true, "system"]) expect(isSystem(value)).toBe(false);
});
