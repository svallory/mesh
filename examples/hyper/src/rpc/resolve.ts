// The transport resolves what the spec names by one record and the port addresses by another (PORTING.md:17): a
// membership by its collaborator, a claim by its Task and fence, a dependency by its two Tasks, the workspace by being
// the only one. It also checks, before an action runs, that each
// record a payload names exists, so a missing one is the spec's `exists` (PROTOCOL.md:110) and never a validator
// failure on an id that is not a UUID, or an id stored without a row behind it (SQLite has no foreign keys here).
import { ForbiddenError, InvalidInputError, NotFoundError, type ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { z } from "zod";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Claim, Dependency, Submission, Task } from "#mesh/domain/work";
import { roleIn } from "../domain/identity/identity.helpers";
import { revokesClaimOf } from "../domain/work/work.helpers";

const uuid = z.uuid();

/** Whether `id` can name a stored row: every key the port generates is a UUID, which the actions' validators require. */
export function isId(id: string): boolean {
  return uuid.safeParse(id).success;
}

/**
 * Throws the `NotFoundError` of `entity` (its FQN) when `id` is not a UUID, so the action's validator never answers a
 * well-formed spec id (any non-empty string) with `invalid_params`: `"nope"` names no record, as an unknown UUID does.
 */
export function requireId(entity: string, id: string): string {
  if (!isId(id)) throw new NotFoundError(entity, { id });
  return id;
}

/** Throws the `NotFoundError` of the collaborator `id` when there is none. */
export async function existingCollaborator(id: string): Promise<Collaborator> {
  requireId("identity.Collaborator", id);
  const [collaborator] = await Mesh.privileged(Collaborator).read({ filter: { id: { eq: id } }, limit: 1 });
  if (!collaborator) throw new NotFoundError("identity.Collaborator", { id });
  return collaborator;
}

/** Throws the `NotFoundError` of the Task `id` when there is none. */
export async function existingTask(id: string): Promise<Task> {
  requireId("work.Task", id);
  const [task] = await Mesh.privileged(Task).read({ filter: { id: { eq: id } }, limit: 1 });
  if (!task) throw new NotFoundError("work.Task", { id });
  return task;
}

/** Throws the `NotFoundError` of the submission `id` when there is none. */
export async function existingSubmission(id: string): Promise<Submission> {
  requireId("work.Submission", id);
  const [submission] = await Mesh.privileged(Submission).read({ filter: { id: { eq: id } }, limit: 1 });
  if (!submission) throw new NotFoundError("work.Submission", { id });
  return submission;
}

/** The one workspace this engine hosts, which bootstrap creates (PROTOCOL.md:42). */
export async function theWorkspace(): Promise<Workspace> {
  const [workspace] = await Mesh.privileged(Workspace).read({ limit: 1 });
  if (!workspace) throw new Error("the engine has no workspace: bootstrap did not run");
  return workspace;
}

/**
 * The membership `membership.change-role` and `membership.revoke` act on, which the spec names by its collaborator: the
 * active one, else the latest, so the entity's own rule answers `membership.active` for a revoked one (PROTOCOL.md:261).
 * A collaborator that never had one has nothing to act on. The permission phase still comes first (PROTOCOL.md:107):
 * an actor that could not change any membership is refused as the actions' `ownerOnly` would refuse it, and only an
 * owner learns that there is no membership.
 */
export async function membershipOf(collaboratorId: string, context: ActionContext, action: "changeRole" | "revoke"): Promise<Membership> {
  await existingCollaborator(collaboratorId);
  const memberships = await Mesh.privileged(Membership).read({ filter: { collaboratorId: { eq: collaboratorId } }, sort: ["grantedAt", "id"] });
  const membership = memberships.find((candidate) => candidate.state === "active") ?? memberships.at(-1);
  if (membership) return membership;
  if (!(await roleIn(context.actor.id, ["owner"]))) {
    throw new ForbiddenError({ entity: "identity.Membership", action, policies: ["ownerOnly"], breakdown: [] });
  }
  throw nothingToActOn("membershipActive", "membership.active", "the collaborator has no membership; grant one with membership.grant");
}

/** The issue an action would report for `code`, for a record the transport finds nothing to act on. */
function nothingToActOn(label: string, code: string, message: string): InvalidInputError {
  return new InvalidInputError([{ label, code, path: [], source: null, details: null, message }]);
}

