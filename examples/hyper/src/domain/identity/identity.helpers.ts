// Helpers for the identity entity files and the identity functions: reads through `Mesh.privileged`, which runs the
// entity's reads with no policy inside the running transaction, each named after the Hyper rule it follows.
import { Mesh } from "meshfw";
import { Collaborator, Membership } from "#mesh/domain/identity";
import type { Role } from "../../context";

/**
 * The role of the collaborator's active membership, or null when it has none (`checks/role.ex:33-38`). The write
 * policies read it here, through `Mesh.privileged`, inside the transaction: a membership revoked a moment ago is refused on the
 * next write (ADR-0074).
 */
export async function roleOf(collaboratorId: string): Promise<Role | null> {
  const [membership] = await Mesh.privileged(Membership).read({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" } }, limit: 1 });
  return membership?.role ?? null;
}

/** Policy `isMember`, the spec's `membership` (`checks/role.ex:24`, PROTOCOL.md:246): the collaborator has an active membership. */
export async function memberOf(collaboratorId: string): Promise<boolean> {
  return (await roleOf(collaboratorId)) !== null;
}

/**
 * Policies `ownerOrMember` and `ownerOnly`, the spec's `role` (`checks/role.ex:21`, `:25`, PROTOCOL.md:247): the
 * active membership's role is one of `roles`. A collaborator with no membership fails it too (fail closed); `isMember`
 * names that case, and the spec accepts the extra failure (PROTOCOL.md:114).
 */
export async function roleIn(collaboratorId: string, roles: readonly Role[]): Promise<boolean> {
  const role = await roleOf(collaboratorId);
  return role !== null && roles.includes(role);
}

/** `collaborator.active` on another collaborator (`collaborators/rules.ex:9-22`): it exists and is not retired. */
export async function collaboratorActiveOf(collaboratorId: string): Promise<boolean> {
  const [collaborator] = await Mesh.privileged(Collaborator).read({ filter: { id: { eq: collaboratorId } } });
  return collaborator?.state === "active";
}

/** `assignment.assignee-role` (`tasks/task/rules.ex:107-116`): the active membership's role is owner or member. */
export async function assignableOf(collaboratorId: string): Promise<boolean> {
  const memberships = await Mesh.privileged(Membership).read({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" } } });
  return memberships.some((membership) => membership.role === "owner" || membership.role === "member");
}

/** `membership.none-active` (`memberships/membership/rules.ex:9-15`): the collaborator has no active membership. */
export async function noActiveMembershipOf(collaboratorId: string): Promise<boolean> {
  return (await Mesh.privileged(Membership).read({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" } }, limit: 1 })).length === 0;
}

/**
 * `membership.last-owner` (`memberships/rules.ex:19-45`): a change that takes away an owner is refused when the
 * workspace has no other active owner. `losesOwner` says whether this change takes one away.
 */
export async function keepsAnOwnerOf(losesOwner: boolean): Promise<boolean> {
  if (!losesOwner) return true;
  return (await Mesh.privileged(Membership).read({ filter: { role: { eq: "owner" }, state: { eq: "active" } }, limit: 2 })).length > 1;
}

/** `membership.last-owner` for `collaborator.retire`: the collaborator's active membership is the owner one. */
export async function retireKeepsAnOwnerOf(collaboratorId: string): Promise<boolean> {
  const owner = await Mesh.privileged(Membership).read({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" }, role: { eq: "owner" } }, limit: 1 });
  return keepsAnOwnerOf(owner.length > 0);
}

/** `collaborator.name-unique` (`collaborators/collaborator/rules.ex:9-20`): no other active collaborator has the name. */
export async function nameFreeOf(name: string, exceptId?: string | null): Promise<boolean> {
  const same = await Mesh.privileged(Collaborator).read({ filter: { name: { eq: name }, state: { eq: "active" } } });
  return same.every((collaborator) => collaborator.id === exceptId);
}
