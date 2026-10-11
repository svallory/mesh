// M5 in Hyper: the effects inside the Task and Run aggregates run in the entity files' actions (`actions`, `tx`,
// `after=:write`); the effects across aggregates, the late result and the warnings run in the command functions of
// `src/domain/<module>/<module>.commands.ts`, each one application transaction. Roadmap M5 acceptance tests 1, 2, 3, 6
// and 10, the version rule of PROTOCOL.md §4.5, and the naming rule of the functions.
import { describe, expect, test } from "bun:test";
import type { DataLayer, DataOperations, TableHandle } from "@meshfw/runtime";
import * as mesh from "#mesh";
import { bind, tables } from "#mesh";
import * as executionCommands from "../src/domain/execution/execution.commands";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import * as identityCommands from "../src/domain/identity/identity.commands";
import { collaboratorRetire, membershipRevoke } from "../src/domain/identity/identity.commands";
import * as workCommands from "../src/domain/work/work.commands";
import { reviewAccept, submissionSubmit, taskCancel, taskComplete } from "../src/domain/work/work.commands";
import { as, codes, issuesOf, minutes, NOW, one, within, type World } from "./world";

const taskOf = async (w: World, id: string) => one(w.hyper.readTask({ filter: { id: { eq: id } } }, as(w.alice)));
const claimsOf = (w: World, taskId: string) => w.hyper.readClaim({ filter: { taskId: { eq: taskId } } }, as(w.alice));

/** A layer that fails the first write `refuse` matches, as a failing step would: the error rolls the transaction back. */
function refusing(layer: DataLayer, refuse: (table: TableHandle, changes: Record<string, unknown>) => boolean): DataLayer {
  // One wrapper per transaction: a call that joins the running transaction gets the same operations object.
  const wrapped = new WeakMap<DataOperations, DataOperations>();
  const wrap = (tx: DataOperations): DataOperations => wrapped.get(tx) ?? wrapped.set(tx, {
    ...tx,
    insert: (table, row) => refuse(table, row) ? Promise.reject(new Error("the last step failed")) : tx.insert(table, row),
    updateByKey: (table, key, changes) => refuse(table, changes) ? Promise.reject(new Error("the last step failed")) : tx.updateByKey(table, key, changes),
  }).get(tx)!;
  return {
    transaction: (run) => layer.transaction((tx) => run(wrap(tx))),
    refuseIfFailed: () => layer.refuseIfFailed(),
    close: () => layer.close(),
  };
}

