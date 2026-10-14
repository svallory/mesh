// Roadmap M5 acceptance test 9: each of Hyper's 57 named rules (gap analysis, Appendix A) has a passing and a failing
// case through the generated actions, named by Hyper's rule name as the issue `code`. A command whose effect crosses
// aggregates is called through its function in `src/domain/<module>/<module>.commands.ts`, never through the generated
// action alone (PORTING.md). The rule `role`, a permission check in Hyper, is a policy since M8b: its cases, in
// POLICIES, fail with `ForbiddenError` naming the policy; `attempt.claimer` is both a rule and a policy, as in Hyper.
// The rule whose case needs plugins is listed in NOT_PORTED with the reason and the milestone; the last test checks
// that the three lists together are the 57, and that every code an entity file reports, at any depth under the domain
// root, has its cases here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NotFoundError } from "@meshfw/runtime";
import { Attempt, Invocation, Machine, Run, SessionReference } from "#mesh/domain/execution";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Assignment, Claim, Completion, Dependency, EvidenceReference, LateResult, Review, Submission, Task } from "#mesh/domain/work";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import { collaboratorRetire, membershipRevoke } from "../src/domain/identity/identity.commands";
import { reviewAccept, submissionSubmit, taskCancel, taskComplete } from "../src/domain/work/work.commands";
import { as, asSystem, codes, deniedBy, issuesOf, minutes, NOW, one, setup, within, type World } from "./world";

const GHOST = "00000000-0000-4000-8000-0000000000ff";
type Who = { readonly id: string };

/** The failing case: the call is refused, and its issues include `code` (with `details`, when given). */
async function refused(call: Promise<unknown>, code: string, details?: unknown): Promise<void> {
  const issues = await issuesOf(call);
  const issue = issues.find((candidate) => candidate.code === code);
  expect(issue, `expected ${code}, got ${JSON.stringify(codes(issues))}`).toBeDefined();
  if (details !== undefined) expect(issue!.details).toEqual(details);
}

