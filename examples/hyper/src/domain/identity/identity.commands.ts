// The identity commands whose effects cross aggregates: revoking a membership or retiring a collaborator revokes
// the collaborator's claims, which belong to the Task aggregate (`tasks.ex:2`), and retiring also revokes the
// membership, its own aggregate (`memberships.ex:2`). Each is one application transaction over the generated actions.
// Names follow Hyper's method names in camelCase (`membership.revoke` is `membershipRevoke`); a generated action is a
// method of the entity's value (`Membership.revoke`, from `#mesh/domain/identity`).
import type { ActionContext } from "@meshfw/runtime";
import { privileged } from "#mesh";
import { Collaborator, Membership, type RetireCollaboratorInput, type RevokeMembershipInput } from "#mesh/domain/identity";
import { Claim } from "#mesh/domain/work";
import { nested } from "../../context";
import { connected, type Binding } from "../binding";

/**
 * Revoke every active claim `holderId` holds, a lapsed one included, each through `Claim.revoke`, which bumps its
 * Task's version (`tasks/claim/changes/end_claim.ex:15-21`, `revoke_all`). Each is a nested call (`system`): the
 * actor's permission was decided on the command, as Hyper's `nested_opts` skips the claims' policies.
 */
async function revokeHeldClaims(holderId: string, reason: string, context: ActionContext): Promise<void> {
  for (const claim of await privileged(Claim).read({ filter: { holderId: { eq: holderId }, state: { eq: "active" } } }))
    await Claim.revoke({ id: claim.id, reason }, nested(context));
}

/** `membership.revoke`: `Membership.revoke`, then the collaborator's claims (`memberships/membership/changes/revoke_claims.ex:11-15`). */
export async function membershipRevoke(input: RevokeMembershipInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly membership: Membership }> {
  return binding.transaction(async () => {
    const membership = await Membership.revoke(input, context);
    await revokeHeldClaims(membership.collaboratorId, "membership revoked", context);
    return { membership };
  });
}

/**
 * `collaborator.retire`: `Collaborator.retire`, then its active membership through `membershipRevoke`, then any claim
 * still held, as when it had no membership (`collaborators/collaborator/changes/revoke_memberships.ex:11-20`). The
 * revocations are nested calls (`system`), as in Hyper.
 */
export async function collaboratorRetire(input: RetireCollaboratorInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly collaborator: Collaborator }> {
  return binding.transaction(async () => {
    const collaborator = await Collaborator.retire(input, context);
    const [membership] = await privileged(Membership).read({ filter: { collaboratorId: { eq: collaborator.id }, state: { eq: "active" } }, limit: 1 });
    if (membership) await membershipRevoke({ id: membership.id, reason: "collaborator retired" }, nested(context), binding);
    await revokeHeldClaims(collaborator.id, "collaborator retired", context);
    return { collaborator };
  });
}
