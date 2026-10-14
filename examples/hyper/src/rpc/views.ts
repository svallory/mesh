// The records as the spec's results show them (`schemas/protocol.ts`, "Record views"): the spec's field names, a
// relationship as `<name>Id`, and every timestamp in RFC 3339 with milliseconds, in UTC (`Timestamp`). The Task view also
// carries what the spec derives for it (PROTOCOL.md:134-142): its derived state and block reasons, its prerequisites,
// its current assignment, live claim and pending submission, and the reviewer the rule names now.
import { Mesh } from "meshfw";
import type { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Assignment, Claim, Completion, Dependency, type EvidenceReference, LateResult, Review, Submission, type Task } from "#mesh/domain/work";
import { blockReasonsOf, currentAssignment, derivedStateOf, liveClaim, reviewerFor } from "../domain/work/work.helpers";

type Instant = Pick<Date, "toISOString">;

const time = (value: Instant) => value.toISOString();
const timeOrNull = (value: Instant | null) => (value === null ? null : value.toISOString());

export function workspaceView(workspace: Workspace) {
  const { id, name, location, state, version } = workspace;
  return { id, name, location, state, version };
}

export function collaboratorView(collaborator: Collaborator) {
  const { id, kind, name, state, version } = collaborator;
  return { id, kind, name, state, version };
}

export function membershipView(membership: Membership) {
  return {
    id: membership.id,
    collaboratorId: membership.collaboratorId,
    role: membership.role,
    state: membership.state,
    grantedAt: time(membership.grantedAt),
    grantedBy: membership.grantedById,
    revokedAt: timeOrNull(membership.revokedAt),
    revokedBy: membership.revokedById,
    version: membership.version,
  };
}

export function assignmentView(assignment: Assignment) {
  return {
    id: assignment.id,
    taskId: assignment.taskId,
    assigneeId: assignment.assigneeId,
    delegatorId: assignment.delegatorId,
    startedAt: time(assignment.startedAt),
    endedAt: timeOrNull(assignment.endedAt),
    endReason: assignment.endReason,
    reviewWaived: assignment.reviewWaived,
  };
}

export function claimView(claim: Claim) {
  return {
    id: claim.id,
    taskId: claim.taskId,
    holderId: claim.holderId,
    fence: claim.fence,
    acquiredAt: time(claim.acquiredAt),
    expiresAt: time(claim.expiresAt),
    state: claim.state,
    endedAt: timeOrNull(claim.endedAt),
    endReason: claim.endReason,
  };
}

export function reviewView(review: Review) {
  return {
    id: review.id,
    submissionId: review.submissionId,
    reviewerId: review.reviewerId,
    decision: review.decision,
    reasons: review.reasons,
    ruleApplied: review.ruleApplied,
    decidedAt: time(review.decidedAt),
  };
}

/** The evidence ids a submission or a late result stores: the list it was given, or none. */
const evidenceOf = (evidence: unknown) => (Array.isArray(evidence) ? (evidence as string[]) : []);

/** A submission and its review, `null` until it is decided. */
export function submissionView(submission: Submission, review: Review | null) {
  return {
    id: submission.id,
    taskId: submission.taskId,
    submitterId: submission.submitterId,
    summary: submission.summary,
    evidence: evidenceOf(submission.evidence),
    taskVersion: submission.taskVersion,
    fence: submission.fence,
    state: submission.state,
    submittedAt: time(submission.submittedAt),
    review: review === null ? null : reviewView(review),
  };
}

/** A submission with its review read through `Mesh.privileged`: there is one review at most per submission. */
export async function reviewedSubmissionView(submission: Submission) {
  const [review] = await Mesh.privileged(Review).read({ filter: { submissionId: { eq: submission.id } }, limit: 1 });
  return submissionView(submission, review ?? null);
}

export function completionView(completion: Completion) {
  return {
    id: completion.id,
    taskId: completion.taskId,
    rule: completion.rule,
    submissionId: completion.submissionId,
    completedBy: completion.completedById,
    completedAt: time(completion.completedAt),
  };
}