const taskOf = (w: World, id: string = w.task.id) => one(Task.read({ filter: { id: { eq: id } } }, as(w.alice)));
const claim = (w: World, who: Who = w.bot, task: string = w.task.id) => Claim.acquire({ task }, as(who));
const evidence = (w: World, who: Who = w.bot) => EvidenceReference.record({ kind: "file", locator: "report.md" }, as(who));

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
  return Run.start({ task: w.task.id }, as(w.bot));
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
      const workspace = await Workspace.create({ name: "Home" }, as(w.alice));
      expect((await Workspace.rename({ id: workspace.id, name: "Base" }, as(w.alice))).name).toBe("Base");
    },
    fail: async (w) => {
      const workspace = await Workspace.create({ name: "Home" }, as(w.alice));
      // No action moves a workspace (export and import are after 1.0), so the state is written as it is.
      await w.force("workspaces", workspace.id, { state: "moved" });
      await refused(Workspace.rename({ id: workspace.id, name: "Again" }, as(w.alice)), "workspace.active");
    },
  },
  "collaborator.active": {
    pass: async (w) => {
      expect((await Collaborator.update({ id: w.bob.id, name: "Robert" }, as(w.bob))).name).toBe("Robert");
    },
    fail: async (w) => {
      await collaboratorRetire({ id: w.bob.id, reason: "left" }, as(w.alice), w.binding);
      // Retiring revoked Bob's membership, so his own update is refused by isMember (PROTOCOL.md:88); an owner's reaches the rule.
      expect(await deniedBy(Collaborator.update({ id: w.bob.id, name: "Ghost" }, as(w.bob)))).toEqual(["isMember"]);
      await refused(Collaborator.update({ id: w.bob.id, name: "Ghost" }, as(w.alice)), "collaborator.active");
      await refused(Collaborator.retire({ id: w.bob.id }, as(w.alice)), "collaborator.active");
      await refused(Membership.grant({ collaborator: w.bob.id, role: "member" }, as(w.alice)), "collaborator.active");
      await refused(Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice)), "collaborator.active");
    },
  },
  "collaborator.name-unique": {
    pass: async (w) => {
      await Collaborator.register({ kind: "human", name: "Carol" }, setup);
      expect((await Collaborator.update({ id: w.bob.id, name: "Bob" }, as(w.bob))).name).toBe("Bob");
    },
    fail: async (w) => {
      await refused(Collaborator.register({ kind: "human", name: "Alice" }, setup), "collaborator.name-unique");
      await refused(Collaborator.update({ id: w.bob.id, name: "Alice" }, as(w.bob)), "collaborator.name-unique");
    },
  },
  "collaborator.kind-immutable": {
    pass: async (w) => {
      expect(await Collaborator.update({ id: w.bot.id, name: "Robot", kind: "agent" }, as(w.bot))).toMatchObject({ name: "Robot", kind: "agent" });
    },
    fail: async (w) => {
      await refused(Collaborator.update({ id: w.bot.id, kind: "human" }, as(w.bot)), "collaborator.kind-immutable");
    },
  },
  "membership.last-owner": {
    pass: async (w) => {
      await Membership.changeRole({ id: w.memberships.bob.id, role: "owner" }, as(w.alice));
      expect((await membershipRevoke({ id: w.memberships.alice.id }, as(w.bob), w.binding)).membership.state).toBe("revoked");
    },
    fail: async (w) => {
      await refused(membershipRevoke({ id: w.memberships.alice.id }, as(w.alice), w.binding), "membership.last-owner");
      await refused(Membership.changeRole({ id: w.memberships.alice.id, role: "member" }, as(w.alice)), "membership.last-owner");
      await refused(collaboratorRetire({ id: w.alice.id }, as(w.alice), w.binding), "membership.last-owner");
      expect(await one(Membership.read({ filter: { id: { eq: w.memberships.alice.id } } }, as(w.alice)))).toMatchObject({ state: "active", role: "owner", version: 1 });
    },
  },
  "membership.none-active": {
    pass: async (w) => {
      const carol = await Collaborator.register({ kind: "human", name: "Carol" }, setup);
      await Membership.grant({ collaborator: carol.id, role: "guest" }, as(w.alice));
      // A revoked membership does not count.
      await membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding);
      expect((await Membership.grant({ collaborator: w.bob.id, role: "member" }, as(w.alice))).state).toBe("active");
    },
    fail: async (w) => {
      await refused(Membership.grant({ collaborator: w.bob.id, role: "owner" }, as(w.alice)), "membership.none-active");
    },
  },
  "membership.active": {
    pass: async (w) => {
      expect((await Membership.changeRole({ id: w.memberships.bob.id, role: "guest" }, as(w.alice))).role).toBe("guest");
    },
    fail: async (w) => {
      await membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding);
      await refused(Membership.changeRole({ id: w.memberships.bob.id, role: "guest" }, as(w.alice)), "membership.active");
      await refused(membershipRevoke({ id: w.memberships.bob.id }, as(w.alice), w.binding), "membership.active");
    },
  },
  "membership.unchanged": {
    pass: async (w) => {
      expect((await Membership.changeRole({ id: w.memberships.bob.id, role: "owner" }, as(w.alice))).role).toBe("owner");
    },
    fail: async (w) => {
      await refused(Membership.changeRole({ id: w.memberships.bob.id, role: "member" }, as(w.alice)), "membership.unchanged");
    },
  },
  "machine.name-free": {
    pass: async (w) => {
      await Machine.register({ name: "laptop" }, as(w.alice));
      // Machine :report is internal (a report names its machine through `machineNamed`): called as the engine.
      expect((await Machine.report({ name: "desktop" }, asSystem(w.bot))).firstReportedById).toBe(w.bot.id);
    },
    fail: async (w) => {
      await Machine.register({ name: "laptop" }, as(w.alice));
      await refused(Machine.register({ name: "laptop" }, as(w.alice)), "machine.name-free");
      await refused(Machine.report({ name: "laptop" }, asSystem(w.bot)), "machine.name-free");
    },
  },
  "machine.active": {
    pass: async (w) => {
      const machine = await Machine.register({ name: "laptop" }, as(w.alice));
      expect((await Machine.update({ id: machine.id, platform: "linux" }, as(w.alice))).platform).toBe("linux");
    },
    fail: async (w) => {
      const machine = await Machine.register({ name: "laptop" }, as(w.alice));
      await Machine.retire({ id: machine.id, reason: "sold" }, as(w.alice));
      await refused(Machine.update({ id: machine.id, platform: "mac" }, as(w.alice)), "machine.active");
      await refused(Machine.retire({ id: machine.id, reason: "again" }, as(w.alice)), "machine.active");
    },
  },
  "machine.idle": {
    pass: async (w) => {
      const attempt = await started(w, await running(w), { machine: "laptop" });
      await Attempt.abandon({ id: attempt.id }, as(w.bot));
      expect((await Machine.retire({ id: attempt.machineId!, reason: "sold" }, as(w.alice))).state).toBe("retired");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w), { machine: "laptop" });
      await refused(Machine.retire({ id: attempt.machineId!, reason: "sold" }, as(w.alice)), "machine.idle");
    },
  },
  "session.agent-profile": {
    pass: async (w) => {
      expect((await session(w)).agentProfileId).toBe(w.bot.id);
    },
    fail: async (w) => {
      await refused(sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: GHOST }, as(w.bot), w.binding), "session.agent-profile");
      // The machine the report recorded rolled back with it.
      expect(await Machine.read({}, as(w.alice))).toEqual([]);
    },
  },
  "session.not-redacted": {
    pass: async (w) => {
      const reference = await session(w);
      expect(await SessionReference.redact({ id: reference.id, reason: "private" }, as(w.alice))).toMatchObject({ availability: "redacted", location: null });
    },
    fail: async (w) => {
      const reference = await session(w);
      await SessionReference.redact({ id: reference.id, reason: "private" }, as(w.alice));
      await refused(SessionReference.redact({ id: reference.id, reason: "again" }, as(w.alice)), "session.not-redacted");
      // By its recorder, Bot: only the recorder sets the availability (policy sessionRecorder).
      await refused(SessionReference.setAvailability({ id: reference.id, availability: "complete" }, as(w.bot)), "session.not-redacted");
    },
  },
  "session.availability": {
    pass: async (w) => {
      const reference = await session(w);
      expect((await SessionReference.setAvailability({ id: reference.id, availability: "partial" }, as(w.bot))).availability).toBe("partial");
    },
    fail: async (w) => {
      const reference = await session(w);
      await refused(SessionReference.setAvailability({ id: reference.id, availability: "redacted" }, as(w.bot)), "session.availability");
    },
  },
  "task.open": {
    pass: async (w) => {
      expect((await Task.setPriority({ id: w.task.id, priority: 3 }, as(w.alice))).priority).toBe(3);
    },
    fail: async (w) => {
      // Bot holds and releases a claim first, so its submit below passes claim.holder (C3) and reaches the rule.
      const held = await claim(w);
      await Claim.release({ id: held.id, fence: held.fence }, as(w.bot));
      await completed(w);
      await refused(Task.setPriority({ id: w.task.id, priority: 4 }, as(w.alice)), "task.open");
      await refused(Task.update({ id: w.task.id, title: "New" }, as(w.alice)), "task.open");
      await refused(Task.move({ id: w.task.id, parent: null }, as(w.alice)), "task.open");
      await refused(Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice)), "task.open");
      await refused(taskCancel({ id: w.task.id, reason: "late" }, as(w.alice), w.binding), "task.open");
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "task.open");
      await refused(submissionSubmit({ task: w.task.id, fence: 1, summary: "s" }, as(w.bot), w.binding), "task.open");
    },
  },
  "claim.current-fence": {
    pass: async (w) => {
      const held = await claim(w);
      expect((await Claim.renew({ id: held.id, fence: held.fence }, as(w.bot))).fence).toBe(1);
      expect((await Claim.release({ id: held.id, fence: held.fence }, as(w.bot))).state).toBe("released");
    },
    fail: async (w) => {
      const held = await claim(w);
      await refused(Claim.renew({ id: held.id, fence: 2 }, as(w.bot)), "claim.current-fence", { currentFence: 1, stale: false });
      await refused(Claim.release({ id: held.id, fence: 2 }, as(w.bot)), "claim.current-fence");
      // On task.complete and submission.submit: a fence that is not the live claim's.
      await refused(taskComplete({ id: w.task.id, fence: 2 }, as(w.alice), w.binding), "claim.current-fence", { currentFence: 1, stale: false });
      await refused(submissionSubmit({ task: w.task.id, fence: 2, summary: "mine" }, as(w.bot), w.binding), "claim.current-fence", { currentFence: 1, stale: false });
      // No fence while another holds the live claim, and a submit by someone who never held a claim on the task, are
      // the spec's claim.holder (PROTOCOL.md:326, :249), a permission check: policy claimHolder refuses both before
      // this rule runs (C3; Hyper's engine answers claim.current-fence here).
      expect(await deniedBy(taskComplete({ id: w.task.id }, as(w.alice), w.binding))).toEqual(["claimHolder"]);
      expect(await deniedBy(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "mine" }, as(w.bob), w.binding))).toEqual(["claimHolder"]);
    },
  },
  "submission.pending": {
    pass: async (w) => {
      const { submission } = await submitted(w);
      expect((await Submission.withdraw({ id: submission.id }, as(w.bot))).state).toBe("withdrawn");
    },
    fail: async (w) => {
      await Task.assign({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      const { submission } = await submitted(w);
      // task.complete with a new summary while the actor's own submission is pending.
      await refused(taskComplete({ id: w.task.id, summary: "again" }, as(w.bot), w.binding), "submission.pending");
      await Submission.withdraw({ id: submission.id }, as(w.bot));
      await refused(Submission.withdraw({ id: submission.id }, as(w.bot)), "submission.pending");
      await refused(reviewAccept({ submission: submission.id }, as(w.alice), w.binding), "submission.pending");
      await refused(Review.return({ submission: submission.id, reasons: "no" }, as(w.alice)), "submission.pending");
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
      await Claim.revoke({ id: held.id, reason: "taking over" }, as(w.alice));
      await refused(LateResult.record({ task: w.task.id, fence: held.fence, evidence: [GHOST] }, as(w.bot)), "evidence.exists");
      // The late result a stale fence records, through both functions.
      await refused(submissionSubmit({ task: w.task.id, fence: held.fence, summary: "late", evidence: "abc" }, as(w.bot), w.binding), "evidence.exists", { missing: ["abc"] });
      await refused(taskComplete({ id: w.task.id, fence: held.fence, evidence: 5 }, as(w.bot), w.binding), "evidence.exists", { missing: ["5"] });
      expect(await Submission.read({}, as(w.alice))).toEqual([]);
      expect(await LateResult.read({}, as(w.alice))).toEqual([]);
    },
  },
  "task.settled": {
    pass: async (w) => {
      await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
      expect(await Task.reopen({ id: w.task.id, reason: "now" }, as(w.alice))).toMatchObject({ state: "open" });
    },
    fail: async (w) => {
      await refused(Task.reopen({ id: w.task.id, reason: "why" }, as(w.alice)), "task.settled");
    },
  },
  "task.unchanged": {
    pass: async (w) => {
      expect((await Task.update({ id: w.task.id, title: "Ship it" }, as(w.alice))).title).toBe("Ship it");
      expect((await Task.update({ id: w.task.id, intent: "by Friday" }, as(w.alice))).intent).toBe("by Friday");
      expect((await Task.update({ id: w.task.id, intent: null }, as(w.alice))).intent).toBeNull();
    },
    fail: async (w) => {
      // `validate` sees the stored values; an omitted input keeps them, so nothing differs.
      await refused(Task.update({ id: w.task.id, title: "Ship" }, as(w.alice)), "task.unchanged");
      await refused(Task.update({ id: w.task.id, intent: null }, as(w.alice)), "task.unchanged");
    },
  },
  "task.parent-open": {
    pass: async (w) => {
      expect((await Task.create({ title: "child", parent: w.task.id }, as(w.alice))).parentId).toBe(w.task.id);
      const other = await Task.create({ title: "other" }, as(w.alice));
      expect((await Task.move({ id: other.id, parent: w.task.id }, as(w.alice))).parentId).toBe(w.task.id);
    },
    fail: async (w) => {
      const other = await Task.create({ title: "other" }, as(w.alice));
      await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
      await refused(Task.create({ title: "late child", parent: w.task.id }, as(w.alice)), "task.parent-open");
      await refused(Task.move({ id: other.id, parent: w.task.id }, as(w.alice)), "task.parent-open");
    },
  },
  "task.no-cycle": {
    pass: async (w) => {
      const child = await Task.create({ title: "child", parent: w.task.id }, as(w.alice));
      const other = await Task.create({ title: "other" }, as(w.alice));
      expect((await Task.move({ id: child.id, parent: other.id }, as(w.alice))).parentId).toBe(other.id);
    },
    fail: async (w) => {
      const child = await Task.create({ title: "child", parent: w.task.id }, as(w.alice));
      const grandchild = await Task.create({ title: "grandchild", parent: child.id }, as(w.alice));
      await refused(Task.move({ id: w.task.id, parent: grandchild.id }, as(w.alice)), "task.no-cycle");
      await refused(Task.move({ id: w.task.id, parent: w.task.id }, as(w.alice)), "task.no-cycle");
    },
  },
  "task.children-settled": {
    pass: async (w) => {
      const child = await Task.create({ title: "child", parent: w.task.id }, as(w.alice));
      const canceled = await Task.create({ title: "dropped", parent: w.task.id }, as(w.alice));
      await completed(w, child.id);
      await taskCancel({ id: canceled.id, reason: "dropped" }, as(w.alice), w.binding);
      expect((await completed(w)).state).toBe("done");
    },
    fail: async (w) => {
      const child = await Task.create({ title: "child", parent: w.task.id }, as(w.alice));
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "task.children-settled", { openChildren: [child.id] });
    },
  },
  "task.review-required": {
    pass: async (w) => {
      // The reviewer completes without review; so does the assignee of an assignment that waives it.
      await Task.assign({ id: w.task.id, assignee: w.bob.id, waiveReview: true }, as(w.alice));
      const result = await taskComplete({ id: w.task.id }, as(w.bob), w.binding);
      expect(result).toMatchObject({ outcome: "completed", completion: { rule: "review-waived", completedById: w.bob.id } });
    },
    fail: async (w) => {
      await refused(taskComplete({ id: w.task.id }, as(w.bob), w.binding), "task.review-required", { reviewerId: w.alice.id });
      // The waiver covers its assignee only.
      await Task.assign({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      await refused(taskComplete({ id: w.task.id }, as(w.bob), w.binding), "task.review-required");
    },
  },
  "task.no-foreign-submission": {
    pass: async (w) => {
      // A foreign submission that was returned no longer blocks the reviewer.
      const { submission } = await submitted(w);
      await Review.return({ submission: submission.id, reasons: "redo" }, as(w.alice));
      expect((await completed(w)).state).toBe("done");
    },
    fail: async (w) => {
      await submitted(w);
      await refused(taskComplete({ id: w.task.id }, as(w.alice), w.binding), "task.no-foreign-submission");
    },
  },
  "task.no-active-claim": {
    pass: async (w) => {
      const other = await Task.create({ title: "other" }, as(w.alice));
      const held = await claim(w);
      await Claim.release({ id: held.id, fence: held.fence }, as(w.bot));
      expect((await Task.move({ id: w.task.id, parent: other.id }, as(w.alice))).parentId).toBe(other.id);
    },
    fail: async (w) => {
      const other = await Task.create({ title: "other" }, as(w.alice));
      await claim(w);
      await refused(Task.move({ id: w.task.id, parent: other.id }, as(w.alice)), "task.no-active-claim");
    },
  },
  "claim.invalidated": {
    pass: async (w) => {
      // Bot is the assignee of an assignment that waives review, so only the fence rules stand between Bot and done.
      await Task.assign({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      const revoked = await claim(w);
      await Claim.revoke({ id: revoked.id, reason: "taking over" }, as(w.alice));
      // With a fence, the rule does not apply: Bot claims again and completes with the new fence.
      const again = await claim(w);
      w.advance(1);
      expect(await taskComplete({ id: w.task.id, fence: again.fence }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });
      // The revoke came before the last completion and the reopen after it, so Bot completes without a fence.
      w.advance(1);
      await Task.reopen({ id: w.task.id, reason: "again" }, as(w.alice));
      w.advance(1);
      expect(await taskComplete({ id: w.task.id }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });
      // A cancel revokes Bot's claim after that completion; the reopen after the cancel is what clears it, and the Task
      // stores when it was reopened because a reopen leaves no other row.
      w.advance(1);
      await Task.reopen({ id: w.task.id, reason: "again" }, as(w.alice));
      await claim(w);
      w.advance(1);
      await taskCancel({ id: w.task.id, reason: "paused" }, as(w.alice), w.binding);
      w.advance(1);
      expect((await Task.reopen({ id: w.task.id, reason: "resumed" }, as(w.alice))).reopenedAt).toEqual(minutes(6));
      w.advance(1);
      expect(await taskComplete({ id: w.task.id }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });

      // A claim counts from its lease end even when a later command marks it expired (PROTOCOL.md:312), not from when
      // it was marked, as the Elixir engine's `ended_at` would (PR #65 round 2, N2). Bot's claim lapses; Alice
      // completes and reopens; Bot's next acquire, after the reopen, marks the lapsed claim expired.
      const later = await Task.create({ title: "Lapsed before the reopen" }, as(w.alice));
      await Task.assign({ id: later.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      const lapsed = await claim(w, w.bot, later.id);
      w.advance(12);
      await completed(w, later.id);
      w.advance(1);
      await Task.reopen({ id: later.id, reason: "again" }, as(w.alice));
      w.advance(1);
      const fresh = await claim(w, w.bot, later.id);
      const marked = await one(Claim.read({ filter: { id: { eq: lapsed.id } } }, as(w.alice)));
      expect(marked).toMatchObject({ state: "expired", endedAt: w.time.now, expiresAt: lapsed.expiresAt });
      await Claim.release({ id: fresh.id, fence: fresh.fence }, as(w.bot));
      expect(await taskComplete({ id: later.id }, as(w.bot), w.binding)).toMatchObject({ outcome: "completed" });

      // The completion review.accept makes is not subject to the rule (PROTOCOL.md:283, :332; PR #65 round 2, F1): the
      // reviewer once held a claim, revoked when she handed the Task to Bot, and the accept still succeeds.
      const reviewed = await Task.create({ title: "Claimed, then delegated" }, as(w.alice));
      const hers = await claim(w, w.alice, reviewed.id);
      await Task.assign({ id: reviewed.id, assignee: w.bot.id }, as(w.alice));
      expect(await one(Claim.read({ filter: { id: { eq: hers.id } } }, as(w.alice)))).toMatchObject({ state: "revoked", endReason: "reassigned" });
      const { submission } = await submitted(w, w.bot, reviewed.id);
      expect(await reviewAccept({ submission: submission.id }, as(w.alice), w.binding)).toMatchObject({ completion: { rule: "review-accepted", submissionId: submission.id } });
      // The same when her earlier claim lapsed instead.
      const lapsedReview = await Task.create({ title: "Claimed, lapsed, then delegated" }, as(w.alice));
      await claim(w, w.alice, lapsedReview.id);
      w.advance(11);
      await Task.assign({ id: lapsedReview.id, assignee: w.bot.id }, as(w.alice));
      const second = await submitted(w, w.bot, lapsedReview.id);
      expect(await reviewAccept({ submission: second.submission.id }, as(w.alice), w.binding)).toMatchObject({ completion: { rule: "review-accepted" } });
    },
    fail: async (w) => {
      await Task.assign({ id: w.task.id, assignee: w.bot.id, waiveReview: true }, as(w.alice));
      // Revoked: an unfenced completion after the actor's claim was revoked is refused, and changes nothing.
      const revoked = await claim(w);
      await Claim.revoke({ id: revoked.id, reason: "taking over" }, as(w.alice));
      const before = await taskOf(w);
      const issues = await issuesOf(taskComplete({ id: w.task.id }, as(w.bot), w.binding));
      expect(codes(issues)).toEqual(["claim.invalidated"]);
      expect(issues[0]!.details).toEqual({ fences: [revoked.fence] });
      expect(await taskOf(w)).toEqual(before);
      expect(await Completion.read({}, as(w.alice))).toEqual([]);
      // Expired: a claim whose lease ran out counts from its lease end, whether or not it was marked expired yet.
      const lapsed = await claim(w);
      w.advance(11);
      await refused(taskComplete({ id: w.task.id }, as(w.bot), w.binding), "claim.invalidated", { fences: [revoked.fence, lapsed.fence] });
      // The next acquire marks it expired; Bot releases the new claim, and both earlier fences still count.
      const third = await claim(w);
      expect(await one(Claim.read({ filter: { id: { eq: lapsed.id } } }, as(w.alice)))).toMatchObject({ state: "expired", endedAt: minutes(11) });
      await Claim.release({ id: third.id, fence: third.fence }, as(w.bot));
      await refused(taskComplete({ id: w.task.id }, as(w.bot), w.binding), "claim.invalidated", { fences: [revoked.fence, lapsed.fence] });
      // The generated action alone applies the rule too.
      await refused(Task.complete({ id: w.task.id }, as(w.bot)), "claim.invalidated");
    },
  },
  "assignment.assignee-role": {
    pass: async (w) => {
      await Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      expect(await Assignment.read({}, as(w.alice))).toMatchObject([{ assigneeId: w.bob.id, delegatorId: w.alice.id }]);
    },
    fail: async (w) => {
      const carol = await Collaborator.register({ kind: "human", name: "Carol" }, setup);
      await refused(Task.assign({ id: w.task.id, assignee: carol.id }, as(w.alice)), "assignment.assignee-role");
      await Membership.grant({ collaborator: carol.id, role: "guest" }, as(w.alice));
      await refused(Task.assign({ id: w.task.id, assignee: carol.id }, as(w.alice)), "assignment.assignee-role");
    },
  },
  "assignment.unchanged": {
    pass: async (w) => {
      await Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      await Task.assign({ id: w.task.id, assignee: w.bob.id, waiveReview: true }, as(w.alice));
      expect(await Assignment.read({ sort: ["startedAt", "id"] }, as(w.alice))).toMatchObject([{ reviewWaived: false, endReason: "reassigned" }, { reviewWaived: true, endedAt: null }]);
    },
    fail: async (w) => {
      await Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      await refused(Task.assign({ id: w.task.id, assignee: w.bob.id, waiveReview: false }, as(w.alice)), "assignment.unchanged");
    },
  },
  "assignment.current": {
    pass: async (w) => {
      await Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      await Task.unassign({ id: w.task.id }, as(w.alice));
      expect(await Assignment.read({}, as(w.alice))).toMatchObject([{ endReason: "unassigned", endedAt: NOW }]);
    },
    fail: async (w) => {
      await refused(Task.unassign({ id: w.task.id }, as(w.alice)), "assignment.current");
      await Task.assign({ id: w.task.id, assignee: w.bob.id }, as(w.alice));
      const [assignment] = await Assignment.read({}, as(w.alice));
      await Task.unassign({ id: w.task.id }, as(w.alice));
      // Assignment :finish is internal (task.assign and task.unassign end an assignment): called as the engine.
      await refused(Assignment.finish({ id: assignment!.id, reason: "unassigned" }, asSystem(w.alice)), "assignment.current");
    },
  },
  "claim.task-ready": {
    pass: async (w) => {
      expect((await claim(w)).state).toBe("active");
    },
    fail: async (w) => {
      await claim(w);
      // Bot, the assignee its claim made it, claims again: Bob would be refused by claim.assignee first (05:148).
      await refused(claim(w), "claim.task-ready", { derivedState: "claimed", reasons: [] });
      const prerequisite = await Task.create({ title: "Design" }, as(w.alice));
      const other = await Task.create({ title: "Build" }, as(w.alice));
      await Dependency.add({ dependent: other.id, prerequisite: prerequisite.id }, as(w.alice));
      await refused(claim(w, w.bob, other.id), "claim.task-ready", { derivedState: "blocked", reasons: [{ kind: "dependency", taskId: prerequisite.id, message: "blocked: waiting for Design" }] });
    },
  },
  "claim.active": {
    pass: async (w) => {
      const held = await claim(w);
      expect(await Claim.revoke({ id: held.id, reason: "taking over" }, as(w.alice))).toMatchObject({ state: "revoked", endReason: "taking over", endedAt: NOW });
    },
    fail: async (w) => {
      const held = await claim(w);
      await Claim.release({ id: held.id, fence: held.fence, reason: "done" }, as(w.bot));
      await refused(Claim.release({ id: held.id, fence: held.fence }, as(w.bot)), "claim.active");
      await refused(Claim.renew({ id: held.id, fence: held.fence }, as(w.bot)), "claim.active");
      await refused(Claim.revoke({ id: held.id, reason: "late" }, as(w.alice)), "claim.active");
      // Claim :expire is internal (the engine's lease sweeper): called as the engine.
      await refused(Claim.expire({ id: held.id }, asSystem(w.alice)), "claim.active");
    },
  },
  "claim.expired": {
    pass: async (w) => {
      const held = await claim(w);
      w.advance(9);
      // The lease runs ten minutes from the renewal.
      expect((await Claim.renew({ id: held.id, fence: held.fence }, as(w.bot))).expiresAt).toEqual(minutes(19));
    },
    fail: async (w) => {
      const held = await claim(w);
      w.advance(10);
      await refused(Claim.renew({ id: held.id, fence: held.fence }, as(w.bot)), "claim.expired");
      await refused(Claim.release({ id: held.id, fence: held.fence }, as(w.bot)), "claim.expired");
      expect(await one(Claim.read({ filter: { id: { eq: held.id } } }, as(w.alice)))).toMatchObject({ state: "active", expiresAt: minutes(10) });
    },
  },
  "submission.none-pending": {
    pass: async (w) => {
      const first = await submitted(w);
      await Review.return({ submission: first.submission.id, reasons: "redo" }, as(w.alice));
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
      await w.insert("claims", { taskId: w.task.id, holderId: w.bot.id, fence: held.fence + 1, acquiredAt: NOW, expiresAt: minutes(10), state: "active" });
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
      await Task.setPriority({ id: w.task.id, priority: 1 }, as(w.alice));
      await refused(reviewAccept({ submission: submission.id }, as(w.alice), w.binding), "submission.task-version");
    },
  },
  "expected-version": {
    pass: async (w) => {
      expect((await Task.setPriority({ id: w.task.id, priority: 1, expectedVersion: 1 }, as(w.alice))).version).toBe(2);
      // A command on a record of the Task aggregate checks the Task's version.
      expect((await Claim.acquire({ task: w.task.id, expectedVersion: 2 }, as(w.bot))).fence).toBe(1);
    },
    fail: async (w) => {
      await Task.setPriority({ id: w.task.id, priority: 1 }, as(w.alice));
      await refused(Task.setPriority({ id: w.task.id, priority: 2, expectedVersion: 1 }, as(w.alice)), "expected-version", { expectedVersion: 1, actualVersion: 2 });
      await refused(Claim.acquire({ task: w.task.id, expectedVersion: 1 }, as(w.bot)), "expected-version");
      await refused(Dependency.add({ dependent: w.task.id, prerequisite: (await Task.create({ title: "pre" }, as(w.alice))).id, expectedVersion: 1 }, as(w.alice)), "expected-version", { expectedVersion: 1, actualVersion: 2 });
      expect(await taskOf(w)).toMatchObject({ priority: 1, version: 2 });
    },
  },
  "claim.stale-fence": {
    pass: async (w) => {
      const held = await claim(w);
      await Claim.revoke({ id: held.id, reason: "taking over" }, as(w.alice));
      const result = await submissionSubmit({ task: w.task.id, fence: held.fence, summary: "late" }, as(w.bot), w.binding);
      expect(result).toMatchObject({ outcome: "late-result-recorded", lateResult: { fence: held.fence } });
    },
    fail: async (w) => {
      // The command functions record a late result only for a stale fence; the generated action refuses any other.
      const held = await claim(w);
      await refused(LateResult.record({ task: w.task.id, fence: held.fence, summary: "x" }, as(w.bot)), "claim.stale-fence");
      await refused(LateResult.record({ task: w.task.id, fence: 7, summary: "x" }, as(w.bot)), "claim.stale-fence");
    },
  },
  "dependency.exists": {
    pass: async (w) => {
      const prerequisite = await Task.create({ title: "pre" }, as(w.alice));
      expect(await Dependency.add({ dependent: w.task.id, prerequisite: prerequisite.id }, as(w.alice))).toMatchObject({ dependentId: w.task.id, createdById: w.alice.id });
    },
    fail: async (w) => {
      await refused(Dependency.add({ dependent: w.task.id, prerequisite: GHOST }, as(w.alice)), "dependency.exists", { missing: [GHOST] });
      await refused(Dependency.add({ dependent: GHOST, prerequisite: w.task.id, expectedVersion: 3 }, as(w.alice)), "dependency.exists", { missing: [GHOST] });
      expect(await Dependency.read({}, as(w.alice))).toEqual([]);
    },
  },
  "dependency.distinct": {
    pass: async (w) => {
      const other = await Task.create({ title: "other" }, as(w.alice));
      await Dependency.add({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
    },
    fail: async (w) => {
      await refused(Dependency.add({ dependent: w.task.id, prerequisite: w.task.id }, as(w.alice)), "dependency.distinct");
    },
  },
  "dependency.duplicate": {
    pass: async (w) => {
      const other = await Task.create({ title: "other" }, as(w.alice));
      const first = await Dependency.add({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
      await Dependency.remove({ id: first.id }, as(w.alice));
      await Dependency.add({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
    },
    fail: async (w) => {
      const other = await Task.create({ title: "other" }, as(w.alice));
      await Dependency.add({ dependent: w.task.id, prerequisite: other.id }, as(w.alice));
      await refused(Dependency.add({ dependent: w.task.id, prerequisite: other.id }, as(w.alice)), "dependency.duplicate");
    },
  },
  "dependency.no-cycle": {
    pass: async (w) => {
      const [b, c] = [await Task.create({ title: "b" }, as(w.alice)), await Task.create({ title: "c" }, as(w.alice))];
      await Dependency.add({ dependent: w.task.id, prerequisite: b.id }, as(w.alice));
      await Dependency.add({ dependent: b.id, prerequisite: c.id }, as(w.alice));
      // A diamond is not a cycle.
      await Dependency.add({ dependent: w.task.id, prerequisite: c.id }, as(w.alice));
    },
    fail: async (w) => {
      const [b, c] = [await Task.create({ title: "b" }, as(w.alice)), await Task.create({ title: "c" }, as(w.alice))];
      await Dependency.add({ dependent: w.task.id, prerequisite: b.id }, as(w.alice));
      await Dependency.add({ dependent: b.id, prerequisite: c.id }, as(w.alice));
      await refused(Dependency.add({ dependent: c.id, prerequisite: w.task.id }, as(w.alice)), "dependency.no-cycle");
      await refused(Dependency.add({ dependent: b.id, prerequisite: w.task.id }, as(w.alice)), "dependency.no-cycle");
    },
  },
  "run.task-open": {
    pass: async (w) => {
      expect(await Run.start({ task: w.task.id }, as(w.bot))).toMatchObject({ state: "running", startedById: w.bot.id });
    },
    fail: async (w) => {
      await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
      await refused(Run.start({ task: w.task.id }, as(w.bot)), "run.task-open");
    },
  },
  "run.parent-running": {
    pass: async (w) => {
      const parent = await Run.start({ task: w.task.id }, as(w.bot));
      expect((await Run.start({ task: w.task.id, parentRun: parent.id }, as(w.bot))).parentRunId).toBe(parent.id);
    },
    fail: async (w) => {
      const parent = await Run.start({ task: w.task.id }, as(w.bot));
      await Run.cancel({ id: parent.id, reason: "stop" }, as(w.alice));
      await refused(Run.start({ task: w.task.id, parentRun: parent.id }, as(w.bot)), "run.parent-running");
    },
  },
  "run.cancelable": {
    pass: async (w) => {
      const run = await Run.start({ task: w.task.id }, as(w.bot));
      expect((await Run.cancel({ id: run.id, reason: "stop" }, as(w.alice))).state).toBe("canceled");
    },
    fail: async (w) => {
      const run = await Run.start({ task: w.task.id }, as(w.bot));
      await Run.cancel({ id: run.id, reason: "stop" }, as(w.alice));
      await refused(Run.cancel({ id: run.id, reason: "again" }, as(w.alice)), "run.cancelable");
    },
  },
  "attempt.claimer": {
    pass: async (w) => {
      expect(await started(w, await running(w))).toMatchObject({ performerId: w.bot.id, claimFence: 1, number: 1 });
    },
    fail: async (w) => {
      // Hyper keeps both a policy and this rule (`runs/checks/reporter.ex:35-41`, `runs/attempt/rules.ex:15-30`): a
      // caller is refused by the policy attemptClaimer first, and a call made as `system`, which every policy admits,
      // still fails the rule.
      const run = await running(w);
      expect(await deniedBy(attemptStart({ run: run.id }, as(w.bob), w.binding))).toEqual(["attemptClaimer"]);
      await refused(attemptStart({ run: run.id }, asSystem(w.bob), w.binding), "attempt.claimer");
      // A lapsed claim is not the actor's any more.
      w.advance(10);
      expect(await deniedBy(attemptStart({ run: run.id }, as(w.bot), w.binding))).toEqual(["attemptClaimer"]);
      await refused(attemptStart({ run: run.id }, asSystem(w.bot), w.binding), "attempt.claimer");
    },
  },
  "attempt.run-running": {
    pass: async (w) => {
      expect((await started(w, await running(w))).state).toBe("running");
    },
    fail: async (w) => {
      const run = await running(w);
      await Run.cancel({ id: run.id, reason: "stop" }, as(w.alice));
      await refused(attemptStart({ run: run.id }, as(w.bot), w.binding), "attempt.run-running");
    },
  },
  "attempt.step-idle": {
    pass: async (w) => {
      const run = await running(w);
      const first = await started(w, run, { step: "build" });
      expect((await started(w, run, { step: "test" })).number).toBe(1);
      // A retryable failure leaves the run running, so the step can be tried again.
      await Attempt.finish({ id: first.id, result: "failed", error: { message: "flaky", retryable: true } }, as(w.bot));
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
      expect((await Attempt.reportStopped({ id: attempt.id, reason: "host rebooted" }, as(w.bot))).state).toBe("stopped");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await Attempt.abandon({ id: attempt.id }, as(w.bot));
      await refused(Attempt.finish({ id: attempt.id, result: "succeeded" }, as(w.bot)), "attempt.running");
      await refused(Attempt.reportStopped({ id: attempt.id, reason: "x" }, as(w.bot)), "attempt.running");
      await refused(Attempt.abandon({ id: attempt.id }, as(w.bot)), "attempt.running");
    },
  },
  "attempt.error": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      expect(await Attempt.finish({ id: attempt.id, result: "failed", error: { message: "boom" } }, as(w.bot))).toMatchObject({ state: "failed" });
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await refused(Attempt.finish({ id: attempt.id, result: "succeeded", error: { message: "boom" } }, as(w.bot)), "attempt.error");
    },
  },
  "attempt.evidence": {
    pass: async (w) => {
      const reference = await evidence(w);
      const attempt = await started(w, await running(w));
      expect((await Attempt.finish({ id: attempt.id, result: "succeeded", evidence: [reference.id] }, as(w.bot))).state).toBe("succeeded");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await refused(Attempt.finish({ id: attempt.id, result: "succeeded", evidence: [GHOST] }, as(w.bot)), "attempt.evidence");
    },
  },
  "invocation.session": {
    pass: async (w) => {
      const reference = await session(w);
      const attempt = await started(w, await running(w), { session: reference.id });
      expect((await Invocation.record({ attempt: attempt.id, session: reference.id, usageSource: "runtime" }, as(w.bot))).sessionId).toBe(reference.id);
      expect((await Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot))).sessionId).toBeNull();
    },
    fail: async (w) => {
      const [mine, other] = [await session(w, "s-1"), await session(w, "s-2")];
      const attempt = await started(w, await running(w), { session: mine.id });
      await refused(Invocation.record({ attempt: attempt.id, session: other.id, usageSource: "runtime" }, as(w.bot)), "invocation.session");
    },
  },
  "invocation.cost-unknown": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      expect((await Invocation.record({ attempt: attempt.id, inputTokens: 10, outputTokens: 5, estimatedCost: 0.25, usageSource: "estimate" }, as(w.bot))).estimatedCost).toBe(0.25);
      await Invocation.record({ attempt: attempt.id, inputTokens: 10, usageSource: "runtime" }, as(w.bot));
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      await refused(Invocation.record({ attempt: attempt.id, inputTokens: 10, estimatedCost: 0.25, usageSource: "estimate" }, as(w.bot)), "invocation.cost-unknown");
      const original = await Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      await refused(Invocation.correct({ corrects: original.id, reason: "cost", estimatedCost: 1, usageSource: "estimate" }, as(w.alice)), "invocation.cost-unknown");
    },
  },
  "invocation.not-corrected": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      const correction = await Invocation.correct({ corrects: original.id, reason: "tokens", inputTokens: 3, usageSource: "provider" }, as(w.alice));
      // A correction can itself be corrected, once.
      expect((await Invocation.correct({ corrects: correction.id, reason: "again", usageSource: "provider" }, as(w.alice))).correctsId).toBe(correction.id);
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      await Invocation.correct({ corrects: original.id, reason: "tokens", usageSource: "provider" }, as(w.alice));
      await refused(Invocation.correct({ corrects: original.id, reason: "twice", usageSource: "provider" }, as(w.alice)), "invocation.not-corrected");
    },
  },
  "invocation.reason": {
    pass: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      expect((await Invocation.correct({ corrects: original.id, reason: "tokens", usageSource: "provider" }, as(w.alice))).reason).toBe("tokens");
    },
    fail: async (w) => {
      const attempt = await started(w, await running(w));
      const original = await Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, as(w.bot));
      await refused(Invocation.correct({ corrects: original.id, usageSource: "provider" }, as(w.alice)), "invocation.reason");
      await refused(Invocation.correct({ corrects: original.id, reason: "", usageSource: "provider" }, as(w.alice)), "invocation.reason");
    },
  },
};

/**
 * The rules of the port that are not among Hyper's 57: a report that names a retired machine, and a second workspace
 * (the spec's `workspace.exists`, PROTOCOL.md:52: one engine hosts the one workspace its bootstrap creates).
 */
const PORT_ONLY: Record<string, Case> = {
  "workspace.exists": {
    pass: async (w) => {
      expect((await Workspace.create({ name: "Home" }, as(w.alice))).name).toBe("Home");
    },
    fail: async (w) => {
      await Workspace.create({ name: null }, setup);
      await refused(Workspace.create({ name: "Again" }, as(w.alice)), "workspace.exists");
      expect(await Workspace.read({}, as(w.alice))).toHaveLength(1);
    },
  },
  "machine.retired": {
    pass: async (w) => {
      const attempt = await started(w, await running(w), { machine: "laptop" });
      expect(attempt.machineId).not.toBeNull();
    },
    fail: async (w) => {
      const machine = await Machine.register({ name: "laptop" }, as(w.alice));
      await Machine.retire({ id: machine.id, reason: "sold" }, as(w.alice));
      await refused(attemptStart({ run: (await running(w)).id, machine: "laptop" }, as(w.bot), w.binding), "machine.retired");
      await refused(sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: w.bot.id }, as(w.bot), w.binding), "machine.retired");
    },
  },
};

