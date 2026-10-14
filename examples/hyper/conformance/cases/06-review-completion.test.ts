/**
 * Group 06 — submission, review and completion.
 * Enforces: domain/core/submission.md#rules, #commands; domain/core/review.md#reviewer, #rules, #commands;
 * domain/core/completion.md#rules; domain/core/index.md#rules (rules 1, 4, 8); domain/invariants.md (1, 5, 11).
 */
import { expect, test } from "bun:test";
import { claimAndSubmit, E, leadWithChild, expectRejected, suite, useWorld } from "./_setup.ts";

suite("06.1 submit, return, resubmit, accept [domain/core/review.md#commands]", () => {
  const w = useWorld();

  test("only the reviewer may review — not the worker, not another member, not even an owner (review.reviewer)", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const other = await w().add("other");
    const { submission } = await claimAndSubmit(worker, child.id);
    await expectRejected(worker.do("review.accept", { submissionId: submission.id }), E.permissionDenied, "review.reviewer");
    await expectRejected(other.do("review.return", { submissionId: submission.id, reasons: "no" }), E.permissionDenied, "review.reviewer");
    await expectRejected(w().owner.do("review.accept", { submissionId: submission.id }), E.permissionDenied, "review.reviewer");
    await lead.do("review.accept", { submissionId: submission.id });
    await expectRejected(lead.do("review.accept", { submissionId: submission.id }), E.ruleViolation, "submission.pending");
  });

  test("with the waiver, the assignee's own pending submission is accepted the same way (review-waived)", async () => {
    const { worker, child } = await leadWithChild(w(), { waiveReview: true });
    const { submission } = await claimAndSubmit(worker, child.id);
    const r = await worker.complete({ taskId: child.id });
    expect(r.completion).toMatchObject({ rule: "review-waived", submissionId: submission.id });
  });

  test("a review binds to the submission it saw: editing the Task afterwards does not change the submission", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const { submission } = await claimAndSubmit(worker, child.id);
    await lead.do("task.update", { taskId: child.id, intent: "changed after submission" });
    const r = await lead.do("review.accept", { submissionId: submission.id });
    expect(r.review.submissionId).toBe(submission.id);
    const h = (await lead.task(child.id)).history;
    expect(h.submissions[0]!.taskVersion).toBe(submission.taskVersion);
    expect(r.task.version).toBeGreaterThan(submission.taskVersion);
  });
});

suite("06.2 the reviewer rule and the waiver [domain/core/review.md#reviewer]", () => {
  const w = useWorld();

  test("the reviewer is the parent's assignee when it has one (parent-assignee), else the parent's creator", async () => {
    const o = w().owner;
    const lead = await w().add("lead");
    const worker = await w().add("worker");
    const p = await o.create("Human's parent");
    const c = await o.create("Child", { parentId: p.id, intent: "x" });
    expect((await o.task(c.id)).task.reviewer).toEqual({ collaboratorId: o.id, rule: "parent-creator" });
    await o.do("task.assign", { taskId: p.id, assigneeId: lead.id });
    expect((await o.task(c.id)).task.reviewer).toEqual({ collaboratorId: lead.id, rule: "parent-assignee" });
    await o.do("task.assign", { taskId: c.id, assigneeId: worker.id });
    const { submission } = await claimAndSubmit(worker, c.id);
    await expectRejected(o.do("review.accept", { submissionId: submission.id }), E.permissionDenied, "review.reviewer");
    const r = await lead.do("review.accept", { submissionId: submission.id });
    expect(r.review.ruleApplied).toBe("parent-assignee");
  });

  test("review is required when the performer is not the reviewer: task.complete is rejected (task.review-required)", async () => {
    const { worker, child } = await leadWithChild(w());
    const { claim } = await worker.do("claim.acquire", { taskId: child.id });
    await expectRejected(worker.complete({ taskId: child.id, fence: claim.fence, summary: "done" }), E.ruleViolation, "task.review-required");
  });

  test("while holding the claim, task.complete needs the current fence (claim.current-fence); another holder blocks others (claim.holder)", async () => {
    const lead = await w().add("fence-lead");
    const t = await lead.create("Fenced", { intent: "x" });
    const { claim } = await lead.do("claim.acquire", { taskId: t.id });
    await expectRejected(lead.complete({ taskId: t.id }), E.ruleViolation, "claim.current-fence");
    await expectRejected(lead.complete({ taskId: t.id, fence: claim.fence + 3 }), E.ruleViolation, "claim.current-fence");
    const { lead: l2, worker, child } = await leadWithChild(w());
    await worker.do("claim.acquire", { taskId: child.id });
    await expectRejected(l2.complete({ taskId: child.id }), E.permissionDenied, "claim.holder");
  });

  test("the reviewer cannot bypass a pending submission from someone else with task.complete (task.no-foreign-submission)", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    await claimAndSubmit(worker, child.id);
    await expectRejected(lead.complete({ taskId: child.id }), E.ruleViolation, "task.no-foreign-submission");
  });

  test("accepting checks the parent rule: a child with an open grandchild cannot be accepted (task.children-settled)", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const g = await worker.create("Grandchild", { parentId: child.id });
    const { submission } = await claimAndSubmit(worker, child.id);
    const e = await expectRejected(lead.do("review.accept", { submissionId: submission.id }), E.ruleViolation, "task.children-settled");
    expect(e.failures!.find((x) => x.check === "task.children-settled")!.details?.openChildren).toEqual([g.id]);
  });

  test("changing roles resolves nothing pending: demoting the reviewer leaves the submission pending, and a guest reviewer cannot act", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const { submission } = await claimAndSubmit(worker, child.id);
    await w().owner.do("membership.change-role", { collaboratorId: lead.id, role: "guest" });
    expect((await w().owner.task(child.id)).task.pendingSubmission?.id).toBe(submission.id);
    await expectRejected(lead.do("review.accept", { submissionId: submission.id }), E.permissionDenied, "role");
    await w().owner.do("membership.change-role", { collaboratorId: lead.id, role: "member" });
    const r = await lead.do("review.accept", { submissionId: submission.id });
    expect(r.task.state).toBe("done");
  });
});
