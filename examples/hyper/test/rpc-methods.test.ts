// The work methods of the method table (`src/rpc/methods.ts`) run in process, as the daemon runs them once its context
// factory has passed the call: params parsed by the method's schema, then `run`. The conformance cases cover what the
// spec's suite asks of each; these cover the methods no case of the v0 slice reaches yet (`task.set-priority`,
// `task.unassign`, `claim.renew`, `claim.release`, `claim.revoke`, `submission.withdraw`), the order of `task.next` and
// `task.list`, what `explained` adds to a failure, and commands during which a lease runs out. The world's clock is set
// to the system's first: the methods read the system clock for the Task they show (`activeClaim`).
import { describe, expect, spyOn, test } from "bun:test";
import { type Call, RpcError } from "@meshfw/jsonrpc";
import type { ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { checkResult } from "../conformance/harness/validate.ts";
import type { MethodName } from "../conformance/schemas/protocol.ts";
import { explained, rejection } from "../src/rpc/errors";
import { methods } from "../src/rpc/methods";
import { params as schemas } from "../src/rpc/params";
import { as, setup, within, type World } from "./world";

type Sent = Record<string, unknown>;

/**
 * Runs `method` with `sent` as its params and `context` as the factory would give it, and holds what it returns, as the
 * client reads it after the JSON round trip, to the spec's result schema for the method.
 */
async function run(method: keyof typeof schemas, sent: Sent, context: ActionContext): Promise<any> {
  const call = { method, id: 1, params: sent, connection: {} } as unknown as Call;
  const result = await methods[method]!.run(schemas[method].parse(sent) as never, context, call);
  expect(checkResult(method as MethodName, JSON.parse(JSON.stringify(result)))).toEqual([]);
  return result;
}

/** A command's params: the envelope and `payload`. */
const command = (context: ActionContext, payload: Sent, extra: Sent = {}): Sent =>
  ({ commandId: crypto.randomUUID(), actor: context.actor.id, caller: "test", payload, ...extra });

/** Sends the command `method` as `context`, which carries the command's id and method as the context factory's does. */
const send = (method: keyof typeof schemas, context: ActionContext, payload: Sent, extra: Sent = {}) => {
  const sent = command(context, payload, extra);
  return run(method, sent, { ...context, commandId: sent.commandId as string, method });
};

/** Sends the query `method` as `context`. */
const ask = (method: keyof typeof schemas, context: ActionContext, fields: Sent = {}) => run(method, { actor: context.actor.id, caller: "test", ...fields }, context);

/** The error a call is refused with, as the client reads it. */
async function refusal(made: Promise<unknown>): Promise<{ code: number; message: string; phase: string; failures: { check: string; reason: string; details?: any }[] }> {
  try {
    await made;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    const data = error.data as { phase: string; failures: { check: string; reason: string; details?: any }[] };
    return { code: error.code, message: error.message, phase: data.phase, failures: data.failures };
  }
  throw new Error("the call was not refused");
}

const checks = (refused: { failures: { check: string }[] }) => refused.failures.map((failure) => failure.check);

/**
 * From here on the world's clock advances 1 ms on every read, starting at `start`: two readings in one command differ,
 * unless they are its transaction's instant, which is read once.
 */
function ticking(w: World, start: Date): void {
  let at = start.getTime();
  Object.defineProperty(w.time, "now", { get: () => new Date(at++), configurable: true });
}

/** A world whose clock reads the system's, with its workspace (every event carries its id) and Gus, a guest. */
function inWorld(body: (w: World & { gus: Collaborator }) => Promise<void>) {
  return within(async (w) => {
    w.time.now = new Date();
    await Workspace.create({ name: "Home", firstOwner: w.alice.id }, setup);
    const gus = await Collaborator.register({ kind: "agent", name: "Gus" }, setup);
    await Membership.grant({ collaborator: gus.id, role: "guest" }, as(w.alice));
    await body({ ...w, gus });
  });
}

describe("task.set-priority and task.unassign", () => {
  test("task.set-priority sets and clears the priority and bumps the version; a settled Task is task.open", () => inWorld(async (w) => {
    const set = await send("task.set-priority", as(w.alice), { taskId: w.task.id, priority: 5 });
    expect(set).toMatchObject({ task: { id: w.task.id, priority: 5, version: 2 } });
    // The command's one event, caused by the command, recording the Task at the version the command left it at.
    expect(set.events).toMatchObject([{
      type: "task.priority-set", actor: w.alice.id, record: { type: "task", id: w.task.id, version: 2 }, taskId: w.task.id,
      cause: { kind: "command", method: "task.set-priority" }, payload: { oldPriority: null, newPriority: 5 },
    }]);
    const cleared = await send("task.set-priority", as(w.alice), { taskId: w.task.id, priority: null }, { expectedVersion: 2 });
    expect(cleared.task).toMatchObject({ priority: null, version: 3 });
    await send("task.cancel", as(w.alice), { taskId: w.task.id, reason: "descoped" });
    const refused = await refusal(send("task.set-priority", as(w.alice), { taskId: w.task.id, priority: 1 }));
    expect([refused.code, refused.phase, checks(refused)]).toEqual([-32003, "content", ["task.open"]]);
  }));

  test("task.unassign ends the assignment and revokes the assignee's claim; a member who does not manage the Task is task.manager; with no assignment it is assignment.current", () => inWorld(async (w) => {
    await send("task.assign", as(w.alice), { taskId: w.task.id, assigneeId: w.bob.id });
    await send("claim.acquire", as(w.bob), { taskId: w.task.id });
    const denied = await refusal(send("task.unassign", as(w.bot), { taskId: w.task.id, reason: "mine now" }));
    expect([denied.code, denied.phase, checks(denied)]).toEqual([-32001, "permission", ["task.manager"]]);
    const result = await send("task.unassign", as(w.alice), { taskId: w.task.id, reason: "rebalancing" });
    expect(result.task).toMatchObject({ assignment: null, activeClaim: null, derived: { state: "ready" } });
    const history = (await ask("task.get", as(w.alice), { taskId: w.task.id })).history;
    expect(history.assignments).toMatchObject([{ assigneeId: w.bob.id, endReason: "unassigned" }]);
    expect(history.claims).toMatchObject([{ holderId: w.bob.id, state: "revoked" }]);
    const none = await refusal(send("task.unassign", as(w.alice), { taskId: w.task.id }));
    expect([none.code, checks(none)]).toEqual([-32003, ["assignment.current"]]);
  }));
});

describe("claim.renew, claim.release and claim.revoke find the claim from the Task", () => {
  test("claim.renew renews the actor's claim with that fence; a wrong fence is claim.current-fence, and someone who never held one is claim.holder", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", as(w.bot), { taskId: w.task.id });
    const renewed = await send("claim.renew", as(w.bot), { taskId: w.task.id, fence: claim.fence });
    expect(Object.keys(renewed).sort()).toEqual(["claim", "events"]);
    expect(renewed.claim).toMatchObject({ id: claim.id, fence: claim.fence, state: "active" });
    expect(Date.parse(renewed.claim.expiresAt)).toBeGreaterThanOrEqual(Date.parse(claim.expiresAt));
    const stale = await refusal(send("claim.renew", as(w.bot), { taskId: w.task.id, fence: claim.fence + 1 }));
    expect([stale.code, stale.phase, checks(stale)]).toEqual([-32003, "content", ["claim.current-fence"]]);
    const stranger = await refusal(send("claim.renew", as(w.bob), { taskId: w.task.id, fence: claim.fence }));
    expect([stranger.code, stranger.phase, checks(stranger)]).toEqual([-32001, "permission", ["claim.holder"]]);
    const guest = await refusal(send("claim.renew", as(w.gus), { taskId: w.task.id, fence: claim.fence }));
    expect(checks(guest)).toEqual(["role", "claim.holder"]);
  }));

  test("claim.release ends the claim and frees the Task; the released claim can no longer be renewed or released (claim.active)", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", as(w.bot), { taskId: w.task.id });
    const released = await send("claim.release", as(w.bot), { taskId: w.task.id, fence: claim.fence, reason: "handing over" });
    expect(released.claim).toMatchObject({ id: claim.id, state: "released", endReason: "handing over" });
    expect(released.task).toMatchObject({ activeClaim: null, derived: { state: "ready" } });
    const again = await refusal(send("claim.renew", as(w.bot), { taskId: w.task.id, fence: claim.fence }));
    expect([again.code, checks(again)]).toEqual([-32003, ["claim.active"]]);
    const twice = await refusal(send("claim.release", as(w.bot), { taskId: w.task.id, fence: claim.fence }));
    expect([twice.code, twice.phase, checks(twice)]).toEqual([-32003, "content", ["claim.active"]]);
  }));

  test("claim.revoke revokes the Task's active claim; with none an owner gets claim.active, and a member who could not revoke gets claim.revoker either way", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", as(w.bot), { taskId: w.task.id });
    const denied = await refusal(send("claim.revoke", as(w.bob), { taskId: w.task.id, reason: "mine" }));
    expect([denied.code, checks(denied)]).toEqual([-32001, ["claim.revoker"]]);
    const revoked = await send("claim.revoke", as(w.alice), { taskId: w.task.id, reason: "stalled" });
    expect(revoked.claim).toMatchObject({ id: claim.id, state: "revoked", endReason: "stalled" });
    expect(revoked.task.activeClaim).toBeNull();
    const none = await refusal(send("claim.revoke", as(w.alice), { taskId: w.task.id, reason: "again" }));
    expect([none.code, none.phase, checks(none)]).toEqual([-32003, "content", ["claim.active"]]);
    const noneForBob = await refusal(send("claim.revoke", as(w.bob), { taskId: w.task.id, reason: "again" }));
    expect([noneForBob.code, checks(noneForBob)]).toEqual([-32001, ["claim.revoker"]]);
    const noneForGus = await refusal(send("claim.revoke", as(w.gus), { taskId: w.task.id, reason: "again" }));
    expect(checks(noneForGus)).toEqual(["role", "claim.revoker"]);
  }));

  test("a claim whose lease ran out is not active before the sweeper marks it (PROTOCOL.md:312): revoke is claim.active, renew and release claim.expired, and the Task shows no active claim", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", { ...as(w.bot), leaseMs: 30 }, { taskId: w.task.id });
    expect(Date.parse(claim.expiresAt) - Date.parse(claim.acquiredAt)).toBe(30);
    // The methods read the system clock and the actions the world's: both move past `expiresAt`.
    await Bun.sleep(40);
    w.time.now = new Date();
    const revoke = await refusal(send("claim.revoke", as(w.alice), { taskId: w.task.id, reason: "stalled" }));
    expect([revoke.code, revoke.phase, checks(revoke)]).toEqual([-32003, "content", ["claim.active"]]);
    const renew = await refusal(send("claim.renew", as(w.bot), { taskId: w.task.id, fence: claim.fence }));
    expect([renew.code, renew.phase, checks(renew)]).toEqual([-32003, "content", ["claim.expired"]]);
    const release = await refusal(send("claim.release", as(w.bot), { taskId: w.task.id, fence: claim.fence }));
    expect([release.code, release.phase, checks(release)]).toEqual([-32003, "content", ["claim.expired"]]);
    const { task, history } = await ask("task.get", as(w.alice), { taskId: w.task.id });
    expect(task).toMatchObject({ activeClaim: null, derived: { state: "ready" } });
    // No sweeper runs in process: the row still says active.
    expect(history.claims).toMatchObject([{ id: claim.id, state: "active", endedAt: null }]);
  }));

  test("an unknown Task is not_found before any claim is looked for", () => inWorld(async (w) => {
    for (const taskId of ["nope", crypto.randomUUID()]) {
      const refused = await refusal(send("claim.release", as(w.bot), { taskId, fence: 1 }));
      expect(refused).toMatchObject({ code: -32005, phase: "permission", failures: [{ check: "exists", details: { recordType: "task", id: taskId } }] });
    }
  }));
});

