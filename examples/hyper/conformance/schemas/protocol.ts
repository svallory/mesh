/**
 * Hyper engine wire protocol, v0 — the source of truth for every method's
 * params and result, and every event payload.
 *
 * Written with TypeBox: each definition *is* a JSON Schema object, and the
 * TypeScript types are inferred from it (`Static<typeof X>`). `bun run schemas`
 * writes the JSON Schema bundle to `schemas/protocol.schema.json` for engines
 * that are not written in TypeScript. Never edit the JSON by hand.
 *
 * Prose rules live in PROTOCOL.md; this file defines shapes only.
 */
import { type Static, type TSchema, Type as T } from "@sinclair/typebox";

export const PROTOCOL_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Opaque, engine-generated identifier. Clients never parse it. */
export const Id = T.String({ minLength: 1, $id: "Id" });
/** RFC 3339 timestamp with milliseconds, UTC (`2026-09-23T21:00:00.000Z`). */
export const Timestamp = T.String({ format: "date-time", $id: "Timestamp" });
/** A record version: 1 on creation, +1 per command that changes the record. */
export const Version = T.Integer({ minimum: 1, $id: "Version" });
/** An event sequence number. The first event of a workspace has seq 1. */
export const Seq = T.Integer({ minimum: 1 });
/** A cursor: the last sequence number the client processed; 0 = from the beginning. */
export const Cursor = T.Integer({ minimum: 0 });
const Nullable = <S extends TSchema>(s: S) => T.Union([s, T.Null()]);
const NonEmpty = T.String({ minLength: 1 });

/** The reserved actor and caller for events the engine emits on its own (bootstrap, `claim.expired`). */
export const ENGINE_ACTOR = "engine";

export const Role = T.Union([T.Literal("owner"), T.Literal("member"), T.Literal("guest")]);
export const CollaboratorKind = T.Union([T.Literal("human"), T.Literal("agent")]);
export const StoredTaskState = T.Union([T.Literal("open"), T.Literal("done"), T.Literal("canceled")]);
export const DerivedTaskState = T.Union([
  T.Literal("ready"),
  T.Literal("blocked"),
  T.Literal("claimed"),
  T.Literal("in-review"),
  T.Literal("done"),
  T.Literal("canceled"),
]);
export const ClaimState = T.Union([
  T.Literal("active"),
  T.Literal("released"),
  T.Literal("expired"),
  T.Literal("revoked"),
]);
export const SubmissionState = T.Union([
  T.Literal("pending"),
  T.Literal("accepted"),
  T.Literal("returned"),
  T.Literal("withdrawn"),
]);
export const CompletionRule = T.Union([
  T.Literal("review-accepted"),
  T.Literal("performer-is-reviewer"),
  T.Literal("review-waived"),
]);
/** Which part of the reviewer rule named the reviewer (`domain/core/review.md#reviewer`). */
export const ReviewerRule = T.Union([
  T.Literal("parent-assignee"),
  T.Literal("parent-creator"),
  T.Literal("task-creator"),
]);
/** Revoking a membership or retiring a collaborator never ends an assignment (domain/core/assignment.md#attributes). */
export const AssignmentEndReason = T.Union([T.Literal("reassigned"), T.Literal("unassigned")]);
export const EvidenceKind = T.String({
  minLength: 1,
  description: "Core kinds: file, link, report, check-run, transcript. Kits may declare others (e.g. commit).",
});

// ---------------------------------------------------------------------------
// Record views (what queries and command results return)
// ---------------------------------------------------------------------------

export const Workspace = T.Object({
  id: Id,
  name: Nullable(T.String()),
  location: T.Union([T.Literal("local"), T.Literal("shared")]),
  state: T.Union([T.Literal("active"), T.Literal("moved")]),
  version: Version,
});

export const Collaborator = T.Object({
  id: Id,
  kind: CollaboratorKind,
  name: NonEmpty,
  state: T.Union([T.Literal("active"), T.Literal("retired")]),
  version: Version,
});

