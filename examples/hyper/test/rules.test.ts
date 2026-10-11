// Roadmap M5 acceptance test 9: each of Hyper's 57 named rules (gap analysis, Appendix A) has a passing and a failing
// case through the generated actions, named by Hyper's rule name as the issue `code`. A command whose effect crosses
// aggregates is called through its function in `src/domain/<module>/<module>.commands.ts`, never through the generated
// action alone (PORTING.md). The two rules whose case needs policies or plugins are listed in NOT_PORTED with the
// reason and the milestone; the last test checks that the two lists together are the 57, and that every code an entity
// file reports, at any depth under the domain root, has its cases here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import { collaboratorRetire, membershipRevoke } from "../src/domain/identity/identity.commands";
import { reviewAccept, submissionSubmit, taskCancel, taskComplete } from "../src/domain/work/work.commands";
import { as, codes, issuesOf, minutes, NOW, one, setup, within, type World } from "./world";

const GHOST = "00000000-0000-4000-8000-0000000000ff";
type Who = { readonly id: string };

/** The failing case: the call is refused, and its issues include `code` (with `details`, when given). */
async function refused(call: Promise<unknown>, code: string, details?: unknown): Promise<void> {
  const issues = await issuesOf(call);
  const issue = issues.find((candidate) => candidate.code === code);
  expect(issue, `expected ${code}, got ${JSON.stringify(codes(issues))}`).toBeDefined();
  if (details !== undefined) expect(issue!.details).toEqual(details);
}

const taskOf = (w: World, id: string = w.task.id) => one(w.hyper.readTask({ filter: { id: { eq: id } } }, as(w.alice)));
const claim = (w: World, who: Who = w.bot, task: string = w.task.id) => w.hyper.acquireClaim({ task }, as(who));
const evidence = (w: World, who: Who = w.bot) => w.hyper.recordEvidenceReference({ kind: "file", locator: "report.md" }, as(who));

/** `who` claims the task and submits: a pending submission, and the claim released. */
async function submitted(w: World, who: Who = w.bot, task: string = w.task.id) {
  const held = await claim(w, who, task);
  const result = await submissionSubmit({ task, fence: held.fence, summary: "done" }, as(who), w.binding);
  if (result.outcome !== "submitted") throw new Error(result.outcome);
  return { claim: held, submission: result.submission };
}

/** Alice, the creator and so the reviewer of a top-level task, completes it. */
async function completed(w: World, task: string = w.task.id) {
  const result = await taskComplete({ id: task }, as(w.alice), w.binding);
  if (result.outcome !== "completed") throw new Error(result.outcome);
  return result.task;
}

/** Bot claims the task and starts a run on it. */
async function running(w: World) {
  await claim(w);
  return w.hyper.startRun({ task: w.task.id }, as(w.bot));
}

const session = async (w: World, runtimeSessionId = "s-1", machine = "laptop") =>
  (await sessionRecord({ runtime: "claude", runtimeSessionId, availability: "complete", location: "/home/s", machine, agentProfile: w.bot.id }, as(w.bot), w.binding)).sessionReference;

const started = async (w: World, run: { id: string }, input: { step?: string; machine?: string; session?: string } = {}) =>
  (await attemptStart({ run: run.id, ...input }, as(w.bot), w.binding)).attempt;

interface Case {
  readonly pass: (w: World) => Promise<void>;
  readonly fail: (w: World) => Promise<void>;
}

