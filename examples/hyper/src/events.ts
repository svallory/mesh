// The events module (`events.load` in `mesh.config.ts`; spec, Events and commands, "What Hyper needs"): the `metadata`
// each event is stored with, and the mapping from a stored event to the spec's wire `Event` (PROTOCOL.md §6,
// `schemas/protocol.ts`, `Event`). Mesh fills the envelope (`id`, `position`, `occurredAt`); this module adds what the
// spec's envelope holds beyond it: who acted and for what (`actor`, `caller`, `cause`), the aggregate root the event
// changed and its version after the change (`record`), and the Task the event concerns (`taskId`).
import type { ActionContext, EventMetadata } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import type { EventRecord, MetadataFunction } from "#mesh";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Assignment, Claim, Completion, EvidenceReference, LateResult, Submission, Task } from "#mesh/domain/work";

/** The actor and caller of what the engine does on its own (`ENGINE_ACTOR` in `schemas/protocol.ts`). */
const ENGINE_ACTOR = "engine";

/** The rule that expires a claim (PROTOCOL.md:312): `claim.expired` names it as its cause, whoever noticed the expiry. */
const LEASE_EXPIRY = "claim.lease-expiry";

/** The aggregate types the wire's `record.type` takes (`RecordType` in `schemas/protocol.ts`). */
export type RecordType = "workspace" | "collaborator" | "membership" | "task" | "evidence-reference";

/** Why an event happened (`Cause` in `schemas/protocol.ts`). */
export type Cause =
  | { readonly kind: "command"; readonly commandId: string; readonly method: string }
  | { readonly kind: "event"; readonly eventId: string }
  | { readonly kind: "rule"; readonly rule: string };

declare module "@meshfw/runtime" {
  /** What `metadata` below stores with every event: the spec's envelope fields that Mesh's own envelope lacks. */
  interface EventMetadata {
    readonly actor: string;
    readonly caller: string;
    readonly cause: Cause;
    readonly schemaVersion: number;
    readonly record: { readonly type: RecordType; readonly id: string; readonly version: number };
    readonly taskId: string | null;
  }
}

/** Each event's wire type (`EventPayloads` in `schemas/protocol.ts`), by the FQN of its class. */
export const WIRE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "identity.WorkspaceCreated": "workspace.created",
  "identity.WorkspaceRenamed": "workspace.renamed",
  "identity.CollaboratorRegistered": "collaborator.registered",
  "identity.CollaboratorUpdated": "collaborator.updated",
  "identity.CollaboratorRetired": "collaborator.retired",
  "identity.MembershipGranted": "membership.granted",
  "identity.MembershipRoleChanged": "membership.role-changed",
  "identity.MembershipRevoked": "membership.revoked",
  "work.TaskCreated": "task.created",
  "work.TaskUpdated": "task.updated",
  "work.TaskPrioritySet": "task.priority-set",
  "work.TaskMoved": "task.moved",
  "work.TaskCompleted": "task.completed",
  "work.TaskCanceled": "task.canceled",
  "work.TaskReopened": "task.reopened",
  "work.AssignmentStarted": "assignment.started",
  "work.AssignmentEnded": "assignment.ended",
  "work.DependencyAdded": "dependency.added",
  "work.DependencyRemoved": "dependency.removed",
  "work.ClaimAcquired": "claim.acquired",
  "work.ClaimRenewed": "claim.renewed",
  "work.ClaimReleased": "claim.released",
  "work.ClaimRevoked": "claim.revoked",
  "work.ClaimExpired": "claim.expired",
  "work.ClaimLateResultRecorded": "claim.late-result-recorded",
  "work.SubmissionSubmitted": "submission.submitted",
  "work.SubmissionWithdrawn": "submission.withdrawn",
  "work.ReviewAccepted": "review.accepted",
  "work.ReviewReturned": "review.returned",
  "work.EvidenceReferenceRecorded": "evidence-reference.recorded",
});

/** Each wire type's FQN: what `events.read` and `events.subscribe` turn their `types` filter into. */
export const FQN_OF_WIRE_TYPE: ReadonlyMap<string, string> = new Map(Object.entries(WIRE_TYPES).map(([fqn, type]) => [type, fqn]));

/** The one row a read returned, or an error naming what was not found (`what` and `id`). */
async function one<R>(rows: Promise<readonly R[]>, what: string, id: string): Promise<R> {
  const [row] = await rows;
  if (row === undefined) throw new Error(`the event's ${what} ${id} was not found in the publishing transaction`);
  return row;
}

/** The Task `id` and its version as the publishing transaction sees it. */
async function taskRecord(id: string) {
  const task = await one(Mesh.privileged(Task).read({ filter: { id: { eq: id } }, limit: 1 }), "Task", id);
  return { record: { type: "task" as const, id, version: task.version }, taskId: id };
}

/**
 * The aggregate root an event changed, its version after the change and the Task it concerns, from the publishing
 * entity and the record's key (PROTOCOL.md §4.5: the Task aggregate holds its assignments, dependencies as dependent,
 * claims, submissions, reviews and completions; a late result belongs to it without changing it). A Dependency is
 * found through its payload, since `dependency.remove` destroys the row before it publishes.
 */