/**
 * The claim `claim.renew` and `claim.release` act on, which the spec names by its Task and fence (PROTOCOL.md:249):
 * the actor's claim with that fence, else the actor's latest claim on the Task, so the action's own checks answer
 * `claim.current-fence`, `claim.active` or `claim.expired`. An actor that never held a claim on the Task is refused
 * `claim.holder` in the permission phase, as the action's `claimHolder` would refuse it, beside `role` when its role
 * could not renew or release any claim.
 */
export async function claimOf(taskId: string, fence: number, context: ActionContext, action: "renew" | "release"): Promise<Claim> {
  await existingTask(taskId);
  const claims = await Mesh.privileged(Claim).read({ filter: { taskId: { eq: taskId }, holderId: { eq: context.actor.id } }, sort: ["fence", "id"] });
  const claim = claims.find((candidate) => candidate.fence === fence) ?? claims.at(-1);
  if (claim) return claim;
  // With no claim there is no record to run the policies on, so this decides them by hand. It mirrors
  // `policy :ownerOrMember` and `policy :claimHolder` of `src/domain/work/claim.mesh.mx` (the actor holds no claim, so
  // `claimHolder` fails); a call from the transport is never `system`. Change it with them.
  const policies = (await roleIn(context.actor.id, ["owner", "member"])) ? ["claimHolder"] : ["ownerOrMember", "claimHolder"];
  throw new ForbiddenError({ entity: "work.Claim", action, policies, breakdown: [] });
}

/**
 * The claim `claim.revoke` acts on, which the spec names by its Task: the Task's active claim. One whose lease has run
 * out before the lease sweeper marked it is expired (PROTOCOL.md:312), and `Claim.revoke` refuses it as `claim.active`
 * (`!&lapsed`), at the transaction's instant. With none there is nothing to revoke, `claim.active` (PROTOCOL.md:279),
 * once the permission phase has passed: an actor that could not revoke the Task's claim is refused as the action's
 * `ownerOrMember` and `claimRevoker` would refuse it.
 */
export async function activeClaimOf(taskId: string, context: ActionContext): Promise<Claim> {
  await existingTask(taskId);
  const [claim] = await Mesh.privileged(Claim).read({ filter: { taskId: { eq: taskId }, state: { eq: "active" } }, sort: ["fence", "id"] });
  if (claim) return claim;
  // With no claim there is no record to run the policies on, so this decides them by hand. It mirrors
  // `policy :ownerOrMember` and `policy :claimRevoker` of `src/domain/work/claim.mesh.mx`; a call from the transport is
  // never `system`. Change it with them.
  const policies = [
    ...((await roleIn(context.actor.id, ["owner", "member"])) ? [] : ["ownerOrMember"]),
    ...((await revokesClaimOf(taskId, context.actor.id)) ? [] : ["claimRevoker"]),
  ];
  if (policies.length > 0) throw new ForbiddenError({ entity: "work.Claim", action: "revoke", policies, breakdown: [] });
  throw nothingToActOn("claimActive", "claim.active", "the task has no active claim to revoke");
}

/**
 * The dependency `dependency.remove` acts on, which the spec names by its two Tasks. Each Task must exist (`exists`);
 * an edge that does not is `dependency.exists`, a content check (PROTOCOL.md:276), once the permission phase has
 * passed: an actor whose role could not remove any dependency is refused as the action's `ownerOrMember` would refuse it.
 */
export async function dependencyOf(dependentId: string, prerequisiteId: string, context: ActionContext): Promise<Dependency> {
  await existingTask(dependentId);
  await existingTask(prerequisiteId);
  const [dependency] = await Mesh.privileged(Dependency).read({ filter: { dependentId: { eq: dependentId }, prerequisiteId: { eq: prerequisiteId } }, limit: 1 });
  if (dependency) return dependency;
  // With no edge there is no record to run the policies on, so this decides them by hand. It mirrors
  // `policy :ownerOrMember` of `src/domain/work/dependency.mesh.mx`; a call from the transport is never `system`. Change
  // it with it.
  if (!(await roleIn(context.actor.id, ["owner", "member"]))) {
    throw new ForbiddenError({ entity: "work.Dependency", action: "remove", policies: ["ownerOrMember"], breakdown: [] });
  }
  throw nothingToActOn("dependencyExists", "dependency.exists", "the dependency does not exist; nothing to remove");
}
