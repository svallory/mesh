// Hyper's method table for `@meshfw/jsonrpc`: one entry per method of the spec (`schemas/protocol.ts`, `Methods`). A
// command runs in one transaction, so a crash never leaves half of one behind (PROTOCOL.md:38), and calls the command
// function where one exists (`src/domain/<module>/<module>.commands.ts`), never the generated action it wraps, which
// would skip the effects on other aggregates (PORTING.md:54). Its result carries `events: []` until the event log
// exists (M6); `workspace.get`'s `head` is 0 for the same reason.
import type { Call, Method, MethodTable } from "@meshfw/jsonrpc";
import type { ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { z } from "zod";
import { transaction } from "#mesh";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Assignment, Claim, Dependency, EvidenceReference, Review, Submission, Task } from "#mesh/domain/work";
import { connected } from "../domain/binding";
import { roleIn } from "../domain/identity/identity.helpers";
import { collaboratorRetire, membershipRevoke } from "../domain/identity/identity.commands";
import { reviewAccept, submissionSubmit, taskCancel, taskComplete } from "../domain/work/work.commands";
import { currentAssignment, type BlockReason } from "../domain/work/work.helpers";
import { explained, notServed, rpcErrorOf } from "./errors";
import { params } from "./params";
import { activeClaimOf, claimOf, dependencyOf, existingCollaborator, existingSubmission, existingTask, isId, membershipOf, requireId, theWorkspace } from "./resolve";
import {
  assignmentView,
  claimView,
  collaboratorView,
  completionView,
  evidenceReferenceView,
  lateResultView,
  membershipView,
  reviewedSubmissionView,
  reviewView,
  submissionView,
  taskHistory,
  taskView,
  workspaceView,
} from "./views";

/** A copy of `value` without its `undefined` members: an action reads a member input that is present as one that was sent. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as never;
}

/**
 * Runs `body` in one transaction, and answers what it throws with the spec's error when it has one (`rpcErrorOf`),
 * with what the failures need from the call's `payload` and the database (`explained`).
 */
async function inTransaction<R>(context: ActionContext, body: () => Promise<R>, payload?: unknown): Promise<R> {
  try {
    return await transaction(body);
  } catch (error) {
    const mapped = rpcErrorOf(error, context);
    if (mapped === undefined) throw error;
    throw await explained(mapped, payload);
  }
}

/** A command (PROTOCOL.md:73-91): its params schema, and what it does, which returns the records of its result. */
function command<S extends z.ZodType, R extends object>(schema: S, run: (params: z.output<S>, context: ActionContext) => Promise<R>): Method<ActionContext, any> {
  return {
    params: schema,
    run: async (sent, context) => ({ events: [], ...(await inTransaction(context, () => run(sent as z.output<S>, context), (sent as { payload?: unknown }).payload)) }),
  };
}

/** A query: its params schema and its result, read in one transaction. */
function query<S extends z.ZodType, R extends object>(schema: S, run: (params: z.output<S>, context: ActionContext) => Promise<R>): Method<ActionContext, any> {
  return {
    params: schema,
    run: (sent, context) => inTransaction(context, () => run(sent as z.output<S>, context)),
  };
}

/** Why each entry `notImplemented` made is not served; `unserved` reads it. */
const unservedReasons = new WeakMap<Method<ActionContext, any>, string>();

/**
 * A method of the spec this engine does not serve (yet): `-32010 not_implemented`, check `method` (PROTOCOL.md:215). The
 * context factory answers it before it reads anything (`unserved`), so `run` is reached only through a factory that
 * skips that step.
 */
function notImplemented(why: string): Method<ActionContext, any> {
  const method: Method<ActionContext, any> = {
    run: (_sent: unknown, _context: ActionContext, call: Call) => {
      throw notServed(call.method, why);
    },
  };
  unservedReasons.set(method, why);
  return method;
}

const outsideTheSlice = notImplemented("it is outside the v0 slice");
const needsTheEventLog = notImplemented("it needs the event log, which arrives with the outbox (Mesh's M6)");

/**
 * The Task `id` as it stands once the call's actions ran, read in the call's transaction. The record an action returns
 * can be behind: an effect on another record of the Task aggregate touches the Task (`Task.touch`), which bumps its
 * version after the action wrote its own row.
 */
async function currentTask(id: string) {
  return taskView(await existingTask(id), new Date());
}