describe("a lease that runs out while a command runs is decided at the command's instant", () => {
  // Each test acquires a one-minute lease and makes the clock tick from the moment it ends: the lease runs out on the
  // command's first reading of the clock, a minute after the system's, and every later reading sees it lapsed. A
  // command that decided from a reading other than its transaction's instant would see the claim live there and lapsed
  // in the action, and be refused.

  test("membership.revoke revokes the membership and leaves the lapsed claim to the sweeper", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", { ...as(w.bot), leaseMs: 60_000 }, { taskId: w.task.id });
    ticking(w, new Date(claim.expiresAt));
    const { membership } = await send("membership.revoke", as(w.alice), { collaboratorId: w.bot.id, reason: "offboarded" });
    expect(membership).toMatchObject({ id: w.memberships.bot.id, state: "revoked" });
    const { history } = await ask("task.get", as(w.alice), { taskId: w.task.id });
    expect(history.claims).toMatchObject([{ id: claim.id, state: "active", endedAt: null }]);
  }));

  test("collaborator.retire retires the collaborator, revokes its membership and leaves the lapsed claim to the sweeper", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", { ...as(w.bot), leaseMs: 60_000 }, { taskId: w.task.id });
    ticking(w, new Date(claim.expiresAt));
    const { collaborator } = await send("collaborator.retire", as(w.alice), { collaboratorId: w.bot.id, reason: "model retired" });
    expect(collaborator).toMatchObject({ id: w.bot.id, state: "retired" });
    expect(await Mesh.privileged(Membership).read({ filter: { id: { eq: w.memberships.bot.id } } })).toMatchObject([{ state: "revoked" }]);
    const { history } = await ask("task.get", as(w.alice), { taskId: w.task.id });
    expect(history.claims).toMatchObject([{ id: claim.id, state: "active", endedAt: null }]);
  }));

  test("task.complete with the lapsed claim's fence records a late result and leaves the Task open", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", { ...as(w.bot), leaseMs: 60_000 }, { taskId: w.task.id });
    ticking(w, new Date(claim.expiresAt));
    const done = await send("task.complete", as(w.bot), { taskId: w.task.id, fence: claim.fence, summary: "shipped" });
    expect(done).toMatchObject({ outcome: "late-result-recorded", lateResult: { taskId: w.task.id, submitterId: w.bot.id, fence: claim.fence, summary: "shipped" } });
    expect(Date.parse(done.lateResult.recordedAt)).toBeGreaterThanOrEqual(Date.parse(claim.expiresAt));
    const { task, history } = await ask("task.get", as(w.alice), { taskId: w.task.id });
    expect(task.state).toBe("open");
    expect(history.completions).toEqual([]);
  }));

  test("submission.submit with the lapsed claim's fence records a late result and submits nothing", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", { ...as(w.bot), leaseMs: 60_000 }, { taskId: w.task.id });
    ticking(w, new Date(claim.expiresAt));
    const done = await send("submission.submit", as(w.bot), { taskId: w.task.id, fence: claim.fence, summary: "ready" });
    expect(done).toMatchObject({ outcome: "late-result-recorded", lateResult: { taskId: w.task.id, submitterId: w.bot.id, fence: claim.fence, summary: "ready" } });
    expect(Date.parse(done.lateResult.recordedAt)).toBeGreaterThanOrEqual(Date.parse(claim.expiresAt));
    const { history } = await ask("task.get", as(w.alice), { taskId: w.task.id });
    expect(history.submissions).toEqual([]);
  }));
});

