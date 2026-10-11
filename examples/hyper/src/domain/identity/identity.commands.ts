// The identity commands whose effects cross aggregates: revoking a membership or retiring a collaborator revokes
// the collaborator's claims, which belong to the Task aggregate (`tasks.ex:2`), and retiring also revokes the
// membership, its own aggregate (`memberships.ex:2`). Each is one application transaction over the generated actions.
// Names follow Hyper's method names in camelCase, so none can be a generated action function (those put the action first).
import type { ActionContext } from "@meshfw/runtime";
import type { Actions } from "#mesh";
import type { Collaborator, Membership, RetireCollaboratorInput, RevokeMembershipInput } from "#mesh/domain/identity";
import { nested } from "../../context";
import { connected, type Binding } from "../binding";
import type { Reads } from "../work/work.helpers";

/**
 * Revoke every active claim `holderId` holds, a lapsed one included, each through `revokeClaim`, which bumps its
 * Task's version (`tasks/claim/changes/end_claim.ex:15-21`, `revoke_all`). Each is a nested call (`system`): the
 * actor's permission was decided on the command, as Hyper's `nested_opts` skips the claims' policies.
 */
async function revokeHeldClaims(actions: Actions, tx: Reads, holderId: string, reason: string, context: ActionContext): Promise<void> {
  for (const claim of await tx.readClaim({ filter: { holderId: { eq: holderId }, state: { eq: "active" } } }))
    await actions.revokeClaim({ id: claim.id, reason }, nested(context));
}

/** `membership.revoke`: `revokeMembership`, then the collaborator's claims (`memberships/membership/changes/revoke_claims.ex:11-15`). */
export async function membershipRevoke(input: RevokeMembershipInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly membership: Membership }> {
  return binding.transaction(async ({ actions, tx }) => {
    const membership = await actions.revokeMembership(input);
    await revokeHeldClaims(actions, tx, membership.collaboratorId, "membership revoked", context);
    return { membership };
  }, context);
}

/**
 * `collaborator.retire`: `retireCollaborator`, then its active membership through `membershipRevoke`, then any claim
 * still held, as when it had no membership (`collaborators/collaborator/changes/revoke_memberships.ex:11-20`). The
 * revocations are nested calls (`system`), as in Hyper.
 */
export async function collaboratorRetire(input: RetireCollaboratorInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly collaborator: Collaborator }> {
  return binding.transaction(async ({ actions, tx }) => {
    const collaborator = await actions.retireCollaborator(input);
    const [membership] = await tx.readMembership({ filter: { collaboratorId: { eq: collaborator.id }, state: { eq: "active" } }, limit: 1 });
    if (membership) await membershipRevoke({ id: membership.id, reason: "collaborator retired" }, nested(context), binding);
    await revokeHeldClaims(actions, tx, collaborator.id, "collaborator retired", context);
    return { collaborator };
  }, context);
}
