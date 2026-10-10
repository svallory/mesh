import { expect, test } from "bun:test";
import { scope } from "@meshfw/runtime";
import { expressions as claim } from "../.mesh/work/claim.expressions.ts";
import { expressions as task } from "../.mesh/work/task.expressions.ts";

// M4: the computed fields Hyper's rules need, evaluated in memory on loaded rows.
test("task.children-settled: no open child, an empty list included", () => {
  const settled = (children: { state: string | null }[] | undefined) =>
    task["computed.childrenSettled"](scope({ self: { children } } as never));
  expect(settled([])).toBe(true);
  expect(settled([{ state: "done" }, { state: "canceled" }])).toBe(true);
  expect(settled([{ state: "done" }, { state: "open" }])).toBe(false);
  expect(settled([{ state: null }])).toBe(false); // an unknown state does not settle a task
  expect(() => settled(undefined)).toThrow("not loaded");
});

test("claim.expired: an active claim whose expiry has passed, by the injected clock", () => {
  const lapsed = (state: string, expiresAt: number, now: number) =>
    claim["computed.lapsed"](scope({ self: { state, expiresAt: new Date(expiresAt) } } as never, { clock: () => new Date(now) }));
  expect(lapsed("active", 1_000, 2_000)).toBe(true);
  expect(lapsed("active", 1_000, 1_000)).toBe(true);
  expect(lapsed("active", 3_000, 2_000)).toBe(false);
  expect(lapsed("released", 1_000, 2_000)).toBe(false);
});

const at = (ms: number) => new Date(ms);
const withClock = (self: object, now: number) => scope({ self } as never, { clock: () => at(now) });

test("task.claimed and task.lapsedClaim: an active claim by its expiry, a released one by neither", () => {
  const claims = [{ state: "released", expiresAt: at(9_000) }, { state: "active", expiresAt: at(5_000) }];
  expect(task["computed.claimed"](withClock({ claims: [] }, 1_000))).toBe(false);
  expect(task["computed.claimed"](withClock({ claims }, 1_000))).toBe(true);
  expect(task["computed.claimed"](withClock({ claims }, 6_000))).toBe(false);
  expect(task["computed.lapsedClaim"](withClock({ claims }, 1_000))).toBe(false);
  expect(task["computed.lapsedClaim"](withClock({ claims }, 6_000))).toBe(true);
});

test("task.inReview and task.assigned", () => {
  const run = (id: string, self: object) => (task as Record<string, (s: unknown) => unknown>)[id]!(scope({ self } as never));
  expect(run("computed.inReview", { submissions: [{ state: "accepted" }] })).toBe(false);
  expect(run("computed.inReview", { submissions: [{ state: "accepted" }, { state: "pending" }] })).toBe(true);
  expect(run("computed.assigned", { assignments: [{ endedAt: new Date(1) }] })).toBe(false);
  expect(run("computed.assigned", { assignments: [{ endedAt: null }] })).toBe(true);
});