describe("dependency.remove finds the edge from its two Tasks", () => {
  test("it removes the edge and unblocks the dependent; a missing edge is dependency.exists for a member and role for a guest; an unknown Task is not_found", () => inWorld(async (w) => {
    const prerequisite = (await send("task.create", as(w.alice), { title: "first" })).task;
    await send("dependency.add", as(w.alice), { dependentId: w.task.id, prerequisiteId: prerequisite.id });
    const removed = await send("dependency.remove", as(w.bob), { dependentId: w.task.id, prerequisiteId: prerequisite.id, reason: "not needed" });
    expect(removed.task).toMatchObject({ id: w.task.id, derived: { state: "ready" } });
    const missing = await refusal(send("dependency.remove", as(w.bob), { dependentId: w.task.id, prerequisiteId: prerequisite.id }));
    expect([missing.code, missing.phase, checks(missing)]).toEqual([-32003, "content", ["dependency.exists"]]);
    const guest = await refusal(send("dependency.remove", as(w.gus), { dependentId: w.task.id, prerequisiteId: prerequisite.id }));
    expect([guest.code, guest.phase, checks(guest)]).toEqual([-32001, "permission", ["role"]]);
    const unknown = await refusal(send("dependency.remove", as(w.bob), { dependentId: w.task.id, prerequisiteId: crypto.randomUUID() }));
    expect([unknown.code, checks(unknown)]).toEqual([-32005, ["exists"]]);
  }));
});