describe("acceptance 1: task.complete writes the completion, the submission and the claim in one transaction", () => {
  test("with a summary: a Completion, a Submission recorded accepted and the claim released, in one commit", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice));
    const before = await taskOf(w, w.task.id);
    const result = await taskComplete({ id: w.task.id, fence: claim.fence, summary: "shipped" }, as(w.alice), w.binding);
    if (result.outcome !== "completed") throw new Error(result.outcome);
    expect(result.task).toMatchObject({ state: "done", version: before.version + 1 });
    expect(result.completion).toMatchObject({ rule: "performer-is-reviewer", taskId: w.task.id, completedById: w.alice.id, submissionId: result.submission!.id });
    // `taskVersion` is the version the work was done against, before this command bumped it (PROTOCOL.md:328).
    expect(result.submission).toMatchObject({ state: "accepted", summary: "shipped", fence: claim.fence, submitterId: w.alice.id, taskVersion: before.version, evidence: [] });
    expect(await claimsOf(w, w.task.id)).toMatchObject([{ id: claim.id, state: "released", endReason: "completed", endedAt: NOW }]);
    expect(result.warnings).toEqual([]);
  }));

  test("a throw in the last step (releasing the claim) leaves none of the three rows", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice));
    const before = await taskOf(w, w.task.id);
    const failing = bind(refusing(w.db, (table, changes) => table === tables.claim && changes.state === "released"), { clock: w.clock });
    await expect(taskComplete({ id: w.task.id, fence: claim.fence, summary: "shipped" }, as(w.alice), { transaction: failing.transaction, clock: w.clock })).rejects.toThrow("the last step failed");
    expect(await w.hyper.readCompletion({}, as(w.alice))).toEqual([]);
    expect(await w.hyper.readSubmission({}, as(w.alice))).toEqual([]);
    expect(await claimsOf(w, w.task.id)).toMatchObject([{ id: claim.id, state: "active", endedAt: null }]);
    expect(await taskOf(w, w.task.id)).toEqual(before);
  }));

  test("the generated action alone does the same: completeTask is the whole effect inside the Task aggregate", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice));
    const done = await w.hyper.completeTask({ id: w.task.id, fence: claim.fence }, as(w.alice));
    expect(done.state).toBe("done");
    expect(await w.hyper.readCompletion({}, as(w.alice))).toMatchObject([{ rule: "performer-is-reviewer", submissionId: null }]);
    expect(await claimsOf(w, w.task.id)).toMatchObject([{ state: "released", endReason: "completed" }]);
  }));

  test("without a summary, the actor's own pending submission is accepted (the assignment waives review)", () => within(async (w) => {
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    const result = await taskComplete({ id: w.task.id }, as(w.bot), w.binding);
    if (result.outcome !== "completed") throw new Error(result.outcome);
    expect(result.completion).toMatchObject({ rule: "review-waived", submissionId: submitted.submission.id, completedById: w.bot.id });
    expect(result.submission).toMatchObject({ id: submitted.submission.id, state: "accepted" });
  }));

  test("review.accept settles the submission and completes the task as review-accepted, in one transaction", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    const accepted = await reviewAccept({ submission: submitted.submission.id }, as(w.alice), w.binding);
    expect(accepted.review).toMatchObject({ decision: "accept", reviewerId: w.alice.id, ruleApplied: "task-creator" });
    expect(accepted.completion).toMatchObject({ rule: "review-accepted", submissionId: submitted.submission.id, completedById: w.alice.id });
    expect(accepted.task).toMatchObject({ state: "done", version: submitted.task.version + 1 });
    expect(await one(w.hyper.readSubmission({}, as(w.alice)))).toMatchObject({ state: "accepted" });
    expect(accepted.warnings).toEqual([]);
  }));

  test("review.accept that fails in the completion leaves the submission pending and writes no review", () => within(async (w) => {
    const child = await w.hyper.createTask({ title: "child", parent: w.task.id }, as(w.alice));
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    // The child is open, so the nested completeTask refuses with task.children-settled.
    expect(codes(await issuesOf(reviewAccept({ submission: submitted.submission.id }, as(w.alice), w.binding)))).toEqual(["task.children-settled"]);
    expect(await w.hyper.readReview({}, as(w.alice))).toEqual([]);
    expect(await one(w.hyper.readSubmission({}, as(w.alice)))).toMatchObject({ state: "pending" });
    void child;
  }));
});

