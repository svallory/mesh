/**
 * Group 05 — claims, leases and fencing.
 * Enforces: domain/core/claim.md#lease, #fencing, #revocation, #rules, #commands, #events;
 * architecture/execution-and-accountability.md#claims; domain/core/submission.md#rules (rule 4: stale fence);
 * implementation/acceptance-cases.md#heart cases 4 (claim race) and 5 (stale worker).
 */
import { expect, test } from "bun:test";
import { E, suite, useWorld } from "./_setup.ts";

suite("05.2 claim race — case 4 [domain/core/claim.md#rules]", () => {
  const w = useWorld();

  test("race on an assigned Task between its assignee's two connections: one wins, the other gets claim.task-ready", async () => {
    const a = await w().add("double");
    const t = await w().owner.create("Double", { intent: "x" });
    await w().owner.do("task.assign", { taskId: t.id, assigneeId: a.id });
    const a2 = await a.reconnect();
    const rs = await Promise.allSettled([a.do("claim.acquire", { taskId: t.id }), a2.do("claim.acquire", { taskId: t.id })]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([lost.reason.code, lost.reason.phase]).toEqual([E.ruleViolation, "content"]);
    expect(lost.reason.failures.some((f: { check?: string }) => f.check === "claim.task-ready")).toBe(true);
  });
});