/** Hyper's rules that run here, each with a passing and a failing case. The keys are the issue codes. */
const RULES: Record<string, Case> = {
  "workspace.active": {
    pass: async (w) => {
      const workspace = await w.hyper.createWorkspace({ name: "Home" }, as(w.alice));
      expect((await w.hyper.renameWorkspace({ id: workspace.id, name: "Base" }, as(w.alice))).name).toBe("Base");
    },
    fail: async (w) => {
      const workspace = await w.hyper.createWorkspace({ name: "Home" }, as(w.alice));
      // No action moves a workspace (export and import are after 1.0), so the state is written as it is.
      await w.force("workspace", workspace.id, { state: "moved" });
      await refused(w.hyper.renameWorkspace({ id: workspace.id, name: "Again" }, as(w.alice)), "workspace.active");
    },
  },
  "collaborator.active": {
    pass: async (w) => {
      expect((await w.hyper.updateCollaborator({ id: w.bob.id, name: "Robert" }, as(w.bob))).name).toBe("Robert");
    },
    fail: async (w) => {
      await collaboratorRetire({ id: w.bob.id, reason: "left" }, as(w.alice), w.binding);
      await refused(w.hyper.updateCollaborator({ id: w.bob.id, name: "Ghost" }, as(w.bob)), "collaborator.active");
      await refused(w.hyper.retireCollaborator({ id: w.bob.id }, as(w.alice)), "collaborator.active");
      await refused(w.hyper.grantMembership({ collaborator: w.bob.id, role: "member" }, as(w.alice)), "collaborator.active");
      await refused(w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice)), "collaborator.active");
    },
  },
  "collaborator.name-unique": {
    pass: async (w) => {
      await w.hyper.registerCollaborator({ kind: "human", name: "Carol" }, setup);
      expect((await w.hyper.updateCollaborator({ id: w.bob.id, name: "Bob" }, as(w.bob))).name).toBe("Bob");
    },
    fail: async (w) => {
      await refused(w.hyper.registerCollaborator({ kind: "human", name: "Alice" }, setup), "collaborator.name-unique");
      await refused(w.hyper.updateCollaborator({ id: w.bob.id, name: "Alice" }, as(w.bob)), "collaborator.name-unique");
    },
  },
  "collaborator.kind-immutable": {
    pass: async (w) => {
      expect(await w.hyper.updateCollaborator({ id: w.bot.id, name: "Robot", kind: "agent" }, as(w.bot))).toMatchObject({ name: "Robot", kind: "agent" });
    },
    fail: async (w) => {
      await refused(w.hyper.updateCollaborator({ id: w.bot.id, kind: "human" }, as(w.bot)), "collaborator.kind-immutable");
    },
  },
  "membership.last-owner": {
    pass: async (w) => {
      await w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "owner" }, as(w.alice));
      expect((await membershipRevoke({ id: w.memberships.alice.id }, as(w.bob), w.binding)).membership.state).toBe("revoked");
    },
    fail: async (w) => {
      await refused(membershipRevoke({ id: w.memberships.alice.id }, as(w.alice), w.binding), "membership.last-owner");
      await refused(w.hyper.changeRoleMembership({ id: w.memberships.alice.id, role: "member" }, as(w.alice)), "membership.last-owner");
      await refused(collaboratorRetire({ id: w.alice.id }, as(w.alice), w.binding), "membership.last-owner");
      expect(await one(w.hyper.readMembership({ filter: { id: { eq: w.memberships.alice.id } } }, as(w.alice)))).toMatchObject({ state: "active", role: "owner", version: 1 });
    },
  },
  "membership.none-active": {
    pass: async (w) => {
      const carol = await w.hyper.registerCollaborator({ kind: "human", name: "Carol" }, setup);
      await w.hyper.grantMembership({ collaborator: carol.id, role: "guest" }, as(w.alice));
      // A revoked membership does not count.
      await membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding);
      expect((await w.hyper.grantMembership({ collaborator: w.bob.id, role: "member" }, as(w.alice))).state).toBe("active");
    },
    fail: async (w) => {
      await refused(w.hyper.grantMembership({ collaborator: w.bob.id, role: "owner" }, as(w.alice)), "membership.none-active");
    },
  },
  "membership.active": {
    pass: async (w) => {
      expect((await w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "guest" }, as(w.alice))).role).toBe("guest");
    },
    fail: async (w) => {
      await membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding);
      await refused(w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "guest" }, as(w.alice)), "membership.active");
      await refused(membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding), "membership.active");
    },
  },
  "membership.unchanged": {
    pass: async (w) => {
      expect((await w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "owner" }, as(w.alice))).role).toBe("owner");
    },
    fail: async (w) => {
      await refused(w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: "member" }, as(w.alice)), "membership.unchanged");
    },
  },
  "machine.name-free": {
    pass: async (w) => {
      await w.hyper.registerMachine({ name: "laptop" }, as(w.alice));
      expect((await w.hyper.reportMachine({ name: "desktop" }, as(w.bot))).firstReportedById).toBe(w.bot.id);
    },
    fail: async (w) => {
      await w.hyper.registerMachine({ name: "laptop" }, as(w.alice));
      await refused(w.hyper.registerMachine({ name: "laptop" }, as(w.alice)), "machine.name-free");
      await refused(w.hyper.reportMachine({ name: "laptop" }, as(w.bot)), "machine.name-free");
    },
  },
  "machine.active": {
    pass: async (w) => {
      const machine = await w.hyper.registerMachine({ name: "laptop" }, as(w.alice));
      expect((await w.hyper.updateMachine({ id: machine.id, platform: "linux" }, as(w.alice))).platform).toBe("linux");
    },
    fail: async (w) => {
      const machine = await w.hyper.registerMachine({ name: "laptop" }, as(w.alice));
      await w.hyper.retireMachine({ id: machine.id, reason: "sold" }, as(w.alice));
      await refused(w.hyper.updateMachine({ id: machine.id, platform: "mac" }, as(w.alice)), "machine.active");
      await refused(w.hyper.retireMachine({ id: machine.id, reason: "again" }, as(w.alice)), "machine.active");
    },
  },
  "machine.idle": {
    pass: async (w) => {
      const attempt = await started(w, await running(w), { machine: "laptop" });
      await w.hyper.abandonAttempt({ id: attempt.id }, as(w.bot));
      expect((await w.hyper.retireMachine({ id: attempt.machineId!, reason: "sold" }, as(w.alice))).state).toBe("retired");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w), { machine: "laptop" });
      await refused(w.hyper.retireMachine({ id: attempt.machineId!, reason: "sold" }, as(w.alice)), "machine.idle");
    },
  },
  "session.agent-profile": {
    pass: async (w) => {
      expect((await session(w)).agentProfileId).toBe(w.bot.id);
    },
    fail: async (w) => {
      await refused(sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: GHOST }, as(w.bot), w.binding), "session.agent-profile");
      // The machine the report recorded rolled back with it.
      expect(await w.hyper.readMachine({}, as(w.alice))).toEqual([]);
    },
  },
  "session.not-redacted": {
    pass: async (w) => {
      const reference = await session(w);
      expect(await w.hyper.redactSessionReference({ id: reference.id, reason: "private" }, as(w.alice))).toMatchObject({ availability: "redacted", location: null });
    },
    fail: async (w) => {
      const reference = await session(w);
      await w.hyper.redactSessionReference({ id: reference.id, reason: "private" }, as(w.alice));
      await refused(w.hyper.redactSessionReference({ id: reference.id, reason: "again" }, as(w.alice)), "session.not-redacted");
      await refused(w.hyper.setAvailabilitySessionReference({ id: reference.id, availability: "complete" }, as(w.alice)), "session.not-redacted");
    },
  },
  "session.availability": {
    pass: async (w) => {
      const reference = await session(w);
      expect((await w.hyper.setAvailabilitySessionReference({ id: reference.id, availability: "partial" }, as(w.bot))).availability).toBe("partial");
    },
    fail: async (w) => {
      const reference = await session(w);
      await refused(w.hyper.setAvailabilitySessionReference({ id: reference.id, availability: "redacted" }, as(w.bot)), "session.availability");
    },
  },
  "task.open": {
    pass: async (w) => {
      expect((await w.hyper.setPriorityTask({ id: w.task.id, priority: 3 }, as(w.alice))).priority).toBe(3);
    },
    fail: async (w) => {
      await completed(w);
      await refused(w.hyper.setPriorityTask({ id: w.task.id, priority: 4 }, as(w.alice)), "task.open");
      await refused(w.hyper.updateTask({ id: w.task.id, title: "New" }, as(w.alice)), "task.open");
      await refused(w.hyper.moveTask({ id: w.task.id, parent: null }, as(w.alice)), "task.open");
      await refused(w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice)), "task.open");
      await refused(taskCancel({ id: w.task.id, reason: "late" }, as(w.alice), w.binding), "task.open");
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "task.open");
      await refused(submissionSubmit({ task: w.task.id, fence: 1, summary: "s" }, as(w.bot), w.binding), "task.open");
    },
  },
  "claim.current-fence": {
    pass: async (w) => {
      const held = await claim(w);
      expect((await w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bot))).fence).toBe(1);
      expect((await w.hyper.releaseClaim({ id: held.id, fence: held.fence }, as(w.bot))).state).toBe("released");
    },
    fail: async (w) => {
      const held = await claim(w);
      await refused(w.hyper.renewClaim({ id: held.id, fence: 2 }, as(w.bot)), "claim.current-fence", { currentFence: 1, stale: false });
      await refused(w.hyper.releaseClaim({ id: held.id, fence: 2 }, as(w.bot)), "claim.current-fence");
      // On task.complete and submission.submit: a fence that is not the live claim's, or a live claim held by another.
      await refused(taskComplete({ id: w.task.id, fence: 2 }, as(w.alice), w.binding), "claim.current-fence", { currentFence: 1, stale: false });
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "claim.current-fence");
      await refused(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "mine" }, as(w.bob), w.binding), "claim.current-fence");
    },
  },
  "submission.pending": {
    pass: async (w) => {
      const { submission } = await submitted(w);
      expect((await w.hyper.withdrawSubmission({ id: submission.id }, as(w.bot))).state).toBe("withdrawn");
    },
    fail: async (w) => {
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      const { submission } = await submitted(w);
      // task.complete with a new summary while the actor's own submission is pending.
      await refused(taskComplete({ id: w.task.id, summary: "again" }, as(w.bot), w.binding), "submission.pending");
      await w.hyper.withdrawSubmission({ id: submission.id }, as(w.bot));
      await refused(w.hyper.withdrawSubmission({ id: submission.id }, as(w.bot)), "submission.pending");
      await refused(reviewAccept({ submission: submission.id }, as(w.alice), w.binding), "submission.pending");
      await refused(w.hyper.returnReview({ submission: submission.id, reasons: "no" }, as(w.alice)), "submission.pending");
    },
  },
  "evidence.exists": {
    pass: async (w) => {
      const reference = await evidence(w);
      const held = await claim(w);
      const result = await submissionSubmit({ task: w.task.id, fence: held.fence, summary: "done", evidence: [reference.id] }, as(w.bot), w.binding);
      expect(result).toMatchObject({ outcome: "submitted", submission: { evidence: [reference.id] } });
    },
    fail: async (w) => {
      const reference = await evidence(w);
      const held = await claim(w);
      await refused(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "done", evidence: [reference.id, GHOST] }, as(w.bot), w.binding), "evidence.exists", { missing: [GHOST] });
      await refused(taskComplete({ id: w.task.id, fence: held.fence, summary: "done", evidence: [GHOST] }, as(w.bot), w.binding), "evidence.exists");
      // Evidence is a list of ids (`schemas/protocol.ts:603`): a value that is not a list is reported, never stored.
      await refused(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "done", evidence: "abc" }, as(w.bot), w.binding), "evidence.exists", { missing: ["abc"] });
      await refused(taskComplete({ id: w.task.id, fence: held.fence, summary: "done", evidence: { id: GHOST } }, as(w.bot), w.binding), "evidence.exists", { missing: [JSON.stringify({ id: GHOST })] });
      await w.hyper.revokeClaim({ id: held.id, reason: "taking over" }, as(w.alice));
      await refused(w.hyper.recordLateResult({ task: w.task.id, fence: held.fence, evidence: [GHOST] }, as(w.bot)), "evidence.exists");
      // The late result a stale fence records, through both functions.
      await refused(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "late", evidence: "abc" }, as(w.bot), w.binding), "evidence.exists", { missing: ["abc"] });
      await refused(taskComplete({ id: w.task.id, fence: held.fence, evidence: 5 }, as(w.bot), w.binding), "evidence.exists", { missing: ["5"] });
      expect(await w.hyper.readSubmission({}, as(w.alice))).toEqual([]);
      expect(await w.hyper.readLateResult({}, as(w.alice))).toEqual([]);
    },
  },
  "task.settled": {
    pass: async (w) => {
      await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
      expect(await w.hyper.reopenTask({ id: w.task.id, reason: "now" }, as(w.alice))).toMatchObject({ state: "open" });
    },
    fail: async (w) => {
      await refused(w.hyper.reopenTask({ id: w.task.id, reason: "why" }, as(w.alice)), "task.settled");
    },
  },
  "task.unchanged": {
    pass: async (w) => {
      expect((await w.hyper.updateTask({ id: w.task.id, title: "Ship it" }, as(w.alice))).title).toBe("Ship it");
      expect((await w.hyper.updateTask({ id: w.task.id, intent: "by Friday" }, as(w.alice))).intent).toBe("by Friday");
      expect((await w.hyper.updateTask({ id: w.task.id, intent: null }, as(w.alice))).intent).toBeNull();
    },
    fail: async (w) => {
      // `before` holds the stored values; an omitted input keeps them, so nothing differs.
      await refused(w.hyper.updateTask({ id: w.task.id, title: "Ship" }, as(w.alice)), "task.unchanged");
      await refused(w.hyper.updateTask({ id: w.task.id, intent: null }, as(w.alice)), "task.unchanged");
    },
  },
  "task.parent-open": {
    pass: async (w) => {
      expect((await w.hyper.createTask({ title: "child", parent: w.task.id }, as(w.alice))).parentId).toBe(w.task.id);
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      expect((await w.hyper.moveTask({ id: other.id, parent: w.task.id }, as(w.alice))).parentId).toBe(w.task.id);
    },
    fail: async (w) => {
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
      await refused(w.hyper.createTask({ title: "late child", parent: w.task.id }, as(w.alice)), "task.parent-open");
      await refused(w.hyper.moveTask({ id: other.id, parent: w.task.id }, as(w.alice)), "task.parent-open");
    },
  },
  "task.no-cycle": {
    pass: async (w) => {
      const child = await w.hyper.createTask({ title: "child", parent: w.task.id }, as(w.alice));
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      expect((await w.hyper.moveTask({ id: child.id, parent: other.id }, as(w.alice))).parentId).toBe(other.id);
    },
    fail: async (w) => {
      const child = await w.hyper.createTask({ title: "child", parent: w.task.id }, as(w.alice));
      const grandchild = await w.hyper.createTask({ title: "grandchild", parent: child.id }, as(w.alice));
      await refused(w.hyper.moveTask({ id: w.task.id, parent: grandchild.id }, as(w.alice)), "task.no-cycle");
      await refused(w.hyper.moveTask({ id: w.task.id, parent: w.task.id }, as(w.alice)), "task.no-cycle");
    },
  },
  "task.children-settled": {
    pass: async (w) => {
      const child = await w.hyper.createTask({ title: "child", parent: w.task.id }, as(w.alice));
      const canceled = await w.hyper.createTask({ title: "dropped", parent: w.task.id }, as(w.alice));
      await completed(w, child.id);
      await taskCancel({ id: canceled.id, reason: "dropped" }, as(w.alice), w.binding);
      expect((await completed(w)).state).toBe("done");
    },
    fail: async (w) => {
      const child = await w.hyper.createTask({ title: "child", parent: w.task.id }, as(w.alice));
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "task.children-settled", { openChildren: [child.id] });
    },
  },
  "task.review-required": {
    pass: async (w) => {
      // The reviewer completes without review; so does the assignee of an assignment that waives it.
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id, waiveReview: true }, as(w.alice));
      const result = await taskComplete({ id: w.task.id }, as(w.bob), w.binding);
      expect(result).toMatchObject({ outcome: "completed", completion: { rule: "review-waived", completedById: w.bob.id } });
    },
    fail: async (w) => {
      await refused(taskComplete({ id: w.task.id }, as(w.bob), w.binding), "task.review-required", { reviewerId: w.alice.id });
      // The waiver covers its assignee only.
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      await refused(taskComplete({ id: w.task.id }, as(w.bob), w.binding), "task.review-required");
    },
  },
  "task.no-foreign-submission": {
    pass: async (w) => {
      // A foreign submission that was returned no longer blocks the reviewer.
      const { submission } = await submitted(w);
      await w.hyper.returnReview({ submission: submission.id, reasons: "redo" }, as(w.alice));
      expect((await completed(w)).state).toBe("done");
    },
    fail: async (w) => {
      await submitted(w);
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "task.no-foreign-submission");
    },
  },
  "task.no-active-claim": {
    pass: async (w) => {
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      const held = await claim(w);
      await w.hyper.releaseClaim({ id: held.id, fence: held.fence }, as(w.bot));
      expect((await w.hyper.moveTask({ id: w.task.id, parent: other.id }, as(w.alice))).parentId).toBe(other.id);
    },
    fail: async (w) => {
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      await claim(w);
      await refused(w.hyper.moveTask({ id: w.task.id, parent: other.id }, as(w.alice)), "task.no-active-claim");
    },
  },
  "claim.invalidated": {
    pass: async (w) => {
      // Bot is the assignee of an assignment that waives review, so only the fence rules stand between Bot and done.
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      const revoked = await claim(w);
      await w.hyper.revokeClaim({ id: revoked.id, reason: "taking over" }, as(w.alice));
      // With a fence, the rule does not apply: Bot claims again and completes with the new fence.
      const again = await claim(w);
      w.advance(1);
      expect(await taskComplete({ id: w.task.id, fence: again.fence }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });
      // The revoke came before the last completion and the reopen after it, so Bot completes without a fence.
      w.advance(1);
      await w.hyper.reopenTask({ id: w.task.id, reason: "again" }, as(w.alice));
      w.advance(1);
      expect(await taskComplete({ id: w.task.id }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });
      // A cancel revokes Bot's claim after that completion; the reopen after the cancel is what clears it, and the Task
      // stores when it was reopened because a reopen leaves no other row.
      w.advance(1);
      await w.hyper.reopenTask({ id: w.task.id, reason: "again" }, as(w.alice));
      await claim(w);
      w.advance(1);
      await taskCancel({ id: w.task.id, reason: "paused" }, as(w.alice), w.binding);
      w.advance(1);
      expect((await w.hyper.reopenTask({ id: w.task.id, reason: "resumed" }, as(w.alice))).reopenedAt).toEqual(minutes(6));
      w.advance(1);
      expect(await taskComplete({ id: w.task.id }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });
    },
    fail: async (w) => {
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      // Revoked: an unfenced completion after the actor's claim was revoked is refused, and changes nothing.
      const revoked = await claim(w);
      await w.hyper.revokeClaim({ id: revoked.id, reason: "taking over" }, as(w.alice));
      const before = await taskOf(w);
      const issues = await issuesOf(taskComplete({ id: w.task.id }, as(w.bot), w.binding));
      expect(codes(issues)).toEqual(["claim.invalidated"]);
      expect(issues[0]!.details).toEqual({ fences: [revoked.fence] });
      expect(await taskOf(w)).toEqual(before);
      expect(await w.hyper.readCompletion({}, as(w.alice))).toEqual([]);
      // Expired: a claim whose lease ran out counts from its lease end, whether or not it was marked expired yet.
      const lapsed = await claim(w);
      w.advance(11);
      await refused(taskComplete({ id: w.task.id }, as(w.bot), w.binding), "claim.invalidated", { fences: [revoked.fence, lapsed.fence] });
      // The next acquire marks it expired; Bot releases the new claim, and both earlier fences still count.
      const third = await claim(w);
      expect(await one(w.hyper.readClaim({ filter: { id: { eq: lapsed.id } } }, as(w.alice)))).toMatchObject({ state: "expired", endedAt: minutes(11) });
      await w.hyper.releaseClaim({ id: third.id, fence: third.fence }, as(w.bot));
      await refused(taskComplete({ id: w.task.id }, as(w.bot), w.binding), "claim.invalidated", { fences: [revoked.fence, lapsed.fence] });
      // The generated action alone applies the rule too.
      await refused(w.hyper.completeTask({ id: w.task.id }, as(w.bot)), "claim.invalidated");
    },
  },
  "assignment.assignee-role": {
    pass: async (w) => {
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      expect(await w.hyper.readAssignment({}, as(w.alice))).toMatchObject([{ assigneeId: w.bob.id, delegatorId: w.alice.id }]);
    },
    fail: async (w) => {
      const carol = await w.hyper.registerCollaborator({ kind: "human", name: "Carol" }, setup);
      await refused(w.hyper.assignTask({ id: w.task.id, assignee: carol.id }, as(w.alice)), "assignment.assignee-role");
      await w.hyper.grantMembership({ collaborator: carol.id, role: "guest" }, as(w.alice));
      await refused(w.hyper.assignTask({ id: w.task.id, assignee: carol.id }, as(w.alice)), "assignment.assignee-role");
    },
  },
  "assignment.unchanged": {
    pass: async (w) => {
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id, waiveReview: true }, as(w.alice));
      expect(await w.hyper.readAssignment({ sort: ["startedAt", "id"] }, as(w.alice))).toMatchObject([{ reviewWaived: false, endReason: "reassigned" }, { reviewWaived: true, endedAt: null }]);
    },
    fail: async (w) => {
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      await refused(w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id, waiveReview: false }, as(w.alice)), "assignment.unchanged");
    },
  },
  "assignment.current": {
    pass: async (w) => {
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      await w.hyper.unassignTask({ id: w.task.id }, as(w.alice));
      expect(await w.hyper.readAssignment({}, as(w.alice))).toMatchObject([{ endReason: "unassigned", endedAt: NOW }]);
    },
    fail: async (w) => {
      await refused(w.hyper.unassignTask({ id: w.task.id }, as(w.alice)), "assignment.current");
      await w.hyper.assignTask({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      const [assignment] = await w.hyper.readAssignment({}, as(w.alice));
      await w.hyper.unassignTask({ id: w.task.id }, as(w.alice));
      await refused(w.hyper.finishAssignment({ id: assignment!.id, reason: "unassigned" }, as(w.alice)), "assignment.current");
    },
  },
  "claim.task-ready": {
    pass: async (w) => {
      expect((await claim(w)).state).toBe("active");
    },
    fail: async (w) => {
      await claim(w);
      await refused(claim(w, w.bob), "claim.task-ready", { derivedState: "claimed", reasons: [] });
      const prerequisite = await w.hyper.createTask({ title: "Design" }, as(w.alice));
      const other = await w.hyper.createTask({ title: "Build" }, as(w.alice));
      await w.hyper.addDependency({ dependent: other.id, prerequisite: prerequisite.id }, as(w.alice));
      await refused(claim(w, w.bob, other.id), "claim.task-ready", { derivedState: "blocked", reasons: [{ kind: "dependency", taskId: prerequisite.id, message: "blocked: waiting for Design" }] });
    },
  },
  "claim.active": {
    pass: async (w) => {
      const held = await claim(w);
      expect(await w.hyper.revokeClaim({ id: held.id, reason: "taking over" }, as(w.alice))).toMatchObject({ state: "revoked", endReason: "taking over", endedAt: NOW });
    },
    fail: async (w) => {
      const held = await claim(w);
      await w.hyper.releaseClaim({ id: held.id, fence: held.fence, reason: "done" }, as(w.bot));
      await refused(w.hyper.releaseClaim({ id: held.id, fence: held.fence }, as(w.bot)), "claim.active");
      await refused(w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bot)), "claim.active");
      await refused(w.hyper.revokeClaim({ id: held.id, reason: "late" }, as(w.alice)), "claim.active");
      await refused(w.hyper.expireClaim({ id: held.id }, as(w.alice)), "claim.active");
    },
  },
  "claim.expired": {
    pass: async (w) => {
      const held = await claim(w);
      w.advance(9);
      // The lease runs ten minutes from the renewal.
      expect((await w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bot))).expiresAt).toEqual(minutes(19));
    },
    fail: async (w) => {
      const held = await claim(w);
      w.advance(10);
      await refused(w.hyper.renewClaim({ id: held.id, fence: held.fence }, as(w.bot)), "claim.expired");
      await refused(w.hyper.releaseClaim({ id: held.id, fence: held.fence }, as(w.bot)), "claim.expired");
      expect(await one(w.hyper.readClaim({ filter: { id: { eq: held.id } } }, as(w.alice)))).toMatchObject({ state: "active", expiresAt: minutes(10) });
    },
  },
  "submission.none-pending": {
    pass: async (w) => {
      const first = await submitted(w);
      await w.hyper.returnReview({ submission: first.submission.id, reasons: "redo" }, as(w.alice));
      const second = await submitted(w);
      expect(second.claim.fence).toBe(2);
    },
    fail: async (w) => {
      // A pending submission makes the task in review, so no live claim can exist beside it: the second submission
      // also fails claim.current-fence, and both are reported.
      const { claim: held } = await submitted(w);
      await refused(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "again" }, as(w.bot), w.binding), "submission.none-pending");
      // No action reaches a live claim beside a pending submission (Hyper's rule is defensive, `submission/rules.ex:9`),
      // so the claim is inserted as it is; the rule then fails alone.
      await w.insert("claim", { taskId: w.task.id, holderId: w.bot.id, fence: held.fence + 1, acquiredAt: NOW, expiresAt: minutes(10), state: "active" });
      const issues = await issuesOf(submissionSubmit({ task: w.task.id, fence: held.fence + 1, summary: "again" }, as(w.bot), w.binding));
      expect(codes(issues)).toEqual(["submission.none-pending"]);
    },
  },
  "submission.task-version": {
    pass: async (w) => {
      const { submission } = await submitted(w);
      expect((await reviewAccept({ submission: submission.id }, as(w.alice), w.binding)).task.state).toBe("done");
    },
    fail: async (w) => {
      const { submission } = await submitted(w);
      await w.hyper.setPriorityTask({ id: w.task.id, priority: 1 }, as(w.alice));
      await refused(reviewAccept({ submission: submission.id }, as(w.alice), w.binding), "submission.task-version");
    },
  },
  "expected-version": {
    pass: async (w) => {
      expect((await w.hyper.setPriorityTask({ id: w.task.id, priority: 1, expectedVersion: 1 }, as(w.alice))).version).toBe(2);
      // A command on a record of the Task aggregate checks the Task's version.
      expect((await w.hyper.acquireClaim({ task: w.task.id, expectedVersion: 2 }, as(w.bot))).fence).toBe(1);
    },
    fail: async (w) => {
      await w.hyper.setPriorityTask({ id: w.task.id, priority: 1 }, as(w.alice));
      await refused(w.hyper.setPriorityTask({ id: w.task.id, priority: 2, expectedVersion: 1 }, as(w.alice)), "expected-version", { expectedVersion: 1, actualVersion: 2 });
      await refused(w.hyper.acquireClaim({ task: w.task.id, expectedVersion: 1 }, as(w.bot)), "expected-version");
      await refused(w.hyper.addDependency({ dependent: w.task.id, prerequisite: (await w.hyper.createTask({ title: "pre" }, as(w.alice))).id, expectedVersion: 1 }, as(w.alice)), "expected-version", { expectedVersion: 1, actualVersion: 2 });
      expect(await taskOf(w)).toMatchObject({ priority: 1, version: 2 });
    },
  },
  "claim.stale-fence": {
    pass: async (w) => {
      const held = await claim(w);
      await w.hyper.revokeClaim({ id: held.id, reason: "taking over" }, as(w.alice));
      const result = await submissionSubmit({ task: w.task.id, fence: held.fence, summary: "late" }, as(w.bot), w.binding);
      expect(result).toMatchObject({ outcome: "late-result-recorded", lateResult: { fence: held.fence } });
    },
    fail: async (w) => {
      // The command functions record a late result only for a stale fence; the generated action refuses any other.
      const held = await claim(w);
      await refused(w.hyper.recordLateResult({ task: w.task.id, fence: held.fence, summary: "x" }, as(w.bot)), "claim.stale-fence");
      await refused(w.hyper.recordLateResult({ task: w.task.id, fence: 7, summary: "x" }, as(w.bot)), "claim.stale-fence");
    },
  },
  "dependency.exists": {
    pass: async (w) => {
      const prerequisite = await w.hyper.createTask({ title: "pre" }, as(w.alice));
      expect(await w.hyper.addDependency({ dependent: w.task.id, prerequisite: prerequisite.id }, as(w.alice))).toMatchObject({ dependentId: w.task.id, createdById: w.alice.id });
    },
    fail: async (w) => {
      await refused(w.hyper.addDependency({ dependent: w.task.id, prerequisite: GHOST }, as(w.alice)), "dependency.exists", { missing: [GHOST] });
      await refused(w.hyper.addDependency({ dependent: GHOST, prerequisite: w.task.id, expectedVersion: 3 }, as(w.alice)), "dependency.exists", { missing: [GHOST] });
      expect(await w.hyper.readDependency({}, as(w.alice))).toEqual([]);
    },
  },
  "dependency.distinct": {
    pass: async (w) => {
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
    },
    fail: async (w) => {
      await refused(w.hyper.addDependency({ dependent: w.task.id, prerequisite: w.task.id }, as(w.alice)), "dependency.distinct");
    },
  },
  "dependency.duplicate": {
    pass: async (w) => {
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      const first = await w.hyper.addDependency({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
      await w.hyper.removeDependency({ id: first.id }, as(w.alice));
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
    },
    fail: async (w) => {
      const other = await w.hyper.createTask({ title: "other" }, as(w.alice));
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
      await refused(w.hyper.addDependency({ dependent: w.task.id, prerequisite: other.id }, as(w.alice)), "dependency.duplicate");
    },
  },
  "dependency.no-cycle": {
    pass: async (w) => {
      const [b, c] = [await w.hyper.createTask({ title: "b" }, as(w.alice)), await w.hyper.createTask({ title: "c" }, as(w.alice))];
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: b.id }, as(w.alice));
      await w.hyper.addDependency({ dependent: b.id, prerequisite: c.id }, as(w.alice));
      // A diamond is not a cycle.
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: c.id }, as(w.alice));
    },
    fail: async (w) => {
      const [b, c] = [await w.hyper.createTask({ title: "b" }, as(w.alice)), await w.hyper.createTask({ title: "c" }, as(w.alice))];
      await w.hyper.addDependency({ dependent: w.task.id, prerequisite: b.id }, as(w.alice));
      await w.hyper.addDependency({ dependent: b.id, prerequisite: c.id }, as(w.alice));
      await refused(w.hyper.addDependency({ dependent: c.id, prerequisite: w.task.id }, as(w.alice)), "dependency.no-cycle");
      await refused(w.hyper.addDependency({ dependent: b.id, prerequisite: w.task.id }, as(w.alice)), "dependency.no-cycle");
    },
  },
  "run.task-open": {
    pass: async (w) => {
      expect(await w.hyper.startRun({ task: w.task.id }, as(w.bot))).toMatchObject({ state: "running", startedById: w.bot.id });
    },
    fail: async (w) => {
      await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
      await refused(w.hyper.startRun({ task: w.task.id }, as(w.bot)), "run.task-open");
    },
  },
  "run.parent-running": {
    pass: async (w) => {
      const parent = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
      expect((await w.hyper.startRun({ task: w.task.id, parentRun: parent.id }, as(w.bot))).parentRunId).toBe(parent.id);
    },
    fail: async (w) => {
      const parent = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
      await w.hyper.cancelRun({ id: parent.id, reason: "stop" }, as(w.alice));
      await refused(w.hyper.startRun({ task: w.task.id, parentRun: parent.id }, as(w.bot)), "run.parent-running");
    },
  },
  "run.cancelable": {
    pass: async (w) => {
      const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
      expect((await w.hyper.cancelRun({ id: run.id, reason: "stop" }, as(w.alice))).state).toBe("canceled");
    },
    fail: async (w) => {
      const run = await w.hyper.startRun({ task: w.task.id }, as(w.bot));
      await w.hyper.cancelRun({ id: run.id, reason: "stop" }, as(w.alice));
      await refused(w.hyper.cancelRun({ id: run.id, reason: "again" }, as(w.alice)), "run.cancelable");
    },
  },
  "attempt.claimer": {
    pass: async (w) => {
      expect(await started(w, await running(w))).toMatchObject({ performerId: w.bot.id, claimFence: 1, number: 1 });
    },
    fail: async (w) => {
      const run = await running(w);
      await refused(attemptStart({ run: run.id }, as(w.bob), w.binding), "attempt.claimer");
      // A lapsed claim is not the actor's any more.
      w.advance(10);
      await refused(attemptStart({ run: run.id }, as(w.bot), w.binding), "attempt.claimer");
    },
  },
  "attempt.run-running": {
    pass: async (w) => {
      expect((await started(w, await running(w))).state).toBe("running");
    },
    fail: async (w) => {
      const run = await running(w);
      await w.hyper.cancelRun({ id: run.id, reason: "stop" }, as(w.alice));
      await refused(attemptStart({ run: run.id }, as(w.bot), w.binding), "attempt.run-running");
    },
  },
  "attempt.step-idle": {
    pass: async (w) => {
      const run = await running(w);
      const first = await started(w, run, { step: "build" });
      expect((await started(w, run, { step: "test" })).number).toBe(1);
      // A retryable failure leaves the run running, so the step can be tried again.
      await w.hyper.finishAttempt({ id: first.id, result: "failed", error: { message: "flaky", retryable: true } }, as(w.bot));
      expect((await started(w, run, { step: "build" })).number).toBe(2);
    },
    fail: async (w) => {
      const run = await running(w);
      await started(w, run, { step: "build" });
      await refused(attemptStart({ run: run.id, step: "build" }, as(w.bot), w.binding), "attempt.step-idle");
    },
  },
  "attempt.session": {
    pass: async (w) => {
      const reference = await session(w);
      expect((await started(w, await running(w), { session: reference.id })).sessionId).toBe(reference.id);
    },
    fail: async (w) => {
      await refused(attemptStart({ run: (await running(w)).id, session: GHOST }, as(w.bot), w.binding), "attempt.session");
    },
  },
  "attempt.running": {
    pass: async (w) => {
      const run = await running(w);
      const attempt = await started(w, run);
      expect((await w.hyper.reportStoppedAttempt({ id: attempt.id, reason: "host rebooted" }, as(w.bot))).state).toBe("stopped");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await w.hyper.abandonAttempt({ id: attempt.id }, as(w.bot));
      await refused(w.hyper.finishAttempt({ id: attempt.id, result: "succeeded" }, as(w.bot)), "attempt.running");
      await refused(w.hyper.reportStoppedAttempt({ id: attempt.id, reason: "x" }, as(w.bot)), "attempt.running");
      await refused(w.hyper.abandonAttempt({ id: attempt.id }, as(w.bot)), "attempt.running");
    },
  },
  "attempt.error": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      expect(await w.hyper.finishAttempt({ id: attempt.id, result: "failed", error: { message: "boom" } }, as(w.bot))).toMatchObject({ state: "failed" });
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await refused(w.hyper.finishAttempt({ id: attempt.id, result: "succeeded", error: { message: "boom" } }, as(w.bot)), "attempt.error");
    },
  },
  "attempt.evidence": {
    pass: async (w) => {
      const reference = await evidence(w);
      const attempt = await started(w, await running(w));
      expect((await w.hyper.finishAttempt({ id: attempt.id, result: "succeeded", evidence: [reference.id] }, as(w.bot))).state).toBe("succeeded");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await refused(w.hyper.finishAttempt({ id: attempt.id, result: "succeeded", evidence: [GHOST] }, as(w.bot)), "attempt.evidence");
    },
  },
  "invocation.session": {
    pass: async (w) => {
      const reference = await session(w);
      const attempt = await started(w, await running(w), { session: reference.id });
      expect((await w.hyper.recordInvocation({ attempt: attempt.id, session: reference.id, usageSource: "runtime" }, as(w.bot))).sessionId).toBe(reference.id);
      expect((await w.hyper.recordInvocation({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot))).sessionId).toBeNull();
    },
    fail: async (w) => {
      const [mine, other] = [await session(w, "s-1"), await session(w, "s-2")];
      const attempt = await started(w, await running(w), { session: mine.id });
      await refused(w.hyper.recordInvocation({ attempt: attempt.id, session: other.id, usageSource: "runtime" }, as(w.bot)), "invocation.session");
    },
  },
  "invocation.cost-unknown": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      expect((await w.hyper.recordInvocation({ attempt: attempt.id, inputTokens: 10, outputTokens: 5, estimatedCost: 0.25, usageSource: "estimate" }, as(w.bot))).estimatedCost).toBe(0.25);
      await w.hyper.recordInvocation({ attempt: attempt.id, inputTokens: 10, usageSource: "runtime" }, as(w.bot));
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await refused(w.hyper.recordInvocation({ attempt: attempt.id, inputTokens: 10, estimatedCost: 0.25, usageSource: "estimate" }, as(w.bot)), "invocation.cost-unknown");
      const original = await w.hyper.recordInvocation({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      await refused(w.hyper.correctInvocation({ corrects: original.id, reason: "cost", estimatedCost: 1, usageSource: "estimate" }, as(w.alice)), "invocation.cost-unknown");
    },
  },
  "invocation.not-corrected": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await w.hyper.recordInvocation({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      const correction = await w.hyper.correctInvocation({ corrects: original.id, reason: "tokens", inputTokens: 3, usageSource: "provider" }, as(w.alice));
      // A correction can itself be corrected, once.
      expect((await w.hyper.correctInvocation({ corrects: correction.id, reason: "again", usageSource: "provider" }, as(w.alice))).correctsId).toBe(correction.id);
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await w.hyper.recordInvocation({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      await w.hyper.correctInvocation({ corrects: original.id, reason: "tokens", usageSource: "provider" }, as(w.alice));
      await refused(w.hyper.correctInvocation({ corrects: original.id, reason: "twice", usageSource: "provider" }, as(w.alice)), "invocation.not-corrected");
    },
  },
  "invocation.reason": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await w.hyper.recordInvocation({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      expect((await w.hyper.correctInvocation({ corrects: original.id, reason: "tokens", usageSource: "provider" }, as(w.alice))).reason).toBe("tokens");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await w.hyper.recordInvocation({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      await refused(w.hyper.correctInvocation({ corrects: original.id, usageSource: "provider" }, as(w.alice)), "invocation.reason");
      await refused(w.hyper.correctInvocation({ corrects: original.id, reason: "", usageSource: "provider" }, as(w.alice)), "invocation.reason");
    },
  },
};

/** A rule of the port that is not one of Hyper's 57: a report that names a retired machine. */
const PORT_ONLY: Record<string, Case> = {
  "machine.retired": {
    pass: async (w) => {
      const attempt = await started(w, await running(w), { machine: "laptop" });
      expect(attempt.machineId).not.toBeNull();
    },
    fail: async (w) => {
      const machine = await w.hyper.registerMachine({ name: "laptop" }, as(w.alice));
      await w.hyper.retireMachine({ id: machine.id, reason: "sold" }, as(w.alice));
      await refused(attemptStart({ run: (await running(w)).id, machine: "laptop" }, as(w.bot), w.binding), "machine.retired");
      await refused(sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: w.bot.id }, as(w.bot), w.binding), "machine.retired");
    },
  },
};

/** Hyper's rules whose cases need policies or plugins, with the milestone that brings them. */
const NOT_PORTED: Record<string, string> = {
  role: "a policy (`canWork(actor)`, `memberships/rules.ex:12`); policies run in M8 (G21)",
  "task.not-blocked": "asks the blocking-condition providers (`tasks/task/rules.ex:82`); providers arrive with the plugin hook points in M6 (G11)",
};

/** Appendix A of the gap analysis: the 57 rule names, in its order. */
const HYPER_RULES = [
  "workspace.active", "collaborator.active", "collaborator.name-unique", "collaborator.kind-immutable", "role",
  "membership.last-owner", "membership.none-active", "membership.active", "membership.unchanged", "machine.name-free",
  "machine.active", "machine.idle", "session.agent-profile", "session.not-redacted", "session.availability", "task.open",
  "claim.current-fence", "submission.pending", "evidence.exists", "task.settled", "task.unchanged", "task.parent-open",
  "task.no-cycle", "task.children-settled", "task.review-required", "task.no-foreign-submission", "task.not-blocked",
  "task.no-active-claim", "claim.invalidated", "assignment.assignee-role", "assignment.unchanged", "assignment.current",
  "claim.task-ready", "claim.active", "claim.expired", "submission.none-pending", "submission.task-version",
  "expected-version", "claim.stale-fence", "dependency.exists", "dependency.distinct", "dependency.duplicate",
  "dependency.no-cycle", "run.task-open", "run.parent-running", "run.cancelable", "attempt.claimer", "attempt.run-running",
  "attempt.step-idle", "attempt.session", "attempt.running", "attempt.error", "attempt.evidence", "invocation.session",
  "invocation.cost-unknown", "invocation.not-corrected", "invocation.reason",
];

describe("roadmap M5 test 9: each of Hyper's rules, a passing and a failing case", () => {
  for (const [code, { pass, fail }] of Object.entries({ ...RULES, ...PORT_ONLY })) {
    test(`${code}: passing case`, () => within(pass));
    test(`${code}: failing case`, () => within(fail));
  }

  test("the rules run here and the ones not ported are Hyper's 57, and every code an entity file reports is run here", () => {
    expect(HYPER_RULES).toHaveLength(57);
    expect(new Set(HYPER_RULES).size).toBe(57);
    expect(Object.keys(RULES)).toHaveLength(55);
    expect(Object.keys(NOT_PORTED)).toEqual(["role", "task.not-blocked"]);
    expect([...Object.keys(RULES), ...Object.keys(NOT_PORTED)].sort()).toEqual([...HYPER_RULES].sort());
    // Every entity file under the domain root (`mesh.config.ts`), at any depth.
    const domain = resolve(import.meta.dir, "../src/domain");
    const files = readdirSync(domain, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".mesh.mx"));
    expect(files.length).toBeGreaterThanOrEqual(18);
    const reported = new Set<string>();
    for (const file of files)
      for (const [, code] of readFileSync(resolve(domain, file), "utf8").matchAll(/code="([^"]+)"/g)) reported.add(code!);
    expect([...reported].sort()).toEqual([...Object.keys(RULES), ...Object.keys(PORT_ONLY)].sort());
  });
});

