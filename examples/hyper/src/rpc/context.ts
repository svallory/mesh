// The context each call runs with (PORTING.md "Permissions"): HA reads the actor and the role of its
// active membership from the database when the call comes in, and never takes either from the request.
import type { Call } from "@meshfw/jsonrpc";
import type { ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { Collaborator, Membership } from "#mesh/domain/identity";
import { notServed, rejection, specCodes } from "./errors";
import { commandHash, idempotencyConflict, storedCommand } from "./idempotency";
import { isId } from "./resolve";

/** The engine's own collaborator id: the actor of what the engine does by itself (bootstrap), never a stored row. */
export const ENGINE_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The engine's context (ADR-0071): `system`, so every policy admits it. It runs bootstrap and the two methods that take
 * no actor (`actorless` in `src/rpc/methods.ts`), never a method that names one.
 */
export const ENGINE: ActionContext = Object.freeze({ actor: Object.freeze({ id: ENGINE_ID, role: null }), system: true, caller: "engine" });

/** The engine's context while it runs `rule` on its own (PROTOCOL.md:48, 178): every event it publishes names the rule as its cause. */
export function engineRule(rule: string, context: ActionContext = ENGINE): ActionContext {
  return Object.freeze({ ...context, rule });
}

/** The `-32001 permission_denied` of an actor that has no active membership (PROTOCOL.md:246). */
function noMembership(reason: string) {
  return rejection(specCodes.permissionDenied, "permission", [{ check: "membership", reason }]);
}

/**
 * The context factory `serve` calls for each request whose params passed their schema. A method in `unserved` (method
 * name to reason, from `unserved` in `src/rpc/methods.ts`) is answered `-32010` first, before anything is read, so it
 * never runs with any context. A method named in `actorless` gets the engine's context. Every other call names its
 * actor: an unknown or retired collaborator, or one with no active membership, is refused before the method runs, with
 * the spec's `membership` check, which also closes the gap (a non-member could otherwise tell a missing record
 * from a hidden one).
 *
 * `leaseMs` (`--lease-ms`) goes on every context the factory returns, the engine's included, so Claim `acquire` and
 * `renew` read it (`ActionContext.leaseMs`, gap G34); left out, the contexts carry none and the lease is `LEASE_MS`.
 */
export function contextFactory(actorless: ReadonlySet<string>, unserved: ReadonlyMap<string, string>, leaseMs?: number) {
  const lease = leaseMs === undefined ? {} : { leaseMs };
  const engine: ActionContext = leaseMs === undefined ? ENGINE : Object.freeze({ ...ENGINE, leaseMs });
  return async (call: Call, params: unknown): Promise<ActionContext> => {
    const why = unserved.get(call.method);
    if (why !== undefined) throw notServed(call.method, why);
    if (actorless.has(call.method)) return engine;
    const { actor, caller, commandId } = params as { readonly actor: string; readonly caller: string; readonly commandId?: string };
    const command = commandId === undefined ? {} : { commandId, method: call.method };
    if (commandId !== undefined) {
      // The idempotency check is in the shape phase, ahead of the permission phase (PROTOCOL.md §4.4): a reused
      // commandId with other params is refused before the actor is looked at, and a repeat of a committed command gets
      // its stored result (the method returns it) even when the actor could no longer send it.
      const stored = await storedCommand(commandId);
      if (stored !== undefined) {
        if (stored.hash !== commandHash(call.method, call.params)) throw idempotencyConflict(commandId, call.method);
        return { actor: { id: actor, role: null }, caller, ...command, ...lease };
      }
    }
    const [collaborator] = isId(actor) ? await Mesh.privileged(Collaborator).read({ filter: { id: { eq: actor } }, limit: 1 }) : [];
    if (!collaborator) throw noMembership(`no collaborator with id ${actor}; register it, and have an owner grant it a membership`);
    if (collaborator.state !== "active") throw noMembership(`collaborator ${actor} is retired and can no longer act`);
    const [membership] = await Mesh.privileged(Membership).read({ filter: { collaboratorId: { eq: actor }, state: { eq: "active" } }, limit: 1 });
    if (!membership) throw noMembership(`collaborator ${actor} has no active membership; an owner can grant one`);
    return { actor: { id: actor, role: membership.role }, caller, ...command, ...lease };
  };
}