describe("acceptance 2: task.cancel revokes the claims, withdraws the submission and cancels the running runs", () => {
  test("a claimed task with runs: the claim is revoked and only the running runs are canceled", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const running = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    const finished = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    await w.hyper.settleRun({ id: finished.id, result: "succeeded" }, as(w.bot));
    const before = await taskOf(w, w.task.id);
    const { task } = await taskCancel({ id: w.task.id, reason: "dropped" }, as(w.alice), w.binding);
    expect(task).toMatchObject({ state: "canceled", version: before.version + 1 });
    expect(await claimsOf(w, w.task.id)).toMatchObject([{ id: claim.id, state: "revoked", endReason: "task canceled" }]);
    const runs = await w.hyper.readRun({ sort: ["startedAt", "id"] }, as(w.alice));
    expect(runs.find((run) => run.id === running.id)).toMatchObject({ state: "canceled", cancelReason: "task canceled", endedAt: NOW, version: 2 });
    expect(runs.find((run) => run.id === finished.id)).toMatchObject({ state: "succeeded", version: 2 });
  }));

  test("a task in review: the pending submission is withdrawn", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    await taskCancel({ id: w.task.id, reason: "dropped" }, as(w.alice), w.binding);
    expect(await one(w.hyper.readSubmission({}, as(w.alice)))).toMatchObject({ id: submitted.submission.id, state: "withdrawn" });
  }));

  test("calling the generated cancelTask directly skips the effect across aggregates: the run keeps running", () => within(async (w) => {
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    await w.hyper.cancelTask({ id: w.task.id, reason: "dropped" }, as(w.alice));
    expect(await one(w.hyper.readRun({ filter: { id: { eq: run.id } } }, as(w.alice)))).toMatchObject({ state: "running" });
  }));

  test("a run that fails to cancel rolls the whole cancel back", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    const before = await taskOf(w, w.task.id);
    const failing = bind(refusing(w.db, (table, changes) => table === tables.run && changes.state === "canceled"), { clock: w.clock });
    await expect(taskCancel({ id: w.task.id, reason: "dropped" }, as(w.alice), { transaction: failing.transaction, clock: w.clock })).rejects.toThrow("the last step failed");
    expect(await taskOf(w, w.task.id)).toEqual(before);
    expect(await claimsOf(w, w.task.id)).toMatchObject([{ id: claim.id, state: "active" }]);
  }));
});

describe("acceptance 3: claim.acquire assigns an unassigned task; two concurrent acquires have one winner", () => {
  test("the holder is the actor, the fence the highest plus one, the lease ten minutes; an unassigned task gets an Assignment", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    expect(claim).toMatchObject({ holderId: w.bot.id, fence: 1, state: "active", acquiredAt: NOW, expiresAt: minutes(10) });
    expect(await w.hyper.readAssignment({}, as(w.alice))).toMatchObject([{ taskId: w.task.id, assigneeId: w.bot.id, delegatorId: w.bot.id, reviewWaived: false, endedAt: null, startedAt: NOW }]);
    await w.hyper.releaseClaim({ id: claim.id, fence: claim.fence }, as(w.bot));
    const second = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bob));
    expect(second.fence).toBe(2);
    // The task already has a current assignment, so no second one starts.
    expect(await w.hyper.readAssignment({}, as(w.alice))).toHaveLength(1);
  }));

  test("two concurrent acquires: one claim, one claim.task-ready with the derived state", () => within(async (w) => {
    const outcomes = await Promise.all([w.bot, w.bob].map((who) => issuesOf(w.hyper.acquireClaim({ task: w.task.id }, as(who)))));
    expect(outcomes.filter((issues) => issues.length === 0)).toHaveLength(1);
    const loser = outcomes.find((issues) => issues.length > 0)!;
    expect(codes(loser)).toEqual(["claim.task-ready"]);
    expect(loser[0]!.details).toEqual({ derivedState: "claimed", reasons: [] });
    expect(await claimsOf(w, w.task.id)).toHaveLength(1);
    expect(await w.hyper.readAssignment({}, as(w.alice))).toHaveLength(1);
  }));

  test("an acquire after the lease ran out expires the lapsed claim first, in the same transaction", () => within(async (w) => {
    const first = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    w.advance(11);
    const second = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bob));
    expect(second.fence).toBe(2);
    expect(await one(w.hyper.readClaim({ filter: { id: { eq: first.id } } }, as(w.alice)))).toMatchObject({ state: "expired", endReason: "lease expired", endedAt: minutes(11) });
  }));
});