describe("rules together, and the version rule on the other entities", () => {
  test("every failing rule of one call is reported together", () => within(async (w) => {
    await completed(w);
    const issues = await issuesOf(w.hyper.updateTask({ id: w.task.id, title: "Ship", expectedVersion: 1 }, as(w.alice)));
    expect(codes(issues)).toEqual(["task.open", "task.unchanged", "expected-version"]);
  }));

  test("expected-version guards Workspace, Collaborator, Membership, Machine and SessionReference, and a write bumps by one", () => within(async (w) => {
    const workspace = await w.hyper.createWorkspace({ name: "Home" }, as(w.alice));
    const machine = await w.hyper.registerMachine({ name: "laptop" }, as(w.alice));
    const reference = await session(w, "s-1", "desktop");
    const calls = [
      (v: number) => w.hyper.renameWorkspace({ id: workspace.id, name: `n${v}`, expectedVersion: v }, as(w.alice)),
      (v: number) => w.hyper.updateCollaborator({ id: w.alice.id, name: `a${v}`, expectedVersion: v }, as(w.alice)),
      (v: number) => w.hyper.changeRoleMembership({ id: w.memberships.bob.id, role: v === 1 ? "owner" : "guest", expectedVersion: v }, as(w.alice)),
      (v: number) => w.hyper.updateMachine({ id: machine.id, platform: `p${v}`, expectedVersion: v }, as(w.alice)),
      (v: number) => w.hyper.setAvailabilitySessionReference({ id: reference.id, availability: v === 1 ? "partial" : "unavailable", expectedVersion: v }, as(w.bot)),
    ];
    for (const call of calls) {
      expect((await call(1)).version).toBe(2);
      expect(codes(await issuesOf(call(1)))).toContain("expected-version");
    }
  }));
});

