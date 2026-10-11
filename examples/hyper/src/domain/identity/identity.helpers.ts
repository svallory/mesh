// Helpers for the identity entity files and the identity functions: reads through `tx`, the reads of the running
// transaction, each named after the Hyper rule it follows.
import type { Role } from "../../context";
import type { Reads } from "../work/work.helpers";

/**
 * The role of the collaborator's active membership, or null when it has none (`checks/role.ex:33-38`). The write
 * policies read it here, through `tx`, inside the transaction: a membership revoked a moment ago is refused on the
 * next write (ADR-0074).
 */
export async function roleOf(tx: Reads, collaboratorId: string): Promise<Role | null> {
  const [membership] = await tx.readMembership({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" } }, limit: 1 });
  return membership?.role ?? null;
}

/** Policy `isMember`, the spec's `membership` (`checks/role.ex:24`, PROTOCOL.md:246): the collaborator has an active membership. */
export async function memberOf(tx: Reads, collaboratorId: string): Promise<boolean> {
  return (await roleOf(tx, collaboratorId)) !== null;
}

/**
 * Policies `ownerOrMember` and `ownerOnly`, the spec's `role` (`checks/role.ex:21`, `:25`, PROTOCOL.md:247): the
 * active membership's role is one of `roles`. A collaborator with no membership fails it too (fail closed); `isMember`
 * names that case, and the spec accepts the extra failure (PROTOCOL.md:114).
 */
export async function roleIn(tx: Reads, collaboratorId: string, roles: readonly Role[]): Promise<boolean> {
  const role = await roleOf(tx, collaboratorId);
  return role !== null && roles.includes(role);
}

/** `collaborator.active` on another collaborator (`collaborators/rules.ex:9-22`): it exists and is not retired. */
export async function collaboratorActiveOf(tx: Reads, collaboratorId: string): Promise<boolean> {
  const [collaborator] = await tx.readCollaborator({ filter: { id: { eq: collaboratorId } } });
  return collaborator?.state === "active";
}

/** `assignment.assignee-role` (`tasks/task/rules.ex:107-116`): the active membership's role is owner or member. */
export async function assignableOf(tx: Reads, collaboratorId: string): Promise<boolean> {
  const memberships = await tx.readMembership({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" } } });
  return memberships.some((membership) => membership.role === "owner" || membership.role === "member");
}

/** `membership.none-active` (`memberships/membership/rules.ex:9-15`): the collaborator has no active membership. */
export async function noActiveMembershipOf(tx: Reads, collaboratorId: string): Promise<boolean> {
  return (await tx.readMembership({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" } }, limit: 1 })).length === 0;
}

/**
 * `membership.last-owner` (`memberships/rules.ex:19-45`): a change that takes away an owner is refused when the
 * workspace has no other active owner. `losesOwner` says whether this change takes one away.
 */
export async function keepsAnOwnerOf(tx: Reads, losesOwner: boolean): Promise<boolean> {
  if (!losesOwner) return true;
  return (await tx.readMembership({ filter: { role: { eq: "owner" }, state: { eq: "active" } }, limit: 2 })).length > 1;
}

/** `membership.last-owner` for `collaborator.retire`: the collaborator's active membership is the owner one. */
export async function retireKeepsAnOwnerOf(tx: Reads, collaboratorId: string): Promise<boolean> {
  const owner = await tx.readMembership({ filter: { collaboratorId: { eq: collaboratorId }, state: { eq: "active" }, role: { eq: "owner" } }, limit: 1 });
  return keepsAnOwnerOf(tx, owner.length > 0);
}

/** `collaborator.name-unique` (`collaborators/collaborator/rules.ex:9-20`): no other active collaborator has the name. */
export async function nameFreeOf(tx: Reads, name: string, exceptId?: string | null): Promise<boolean> {
  const same = await tx.readCollaborator({ filter: { name: { eq: name }, state: { eq: "active" } } });
  return same.every((collaborator) => collaborator.id === exceptId);
}