/** Block reasons as the wire carries them (`schemas/protocol.ts`, `Warnings`). */
const warningsOf = (reasons: readonly BlockReason[]) => reasons.map((reason) => ({ ...reason }));

/** Priority descending with `null` below every number, then creation order (PROTOCOL.md:127, the `task.next` tie rule). */
function nextFirst(a: Task, b: Task): number {
  if (a.priority !== b.priority) {
    if (a.priority === null) return 1;
    if (b.priority === null) return -1;
    return b.priority - a.priority;
  }
  const created = a.createdAt.getTime() - b.createdAt.getTime();
  return created !== 0 ? created : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The methods that take no actor (PROTOCOL.md:124, 132; `workspace.get` and `events.unsubscribe` are the two whose
 * params have no `actor` in `schemas/protocol.ts`): they run with the engine's context. Every other method names its
 * actor, so serving one never needs an entry here.
 */
export const actorless: ReadonlySet<string> = new Set(["workspace.get", "events.unsubscribe"]);

/**
 * The methods of `table` this engine does not serve, each with the reason its `-32010` gives: the entries
 * `notImplemented` made. Serving one means replacing its entry, which takes it off this map.
 */
export function unserved(table: MethodTable<ActionContext>): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>();
  for (const [name, method] of Object.entries(table)) {
    const why = unservedReasons.get(method);
    if (why !== undefined) reasons.set(name, why);
  }
  return reasons;
}