describe("acceptance 6: a step after the write sees the stored row", () => {
  test("acquire's step reads the holder its `set` stored, not an input", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bob));
    expect(await one(w.hyper.readAssignment({}, as(w.alice)))).toMatchObject({ assigneeId: claim.holderId });
    expect(claim.holderId).toBe(w.bob.id);
  }));

  test("attempt.finish's step settles the run with the outcome its `set` stored", () => within(async (w) => {
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    const { attempt } = await attemptStart({ run: run.id }, as(w.bot), w.binding);
    const finished = await w.hyper.finishAttempt({ id: attempt.id, result: "succeeded", outputs: { pr: 64 }, evidence: [], error: null }, as(w.bot));
    // Empty and null values are dropped from the stored outcome (`end_attempt.ex:7-15`); the run gets that value.
    expect(finished.outcome).toEqual({ outputs: { pr: 64 } });
    expect(await one(w.hyper.readRun({ filter: { id: { eq: run.id } } }, as(w.alice)))).toMatchObject({ state: "succeeded", outcome: { outputs: { pr: 64 } }, endedAt: NOW });
  }));

  test("a retryable failure leaves the run running", () => within(async (w) => {
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    const { attempt } = await attemptStart({ run: run.id }, as(w.bot), w.binding);
    await w.hyper.finishAttempt({ id: attempt.id, result: "failed", error: { message: "timeout", retryable: true } }, as(w.bot));
    expect(await one(w.hyper.readRun({ filter: { id: { eq: run.id } } }, as(w.alice)))).toMatchObject({ state: "running", outcome: null });
    const { attempt: retry } = await attemptStart({ run: run.id }, as(w.bot), w.binding);
    expect(retry.number).toBe(2);
    await w.hyper.finishAttempt({ id: retry.id, result: "failed", error: { message: "bad input" } }, as(w.bot));
    expect(await one(w.hyper.readRun({ filter: { id: { eq: run.id } } }, as(w.alice)))).toMatchObject({ state: "failed", outcome: { error: { message: "bad input" } } });
  }));
});

describe("acceptance 10: warnings, and a late result instead of a failure", () => {
  async function blockedLater(w: World) {
    const reopened = await w.hyper.createTask({ title: "Design" }, as(w.alice));
    const canceled = await w.hyper.createTask({ title: "Docs" }, as(w.alice));
    for (const prerequisite of [reopened, canceled]) {
      w.advance(1);
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: prerequisite.id }, as(w.alice));
      await w.hyper.completeTask({ id: prerequisite.id }, as(w.alice));
    }
    return { reopened, canceled };
  }

  test("task.complete succeeds over an open and a canceled prerequisite and lists both as warnings", () => within(async (w) => {
    const { reopened, canceled } = await blockedLater(w);
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice));
    await w.hyper.reopenTask({ id: reopened.id, reason: "redo" }, as(w.alice));
    await w.hyper.reopenTask({ id: canceled.id, reason: "redo" }, as(w.alice));
    await taskCancel({ id: canceled.id, reason: "not needed" }, as(w.alice), w.binding);
    const result = await taskComplete({ id: w.task.id, fence: claim.fence }, as(w.alice), w.binding);
    if (result.outcome !== "completed") throw new Error(result.outcome);
    expect(result.task.state).toBe("done");
    expect(result.warnings).toEqual([
      { kind: "dependency", taskId: reopened.id, message: "blocked: waiting for Design" },
      { kind: "prerequisite-canceled", taskId: canceled.id, message: "blocked: prerequisite canceled: Docs" },
    ]);
  }));

  test("review.accept lists the same warnings", () => within(async (w) => {
    const { reopened } = await blockedLater(w);
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    await w.hyper.reopenTask({ id: reopened.id, reason: "redo" }, as(w.alice));
    // The reopen did not change this task, so the submission's task version still matches.
    const accepted = await reviewAccept({ submission: submitted.submission.id }, as(w.alice), w.binding);
    expect(accepted.warnings).toEqual([{ kind: "dependency", taskId: reopened.id, message: "blocked: waiting for Design" }]);
  }));

  test("submission.submit with the fence of a revoked claim records a late result and leaves the task unchanged", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await w.hyper.revokeClaim({ id: claim.id, reason: "taking over" }, as(w.alice));
    const before = await taskOf(w, w.task.id);
    const result = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "too late" }, as(w.bot), w.binding);
    expect(result).toMatchObject({ outcome: "late-result-recorded", lateResult: { taskId: w.task.id, submitterId: w.bot.id, fence: claim.fence, summary: "too late", evidence: [] } });
    expect(await taskOf(w, w.task.id)).toEqual(before);
    expect(await w.hyper.readSubmission({}, as(w.alice))).toEqual([]);
  }));

  test("task.complete with the fence of a lapsed claim records a late result with no summary", () => within(async (w) => {
    await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    w.advance(15);
    const before = await taskOf(w, w.task.id);
    const result = await taskComplete({ id: w.task.id, fence: claim.fence }, as(w.bot), w.binding);
    expect(result).toMatchObject({ outcome: "late-result-recorded", lateResult: { fence: claim.fence, summary: null, submitterId: w.bot.id } });
    expect(await taskOf(w, w.task.id)).toEqual(before);
    expect(await w.hyper.readCompletion({}, as(w.alice))).toEqual([]);
  }));

  test("a submit queued behind another transaction decides stale or not when it runs, not when it was called", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    w.advance(9);
    // A transaction holds the layer, which runs whole transactions one at a time, so the submit waits behind it.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const holding = w.hyper.transaction(() => gate, as(w.alice));
    const queued = submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "late" }, as(w.bot), w.binding);
    // The lease ends while the submit waits: when it runs, the fence is stale.
    w.advance(2);
    open();
    await holding;
    expect(await queued).toMatchObject({ outcome: "late-result-recorded", lateResult: { fence: claim.fence, summary: "late", submitterId: w.bot.id } });
    expect(await w.hyper.readSubmission({}, as(w.alice))).toEqual([]);
  }));

  test("a fence the actor never held is claim.current-fence, not a late result", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await w.hyper.revokeClaim({ id: claim.id, reason: "taking over" }, as(w.alice));
    // Bob never held fence 1.
    const issues = await issuesOf(submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "mine" }, as(w.bob), w.binding));
    expect(codes(issues)).toEqual(["claim.current-fence"]);
    expect(issues[0]!.details).toEqual({ currentFence: 1, stale: false });
    expect(await w.hyper.readLateResult({}, as(w.alice))).toEqual([]);
  }));

  test("the generated recordLateResult refuses a fence that is not stale (claim.stale-fence)", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    expect(codes(await issuesOf(w.hyper.recordLateResult({ task: w.task.id, fence: claim.fence, summary: "x" }, as(w.bot))))).toEqual(["claim.stale-fence"]);
  }));
});