/**
 * Hyper's rule that is a permission check, ported as a policy (M8b): the passing case is a call the policy admits, the
 * failing one a `ForbiddenError` naming the policy. `role` re-runs the role gate under the workspace lock for six actions
 * (`memberships/rules.ex:12-17`); a policy that reads the role through `Mesh.privileged` runs inside the transaction, so it covers
 * the rule. (`attempt.claimer`, Hyper's other rule that denies through `Role.deny`, is both a rule and the policy
 * `attemptClaimer`, as in Hyper, and its cases are in RULES.)
 */
const POLICIES: Record<string, Case> = {
  role: {
    pass: async (w) => {
      expect((await Task.create({ title: "Mine" }, as(w.bot))).creatorId).toBe(w.bot.id);
    },
    fail: async (w) => {
      const run = await running(w);
      const attempt = await started(w, run);
      await Membership.changeRole({ id: w.memberships.bot.id, role: "guest" }, as(w.alice));
      // The six actions whose rules list `role` (claim.ex:56, task.ex:90-92, run.ex:49-50, invocation.ex:53-54,
      // session_reference.ex:39, machine.ex:34), by a guest: each is refused by ownerOrMember, before any rule.
      const guest = as(w.bot);
      expect(await deniedBy(Claim.acquire({ task: w.task.id }, guest))).toEqual(["ownerOrMember"]);
      expect(await deniedBy(taskComplete({ id: w.task.id, fence: 1 }, guest, w.binding))).toEqual(["ownerOrMember"]);
      expect(await deniedBy(Run.start({ task: w.task.id }, guest))).toEqual(["ownerOrMember"]);
      expect(await deniedBy(Invocation.record({ attempt: attempt.id, usageSource: "runtime" }, guest))).toEqual(["ownerOrMember"]);
      expect(await deniedBy(sessionRecord({ runtime: "claude", runtimeSessionId: "s-9", availability: "complete", machine: "laptop", agentProfile: w.bot.id }, guest, w.binding))).toEqual(["ownerOrMember"]);
      expect(await deniedBy(Machine.register({ name: "desktop" }, guest))).toEqual(["ownerOrMember"]);
      // The refused session report rolled back the machine it recorded.
      expect(await Machine.read({}, as(w.alice))).toEqual([]);
    },
  },
};

