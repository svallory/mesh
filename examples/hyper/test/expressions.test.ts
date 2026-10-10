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

test("task.hasActiveClaim: some claim is active", () => {
  const has = (claims: { state: string }[]) => task["computed.hasActiveClaim"](scope({ self: { claims } } as never));
  expect(has([])).toBe(false);
  expect(has([{ state: "released" }, { state: "active" }])).toBe(true);
});