export const Membership = T.Object({
  id: Id,
  collaboratorId: Id,
  role: Role,
  state: T.Union([T.Literal("active"), T.Literal("revoked")]),
  grantedAt: Timestamp,
  grantedBy: Id,
  revokedAt: Nullable(Timestamp),
  revokedBy: Nullable(Id),
  version: Version,
});

/** Why a Task is not ready. `message` is the human reason ("blocked: waiting for T-12"). */
export const BlockReason = T.Object({
  kind: T.Union([
    T.Literal("dependency"), // prerequisite open
    T.Literal("prerequisite-canceled"),
    T.Literal("condition"), // a blocking-condition provider (another context)
  ]),
  taskId: T.Optional(Id),
  source: T.Optional(T.String({ description: "Provider name, for kind = condition" })),
  message: NonEmpty,
});

export const Assignment = T.Object({
  id: Id,
  taskId: Id,
  assigneeId: Id,
  delegatorId: Id,
  startedAt: Timestamp,
  endedAt: Nullable(Timestamp),
  endReason: Nullable(AssignmentEndReason),
  reviewWaived: T.Boolean(),
});

export const Claim = T.Object({
  id: Id,
  taskId: Id,
  holderId: Id,
  fence: T.Integer({ minimum: 1 }),
  acquiredAt: Timestamp,
  expiresAt: Timestamp,
  state: ClaimState,
  endedAt: Nullable(Timestamp),
  endReason: Nullable(T.String()),
});

export const Review = T.Object({
  id: Id,
  submissionId: Id,
  reviewerId: Id,
  decision: T.Union([T.Literal("accept"), T.Literal("return")]),
  reasons: Nullable(T.String()),
  ruleApplied: ReviewerRule,
  decidedAt: Timestamp,
});

export const Submission = T.Object({
  id: Id,
  taskId: Id,
  submitterId: Id,
  /** `null` only for a `task.complete` that carried evidence but no summary. */
  summary: Nullable(NonEmpty),
  evidence: T.Array(Id, { description: "Evidence reference IDs" }),
  taskVersion: Version,
  fence: Nullable(T.Integer({ minimum: 1 })),
  state: SubmissionState,
  submittedAt: Timestamp,
  review: Nullable(Review),
});

export const LateResult = T.Object({
  id: Id,
  taskId: Id,
  submitterId: Id,
  fence: T.Integer({ minimum: 1 }),
  /** `null` when the late result came from a `task.complete` without a summary. */
  summary: Nullable(NonEmpty),
  evidence: T.Array(Id),
  recordedAt: Timestamp,
});

export const Completion = T.Object({
  id: Id,
  taskId: Id,
  rule: CompletionRule,
  submissionId: Nullable(Id),
  completedBy: Id,
  completedAt: Timestamp,
});

export const Task = T.Object({
  id: Id,
  title: NonEmpty,
  intent: Nullable(T.String()),
  state: StoredTaskState,
  parentId: Nullable(Id),
  /** Higher ranks first. `null` ranks below every number. */
  priority: Nullable(T.Integer()),
  creatorId: Id,
  version: Version,
  createdAt: Timestamp,
  derived: T.Object({
    state: DerivedTaskState,
    /** Every current block reason, even when `state` is claimed or in-review. Empty when none. */
    reasons: T.Array(BlockReason),
  }),
  /** Prerequisite Task IDs (this Task depends on them). */
  dependsOn: T.Array(Id),
  assignment: Nullable(Assignment),
  activeClaim: Nullable(Claim),
  pendingSubmission: Nullable(Submission),
  /** The reviewer the rule names right now, and which part of the rule named it. */
  reviewer: T.Object({ collaboratorId: Id, rule: ReviewerRule }),
});

export const TaskHistory = T.Object({
  assignments: T.Array(Assignment),
  claims: T.Array(Claim),
  submissions: T.Array(Submission),
  lateResults: T.Array(LateResult),
  completions: T.Array(Completion),
});