async function recordOf(event: Parameters<MetadataFunction>[0]["event"]): Promise<Pick<EventMetadata, "record" | "taskId">> {
  const id = String((event.key as { id?: unknown }).id);
  const payload = event.payload as unknown as Record<string, unknown>;
  const byId = { filter: { id: { eq: id } }, limit: 1 } as const;
  switch (event.entity) {
    case "work.Task":
      return taskRecord(id);
    case "work.Claim":
      return taskRecord((await one(Mesh.privileged(Claim).read(byId), "Claim", id)).taskId);
    case "work.Assignment":
      return taskRecord((await one(Mesh.privileged(Assignment).read(byId), "Assignment", id)).taskId);
    case "work.Submission":
      return taskRecord((await one(Mesh.privileged(Submission).read(byId), "Submission", id)).taskId);
    case "work.Completion":
      return taskRecord((await one(Mesh.privileged(Completion).read(byId), "Completion", id)).taskId);
    case "work.LateResult":
      return taskRecord((await one(Mesh.privileged(LateResult).read(byId), "LateResult", id)).taskId);
    case "work.Review": {
      const submissionId = String(payload.submissionId);
      const submission = await one(Mesh.privileged(Submission).read({ filter: { id: { eq: submissionId } }, limit: 1 }), "Submission", submissionId);
      return taskRecord(submission.taskId);
    }
    case "work.Dependency":
      return taskRecord(String(payload.dependentId));
    case "identity.Workspace": {
      const workspace = await one(Mesh.privileged(Workspace).read(byId), "Workspace", id);
      return { record: { type: "workspace", id, version: workspace.version }, taskId: null };
    }
    case "identity.Collaborator": {
      const collaborator = await one(Mesh.privileged(Collaborator).read(byId), "Collaborator", id);
      return { record: { type: "collaborator", id, version: collaborator.version }, taskId: null };
    }
    case "identity.Membership": {
      const membership = await one(Mesh.privileged(Membership).read(byId), "Membership", id);
      return { record: { type: "membership", id, version: membership.version }, taskId: null };
    }
    case "work.EvidenceReference":
      // An evidence reference is never changed once recorded, so it stays at version 1 (PROTOCOL.md §4.5).
      await one(Mesh.privileged(EvidenceReference).read(byId), "EvidenceReference", id);
      return { record: { type: "evidence-reference", id, version: 1 }, taskId: null };
    default:
      throw new Error(`no aggregate is known for an event published by ${event.entity}`);
  }
}

/** Who an event is recorded as acting for, and why it happened. */
function causeOf(name: string, context: Readonly<ActionContext>): Pick<EventMetadata, "actor" | "caller" | "cause"> {
  // An expiry is the engine's rule whoever noticed it (PROTOCOL.md:312): the sweeper, or a command that ends a lapsed claim.
  const rule = name === "work.ClaimExpired" ? LEASE_EXPIRY : context.rule;
  if (rule !== undefined) return { actor: ENGINE_ACTOR, caller: ENGINE_ACTOR, cause: { kind: "rule", rule } };
  if (context.commandId === undefined || context.method === undefined)
    throw new Error(`an event (${name}) was published by a call that is neither a command (commandId and method) nor an engine rule`);
  return {
    actor: context.actor.id,
    caller: context.caller ?? ENGINE_ACTOR,
    cause: { kind: "command", commandId: context.commandId, method: context.method },
  };
}

/**
 * The project's metadata function: runs in the publishing transaction, once per `publish`. It stores who acted
 * (`actor` and `caller`, verbatim: PROTOCOL.md §4.1), the cause (the command, or the engine's rule), and the aggregate
 * root with its version as the transaction sees it at the publish, so a command that changes the Task twice records
 * the version each event left it at.
 */
export const metadata: MetadataFunction = async ({ event, context }) => ({
  ...causeOf(event.name, context),
  schemaVersion: 1,
  ...(await recordOf(event)),
});

/** The spec's wire `Event` (`schemas/protocol.ts`, `Event`). */
export interface WireEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly record: { readonly type: RecordType; readonly id: string; readonly version: number };
  readonly taskId: string | null;
  readonly actor: string;
  readonly caller: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly cause: Cause;
  readonly payload: unknown;
}

/**
 * An event as the wire carries it. `seq` is the outbox position, gapless from 1 (the bus and the data adapter declare
 * `gapless-positions`); `recordedAt` is the publishing transaction's instant, as `occurredAt` is, since the event is
 * recorded in the transaction that makes it. `workspaceId` is the one workspace's id, passed in: it is not stored with
 * the event, since bootstrap publishes `collaborator.registered` (seq 1) before the workspace exists. Dates in the
 * payload become RFC 3339 strings. `checks` is left out: no hook check runs in this slice.
 */
export function toWire(record: EventRecord, workspaceId: string): WireEvent {
  const type = WIRE_TYPES[record.name];
  if (type === undefined) throw new Error(`the event ${record.name} has no wire type`);
  const { actor, caller, cause, schemaVersion, record: root, taskId } = record.metadata;
  const at = record.occurredAt.toISOString();
  return {
    id: record.id,
    seq: record.position,
    type,
    schemaVersion,
    workspaceId,
    record: root,
    taskId,
    actor,
    caller,
    occurredAt: at,
    recordedAt: at,
    cause,
    payload: JSON.parse(JSON.stringify(record.payload)),
  };
}