/** Hyper's rules whose cases need plugins, with the milestone that brings them. */
const NOT_PORTED: Record<string, string> = {
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
  for (const [code, { pass, fail }] of Object.entries({ ...RULES, ...PORT_ONLY, ...POLICIES })) {
    test(`${code}: passing case`, () => within(pass));
    test(`${code}: failing case`, () => within(fail));
  }

  test("the rules run here and the ones not ported are Hyper's 57, and every code an entity file reports is run here", () => {
    expect(HYPER_RULES).toHaveLength(57);
    expect(new Set(HYPER_RULES).size).toBe(57);
    expect(Object.keys(RULES)).toHaveLength(55);
    expect(Object.keys(POLICIES)).toEqual(["role"]);
    expect(Object.keys(NOT_PORTED)).toEqual(["task.not-blocked"]);
    expect([...Object.keys(RULES), ...Object.keys(POLICIES), ...Object.keys(NOT_PORTED)].sort()).toEqual([...HYPER_RULES].sort());
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
    const issues = await issuesOf(Task.update({ id: w.task.id, title: "Ship", expectedVersion: 1 }, as(w.alice)));
    expect(codes(issues)).toEqual(["task.open", "task.unchanged", "expected-version"]);
  }));

  test("expected-version guards Workspace, Collaborator, Membership, Machine and SessionReference, and a write bumps by one", () => within(async (w) => {
    const workspace = await Workspace.create({ name: "Home" }, as(w.alice));
    const machine = await Machine.register({ name: "laptop" }, as(w.alice));
    const reference = await session(w, "s-1", "desktop");
    const calls = [
      (v: number) => Workspace.rename({ id: workspace.id, name: `n${v}`, expectedVersion: v }, as(w.alice)),
      (v: number) => Collaborator.update({ id: w.alice.id, name: `a${v}`, expectedVersion: v }, as(w.alice)),
      (v: number) => Membership.changeRole({ id: w.memberships.bob.id, role: v === 1 ? "owner" : "guest", expectedVersion: v }, as(w.alice)),
      (v: number) => Machine.update({ id: machine.id, platform: `p${v}`, expectedVersion: v }, as(w.alice)),
      (v: number) => SessionReference.setAvailability({ id: reference.id, availability: v === 1 ? "partial" : "unavailable", expectedVersion: v }, as(w.bot)),
    ];
    for (const call of calls) {
      expect((await call(1)).version).toBe(2);
      expect(codes(await issuesOf(call(1)))).toContain("expected-version");
    }
  }));
});