describe("submission.withdraw and the review methods", () => {
  test("submission.withdraw: only the submitter, and only while pending", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", as(w.bot), { taskId: w.task.id });
    const { submission } = await send("submission.submit", as(w.bot), { taskId: w.task.id, fence: claim.fence, summary: "done" });
    const denied = await refusal(send("submission.withdraw", as(w.alice), { submissionId: submission.id }));
    expect([denied.code, checks(denied)]).toEqual([-32001, ["submission.submitter"]]);
    const withdrawn = await send("submission.withdraw", as(w.bot), { submissionId: submission.id, reason: "wrong file" });
    expect(withdrawn.submission).toMatchObject({ id: submission.id, state: "withdrawn", review: null });
    expect(withdrawn.task).toMatchObject({ pendingSubmission: null, derived: { state: "ready" } });
    const again = await refusal(send("submission.withdraw", as(w.bot), { submissionId: submission.id }));
    expect([again.code, checks(again)]).toEqual([-32003, ["submission.pending"]]);
  }));

  test("an unknown submission is not_found", () => inWorld(async (w) => {
    for (const submissionId of ["nope", crypto.randomUUID()]) {
      const refused = await refusal(send("review.accept", as(w.alice), { submissionId }));
      expect(refused).toMatchObject({ code: -32005, failures: [{ check: "exists", details: { recordType: "submission", id: submissionId } }] });
    }
  }));

  test("review.return keeps the assignment and puts the Task back to ready; the submission in task.get carries its review", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", as(w.bot), { taskId: w.task.id });
    const { submission } = await send("submission.submit", as(w.bot), { taskId: w.task.id, fence: claim.fence, summary: "v1" });
    const returned = await send("review.return", as(w.alice), { submissionId: submission.id, reasons: "missing tests" });
    expect(returned.review).toMatchObject({ submissionId: submission.id, reviewerId: w.alice.id, decision: "return", reasons: "missing tests", ruleApplied: "task-creator" });
    expect(returned.task).toMatchObject({ derived: { state: "ready" }, assignment: { assigneeId: w.bot.id }, pendingSubmission: null });
    const history = (await ask("task.get", as(w.bob), { taskId: w.task.id })).history;
    expect(history.submissions).toMatchObject([{ id: submission.id, state: "returned", review: { decision: "return" } }]);
  }));
});