describe("what the rules leave in place", () => {
  test("release ends the claim with the time and reason; revoke needs a reason and stores it", () => within(async (w) => {
    const held = await claim(w);
    w.advance(3);
    expect(await w.hyper.releaseClaim({ id: held.id, fence: held.fence, reason: "done" }, as(w.bot))).toMatchObject({ state: "released", endReason: "done", endedAt: minutes(3) });
    const again = await claim(w);
    expect((await issuesOf(w.hyper.revokeClaim({ id: again.id, reason: "" }, as(w.alice)))).map((issue) => issue.path)).toEqual([["reason"]]);
  }));

  test("redact clears the location, and the redaction is final", () => within(async (w) => {
    const reference = await session(w);
    expect(reference.location).toBe("/home/s");
    expect(await w.hyper.redactSessionReference({ id: reference.id, reason: "private" }, as(w.alice))).toMatchObject({ availability: "redacted", location: null, version: 2 });
  }));

  test("an unknown claim is NotFoundError, not an issue", () => within(async (w) => {
    await expect(w.hyper.revokeClaim({ id: GHOST, reason: "x" }, as(w.alice))).rejects.toThrow("not found");
  }));

  test("a related id that names no row, where no rule asks, is a FrameworkError (the `exists` check is M8's permission phase)", () => within(async (w) => {
    await expect(w.hyper.acquireClaim({ task: GHOST }, as(w.bot))).rejects.toThrow("which does not exist");
  }));
});
