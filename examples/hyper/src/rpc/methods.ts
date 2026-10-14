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
import { Task } from "#mesh/domain/work";
import { connected } from "../domain/binding";
import { collaboratorRetire, membershipRevoke } from "../domain/identity/identity.commands";
import { notServed, rpcErrorOf } from "./errors";
import { params } from "./params";
import { existingCollaborator, existingTask, membershipOf, requireId, theWorkspace } from "./resolve";
import { collaboratorView, membershipView, taskView, workspaceView } from "./views";

/** A copy of `value` without its `undefined` members: an action reads a member input that is present as one that was sent. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as never;
}

/** Runs `body` in one transaction, and answers what it throws with the spec's error when it has one (`rpcErrorOf`). */
async function inTransaction<R>(context: ActionContext, body: () => Promise<R>): Promise<R> {
  try {
    return await transaction(body);
  } catch (error) {
    throw rpcErrorOf(error, context) ?? error;
  }
}

/** A command (PROTOCOL.md:73-91): its params schema, and what it does, which returns the records of its result. */
function command<S extends z.ZodType, R extends object>(schema: S, run: (params: z.output<S>, context: ActionContext) => Promise<R>): Method<ActionContext, any> {
  return {
    params: schema,
    run: async (sent, context) => ({ events: [], ...(await inTransaction(context, () => run(sent as z.output<S>, context))) }),
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
const notYet = notImplemented("the work methods are not served yet");

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
  "task.update": notYet,
  "task.set-priority": notYet,
  "task.move": notYet,
  "task.complete": notYet,
  "task.cancel": notYet,
  "task.reopen": notYet,
  "task.assign": notYet,
  "task.unassign": notYet,
  "dependency.add": notYet,
  "dependency.remove": notYet,
  "claim.acquire": notYet,
  "claim.renew": notYet,
  "claim.release": notYet,
  "claim.revoke": notYet,
  "submission.submit": notYet,
  "submission.withdraw": notYet,
  "review.accept": notYet,
  "review.return": notYet,
  "evidence-reference.record": notYet,

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
  "task.get": notYet,
  "task.list": notYet,
  "task.next": notYet,
  "events.read": needsTheEventLog,
  "events.subscribe": needsTheEventLog,
  "events.unsubscribe": needsTheEventLog,
};
