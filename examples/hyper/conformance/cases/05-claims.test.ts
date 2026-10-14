/**
 * Group 05 — claims, leases and fencing.
 * Enforces: domain/core/claim.md#lease, #fencing, #revocation, #rules, #commands, #events;
 * architecture/execution-and-accountability.md#claims; domain/core/submission.md#rules (rule 4: stale fence);
 * implementation/acceptance-cases.md#heart cases 4 (claim race) and 5 (stale worker).
 */
import { expect, test } from "bun:test";
import { E, expectRejected, suite, useWorld } from "./_setup.ts";

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

const LEASE_MS = 400;

suite("05.3 lease expiry and stale workers — case 5 [domain/core/claim.md#lease, #fencing]", () => {
  const w = useWorld({ leaseMs: LEASE_MS });

  test("renewing just after expiresAt is rejected with claim.expired even before claim.expired is emitted", async () => {
    const a = await w().add("just-late");
    const t = await w().owner.create("Just late", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await Bun.sleep(Math.max(0, Date.parse(claim.expiresAt) - Date.now()) + 20);
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence }), E.ruleViolation, "claim.expired");
    expect((await a.task(t.id)).task.activeClaim).toBeNull();
  }, 10_000);

  test("one phase, several failures: renewing an expired claim with a wrong fence may report claim.expired, claim.current-fence, or both (content)", async () => {
    const a = await w().add("late-and-wrong");
    const t = await w().owner.create("Expired and fenced", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await Bun.sleep(Math.max(0, Date.parse(claim.expiresAt) - Date.now()) + 20);
    // Both checks are content-phase failures; the engine may return one or both. Extras are tolerated.
    await expectRejected(a.do("claim.renew", { taskId: t.id, fence: claim.fence + 9 }), E.ruleViolation, ["claim.expired", "claim.current-fence"]);
  }, 10_000);

  test("a result under a revoked fence is also a late result; a fence the actor never held is claim.current-fence", async () => {
    const o = w().owner;
    const a = await w().add("revoked-worker");
    const t = await o.create("Revoked", { intent: "x" });
    const { claim } = await a.do("claim.acquire", { taskId: t.id });
    await o.do("claim.revoke", { taskId: t.id, reason: "intervene" });
    const r = await a.do("submission.submit", { taskId: t.id, fence: claim.fence, summary: "late" });
    expect(r.outcome).toBe("late-result-recorded");
    await expectRejected(a.do("submission.submit", { taskId: t.id, fence: 42, summary: "made up" }), E.ruleViolation, "claim.current-fence");
  });
});