export const EvidenceReference = T.Object({
  id: Id,
  kind: EvidenceKind,
  locator: NonEmpty,
  contentHash: Nullable(T.String()),
  description: Nullable(T.String()),
  recordedBy: Id,
  recordedAt: Timestamp,
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const RecordType = T.Union([
  T.Literal("workspace"),
  T.Literal("collaborator"),
  T.Literal("membership"),
  T.Literal("task"),
  T.Literal("evidence-reference"),
]);

export const Cause = T.Union([
  T.Object({ kind: T.Literal("command"), commandId: NonEmpty, method: NonEmpty }),
  T.Object({ kind: T.Literal("event"), eventId: Id }),
  T.Object({ kind: T.Literal("rule"), rule: NonEmpty, description: T.Optional(T.String()) }),
]);

/** A required hook check that passed, recorded on the event of the command it guarded. */
export const CheckRecord = T.Object({
  hook: NonEmpty,
  kit: NonEmpty,
  version: NonEmpty,
  policy: Nullable(T.String()),
  result: T.Literal("passed"),
});

const changes = T.Record(T.String(), T.Object({ old: T.Unknown(), new: T.Unknown() }), {
  description: "Changed field name -> { old, new }",
});

/** Payload schema per event type. */
export const EventPayloads = {
  "workspace.created": T.Object({ name: Nullable(T.String()), location: T.String(), firstOwnerId: Id }),
  "workspace.renamed": T.Object({ oldName: Nullable(T.String()), newName: T.String() }),
  "workspace.exported": T.Object({ bundle: T.String(), recordCounts: T.Record(T.String(), T.Integer()), checksums: T.Record(T.String(), T.String()) }),
  "workspace.moved": T.Object({ oldLocation: T.String(), newLocation: T.String() }),

  "collaborator.registered": T.Object({ kind: CollaboratorKind, name: NonEmpty }),
  "collaborator.updated": T.Object({ changes }),
  "collaborator.retired": T.Object({ reason: Nullable(T.String()) }),

  "membership.granted": T.Object({ collaboratorId: Id, role: Role, grantedBy: Id }),
  "membership.role-changed": T.Object({ collaboratorId: Id, oldRole: Role, newRole: Role }),
  "membership.revoked": T.Object({ collaboratorId: Id, reason: Nullable(T.String()), revokedBy: Id }),

  "task.created": T.Object({
    title: NonEmpty,
    intent: Nullable(T.String()),
    parentId: Nullable(Id),
    priority: Nullable(T.Integer()),
    creatorId: Id,
  }),
  "task.updated": T.Object({ changes }),
  "task.priority-set": T.Object({ oldPriority: Nullable(T.Integer()), newPriority: Nullable(T.Integer()) }),
  "task.moved": T.Object({ oldParentId: Nullable(Id), newParentId: Nullable(Id) }),
  "task.completed": T.Object({
    completionId: Id,
    rule: CompletionRule,
    submissionId: Nullable(Id),
    completedBy: Id,
  }),
  "task.canceled": T.Object({ reason: NonEmpty }),
  "task.reopened": T.Object({ reason: NonEmpty, fromState: T.Union([T.Literal("done"), T.Literal("canceled")]) }),

  "assignment.started": T.Object({
    assignmentId: Id,
    taskId: Id,
    assigneeId: Id,
    delegatorId: Id,
    reviewWaived: T.Boolean(),
  }),
  "assignment.ended": T.Object({
    assignmentId: Id,
    taskId: Id,
    formerAssigneeId: Id,
    endReason: AssignmentEndReason,
  }),

  "dependency.added": T.Object({ dependentId: Id, prerequisiteId: Id }),
  "dependency.removed": T.Object({ dependentId: Id, prerequisiteId: Id, reason: Nullable(T.String()) }),

  "claim.acquired": T.Object({ claimId: Id, taskId: Id, holderId: Id, fence: T.Integer(), expiresAt: Timestamp }),
  "claim.renewed": T.Object({ claimId: Id, fence: T.Integer(), expiresAt: Timestamp }),
  "claim.released": T.Object({ claimId: Id, fence: T.Integer(), endReason: NonEmpty }),
  "claim.revoked": T.Object({ claimId: Id, fence: T.Integer(), revokedBy: Id, reason: NonEmpty }),
  "claim.expired": T.Object({ claimId: Id, fence: T.Integer(), expiredAt: Timestamp }),
  "claim.late-result-recorded": T.Object({
    lateResultId: Id,
    fence: T.Integer(),
    submitterId: Id,
    summary: Nullable(NonEmpty),
    evidence: T.Array(Id),
  }),

  "submission.submitted": T.Object({
    submissionId: Id,
    taskId: Id,
    submitterId: Id,
    summary: Nullable(NonEmpty),
    evidence: T.Array(Id),
    taskVersion: Version,
    fence: Nullable(T.Integer()),
  }),
  "submission.withdrawn": T.Object({ submissionId: Id, reason: Nullable(T.String()) }),

  "review.accepted": T.Object({ reviewId: Id, submissionId: Id, reviewerId: Id, ruleApplied: ReviewerRule }),
  "review.returned": T.Object({ reviewId: Id, submissionId: Id, reviewerId: Id, reasons: NonEmpty }),

  "evidence-reference.recorded": T.Object({
    evidenceReferenceId: Id,
    kind: EvidenceKind,
    locator: NonEmpty,
    contentHash: Nullable(T.String()),
    description: Nullable(T.String()),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];

export const Event = T.Object({
  id: Id,
  seq: Seq,
  type: T.Union(EVENT_TYPES.map((t) => T.Literal(t))),
  schemaVersion: T.Integer({ minimum: 1 }),
  workspaceId: Id,
  /** The aggregate root the event changed, and its version after the change. */
  record: T.Object({ type: RecordType, id: Id, version: Version }),
  /** The Task the event concerns, for task-aggregate events; `null` otherwise. Used for subtree filters. */
  taskId: Nullable(Id),
  actor: NonEmpty,
  caller: NonEmpty,
  occurredAt: Timestamp,
  recordedAt: Timestamp,
  cause: Cause,
  /** Required hook checks that passed for the command that produced this event. Omitted when none ran. */
  checks: T.Optional(T.Array(CheckRecord)),
  payload: T.Unknown({ description: "See EventPayloads[type]" }),
});

// ---------------------------------------------------------------------------
// Command envelope
// ---------------------------------------------------------------------------

const envelopeFields = {
  /** Client-chosen. Repeating it with identical params returns the first result. */
  commandId: T.String({ minLength: 1, maxLength: 200 }),
  /** The collaborator ID on whose behalf the command acts. */
  actor: Id,
  /** The credential that sent it. Recorded verbatim on every event (no verification in this slice). */
  caller: NonEmpty,
  /** The target record's version the client last saw. */
  expectedVersion: T.Optional(Version),
};

const Command = <P extends TSchema>(payload: P) => T.Object({ ...envelopeFields, payload });
const QueryParams = <P extends Record<string, TSchema>>(fields: P) =>
  T.Object({ actor: Id, caller: NonEmpty, ...fields });

/** Every command result carries the events it committed, in seq order. */
const Result = <P extends Record<string, TSchema>>(fields: P) => T.Object({ events: T.Array(Event), ...fields });

const TaskRef = { taskId: Id };
/**
 * Unsatisfied dependencies at completion. Dependencies gate claiming, not completion: `task.complete` and
 * `review.accept` succeed and report each open or canceled prerequisite here (kinds `dependency` and
 * `prerequisite-canceled`). Empty when none.
 */
const Warnings = T.Array(BlockReason);
const Reason = T.Optional(T.String());

/**
 * Every method: its params and result schema, and for commands the record
 * `expectedVersion` is compared against ("target").
 */
export const Methods = {
  // --- Workspace ---------------------------------------------------------
  "workspace.create": {
    kind: "command",
    target: "workspace",
    params: Command(T.Object({ name: T.Optional(T.String()) })),
    result: Result({ workspace: Workspace }),
  },
  "workspace.rename": {
    kind: "command",
    target: "workspace",
    params: Command(T.Object({ name: NonEmpty })),
    result: Result({ workspace: Workspace }),
  },
  "workspace.export": {
    kind: "command",
    target: "workspace",
    params: Command(T.Object({})),
    result: Result({ bundle: T.String() }),
  },
  "workspace.move": {
    kind: "command",
    target: "workspace",
    params: Command(T.Object({ target: NonEmpty })),
    result: Result({ workspace: Workspace }),
  },

  // --- Collaborator --------------------------------------------------------
  "collaborator.register": {
    kind: "command",
    target: null,
    params: Command(T.Object({ kind: CollaboratorKind, name: NonEmpty })),
    result: Result({ collaborator: Collaborator }),
  },
  "collaborator.update": {
    kind: "command",
    target: "collaborator",
    params: Command(T.Object({ collaboratorId: Id, name: T.Optional(NonEmpty), kind: T.Optional(CollaboratorKind) })),
    result: Result({ collaborator: Collaborator }),
  },
  "collaborator.retire": {
    kind: "command",
    target: "collaborator",
    params: Command(T.Object({ collaboratorId: Id, reason: Reason })),
    result: Result({ collaborator: Collaborator }),
  },

  // --- Membership ------------------------------------------------------------
  "membership.grant": {
    kind: "command",
    target: null,
    params: Command(T.Object({ collaboratorId: Id, role: Role })),
    result: Result({ membership: Membership }),
  },
  "membership.change-role": {
    kind: "command",
    target: "membership",
    params: Command(T.Object({ collaboratorId: Id, role: Role })),
    result: Result({ membership: Membership }),
  },
  "membership.revoke": {
    kind: "command",
    target: "membership",
    params: Command(T.Object({ collaboratorId: Id, reason: Reason })),
    result: Result({ membership: Membership }),
  },

  // --- Task ------------------------------------------------------------------
  "task.create": {
    kind: "command",
    target: null,
    params: Command(
      T.Object({
        title: NonEmpty,
        intent: T.Optional(Nullable(T.String())),
        parentId: T.Optional(Nullable(Id)),
        priority: T.Optional(Nullable(T.Integer())),
      }),
    ),
    result: Result({ task: Task }),
  },
  "task.update": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, title: T.Optional(NonEmpty), intent: T.Optional(Nullable(T.String())) })),
    result: Result({ task: Task }),
  },
  "task.set-priority": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, priority: Nullable(T.Integer()) })),
    result: Result({ task: Task }),
  },
  "task.move": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, parentId: Nullable(Id) })),
    result: Result({ task: Task }),
  },
  "task.complete": {
    kind: "command",
    target: "task",
    params: Command(
      T.Object({
        ...TaskRef,
        /** Required when the actor holds the active claim. */
        fence: T.Optional(T.Integer({ minimum: 1 })),
        /** With a summary and/or evidence, the result is recorded as an accepted submission in the same change. */
        summary: T.Optional(NonEmpty),
        evidence: T.Optional(T.Array(Id)),
      }),
    ),
    result: T.Union([
      Result({
        outcome: T.Literal("completed"),
        task: Task,
        completion: Completion,
        submission: Nullable(Submission),
        warnings: Warnings,
      }),
      /** The fence was invalidated (claim expired or revoked): recorded, the Task is unchanged (PROTOCOL.md#behavior). */
      Result({ outcome: T.Literal("late-result-recorded"), lateResult: LateResult }),
    ]),
  },
  "task.cancel": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, reason: NonEmpty })),
    result: Result({ task: Task }),
  },
  "task.reopen": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, reason: NonEmpty })),
    result: Result({ task: Task }),
  },

  // --- Assignment --------------------------------------------------------------
  "task.assign": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, assigneeId: Id, waiveReview: T.Optional(T.Boolean()) })),
    result: Result({ task: Task, assignment: Assignment }),
  },
  "task.unassign": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, reason: Reason })),
    result: Result({ task: Task }),
  },

  // --- Dependency --------------------------------------------------------------
  "dependency.add": {
    kind: "command",
    target: "task", // the dependent
    params: Command(T.Object({ dependentId: Id, prerequisiteId: Id })),
    result: Result({ task: Task }),
  },
  "dependency.remove": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ dependentId: Id, prerequisiteId: Id, reason: Reason })),
    result: Result({ task: Task }),
  },

  // --- Claim -------------------------------------------------------------------
  "claim.acquire": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef })),
    result: Result({ task: Task, claim: Claim }),
  },
  "claim.renew": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, fence: T.Integer({ minimum: 1 }) })),
    result: Result({ claim: Claim }),
  },
  "claim.release": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, fence: T.Integer({ minimum: 1 }), reason: Reason })),
    result: Result({ task: Task, claim: Claim }),
  },
  "claim.revoke": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ ...TaskRef, reason: NonEmpty })),
    result: Result({ task: Task, claim: Claim }),
  },

  // --- Submission ----------------------------------------------------------------
  "submission.submit": {
    kind: "command",
    target: "task",
    params: Command(
      T.Object({ ...TaskRef, fence: T.Integer({ minimum: 1 }), summary: NonEmpty, evidence: T.Optional(T.Array(Id)) }),
    ),
    result: T.Union([
      Result({ outcome: T.Literal("submitted"), task: Task, submission: Submission }),
      Result({ outcome: T.Literal("late-result-recorded"), lateResult: LateResult }),
    ]),
  },
  "submission.withdraw": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ submissionId: Id, reason: Reason })),
    result: Result({ task: Task, submission: Submission }),
  },

  // --- Review ------------------------------------------------------------------------
  "review.accept": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ submissionId: Id })),
    result: Result({ task: Task, review: Review, completion: Completion, warnings: Warnings }),
  },
  "review.return": {
    kind: "command",
    target: "task",
    params: Command(T.Object({ submissionId: Id, reasons: NonEmpty })),
    result: Result({ task: Task, review: Review }),
  },

  // --- Evidence reference ------------------------------------------------------------
  "evidence-reference.record": {
    kind: "command",
    target: null,
    params: Command(
      T.Object({
        kind: EvidenceKind,
        locator: NonEmpty,
        contentHash: T.Optional(T.String()),
        description: T.Optional(T.String()),
      }),
    ),
    result: Result({ evidenceReference: EvidenceReference }),
  },

  // --- Queries -------------------------------------------------------------------------
  "workspace.get": {
    kind: "query",
    target: null,
    params: T.Object({}),
    result: T.Object({ workspace: Workspace, owners: T.Array(Collaborator), head: Cursor }),
  },
  "task.get": {
    kind: "query",
    target: null,
    params: QueryParams({ taskId: Id }),
    result: T.Object({ task: Task, history: TaskHistory }),
  },
  "task.list": {
    kind: "query",
    target: null,
    params: QueryParams({
      /** Omitted: every Task. `null`: top-level Tasks only. An ID: that Task's direct children. */
      parentId: T.Optional(Nullable(Id)),
      state: T.Optional(StoredTaskState),
    }),
    result: T.Object({ tasks: T.Array(Task) }),
  },
  "task.next": {
    kind: "query",
    target: null,
    params: QueryParams({}),
    result: T.Object({ task: Nullable(Task) }),
  },
  "events.read": {
    kind: "query",
    target: null,
    params: QueryParams({
      after: Cursor,
      limit: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
      /** Only events whose taskId is this Task or one of its current descendants. */
      taskSubtree: T.Optional(Id),
      types: T.Optional(T.Array(NonEmpty)),
    }),
    result: T.Object({
      events: T.Array(Event),
      /** The seq of the last event scanned (pass it as `after` next time). */
      cursor: Cursor,
      hasMore: T.Boolean(),
    }),
  },
  "events.subscribe": {
    kind: "query",
    target: null,
    params: QueryParams({
      after: Cursor,
      taskSubtree: T.Optional(Id),
      types: T.Optional(T.Array(NonEmpty)),
    }),
    result: T.Object({ subscriptionId: Id }),
  },
  "events.unsubscribe": {
    kind: "query",
    target: null,
    params: T.Object({ subscriptionId: Id }),
    result: T.Object({ ok: T.Literal(true) }),
  },
} as const;