describe("what a failure carries", () => {
  test("task.children-settled names each open child by title in the reason (the check's message function), and its details keep the ids alone", () => inWorld(async (w) => {
    const open = await send("task.create", as(w.alice), { title: "Open child", parentId: w.task.id });
    const other = await send("task.create", as(w.alice), { title: "Other \"quoted\" child", parentId: w.task.id });
    const refused = await refusal(send("task.complete", as(w.alice), { taskId: w.task.id }));
    expect([refused.code, refused.phase]).toEqual([-32003, "content"]);
    const failure = refused.failures.find((entry) => entry.check === "task.children-settled")!;
    expect(failure.details).toEqual({ openChildren: [open.task.id, other.task.id] });
    expect(failure.reason).toBe(`complete or cancel every child first; open: "Open child", "Other \\"quoted\\" child"`);
  }));

  test("review.reviewer carries the reviewer the rule names; a role failure beside it is left as it is", () => inWorld(async (w) => {
    const { claim } = await send("claim.acquire", as(w.bot), { taskId: w.task.id });
    const { submission } = await send("submission.submit", as(w.bot), { taskId: w.task.id, fence: claim.fence, summary: "done" });
    const refused = await refusal(send("review.accept", as(w.bob), { submissionId: submission.id }));
    expect(refused).toMatchObject({ code: -32001, phase: "permission" });
    expect(refused.failures).toEqual([{ check: "review.reviewer", reason: expect.any(String), details: { reviewerId: w.alice.id } }]);
    const guest = await refusal(send("review.return", as(w.gus), { submissionId: submission.id, reasons: "no" }));
    expect(guest.failures.find((entry) => entry.check === "role")!.details).toEqual({ role: "guest", required: ["owner", "member"] });
    expect(guest.failures.find((entry) => entry.check === "review.reviewer")!.details).toEqual({ reviewerId: w.alice.id });
  }));

  test("when the read that explains a failure fails, the rejection is answered as it is and the failure is logged", () => inWorld(async (w) => {
    const error = rejection(-32001, "permission", [{ check: "review.reviewer", reason: "only the reviewer can review" }]);
    // Closing the in-memory layer drops its database: the next transaction opens an empty one, with no tables to read.
    await w.db.close();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await explained(error, { submissionId: "00000000-0000-4000-8000-000000000001" })).toBe(error);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  }));
});

