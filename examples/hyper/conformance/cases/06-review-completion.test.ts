/**
 * Group 06 — submission, review and completion.
 * Enforces: domain/core/submission.md#rules, #commands; domain/core/review.md#reviewer, #rules, #commands;
 * domain/core/completion.md#rules; domain/core/index.md#rules (rules 1, 4, 8); domain/invariants.md (1, 5, 11).
 */
import { expect, test } from "bun:test";
import { claimAndSubmit, E, leadWithChild, expectRejected, suite, types, useWorld } from "./_setup.ts";

suite("06.1 submit, return, resubmit, accept [domain/core/review.md#commands]", () => {
  const w = useWorld();

  test("submitting releases the claim, binds the Task version and puts the Task in review", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const { claim } = await worker.do("claim.acquire", { taskId: child.id });
    const r = await worker.do("submission.submit", { taskId: child.id, fence: claim.fence, summary: "first cut" });
    if (r.outcome !== "submitted") throw new Error("expected submitted");
    expect(types(r.events)).toEqual(["submission.submitted", "claim.released"]);
    // The submission names the version the worker saw (after its claim, before the submit).
    expect(r.submission).toMatchObject({ state: "pending", submitterId: worker.id, fence: claim.fence });
    const claimed = (await lead.task(child.id)).history.claims[0]!;
    expect(claimed.fence).toBe(claim.fence);
    expect((r.events[0]!.payload as { taskVersion: number }).taskVersion).toBe(r.submission.taskVersion);
    expect(r.task.version).toBe(r.submission.taskVersion + 1);
    expect(r.task.derived.state).toBe("in-review");
    expect(r.task.reviewer).toEqual({ collaboratorId: lead.id, rule: "parent-creator" });
  });

  test("return with reasons keeps the assignment; the worker claims again (new fence) and resubmits; accept completes", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const first = await claimAndSubmit(worker, child.id, "v1");
    const ret = await lead.do("review.return", { submissionId: first.submission.id, reasons: "missing the edge cases" });
    expect(types(ret.events)).toEqual(["review.returned"]);
    expect(ret.events[0]!.payload).toMatchObject({ submissionId: first.submission.id, reviewerId: lead.id, reasons: "missing the edge cases" });
    expect(ret.review).toMatchObject({ decision: "return", reasons: "missing the edge cases", ruleApplied: "parent-creator" });
    expect(ret.task).toMatchObject({ derived: { state: "ready" }, assignment: { assigneeId: worker.id }, pendingSubmission: null });

    const second = await claimAndSubmit(worker, child.id, "v2");
    expect(second.fence).toBe(first.fence + 1);
    const acc = await lead.do("review.accept", { submissionId: second.submission.id });
    expect(types(acc.events)).toEqual(["review.accepted", "task.completed"]);
    expect(acc.completion).toMatchObject({ rule: "review-accepted", submissionId: second.submission.id, completedBy: lead.id });
    expect(acc.events[1]!.payload).toMatchObject({ rule: "review-accepted", submissionId: second.submission.id, completedBy: lead.id });
    expect(acc.task.state).toBe("done");

    const h = (await lead.task(child.id)).history;
    expect(h.submissions.map((s) => s.state)).toEqual(["returned", "accepted"]);
    expect(h.submissions[0]!.review?.decision).toBe("return");
    expect(h.completions).toHaveLength(1);
    // Invariant 1: responsibility, performance and acceptance are three recorded facts.
    expect(h.assignments[0]).toMatchObject({ assigneeId: worker.id, delegatorId: lead.id });
    expect(h.submissions[1]!.submitterId).toBe(worker.id);
    expect(h.completions[0]!.completedBy).toBe(lead.id);
  });

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

  test("the submitter may withdraw a pending submission; others may not", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const { submission } = await claimAndSubmit(worker, child.id);
    await expectRejected(lead.do("submission.withdraw", { submissionId: submission.id }), E.permissionDenied, "submission.submitter");
    const r = await worker.do("submission.withdraw", { submissionId: submission.id, reason: "wrong file" });
    expect(types(r.events)).toEqual(["submission.withdrawn"]);
    expect(r.submission.state).toBe("withdrawn");
    expect(r.task.derived.state).toBe("ready");
    await expectRejected(worker.do("submission.withdraw", { submissionId: submission.id }), E.ruleViolation, "submission.pending");
  });

  test("task.complete with evidence but no summary records an accepted submission with summary null and the evidence kept", async () => {
    const lead = await w().add("evidence-only");
    const t = await lead.create("Evidence only", { intent: "x" });
    const { evidenceReference } = await lead.do("evidence-reference.record", { kind: "file", locator: "out/report.pdf", contentHash: "sha256:e" });
    const r = await lead.complete({ taskId: t.id, evidence: [evidenceReference.id] });
    expect(types(r.events)).toEqual(["submission.submitted", "task.completed"]);
    expect(r.submission).toMatchObject({ summary: null, evidence: [evidenceReference.id], state: "accepted", submitterId: lead.id });
    expect(r.events[0]!.payload).toMatchObject({ summary: null, evidence: [evidenceReference.id] });
    expect(r.completion.submissionId).toBe(r.submission!.id);
    const h = (await lead.task(t.id)).history;
    expect(h.submissions[0]!.evidence).toEqual([evidenceReference.id]);
  });

  test("completing with one's own pending submission accepts it (no new summary); a new summary is rejected (submission.pending)", async () => {
    const solo = await w().add("self-submitter");
    const t = await solo.create("Self reviewed", { intent: "x" });
    const { claim } = await solo.do("claim.acquire", { taskId: t.id });
    const s = await solo.do("submission.submit", { taskId: t.id, fence: claim.fence, summary: "my result" });
    if (s.outcome !== "submitted") throw new Error("expected submitted");
    const e = await expectRejected(solo.do("task.complete", { taskId: t.id, summary: "a different result" }), E.ruleViolation, "submission.pending");
    expect(e.failures!.find((x) => x.check === "submission.pending")!.reason).toContain("withdraw");
    const { evidenceReference } = await solo.do("evidence-reference.record", { kind: "file", locator: "x.txt" });
    await expectRejected(solo.do("task.complete", { taskId: t.id, evidence: [evidenceReference.id] }), E.ruleViolation, "submission.pending");

    const r = await solo.complete({ taskId: t.id });
    expect(types(r.events)).toEqual(["task.completed"]);
    expect(r.completion).toMatchObject({ rule: "performer-is-reviewer", submissionId: s.submission.id, completedBy: solo.id });
    expect(r.submission).toMatchObject({ id: s.submission.id, state: "accepted", summary: "my result" });
    expect(r.events[0]!.payload).toMatchObject({ submissionId: s.submission.id });
    const h = (await solo.task(t.id)).history;
    expect(h.submissions.map((x) => x.state)).toEqual(["accepted"]);
  });

  test("with the waiver, the assignee's own pending submission is accepted the same way (review-waived)", async () => {
    const { worker, child } = await leadWithChild(w(), { waiveReview: true });
    const { submission } = await claimAndSubmit(worker, child.id);
    const r = await worker.complete({ taskId: child.id });
    expect(r.completion).toMatchObject({ rule: "review-waived", submissionId: submission.id });
  });

  test("task.cancel withdraws a pending submission in the same change (reason task-canceled)", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const { submission } = await claimAndSubmit(worker, child.id);
    const r = await lead.do("task.cancel", { taskId: child.id, reason: "no longer needed" });
    expect(types(r.events)).toEqual(["submission.withdrawn", "task.canceled"]);
    expect(r.events[0]!.payload).toEqual({ submissionId: submission.id, reason: "task-canceled" });
    const h = (await lead.task(child.id)).history;
    expect(h.submissions[0]!.state).toBe("withdrawn");
    expect((await lead.task(child.id)).task.pendingSubmission).toBeNull();
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

  test("evidence references: recorded with kind and locator, cited by ID, immutable; unknown IDs are rejected", async () => {
    const { lead, worker, child } = await leadWithChild(w());
    const ev = await worker.do("evidence-reference.record", {
      kind: "link",
      locator: "https://embassy.example/visa",
      contentHash: "sha256:abc",
      description: "embassy page",
    });
    expect(ev.evidenceReference).toMatchObject({ kind: "link", locator: "https://embassy.example/visa", contentHash: "sha256:abc", recordedBy: worker.id });
    expect(types(ev.events)).toEqual(["evidence-reference.recorded"]);
    expect(ev.events[0]).toMatchObject({ record: { type: "evidence-reference", id: ev.evidenceReference.id }, taskId: null });
    const { claim } = await worker.do("claim.acquire", { taskId: child.id });
    const bad = await worker
      .do("submission.submit", { taskId: child.id, fence: claim.fence, summary: "x", evidence: ["no-such-evidence"] })
      .catch((e) => e);
    expect([bad.code, bad.phase]).toEqual([E.notFound, "permission"]);
    expect(bad.failures.some((f: { check?: string }) => f.check === "exists")).toBe(true);
    const r = await worker.do("submission.submit", { taskId: child.id, fence: claim.fence, summary: "with evidence", evidence: [ev.evidenceReference.id] });
    if (r.outcome !== "submitted") throw new Error("expected submitted");
    expect(r.submission.evidence).toEqual([ev.evidenceReference.id]);
    void lead;
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

  test("performer is the reviewer: completes directly (performer-is-reviewer), no review record", async () => {
    const lead = await w().add("solo-lead");
    const p = await lead.create("P");
    const c = await lead.create("My own child", { parentId: p.id, intent: "x" });
    const { claim } = await lead.do("claim.acquire", { taskId: c.id });
    const r = await lead.complete({ taskId: c.id, fence: claim.fence });
    expect(types(r.events)).toEqual(["task.completed", "claim.released"]);
    expect(r.completion).toMatchObject({ rule: "performer-is-reviewer", submissionId: null, completedBy: lead.id });
    expect(r.submission).toBeNull();
  });

  test("the delegator's waiver lets the assignee complete directly (review-waived); a result is recorded as an accepted submission", async () => {
    const { lead, worker, child } = await leadWithChild(w(), { waiveReview: true });
    const t = (await lead.task(child.id)).task;
    expect(t.assignment?.reviewWaived).toBe(true);
    const { claim } = await worker.do("claim.acquire", { taskId: child.id });
    const r = await worker.complete({ taskId: child.id, fence: claim.fence, summary: "generated deterministically" });
    expect(types(r.events)).toEqual(["submission.submitted", "task.completed", "claim.released"]);
    expect(r.completion).toMatchObject({ rule: "review-waived", completedBy: worker.id });
    expect(r.submission).toMatchObject({ state: "accepted", summary: "generated deterministically", submitterId: worker.id });
    expect(r.completion.submissionId).toBe(r.submission!.id);
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