export function lateResultView(lateResult: LateResult) {
  return {
    id: lateResult.id,
    taskId: lateResult.taskId,
    submitterId: lateResult.submitterId,
    fence: lateResult.fence,
    summary: lateResult.summary,
    evidence: evidenceOf(lateResult.evidence),
    recordedAt: time(lateResult.recordedAt),
  };
}

export function evidenceReferenceView(evidenceReference: EvidenceReference) {
  return {
    id: evidenceReference.id,
    kind: evidenceReference.kind,
    locator: evidenceReference.locator,
    contentHash: evidenceReference.contentHash,
    description: evidenceReference.description,
    recordedBy: evidenceReference.recordedById,
    recordedAt: time(evidenceReference.recordedAt),
  };
}

/**
 * The Task's history as `task.get` returns it (PROTOCOL.md:125): every assignment, claim, submission with its review,
 * late result and completion, each list in the order the records were made (ids are time-ordered UUIDs, which break a
 * tie within one millisecond).
 */
export async function taskHistory(taskId: string) {
  const ofTask = { taskId: { eq: taskId } };
  const assignments = await Mesh.privileged(Assignment).read({ filter: ofTask, sort: ["startedAt", "id"] });
  const claims = await Mesh.privileged(Claim).read({ filter: ofTask, sort: ["acquiredAt", "id"] });
  const submissions = await Mesh.privileged(Submission).read({ filter: ofTask, sort: ["submittedAt", "id"] });
  const reviews = submissions.length === 0 ? [] : await Mesh.privileged(Review).read({ filter: { submissionId: { in: submissions.map((submission) => submission.id) } } });
  const reviewOf = new Map(reviews.map((review) => [review.submissionId, review]));
  const lateResults = await Mesh.privileged(LateResult).read({ filter: ofTask, sort: ["recordedAt", "id"] });
  const completions = await Mesh.privileged(Completion).read({ filter: ofTask, sort: ["completedAt", "id"] });
  return {
    assignments: assignments.map(assignmentView),
    claims: claims.map(claimView),
    submissions: submissions.map((submission) => submissionView(submission, reviewOf.get(submission.id) ?? null)),
    lateResults: lateResults.map(lateResultView),
    completions: completions.map(completionView),
  };
}

/**
 * The Task view (`schemas/protocol.ts`, `Task`), read through `Mesh.privileged` inside the call's transaction, so it
 * shows what the call committed. `now` decides which claim is live, as the derived state does.
 */
export async function taskView(task: Task, now: Date) {
  const derivedState = await derivedStateOf(task.id);
  if (derivedState === null) throw new Error(`Task ${task.id} vanished while its view was read`);
  const reasons = await blockReasonsOf(task.id);
  const dependencies = await Mesh.privileged(Dependency).read({ filter: { dependentId: { eq: task.id } }, sort: ["createdAt", "id"] });
  const assignments = await Mesh.privileged(Assignment).read({ filter: { taskId: { eq: task.id }, endedAt: { nil: true } } });
  const claims = await Mesh.privileged(Claim).read({ filter: { taskId: { eq: task.id }, state: { eq: "active" } } });
  const [pending] = await Mesh.privileged(Submission).read({ filter: { taskId: { eq: task.id }, state: { eq: "pending" } }, limit: 1 });
  const assignment = currentAssignment(assignments);
  const claim = liveClaim(claims, now);
  return {
    id: task.id,
    title: task.title,
    intent: task.intent,
    state: task.state,
    parentId: task.parentId,
    priority: task.priority,
    creatorId: task.creatorId,
    version: task.version,
    createdAt: time(task.createdAt),
    derived: { state: derivedState, reasons: reasons.map((reason) => ({ ...reason })) },
    dependsOn: dependencies.map((dependency) => dependency.prerequisiteId),
    assignment: assignment === undefined ? null : assignmentView(assignment),
    activeClaim: claim === undefined ? null : claimView(claim),
    pendingSubmission: pending === undefined ? null : submissionView(pending, null),
    reviewer: { ...(await reviewerFor(task)) },
  };
}