// A translated check reads a value not sent as null, so `input.x ?? &x` cannot tell "sent null" from "not sent" (ACT-27).
// The two rules where that differs are plain code (`taskChanges` and `movedParent` in work.helpers.ts); these pin both.
describe("a value sent as null is not a value left out", () => {
  test("task.unchanged: an intent sent as null clears it, one left out keeps it", () => within(async (w) => {
    await Task.update({ id: w.task.id, intent: "by Friday" }, as(w.alice));
    expect(await Task.update({ id: w.task.id, title: "Ship it" }, as(w.alice))).toMatchObject({ title: "Ship it", intent: "by Friday" });
    await refused(Task.update({ id: w.task.id, title: "Ship it" }, as(w.alice)), "task.unchanged");
    expect((await Task.update({ id: w.task.id, title: "Ship it", intent: null }, as(w.alice))).intent).toBeNull();
    await refused(Task.update({ id: w.task.id, title: "Ship it", intent: null }, as(w.alice)), "task.unchanged");
  }));

  test("task.parent-open: a parent sent as null moves the Task to the top, one left out keeps the stored parent", () => within(async (w) => {
    const child = await Task.create({ title: "child", parent: w.task.id }, as(w.alice));
    await taskCancel({ id: w.task.id, reason: "not now" }, as(w.alice), w.binding);
    await refused(Task.move({ id: child.id }, as(w.alice)), "task.parent-open");
    expect((await Task.move({ id: child.id, parent: null }, as(w.alice))).parentId).toBeNull();
  }));
});

