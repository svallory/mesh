// The transport resolves what the spec names by one record and the port addresses by another (PORTING.md:17): a
// membership by its collaborator, the workspace by being the only one. It also checks, before an action runs, that each
// record a payload names exists, so a missing one is the spec's `exists` (PROTOCOL.md:110) and never a validator
// failure on an id that is not a UUID, or an id stored without a row behind it (SQLite has no foreign keys here).
import { ForbiddenError, InvalidInputError, NotFoundError, type ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { z } from "zod";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Task } from "#mesh/domain/work";
import { roleIn } from "../domain/identity/identity.helpers";

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
  throw new InvalidInputError([{
    label: "membershipActive", code: "membership.active", path: [], source: null, details: null,
    message: "the collaborator has no membership; grant one with membership.grant",
  }]);
}