describe("effects across aggregates in the identity commands", () => {
  test("membership.revoke revokes the collaborator's claims and bumps each task once", () => within(async (w) => {
    const other = await w.hyper.createTask({ title: "Other" }, as(w.alice));
    const claims = [await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot)), await w.hyper.acquireClaim({ task: other.id }, as(w.bot))];
    const versions = await Promise.all([w.task.id, other.id].map(async (id) => (await taskOf(w, id)).version));
    const { membership } = await membershipRevoke({ id: w.memberships.bot.id, reason: "left" }, as(w.alice), w.binding);
    expect(membership).toMatchObject({ state: "revoked", revokedById: w.alice.id, revokedAt: NOW, version: 2 });
    for (const claim of claims) expect(await one(w.hyper.readClaim({ filter: { id: { eq: claim.id } } }, as(w.alice)))).toMatchObject({ state: "revoked", endReason: "membership revoked" });
    expect(await Promise.all([w.task.id, other.id].map(async (id) => (await taskOf(w, id)).version))).toEqual(versions.map((v) => v + 1));
  }));

  test("collaborator.retire revokes the membership and the claims; the generated action alone leaves both", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const { collaborator } = await collaboratorRetire({ id: w.bot.id }, as(w.alice), w.binding);
    expect(collaborator).toMatchObject({ state: "retired", version: 2 });
    expect(await one(w.hyper.readMembership({ filter: { id: { eq: w.memberships.bot.id } } }, as(w.alice)))).toMatchObject({ state: "revoked" });
    expect(await one(w.hyper.readClaim({ filter: { id: { eq: claim.id } } }, as(w.alice)))).toMatchObject({ state: "revoked", endReason: "membership revoked" });
    await w.hyper.retireCollaborator({ id: w.bob.id }, as(w.alice));
    expect(await one(w.hyper.readMembership({ filter: { id: { eq: w.memberships.bob.id } } }, as(w.alice)))).toMatchObject({ state: "active" });
  }));

  test("retiring the last owner is refused by membership.last-owner and changes nothing", () => within(async (w) => {
    expect(codes(await issuesOf(collaboratorRetire({ id: w.alice.id }, as(w.alice), w.binding)))).toEqual(["membership.last-owner"]);
    expect(codes(await issuesOf(membershipRevoke({ id: w.memberships.alice.id }, as(w.alice), w.binding)))).toEqual(["membership.last-owner"]);
    expect(await one(w.hyper.readCollaborator({ filter: { id: { eq: w.alice.id } } }, as(w.alice)))).toMatchObject({ state: "active", version: 1 });
  }));
});