describe("what the rules leave in place", () => {
  test("release ends the claim with the time and reason; revoke needs a reason and stores it", () => within(async (w) => {
    const held = await claim(w);
    w.advance(3);
    expect(await Claim.release({ id: held.id, fence: held.fence, reason: "done" }, as(w.bot))).toMatchObject({ state: "released", endReason: "done", endedAt: minutes(3) });
    const again = await claim(w);
    expect((await issuesOf(Claim.revoke({ id: again.id, reason: "" }, as(w.alice)))).map((issue) => issue.path)).toEqual([["reason"]]);
  }));

  test("redact clears the location, and the redaction is final", () => within(async (w) => {
    const reference = await session(w);
    expect(reference.location).toBe("/home/s");
    expect(await SessionReference.redact({ id: reference.id, reason: "private" }, as(w.alice))).toMatchObject({ availability: "redacted", location: null, version: 2 });
  }));

  test("an unknown claim is NotFoundError, not an issue", () => within(async (w) => {
    await expect(Claim.revoke({ id: GHOST, reason: "x" }, as(w.alice))).rejects.toThrow("not found");
  }));

  test("a related id that names no row, where no rule asks, is a FrameworkError (the `exists` check is M8's permission phase)", () => within(async (w) => {
    // No check of `Invocation.record` reads the attempt when no session is sent; its `set` step loads it and finds no row.
    await expect(Invocation.record({ attempt: GHOST, usageSource: "runtime" }, as(w.bot))).rejects.toThrow("which does not exist");
  }));

  test("a rule that reads the record a create names reads it through privileged, so an id that names no row fails the rule (ACT-27)", () => within(async (w) => {
    // A caller's acquire of a Task that does not exist is not_found in the permission phase (PROTOCOL.md:110, PR #70 N4):
    // policy claimAssignee throws NotFoundError before any rule runs.
    await expect(Claim.acquire({ task: GHOST }, as(w.bot))).rejects.toBeInstanceOf(NotFoundError);
    // A call as the engine skips the policies: a create's checks see `self` before the input, so `claim.task-ready`
    // reads the Task by `input.task` and finds none.
    await refused(Claim.acquire({ task: GHOST }, asSystem(w.bot)), "claim.task-ready", { derivedState: null, reasons: [] });
  }));
});