describe("task.list and task.next", () => {
  test("task.list: every Task, the top-level ones, a Task's children, by stored state, in creation order; an id that names no Task has no children", () => inWorld(async (w) => {
    const first = (await send("task.create", as(w.alice), { title: "first", parentId: w.task.id })).task;
    const second = (await send("task.create", as(w.alice), { title: "second", parentId: w.task.id })).task;
    await send("task.cancel", as(w.alice), { taskId: second.id, reason: "dup" });
    const ids = async (fields: Sent) => (await ask("task.list", as(w.gus), fields)).tasks.map((task: { id: string }) => task.id);
    expect(await ids({})).toEqual([w.task.id, first.id, second.id]);
    expect(await ids({ parentId: null })).toEqual([w.task.id]);
    expect(await ids({ parentId: w.task.id })).toEqual([first.id, second.id]);
    expect(await ids({ parentId: w.task.id, state: "canceled" })).toEqual([second.id]);
    expect(await ids({ state: "open" })).toEqual([w.task.id, first.id]);
    expect(await ids({ parentId: "nope" })).toEqual([]);
    expect(await ids({ parentId: crypto.randomUUID() })).toEqual([]);
  }));

  test("task.next: the ready Task the actor may claim with the highest priority, null below every number, then the earliest created; a guest has none", () => inWorld(async (w) => {
    await send("task.cancel", as(w.alice), { taskId: w.task.id, reason: "out of the way" });
    const next = async (who: { id: string }) => (await ask("task.next", as(who))).task?.id ?? null;
    expect(await next(w.bot)).toBeNull();
    const none = (await send("task.create", as(w.alice), { title: "none" })).task;
    const low = (await send("task.create", as(w.alice), { title: "low", priority: 1 })).task;
    const lateNone = (await send("task.create", as(w.alice), { title: "late none" })).task;
    const high = (await send("task.create", as(w.alice), { title: "high", priority: 5 })).task;
    const bobs = (await send("task.create", as(w.alice), { title: "Bob's", priority: 100 })).task;
    await send("task.assign", as(w.alice), { taskId: bobs.id, assigneeId: w.bob.id });
    const blocked = (await send("task.create", as(w.alice), { title: "blocked", priority: 50 })).task;
    await send("dependency.add", as(w.alice), { dependentId: blocked.id, prerequisiteId: none.id });
    expect(await next(w.bot)).toBe(high.id);
    expect(await next(w.bob)).toBe(bobs.id);
    expect(await next(w.gus)).toBeNull();
    await send("claim.acquire", as(w.alice), { taskId: high.id });
    expect(await next(w.bot)).toBe(low.id);
    await send("task.set-priority", as(w.alice), { taskId: low.id, priority: null });
    expect(await next(w.bot)).toBe(none.id);
    await send("claim.acquire", as(w.alice), { taskId: none.id });
    expect(await next(w.bot)).toBe(low.id);
    expect(lateNone.priority).toBeNull();
  }));
});