describe("effects across aggregates in the execution commands: the machine named by a report", () => {
  test("an unknown name records the machine, a known one is reused, a retired one is refused", () => within(async (w) => {
    await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
    const { attempt } = await attemptStart({ run: run.id, machine: "laptop" }, as(w.bot), w.binding);
    const machine = await one(w.hyper.readMachine({}, as(w.alice)));
    expect(machine).toMatchObject({ name: "laptop", firstReportedById: w.bot.id, state: "active" });
    expect(attempt.machineId).toBe(machine.id);
    const { sessionReference } = await sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: w.bot.id }, as(w.bot), w.binding);
    expect(sessionReference).toMatchObject({ machineId: machine.id, recordedById: w.bot.id });
    await w.hyper.abandonAttempt({ id: attempt.id }, as(w.bot));
    await w.hyper.retireMachine({ id: machine.id, reason: "sold" }, as(w.alice));
    expect(codes(await issuesOf(sessionRecord({ runtime: "claude", runtimeSessionId: "s-2", availability: "complete", machine: "laptop", agentProfile: w.bot.id }, as(w.bot), w.binding)))).toEqual(["machine.retired"]);
    expect(await w.hyper.readMachine({}, as(w.alice))).toHaveLength(1);
  }));

  test("a report that fails after recording a new machine leaves no machine", () => within(async (w) => {
    // Bob holds no claim on the task, so attempt.claimer refuses, and the machine the call recorded rolls back.
    const run = await w.hyper.startRun({ task: w.task.id }, as(w.bob));
    expect(codes(await issuesOf(attemptStart({ run: run.id, machine: "desktop" }, as(w.bob), w.binding)))).toEqual(["attempt.claimer"]);
    expect(await w.hyper.readMachine({}, as(w.alice))).toEqual([]);
  }));
});

