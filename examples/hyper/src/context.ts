import "@meshfw/runtime";
import type { ActionContext } from "@meshfw/runtime";

/** A membership's role (PROTOCOL.md §9, `memberships/membership.ex`). */
export type Role = "owner" | "member" | "guest";

declare module "@meshfw/runtime" {
  interface ActionContext {
    /**
     * The collaborator the call acts for, and the role of its active membership (`null` when it has none), which the
     * application reads when the call comes in, as Hyper's router resolves the actor (`transport/router.ex:102-120`).
     * HA, the socket server, reads both from the database at call entry, refuses an unknown or retired actor there,
     * and never copies them from the request's payload. Only the read policies (`membersRead`) use
     * `role`: a write policy reads the role through `Mesh.privileged`, inside the transaction, so a membership revoked a
     * moment ago is refused on the next write (ADR-0074); it never reads `actor.role`.
     */
    actor: { id: string; role: Role | null };
    /** The command a call belongs to; the application sets it, and the seams (`afterWrite`) see it on every write of the call, nested ones included. */
    commandId?: string;
    /** Who sent the command (a surface or a plugin name); reaches the seams like `commandId`. */
    caller?: string;
    /**
     * Set only by `review.accept` on its nested `task.complete`, as Hyper's engine passes the completion through
     * the changeset context (`tasks/review/changes/review.ex:25-31`): the Completion then records rule
     * `review-accepted` and names the accepted submission. Task `complete` refuses a call that sets it without
     * `system` (policy `reviewCompletion`), and reads the submission through `Mesh.privileged` and throws a
     * `FrameworkError` unless it is an accepted submission of that Task that no completion names yet
     * (`acceptedSubmissionOf` in `src/domain/work/work.helpers.ts`).
     */
    completion?: { readonly rule: "review-accepted"; readonly submissionId: string };
    /**
     * The claim lease in milliseconds (`--lease-ms`, PROTOCOL.md:33), which Claim `acquire` and `renew` add to the
     * time they run at (`leaseEnd` in `src/domain/work/work.helpers.ts`), as Hyper reads `lease_ms` from its
     * configuration (`tasks/claim/changes/lease.ex:24-25`; gap G34). The daemon's context factory sets it on every
     * call; a context without it gets the default lease, `LEASE_MS`.
     */
    leaseMs?: number;
    /**
     * The method of the command a call belongs to (`task.create`); the daemon's context factory sets it with
     * `commandId`, and every event the call publishes names both as its cause (PROTOCOL.md §4.2, `metadata` in
     * `src/events.ts`).
     */
    method?: string;
    /**
     * The engine rule a call runs for, when the engine acts on its own: `workspace.bootstrap` for bootstrap and
     * `claim.lease-expiry` for the lease sweeper (PROTOCOL.md:48, 178). Every event such a call publishes is recorded
     * with actor and caller `engine` and the cause `{ kind: "rule", rule }`.
     */
    rule?: string;
  }
}

/**
 * The context of a nested call: the caller's, with `system` set (ADR-0071). Hyper authorizes only the command the
 * actor sent and runs every nested call with `authorize?: false` (`pipeline/changes.ex:26-31`); each policy of the
 * port admits such a call through `Mesh.isSystem(context)`, and the actor stays on the context for what the call records.
 */
export function nested(context: ActionContext): ActionContext {
  return { ...context, system: true };
}
