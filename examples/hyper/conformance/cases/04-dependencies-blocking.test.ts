/**
 * Group 04 — dependencies, readiness and blocked reasons.
 * Enforces: domain/core/dependency.md#rules, #commands, #events; domain/core/task.md#states (derived states with
 * reasons), #blocking-conditions (claim.acquire and task.complete rejected while blocked);
 * implementation/acceptance-cases.md#heart case 8 (concurrent dependency cycle).
 */
import { expect, test } from "bun:test";
import { E, expectRejected, suite, useWorld } from "./_setup.ts";

suite("04.1 dependency commands [domain/core/dependency.md#commands]", () => {
  const w = useWorld();

  test("rejects a self-dependency, a duplicate, an unknown Task, removing a missing one, and a cycle", async () => {
    const o = w().owner;
    const a = await o.create("a");
    const b = await o.create("b");
    const c = await o.create("c");
    await expectRejected(o.do("dependency.add", { dependentId: a.id, prerequisiteId: a.id }), E.ruleViolation, "dependency.distinct");
    await o.do("dependency.add", { dependentId: b.id, prerequisiteId: a.id });
    await expectRejected(o.do("dependency.add", { dependentId: b.id, prerequisiteId: a.id }), E.ruleViolation, "dependency.duplicate");
    await expectRejected(o.do("dependency.add", { dependentId: b.id, prerequisiteId: "ghost" }), E.notFound, "exists");
    await expectRejected(o.do("dependency.remove", { dependentId: c.id, prerequisiteId: a.id }), E.ruleViolation, "dependency.exists");
    await o.do("dependency.add", { dependentId: c.id, prerequisiteId: b.id });
    await expectRejected(o.do("dependency.add", { dependentId: a.id, prerequisiteId: c.id }), E.ruleViolation, "dependency.no-cycle");
  });

  test("a guest cannot add dependencies", async () => {
    const g = await w().add("g", "guest");
    const a = await w().owner.create("x");
    const b = await w().owner.create("y");
    await expectRejected(g.do("dependency.add", { dependentId: b.id, prerequisiteId: a.id }), E.permissionDenied, "role");
  });

  test("case 8: two concurrent dependency.add that together would make a cycle — exactly one is rejected", async () => {
    const o = w().owner;
    const x = await o.create("X");
    const y = await o.create("Y");
    const o2 = await o.reconnect();
    const rs = await Promise.allSettled([
      o.do("dependency.add", { dependentId: x.id, prerequisiteId: y.id }),
      o2.do("dependency.add", { dependentId: y.id, prerequisiteId: x.id }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([failed.reason.code, failed.reason.phase]).toEqual([E.ruleViolation, "content"]);
    expect(failed.reason.failures.some((f: { check?: string }) => f.check === "dependency.no-cycle")).toBe(true);
  });
});

suite("04.2 readiness and blocked reasons [domain/core/dependency.md#rules, domain/core/task.md#states]", () => {
  const w = useWorld();

  test("a blocked Task cannot be claimed (claim.task-ready, with reasons); completing it succeeds with the dependency as a warning", async () => {
    const o = w().owner;
    const pre = await o.create("Prerequisite");
    const dep = await o.create("Dependent", { intent: "x" });
    await o.do("dependency.add", { dependentId: dep.id, prerequisiteId: pre.id });
    const e = await expectRejected(o.do("claim.acquire", { taskId: dep.id }), E.ruleViolation, "claim.task-ready");
    const f = e.failures!.find((x) => x.check === "claim.task-ready")!;
    expect(f.details?.derivedState).toBe("blocked");
    expect(f.details?.reasons).toEqual([{ kind: "dependency", taskId: pre.id, message: expect.any(String) }]);
    // Dependencies gate claiming, not completion (PROTOCOL.md#behavior).
    const done = await o.complete({ taskId: dep.id });
    expect(done.task.state).toBe("done");
    expect(done.warnings).toEqual([{ kind: "dependency", taskId: pre.id, message: expect.any(String) }]);
    const clean = await o.complete({ taskId: pre.id });
    expect(clean.warnings).toEqual([]);
  });

  test("only done satisfies: prerequisite done → ready; canceled → blocked with prerequisite-canceled", async () => {
    const o = w().owner;
    const p1 = await o.create("p1");
    const p2 = await o.create("p2");
    const d = await o.create("d");
    await o.do("dependency.add", { dependentId: d.id, prerequisiteId: p1.id });
    await o.do("dependency.add", { dependentId: d.id, prerequisiteId: p2.id });
    let t = (await o.task(d.id)).task;
    expect(t.derived.reasons.map((r) => [r.kind, r.taskId]).sort()).toEqual(
      [["dependency", p1.id], ["dependency", p2.id]].sort(),
    );
    await o.complete({ taskId: p1.id });
    await o.do("task.cancel", { taskId: p2.id, reason: "dropped" });
    t = (await o.task(d.id)).task;
    expect(t.derived.state).toBe("blocked");
    expect(t.derived.reasons).toEqual([{ kind: "prerequisite-canceled", taskId: p2.id, message: expect.any(String) }]);
    await o.do("dependency.remove", { dependentId: d.id, prerequisiteId: p2.id, reason: "replaced" });
    t = (await o.task(d.id)).task;
    expect(t.derived).toEqual({ state: "ready", reasons: [] });
  });

  test("a prerequisite reopened after the claim: review.accept succeeds and returns it as a warning", async () => {
    const o = w().owner;
    const agent = await w().add("late-agent");
    const pre = await o.create("pre2");
    const dep = await o.create("dep2", { intent: "x" });
    await o.do("dependency.add", { dependentId: dep.id, prerequisiteId: pre.id });
    await o.complete({ taskId: pre.id });
    await o.do("task.assign", { taskId: dep.id, assigneeId: agent.id });
    const { claim } = await agent.do("claim.acquire", { taskId: dep.id });
    await o.do("task.reopen", { taskId: pre.id, reason: "regression found" });
    const s = await agent.do("submission.submit", { taskId: dep.id, fence: claim.fence, summary: "done anyway" });
    if (s.outcome !== "submitted") throw new Error("expected submitted");
    const r = await o.do("review.accept", { submissionId: s.submission.id });
    expect(r.task.state).toBe("done");
    expect(r.warnings).toEqual([{ kind: "dependency", taskId: pre.id, message: expect.any(String) }]);
  });

  test("derived state precedence: in-review over claimed over blocked over ready; stored states win", async () => {
    const o = w().owner;
    const agent = await w().add("agent");
    const t = await o.create("t", { intent: "x" });
    await o.do("task.assign", { taskId: t.id, assigneeId: agent.id });
    expect((await o.task(t.id)).task.derived.state).toBe("ready");
    const { claim } = await agent.do("claim.acquire", { taskId: t.id });
    expect((await o.task(t.id)).task.derived.state).toBe("claimed");
    await agent.do("submission.submit", { taskId: t.id, fence: claim.fence, summary: "done" });
    const inReview = (await o.task(t.id)).task;
    expect(inReview.derived.state).toBe("in-review");
    expect(inReview.activeClaim).toBeNull();
    expect(inReview.pendingSubmission?.submitterId).toBe(agent.id);
  });
});