describe("PROTOCOL.md §4.5: the Task's version goes up by one per committed command that changes the aggregate", () => {
  test("each command, one bump; a late result, none", () => within(async (w) => {
    const steps: [string, () => Promise<unknown>][] = [];
    let fence = 0;
    let submissionId = "";
    const prerequisite = await w.hyper.createTask({ title: "Prerequisite" }, as(w.alice));
    await w.hyper.completeTask({ id: prerequisite.id }, as(w.alice));
    steps.push(
      ["dependency.add", () => w.hyper.addDependency({ dependent: w.task.id, prerequisite: prerequisite.id }, as(w.alice))],
      ["task.assign", () => w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id }, as(w.alice))],
      ["claim.acquire", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot))).fence; }],
      ["claim.renew", async () => w.hyper.renewClaim({ id: (await claimsOf(w, w.task.id)).find((c) => c.fence === fence)!.id, fence }, as(w.bot))],
      ["submission.submit", async () => { const r = await submissionSubmit({ task: w.task.id, fence, summary: "s" }, as(w.bot), w.binding); submissionId = r.outcome === "submitted" ? r.submission.id : ""; }],
      ["submission.withdraw", () => w.hyper.withdrawSubmission({ id: submissionId }, as(w.bot))],
      ["claim.acquire again", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot))).fence; }],
      ["claim.release", async () => w.hyper.releaseClaim({ id: (await claimsOf(w, w.task.id)).find((c) => c.fence === fence)!.id, fence }, as(w.bot))],
      ["claim.acquire, then submit", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot))).fence; }],
      ["submission.submit again", async () => { const r = await submissionSubmit({ task: w.task.id, fence, summary: "s" }, as(w.bot), w.binding); submissionId = r.outcome === "submitted" ? r.submission.id : ""; }],
      ["review.return", () => w.hyper.returnReview({ submission: submissionId, reasons: "more tests" }, as(w.alice))],
      ["task.unassign", () => w.hyper.unassignTask({ id: w.task.id }, as(w.alice))],
      ["claim.acquire by Alice", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice))).fence; }],
      ["claim.revoke", async () => w.hyper.revokeClaim({ id: (await claimsOf(w, w.task.id)).find((c) => c.fence === fence)!.id, reason: "stop" }, as(w.alice))],
      ["claim.acquire, then expire", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice))).fence; }],
      ["claim.expire", async () => w.hyper.expireClaim({ id: (await claimsOf(w, w.task.id)).find((c) => c.fence === fence)!.id }, as(w.alice))],
      ["dependency.remove", async () => w.hyper.removeDependency({ id: (await one(w.hyper.readDependency({}, as(w.alice)))).id }, as(w.alice))],
      ["task.setPriority", () => w.hyper.setPriorityTask({ id: w.task.id, priority: 2 }, as(w.alice))],
      ["claim.acquire, then complete", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice))).fence; }],
      // The completion, the accepted submission and the released claim are three writes in the aggregate: one bump.
      ["task.complete with a summary, releasing the live claim", () => taskComplete({ id: w.task.id, fence, summary: "done" }, as(w.alice), w.binding)],
      ["task.reopen", () => w.hyper.reopenTask({ id: w.task.id, reason: "again" }, as(w.alice))],
      ["claim.acquire, then submit for review", async () => { fence = (await w.hyper.acquireClaim({ task: w.task.id }, as(w.alice))).fence; }],
      ["submission.submit for review", async () => { const r = await submissionSubmit({ task: w.task.id, fence, summary: "s" }, as(w.alice), w.binding); submissionId = r.outcome === "submitted" ? r.submission.id : ""; }],
      // Settling the submission and completing the Task: one bump.
      ["review.accept", () => reviewAccept({ submission: submissionId }, as(w.alice), w.binding)],
      ["task.reopen again", () => w.hyper.reopenTask({ id: w.task.id, reason: "again" }, as(w.alice))],
      ["task.cancel", () => taskCancel({ id: w.task.id, reason: "stop" }, as(w.alice), w.binding)],
    );
    for (const [name, step] of steps) {
      const before = (await taskOf(w, w.task.id)).version;
      await step();
      expect((await taskOf(w, w.task.id)).version, name).toBe(before + 1);
    }
  }));

  test("a late result does not bump the task", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
    await w.hyper.revokeClaim({ id: claim.id, reason: "stop" }, as(w.alice));
    const before = (await taskOf(w, w.task.id)).version;
    expect((await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "late" }, as(w.bot), w.binding)).outcome).toBe("late-result-recorded");
    expect((await taskOf(w, w.task.id)).version).toBe(before);
  }));
});

describe("the command functions", () => {
  test("follow Hyper's method names in camelCase, and none is a name `#mesh` exports", () => {
    const exported = new Set(Object.keys(mesh));
    const functions = { ...workCommands, ...identityCommands, ...executionCommands };
    expect(Object.keys(functions).sort()).toEqual(["attemptStart", "collaboratorRetire", "membershipRevoke", "reviewAccept", "sessionRecord", "submissionSubmit", "taskCancel", "taskComplete"]);
    for (const name of Object.keys(functions)) expect(exported.has(name), name).toBe(false);
    // The generated names put the action first, so `<entity><Method>` cannot meet one.
    expect(exported.has("completeTask") && exported.has("cancelTask") && exported.has("revokeMembership")).toBe(true);
  });
});
