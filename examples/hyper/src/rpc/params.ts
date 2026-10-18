// The parameters of each method the engine serves, as zod schemas. They mirror the spec's `Methods`
// (`conformance/schemas/protocol.ts:376-705`, copied from the spec at commit `ccc00f9`), written by hand; the
// conformance cases check the mirror. A schema keeps the spec's field names: the methods in `methods.ts` turn them into
// the inputs of the port's actions.
import { z } from "zod";

/** An engine-generated identifier (`Id`). Clients never parse it, so any non-empty string is well formed. */
const Id = z.string().min(1);
const NonEmpty = z.string().min(1);
const Role = z.enum(["owner", "member", "guest"]);
const CollaboratorKind = z.enum(["human", "agent"]);
const Reason = z.string().optional();
const Fence = z.number().int().min(1);
const Evidence = z.array(Id);
const StoredTaskState = z.enum(["open", "done", "canceled"]);

/** The fields every command carries beside its payload (`PROTOCOL.md:73-91`). */
const envelope = {
  commandId: z.string().min(1).max(200),
  actor: Id,
  caller: NonEmpty,
  expectedVersion: z.number().int().min(1).optional(),
};

/** A command's params: the envelope, and `payload`, an object (`{}` when the command has no fields). */
const command = <P extends z.ZodRawShape>(payload: P) => z.object({ ...envelope, payload: z.object(payload) });

/** A query's params (`schemas/protocol.ts`, `QueryParams`): the actor, the caller and the query's own fields, with no payload. */
const query = <P extends z.ZodRawShape>(fields: P) => z.object({ actor: Id, caller: NonEmpty, ...fields });

export const params = {
  "workspace.create": command({ name: z.string().optional() }),
  "workspace.rename": command({ name: NonEmpty }),
  "collaborator.register": command({ kind: CollaboratorKind, name: NonEmpty }),
  "collaborator.update": command({ collaboratorId: Id, name: NonEmpty.optional(), kind: CollaboratorKind.optional() }),
  "collaborator.retire": command({ collaboratorId: Id, reason: Reason }),
  "membership.grant": command({ collaboratorId: Id, role: Role }),
  "membership.change-role": command({ collaboratorId: Id, role: Role }),
  "membership.revoke": command({ collaboratorId: Id, reason: Reason }),
  "task.create": command({
    title: NonEmpty,
    intent: z.string().nullable().optional(),
    parentId: Id.nullable().optional(),
    priority: z.number().int().nullable().optional(),
  }),
  "task.update": command({ taskId: Id, title: NonEmpty.optional(), intent: z.string().nullable().optional() }),
  "task.set-priority": command({ taskId: Id, priority: z.number().int().nullable() }),
  "task.move": command({ taskId: Id, parentId: Id.nullable() }),
  "task.complete": command({ taskId: Id, fence: Fence.optional(), summary: NonEmpty.optional(), evidence: Evidence.optional() }),
  "task.cancel": command({ taskId: Id, reason: NonEmpty }),
  "task.reopen": command({ taskId: Id, reason: NonEmpty }),
  "task.assign": command({ taskId: Id, assigneeId: Id, waiveReview: z.boolean().optional() }),
  "task.unassign": command({ taskId: Id, reason: Reason }),
  "dependency.add": command({ dependentId: Id, prerequisiteId: Id }),
  "dependency.remove": command({ dependentId: Id, prerequisiteId: Id, reason: Reason }),
  "claim.acquire": command({ taskId: Id }),
  "claim.renew": command({ taskId: Id, fence: Fence }),
  "claim.release": command({ taskId: Id, fence: Fence, reason: Reason }),
  "claim.revoke": command({ taskId: Id, reason: NonEmpty }),
  "submission.submit": command({ taskId: Id, fence: Fence, summary: NonEmpty, evidence: Evidence.optional() }),
  "submission.withdraw": command({ submissionId: Id, reason: Reason }),
  "review.accept": command({ submissionId: Id }),
  "review.return": command({ submissionId: Id, reasons: NonEmpty }),
  "evidence-reference.record": command({ kind: NonEmpty, locator: NonEmpty, contentHash: z.string().optional(), description: z.string().optional() }),
  "task.get": query({ taskId: Id }),
  "task.list": query({ parentId: Id.nullable().optional(), state: StoredTaskState.optional() }),
  "task.next": query({}),
  "events.read": query({
    after: z.number().int().min(0),
    limit: z.number().int().min(1).max(1000).optional(),
    taskSubtree: Id.optional(),
    types: z.array(NonEmpty).optional(),
  }),
  "events.subscribe": query({ after: z.number().int().min(0), taskSubtree: Id.optional(), types: z.array(NonEmpty).optional() }),
  "events.unsubscribe": z.object({ subscriptionId: Id }),
} as const;