/** The method table: every one of the spec's 37 methods. */
export const methods: MethodTable<ActionContext> = {
  "workspace.create": command(params["workspace.create"], async ({ payload }, context) => ({
    workspace: workspaceView(await Workspace.create({ name: payload.name ?? null, location: "local" }, context)),
  })),
  "workspace.rename": command(params["workspace.rename"], async ({ payload, expectedVersion }, context) => {
    const { id } = await theWorkspace();
    return { workspace: workspaceView(await Workspace.rename(defined({ id, name: payload.name, expectedVersion }), context)) };
  }),
  "workspace.export": outsideTheSlice,
  "workspace.move": outsideTheSlice,

  "collaborator.register": command(params["collaborator.register"], async ({ payload }, context) => ({
    collaborator: collaboratorView(await Collaborator.register({ kind: payload.kind, name: payload.name }, context)),
  })),
  "collaborator.update": command(params["collaborator.update"], async ({ payload, expectedVersion }, context) => {
    const id = requireId("identity.Collaborator", payload.collaboratorId);
    return { collaborator: collaboratorView(await Collaborator.update(defined({ id, name: payload.name, kind: payload.kind, expectedVersion }), context)) };
  }),
  "collaborator.retire": command(params["collaborator.retire"], async ({ payload, expectedVersion }, context) => {
    const id = requireId("identity.Collaborator", payload.collaboratorId);
    const { collaborator } = await collaboratorRetire(defined({ id, reason: payload.reason, expectedVersion }), context, connected);
    return { collaborator: collaboratorView(collaborator) };
  }),

  "membership.grant": command(params["membership.grant"], async ({ payload }, context) => {
    await existingCollaborator(payload.collaboratorId);
    return { membership: membershipView(await Membership.grant({ collaborator: payload.collaboratorId, role: payload.role }, context)) };
  }),
  "membership.change-role": command(params["membership.change-role"], async ({ payload, expectedVersion }, context) => {
    const { id } = await membershipOf(payload.collaboratorId, context, "changeRole");
    return { membership: membershipView(await Membership.changeRole(defined({ id, role: payload.role, expectedVersion }), context)) };
  }),
  "membership.revoke": command(params["membership.revoke"], async ({ payload, expectedVersion }, context) => {
    const { id } = await membershipOf(payload.collaboratorId, context, "revoke");
    const { membership } = await membershipRevoke(defined({ id, reason: payload.reason, expectedVersion }), context, connected);
    return { membership: membershipView(membership) };
  }),

  "task.create": command(params["task.create"], async ({ payload }, context) => {
    if (payload.parentId !== undefined && payload.parentId !== null) await existingTask(payload.parentId);
    const task = await Task.create(defined({ title: payload.title, intent: payload.intent, parent: payload.parentId, priority: payload.priority }), context);
    return { task: await taskView(task, new Date()) };
  }),
  "task.update": command(params["task.update"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    await Task.update(defined({ id, title: payload.title, intent: payload.intent, expectedVersion }), context);
    return { task: await currentTask(id) };
  }),
  "task.set-priority": command(params["task.set-priority"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    await Task.setPriority(defined({ id, priority: payload.priority, expectedVersion }), context);
    return { task: await currentTask(id) };
  }),
  "task.move": command(params["task.move"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    if (payload.parentId !== null) await existingTask(payload.parentId);
    await Task.move(defined({ id, parent: payload.parentId, expectedVersion }), context);
    return { task: await currentTask(id) };
  }),
  "task.complete": command(params["task.complete"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    const done = await taskComplete(defined({ id, fence: payload.fence, summary: payload.summary, evidence: payload.evidence, expectedVersion }), context, connected);
    if (done.outcome === "late-result-recorded") return { outcome: done.outcome, lateResult: lateResultView(done.lateResult) };
    return {
      outcome: done.outcome,
      task: await currentTask(id),
      completion: completionView(done.completion),
      submission: done.submission === null ? null : await reviewedSubmissionView(done.submission),
      warnings: warningsOf(done.warnings),
    };
  }),
  "task.cancel": command(params["task.cancel"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    await taskCancel(defined({ id, reason: payload.reason, expectedVersion }), context, connected);
    return { task: await currentTask(id) };
  }),
  "task.reopen": command(params["task.reopen"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    await Task.reopen(defined({ id, reason: payload.reason, expectedVersion }), context);
    return { task: await currentTask(id) };
  }),
  "task.assign": command(params["task.assign"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    await existingCollaborator(payload.assigneeId);
    await Task.assign(defined({ id, assignee: payload.assigneeId, waiveReview: payload.waiveReview, expectedVersion }), context);
    const assignment = currentAssignment(await Mesh.privileged(Assignment).read({ filter: { taskId: { eq: id }, endedAt: { nil: true } } }));
    if (assignment === undefined) throw new Error(`Task.assign left Task ${id} with no current assignment`);
    return { task: await currentTask(id), assignment: assignmentView(assignment) };
  }),
  "task.unassign": command(params["task.unassign"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    await Task.unassign(defined({ id, reason: payload.reason, expectedVersion }), context);
    return { task: await currentTask(id) };
  }),
  "dependency.add": command(params["dependency.add"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.dependentId);
    await existingTask(payload.prerequisiteId);
    await Dependency.add(defined({ dependent: id, prerequisite: payload.prerequisiteId, expectedVersion }), context);
    return { task: await currentTask(id) };
  }),
  "dependency.remove": command(params["dependency.remove"], async ({ payload, expectedVersion }, context) => {
    const dependency = await dependencyOf(payload.dependentId, payload.prerequisiteId, context);
    await Dependency.remove(defined({ id: dependency.id, reason: payload.reason, expectedVersion }), context);
    return { task: await currentTask(dependency.dependentId) };
  }),
  "claim.acquire": command(params["claim.acquire"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    const claim = await Claim.acquire(defined({ task: id, expectedVersion }), context);
    return { task: await currentTask(id), claim: claimView(claim) };
  }),
  "claim.renew": command(params["claim.renew"], async ({ payload, expectedVersion }, context) => {
    const { id } = await claimOf(payload.taskId, payload.fence, context, "renew");
    return { claim: claimView(await Claim.renew(defined({ id, fence: payload.fence, expectedVersion }), context)) };
  }),
  "claim.release": command(params["claim.release"], async ({ payload, expectedVersion }, context) => {
    const { id } = await claimOf(payload.taskId, payload.fence, context, "release");
    const claim = await Claim.release(defined({ id, fence: payload.fence, reason: payload.reason, expectedVersion }), context);
    return { task: await currentTask(claim.taskId), claim: claimView(claim) };
  }),
  "claim.revoke": command(params["claim.revoke"], async ({ payload, expectedVersion }, context) => {
    const { id } = await activeClaimOf(payload.taskId, new Date(), context);
    const claim = await Claim.revoke(defined({ id, reason: payload.reason, expectedVersion }), context);
    return { task: await currentTask(claim.taskId), claim: claimView(claim) };
  }),
  "submission.submit": command(params["submission.submit"], async ({ payload, expectedVersion }, context) => {
    const { id } = await existingTask(payload.taskId);
    const done = await submissionSubmit(defined({ task: id, fence: payload.fence, summary: payload.summary, evidence: payload.evidence, expectedVersion }), context, connected);
    if (done.outcome === "late-result-recorded") return { outcome: done.outcome, lateResult: lateResultView(done.lateResult) };
    return { outcome: done.outcome, task: await currentTask(id), submission: submissionView(done.submission, null) };
  }),
  "submission.withdraw": command(params["submission.withdraw"], async ({ payload, expectedVersion }, context) => {
    const { id, taskId } = await existingSubmission(payload.submissionId);
    const submission = await Submission.withdraw(defined({ id, reason: payload.reason, expectedVersion }), context);
    return { task: await currentTask(taskId), submission: await reviewedSubmissionView(submission) };
  }),
  "review.accept": command(params["review.accept"], async ({ payload, expectedVersion }, context) => {
    const { id, taskId } = await existingSubmission(payload.submissionId);
    const accepted = await reviewAccept(defined({ submission: id, expectedVersion }), context, connected);
    return { task: await currentTask(taskId), review: reviewView(accepted.review), completion: completionView(accepted.completion), warnings: warningsOf(accepted.warnings) };
  }),
  "review.return": command(params["review.return"], async ({ payload, expectedVersion }, context) => {
    const { id, taskId } = await existingSubmission(payload.submissionId);
    const review = await Review.return(defined({ submission: id, reasons: payload.reasons, expectedVersion }), context);
    return { task: await currentTask(taskId), review: reviewView(review) };
  }),
  "evidence-reference.record": command(params["evidence-reference.record"], async ({ payload }, context) => {
    const evidenceReference = await EvidenceReference.record(
      defined({ kind: payload.kind, locator: payload.locator, contentHash: payload.contentHash, description: payload.description }),
      context,
    );
    return { evidenceReference: evidenceReferenceView(evidenceReference) };
  }),

  "workspace.get": query(z.object({}), async () => {
    const owners = await Mesh.privileged(Membership).read({ filter: { role: { eq: "owner" }, state: { eq: "active" } }, sort: ["grantedAt", "id"] });
    const collaborators = owners.length === 0 ? [] : await Mesh.privileged(Collaborator).read({ filter: { id: { in: owners.map((owner) => owner.collaboratorId) } } });
    const byId = new Map(collaborators.map((collaborator) => [collaborator.id, collaborator]));
    return {
      workspace: workspaceView(await theWorkspace()),
      owners: owners.flatMap((owner) => {
        const collaborator = byId.get(owner.collaboratorId);
        return collaborator ? [collaboratorView(collaborator)] : [];
      }),
      head: 0,
    };
  }),
  "task.get": query(params["task.get"], async ({ taskId }) => {
    const task = await existingTask(taskId);
    return { task: await taskView(task, new Date()), history: await taskHistory(task.id) };
  }),
  "task.list": query(params["task.list"], async ({ parentId, state }) => {
    // An id that is not a UUID names no Task, so it has no children.
    if (typeof parentId === "string" && !isId(parentId)) return { tasks: [] };
    const tasks = await Mesh.privileged(Task).read({
      filter: {
        ...(parentId === undefined ? {} : parentId === null ? { parentId: { nil: true } } : { parentId: { eq: parentId } }),
        ...(state === undefined ? {} : { state: { eq: state } }),
      },
      sort: ["createdAt", "id"],
    });
    const now = new Date();
    const views = [];
    for (const task of tasks) views.push(await taskView(task, now));
    return { tasks: views };
  }),
  "task.next": query(params["task.next"], async (_params, context) => {
    // Only a member or an owner may claim (PROTOCOL.md:127): a guest has no next Task.
    if (!(await roleIn(context.actor.id, ["owner", "member"]))) return { task: null };
    // `derivedState` cannot be filtered on in a read (G07): the open Tasks are read with it and filtered here.
    const open = await Mesh.privileged(Task).read({ filter: { state: { eq: "open" } }, load: ["derivedState"] });
    const ready = open.filter((task) => task.derivedState === "ready");
    const assignments = ready.length === 0 ? [] : await Mesh.privileged(Assignment).read({ filter: { taskId: { in: ready.map((task) => task.id) }, endedAt: { nil: true } } });
    const mayClaim = ready.filter((task) => {
      const assignment = currentAssignment(assignments.filter((row) => row.taskId === task.id));
      return assignment === undefined || assignment.assigneeId === context.actor.id;
    });
    const [next] = mayClaim.sort(nextFirst);
    return { task: next === undefined ? null : await taskView(next, new Date()) };
  }),
  "events.read": needsTheEventLog,
  "events.subscribe": needsTheEventLog,
  "events.unsubscribe": needsTheEventLog,
};