export type MethodName = keyof typeof Methods;
export type Params<M extends MethodName> = Static<(typeof Methods)[M]["params"]>;
export type ResultOf<M extends MethodName> = Static<(typeof Methods)[M]["result"]>;
export type Payload<M extends MethodName> = Params<M> extends { payload: infer P } ? P : never;
export type CommandName = { [K in MethodName]: (typeof Methods)[K]["kind"] extends "command" ? K : never }[MethodName];

/** Notification the engine sends for each event on a subscription. */
export const EventNotification = T.Object({
  jsonrpc: T.Literal("2.0"),
  method: T.Literal("events.event"),
  params: T.Object({ subscriptionId: Id, event: Event }),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  permissionDenied: -32001,
  versionConflict: -32002,
  ruleViolation: -32003,
  checkFailed: -32004,
  notFound: -32005,
  idempotencyConflict: -32006,
  notImplemented: -32010,
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const HookFailure = T.Object({
  kit: NonEmpty,
  version: NonEmpty,
  policy: Nullable(T.String()),
  reason: NonEmpty,
});

/** The check phase a rejection comes from (PROTOCOL.md#check-phases). */
export const Phase = T.Union([T.Literal("shape"), T.Literal("permission"), T.Literal("content"), T.Literal("hooks")]);

/**
 * A hooks-phase failure entry (`check` is `hook.<hook name>`): every failing required check is listed in
 * `details.failures`, never just the first.
 */
export const HookFailureEntry = T.Object({
  check: T.String({ pattern: "^hook\\." }),
  /** A summary of the rejection a person or agent can act on. */
  reason: NonEmpty,
  details: T.Object({
    failures: T.Array(HookFailure, { minItems: 1 }),
  }),
});

export const Failure = T.Object({
  /** Stable check identifier, e.g. `task.children-settled` (see PROTOCOL.md#checks). `hook.*` checks use HookFailureEntry. */
  check: T.Not(T.String({ pattern: "^hook\\." }), NonEmpty),
  /** A reason a person or agent can act on. */
  reason: NonEmpty,
  /** Structured facts about the failure (IDs, versions, block reasons). */
  details: T.Optional(T.Record(T.String(), T.Unknown())),
});

export const FailureEntry = T.Union([HookFailureEntry, Failure]);

export const ErrorData = T.Object({
  /** The phase whose checks rejected the command. */
  phase: Phase,
  /**
   * This phase's failures: every one the engine found, or only the first it hit. Order is unspecified;
   * conformance asserts membership, never position, count or exclusivity.
   */
  failures: T.Array(FailureEntry, { minItems: 1 }),
});

export const RpcError = T.Object({
  code: T.Integer(),
  message: T.String(),
  data: T.Optional(ErrorData),
});

// Static types
export type Workspace = Static<typeof Workspace>;
export type Collaborator = Static<typeof Collaborator>;
export type Membership = Static<typeof Membership>;
export type Task = Static<typeof Task>;
export type TaskHistory = Static<typeof TaskHistory>;
export type BlockReason = Static<typeof BlockReason>;
export type Assignment = Static<typeof Assignment>;
export type Claim = Static<typeof Claim>;
export type Submission = Static<typeof Submission>;
export type Review = Static<typeof Review>;
export type Completion = Static<typeof Completion>;
export type LateResult = Static<typeof LateResult>;
export type EvidenceReference = Static<typeof EvidenceReference>;
export type Event = Static<typeof Event>;
export type ErrorData = Static<typeof ErrorData>;
export type RpcError = Static<typeof RpcError>;
export type HookFailure = Static<typeof HookFailure>;
export type Phase = Static<typeof Phase>;
export type Failure = Static<typeof Failure>;
export type HookFailureEntry = Static<typeof HookFailureEntry>;
export type FailureEntry = Static<typeof FailureEntry>;
