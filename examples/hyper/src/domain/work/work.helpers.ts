// Helpers for the work entity files and the work functions. The pure ones take values (rows already read, ids, a
// time) and never the model; the ones whose names end in `Of` read through `tx`, the reads of the running
// transaction, and hand what they read to a pure one. Each names the Hyper rule or change it follows.
import { FrameworkError, type ReadOnlyResults } from "@meshfw/runtime";
import type { Reads as AllReads } from "#mesh";

/** The reads of the running transaction, as an entity file's `tx` or an application transaction's `tx` hands them over. */
export type Reads = ReadOnlyResults<AllReads>;

/** The default lease (PROTOCOL.md:33, `--lease-ms`): 10 minutes. */
export const LEASE_MS = 600_000;

/** When a lease taken or renewed at `now` runs out (PROTOCOL.md:311, `tasks/claim/changes/lease.ex:23-26`). */
export function leaseEnd(now: Date): Date {
  return new Date(now.getTime() + LEASE_MS);
}

/** A stored time as the records handed to a function carry it: read-only, so only its reading methods. */
export type Instant = Pick<Date, "getTime">;

export interface ClaimFacts {
  readonly id: string;
  readonly holderId: string;
  readonly fence: number;
  readonly state: string;
  readonly expiresAt: Instant;
}

/** The Task's live claim: active and its lease not run out (`tasks/queries.ex:15-19`, `active_claim`). */
export function liveClaim<C extends ClaimFacts>(claims: readonly C[], now: Date): C | undefined {
  return claims.find((claim) => claim.state === "active" && claim.expiresAt.getTime() > now.getTime());
}

/**
 * The claim to release when the work it covered ends: the live claim, whoever holds it. Hyper releases it on
 * `task.complete` (reason `completed`, `tasks/task/changes/record_completion.ex:36-43`) and on `submission.submit`
 * (reason `submitted`, `tasks/submission/changes/submit.ex:20-27`); `review.accept` reaches it through `complete`.
 */
export function claimToRelease<C extends ClaimFacts>(claims: readonly C[], now: Date): C | undefined {
  return liveClaim(claims, now);
}

/**
 * The claims to revoke: every claim still `active`, a lapsed one included, optionally only one holder's
 * (`tasks/claim/changes/end_claim.ex:16-21`, `revoke_all`).
 */
export function openClaims<C extends ClaimFacts>(claims: readonly C[], holderId?: string): C[] {
  return claims.filter((claim) => claim.state === "active" && (holderId === undefined || claim.holderId === holderId));
}

/** The active claims whose lease has run out, which `claim.acquire` expires first (`tasks/claim/changes/lease.ex:44-50`). */
export function lapsedClaims<C extends ClaimFacts>(claims: readonly C[], now: Date): C[] {
  return claims.filter((claim) => claim.state === "active" && claim.expiresAt.getTime() <= now.getTime());
}

/**
 * The claim `holderId` held with `fence` that expired or was revoked, or a still-active one whose lease ran out
 * (`tasks/queries.ex:22-33`, `stale_claim`): the fence of a late result.
 */
export function staleClaim<C extends ClaimFacts>(claims: readonly C[], fence: number | null | undefined, holderId: string, now: Date): C | undefined {
  if (fence === null || fence === undefined) return undefined;
  return claims.find((claim) => claim.fence === fence && claim.holderId === holderId &&
    (claim.state === "expired" || claim.state === "revoked" || (claim.state === "active" && claim.expiresAt.getTime() <= now.getTime())));
}

/** Whether `fence` names a stale claim of `holderId` (`staleClaim`): the condition of a late result. */
export function isStale(claims: readonly ClaimFacts[], fence: number | null | undefined, holderId: string, now: Date): boolean {
  return staleClaim(claims, fence, holderId, now) !== undefined;
}

export interface EndedClaimFacts extends ClaimFacts {
  readonly endedAt: Instant | null;
}

/**
 * When a claim stopped counting for its holder, in milliseconds, or null while it is live or once it was released. A
 * claim is expired the moment its lease runs out, whether or not it was marked expired (PROTOCOL.md:312), so a revoked
 * or expired claim counts from its end or its lease end, whichever came first, and an active one from its lease end
 * once that has passed. The port marks a lapsed claim expired only when a command notices it (no sweeper), and a
 * command that revokes every open claim can end one whose lease had already run out, so `endedAt` alone would be late.
 * The Elixir engine compares `ended_at` once a claim is marked (`tasks/task/rules.ex:175-176`); the port follows the spec.
 */
export function invalidatedAt(claim: EndedClaimFacts, now: Date): number | null {
  const leaseEnd = claim.expiresAt.getTime();
  if (claim.state === "revoked" || claim.state === "expired") return Math.min(claim.endedAt?.getTime() ?? leaseEnd, leaseEnd);
  return claim.state === "active" && leaseEnd <= now.getTime() ? leaseEnd : null;
}

/**
 * The Task's last completion or reopen, in milliseconds, or null when it has had neither: the latest `completedAt` of
 * its completions (`review.accept` records one too) and its `reopenedAt`. Hyper reads the time of the last `complete`
 * or `reopen` event (`tasks/task/rules.ex:184-192`); a reopen leaves no row, so the Task stores when it was reopened.
 */
export function lastCompletedOrReopened(completions: readonly { readonly completedAt: Instant }[], reopenedAt: Instant | null): number | null {
  const times = [...completions.map((completion) => completion.completedAt.getTime()), ...(reopenedAt === null ? [] : [reopenedAt.getTime()])];
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * `claim.invalidated` (PROTOCOL.md:326, `tasks/task/rules.ex:101-113` and `:168-181`): the fences, in order, of the
 * claims `holderId` held on the Task that expired or were revoked after its last completion or reopen. An unfenced
 * `task.complete` by that holder is refused while there is one: a stale worker cannot finish (invariant 3).
 */
export function invalidatedFences(claims: readonly EndedClaimFacts[], holderId: string, completions: readonly { readonly completedAt: Instant }[], reopenedAt: Instant | null, now: Date): number[] {
  const since = lastCompletedOrReopened(completions, reopenedAt) ?? Number.NEGATIVE_INFINITY;
  return claims
    .filter((claim) => claim.holderId === holderId)
    .filter((claim) => { const at = invalidatedAt(claim, now); return at !== null && at > since; })
    .map((claim) => claim.fence)
    .sort((a, b) => a - b);
}

/**
 * `claim.invalidated` on `task.complete`: a completion with a fence passes (the fence rules decide it); one without
 * passes while `invalidatedFences` is empty. The completion `review.accept` makes (`completion` set, checked by the
 * step through `acceptedSubmissionOf`) passes too: the spec applies the rule to `task.complete` only
 * (PROTOCOL.md:283), and `review.accept` re-checks the other completion rules, not this one (:332). The reviewer may
 * once have held a claim on the Task, for example before assigning it to someone else.
 */
export function claimNotInvalidated(claims: readonly EndedClaimFacts[], fence: number | null | undefined, actorId: string, completions: readonly { readonly completedAt: Instant }[], reopenedAt: Instant | null, now: Date, completion: object | null | undefined): boolean {
  if (completion !== null && completion !== undefined) return true;
  return (fence !== null && fence !== undefined) || invalidatedFences(claims, actorId, completions, reopenedAt, now).length === 0;
}

/** `claim.current-fence`'s details on a submission or a completion: the Task's latest fence, and whether the given one is stale. */
export function fenceDetails(latestFence: number | null, claims: readonly ClaimFacts[], fence: number | null | undefined, actorId: string, now: Date): { currentFence: number | null; stale: boolean } {
  return { currentFence: latestFence, stale: isStale(claims, fence, actorId, now) };
}

/**
 * `claim.current-fence` on a submission or a completion (`tasks/rules.ex:20-41`, and the Task variant at `:68-70`):
 * without a fence, no claim is live; with one, the live claim has it and the actor holds it.
 */
export function fenceIsCurrent(claims: readonly ClaimFacts[], fence: number | null | undefined, actorId: string, now: Date): boolean {
  const live = liveClaim(claims, now);
  if (fence === null || fence === undefined) return live === undefined;
  return live !== undefined && live.fence === fence && live.holderId === actorId;
}

/** The fence the performer holds on the Task, or null (`runs/attempt/changes/start_attempt.ex:41-43`). */
export function heldFence(claims: readonly ClaimFacts[], actorId: string, now: Date): number | null {
  const live = liveClaim(claims, now);
  return live !== undefined && live.holderId === actorId ? live.fence : null;
}

export interface AssignmentFacts {
  readonly id: string;
  readonly assigneeId: string;
  readonly delegatorId: string;
  readonly reviewWaived: boolean;
  readonly endedAt: Instant | null;
}

/** The Task's current assignment: the one not ended (`current_assignment`). */
export function currentAssignment<A extends AssignmentFacts>(assignments: readonly A[]): A | undefined {
  return assignments.find((assignment) => assignment.endedAt === null);
}

/** `assignment.unchanged` (`tasks/task/rules.ex:118-128`): no current assignment, or another assignee or waiver. */
export function assignmentChanges(assignments: readonly AssignmentFacts[], assigneeId: string, waiveReview: boolean): boolean {
  const current = currentAssignment(assignments);
  return current === undefined || current.assigneeId !== assigneeId || current.reviewWaived !== waiveReview;
}

export type ReviewerRule = "parent-assignee" | "parent-creator" | "task-creator";
export interface Reviewer { readonly collaboratorId: string; readonly rule: ReviewerRule }

/**
 * The reviewer rule (PROTOCOL.md:318, `tasks/task/queries.ex:9-16`): the parent's current assignee, else the
 * parent's creator; for a top-level Task, its creator.
 */
export function reviewerOf(task: { readonly creatorId: string }, parent: { readonly creatorId: string; readonly assignments: readonly AssignmentFacts[] } | null): Reviewer {
  if (parent === null) return { collaboratorId: task.creatorId, rule: "task-creator" };
  const assignment = currentAssignment(parent.assignments);
  return assignment ? { collaboratorId: assignment.assigneeId, rule: "parent-assignee" } : { collaboratorId: parent.creatorId, rule: "parent-creator" };
}

/** Reads the parent and its assignments, then applies the reviewer rule. */
export async function reviewerFor(tx: Reads, task: { readonly parentId: string | null; readonly creatorId: string }): Promise<Reviewer> {
  if (task.parentId === null) return reviewerOf(task, null);
  const [parent] = await tx.readTask({ filter: { id: { eq: task.parentId } } });
  if (!parent) return reviewerOf(task, null);
  const assignments = await tx.readAssignment({ filter: { taskId: { eq: parent.id }, endedAt: { nil: true } } });
  return reviewerOf(task, { creatorId: parent.creatorId, assignments });
}

/** Reads the Task by id, then applies the reviewer rule. */
export async function reviewerOfTask(tx: Reads, taskId: string): Promise<Reviewer> {
  const [task] = await tx.readTask({ filter: { id: { eq: taskId } } });
  if (!task) throw new Error(`Task ${taskId} not found`);
  return reviewerFor(tx, task);
}

/**
 * `task.review-required` (PROTOCOL.md:319): no review is needed when the actor is the reviewer, or when the current
 * assignment waives review and the actor is its assignee. Hyper's engine checks the waiver alone
 * (`tasks/task/rules.ex:46-58`); the specification adds the assignee, and the port follows the specification.
 */
export function mayCompleteWithoutReview(actorId: string, reviewer: Reviewer, assignments: readonly AssignmentFacts[]): boolean {
  const current = currentAssignment(assignments);
  return actorId === reviewer.collaboratorId || (current !== undefined && current.reviewWaived && current.assigneeId === actorId);
}

/** `task.review-required` read through `tx`: the reviewer of `task` and its own current assignment. */
export async function reviewNotRequiredOf(tx: Reads, task: { readonly id: string; readonly parentId: string | null; readonly creatorId: string }, actorId: string): Promise<boolean> {
  const reviewer = await reviewerFor(tx, task);
  const assignments = await tx.readAssignment({ filter: { taskId: { eq: task.id }, endedAt: { nil: true } } });
  return mayCompleteWithoutReview(actorId, reviewer, assignments);
}

/** The completion rule when no review was accepted (PROTOCOL.md:320). */
export function completionRule(actorId: string, reviewer: Reviewer): "performer-is-reviewer" | "review-waived" {
  return actorId === reviewer.collaboratorId ? "performer-is-reviewer" : "review-waived";
}

export interface SubmissionFacts { readonly id: string; readonly submitterId: string; readonly state: string }

/** The pending submission of another collaborator (`task.no-foreign-submission`, `tasks/task/rules.ex:60-67`). */
export function foreignPending(submissions: readonly SubmissionFacts[], actorId: string): boolean {
  return submissions.some((submission) => submission.state === "pending" && submission.submitterId !== actorId);
}

/** The actor's own pending submission (PROTOCOL.md:328-331). */
export function ownPending<S extends SubmissionFacts>(submissions: readonly S[], actorId: string): S | undefined {
  return submissions.find((submission) => submission.state === "pending" && submission.submitterId === actorId);
}

/**
 * The submission a `review-accepted` completion names (`context.completion`, which only `review.accept` sets on its
 * nested `task.complete`, `tasks/review/changes/review.ex:25-31`): a submission of the Task being completed, that
 * `review.accept` has just settled as accepted and that no completion names yet. Anything else means the context
 * was forged or misrouted, which no input can cause, so it is a `FrameworkError` and the transaction rolls back.
 */
export async function acceptedSubmissionOf(tx: Reads, taskId: string, submissionId: string): Promise<string> {
  const [submission] = await tx.readSubmission({ filter: { id: { eq: submissionId } } });
  const named = await tx.readCompletion({ filter: { submissionId: { eq: submissionId } }, limit: 1 });
  if (!submission || submission.taskId !== taskId || submission.state !== "accepted" || named.length > 0)
    throw new FrameworkError(`a review-accepted completion of Task ${taskId} names submission ${submissionId}, which is not an accepted submission of that Task that no completion names yet`);
  return submission.id;
}

/** The ids of the open children (`task.children-settled`'s `details.openChildren`, `tasks/task/rules.ex:40-53`). */
export function openChildren(children: readonly { readonly id: string; readonly state: string }[]): string[] {
  return children.filter((child) => child.state === "open").map((child) => child.id);
}

export interface BlockReason {
  readonly kind: "dependency" | "prerequisite-canceled" | "condition";
  readonly taskId?: string;
  readonly source?: string;
  readonly message: string;
}

/**
 * The block reasons a Task's prerequisites give (`tasks/task/calculations/blocked_reasons.ex:21-35`): one per
 * prerequisite that is not done, `prerequisite-canceled` for a canceled one. The `condition` kind comes from
 * blocking-condition providers, which arrive with the plugin hook points (M6).
 */
export function blockReasons(prerequisites: readonly { readonly id: string; readonly title: string; readonly state: string }[]): BlockReason[] {
  return prerequisites.filter((p) => p.state !== "done").map((p) => p.state === "canceled"
    ? { kind: "prerequisite-canceled", taskId: p.id, message: `blocked: prerequisite canceled: ${p.title}` }
    : { kind: "dependency", taskId: p.id, message: `blocked: waiting for ${p.title}` });
}

/** The block reasons of the Task `taskId`, read through `tx`, in the order the dependencies were added. */
export async function blockReasonsOf(tx: Reads, taskId: string): Promise<BlockReason[]> {
  const dependencies = await tx.readDependency({ filter: { dependentId: { eq: taskId } }, sort: ["createdAt", "id"] });
  if (dependencies.length === 0) return [];
  const prerequisites = await tx.readTask({ filter: { id: { in: dependencies.map((d) => d.prerequisiteId) } } });
  const byId = new Map(prerequisites.map((task) => [task.id, task]));
  return blockReasons(dependencies.map((d) => byId.get(d.prerequisiteId)!).filter((task) => task !== undefined));
}

/**
 * `evidence.exists` (`tasks/rules.ex:48-62`): the ids among `evidence` that name no evidence reference. Evidence is a
 * list of ids (`schemas/protocol.ts:603`); a value that is neither null nor a list is reported whole, as text, so it
 * is never stored, and so is each item of a list that is not a string.
 */
export async function missingEvidenceOf(tx: Reads, evidence: unknown): Promise<string[]> {
  const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
  if (evidence === null || evidence === undefined) return [];
  if (!Array.isArray(evidence)) return [text(evidence)];
  const ids = evidence.filter((id): id is string => typeof id === "string");
  if (ids.length !== evidence.length) return evidence.filter((id) => typeof id !== "string").map(text);
  if (ids.length === 0) return [];
  const found = new Set((await tx.readEvidenceReference({ filter: { id: { in: ids } } })).map((row) => row.id));
  return ids.filter((id) => !found.has(id));
}

/** `task.no-cycle` (`tasks/task/rules.ex:31-36`, `:144-158`): the new parent is neither the Task nor one of its descendants. */
export async function noContainmentCycleOf(tx: Reads, taskId: string, parentId: string | null | undefined): Promise<boolean> {
  const seen = new Set<string>();
  for (let id = parentId ?? null; id !== null && !seen.has(id);) {
    if (id === taskId) return false;
    seen.add(id);
    const [task] = await tx.readTask({ filter: { id: { eq: id } } });
    id = task?.parentId ?? null;
  }
  return true;
}

/**
 * `dependency.no-cycle` (`tasks/dependency/rules.ex:28-55`): breadth-first from the prerequisite over prerequisite
 * edges; a path back to the dependent would close a cycle.
 */
export async function prerequisiteReachesOf(tx: Reads, prerequisiteId: string, dependentId: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let queue = [prerequisiteId]; queue.length > 0;) {
    const id = queue.shift()!;
    if (id === dependentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue = [...queue, ...(await tx.readDependency({ filter: { dependentId: { eq: id } } })).map((d) => d.prerequisiteId)];
  }
  return false;
}

/** `dependency.exists` (`tasks/dependency/rules.ex:10-14`): the ids among `ids` that name no Task. */
export async function missingTasksOf(tx: Reads, ids: readonly string[]): Promise<string[]> {
  const found = new Set((await tx.readTask({ filter: { id: { in: [...ids] } } })).map((task) => task.id));
  return ids.filter((id) => !found.has(id));
}

/** The version of the Task `taskId`, or null when there is none (`dependency.exists` reports that). */
export async function taskVersionOf(tx: Reads, taskId: string): Promise<number | null> {
  const [task] = await tx.readTask({ filter: { id: { eq: taskId } }, limit: 1 });
  return task ? task.version : null;
}

/** `dependency.duplicate` (`tasks/dependency/rules.ex:19-26`). */
export async function dependencyExistsOf(tx: Reads, dependentId: string, prerequisiteId: string): Promise<boolean> {
  return (await tx.readDependency({ filter: { dependentId: { eq: dependentId }, prerequisiteId: { eq: prerequisiteId } }, limit: 1 })).length > 0;
}

/** `claim.task-ready`'s details (`tasks/claim/rules.ex:36-47`): the derived state and the block reasons behind it. */
export async function readinessOf(tx: Reads, taskId: string): Promise<{ derivedState: DerivedState | null; reasons: BlockReason[] }> {
  return { derivedState: await derivedStateOf(tx, taskId), reasons: await blockReasonsOf(tx, taskId) };
}

// The reads a create's check makes. In `validate`, a create's `self` is the new instance before the input is applied
// (ACT-27), so `&task` is not the Task the caller names yet: the check reads that Task through `tx`, by the id in
// `input` (POL-08). `tx` returns stored rows without computed fields, so the helpers below derive the ones the checks
// need from the rows, the same way the computed fields in `task.mesh.mx` do.

/** The Task `taskId`, or undefined when there is none. */
export async function taskOf(tx: Reads, taskId: string) {
  return (await tx.readTask({ filter: { id: { eq: taskId } }, limit: 1 }))[0];
}

/** `task.open` on the Task a create names (`tasks/rules.ex:13-16`): it exists and is open. */
export async function taskOpenOf(tx: Reads, taskId: string): Promise<boolean> {
  return (await taskOf(tx, taskId))?.state === "open";
}

/** `task.parent-open` (`tasks/task/rules.ex:24-33`): no parent, or an open one. */
export async function parentOpenOf(tx: Reads, parentId: string | null): Promise<boolean> {
  return parentId === null || await taskOpenOf(tx, parentId);
}

/**
 * The parent a `task.move` leaves the Task under: the one the caller sends, `null` to move it to the top, or the
 * stored one when the caller sends none. A translated `input.parent ?? &parent` cannot tell `null` from a missing
 * value, so the check is plain code (ACT-27).
 */
export function movedParent(stored: { readonly parentId: string | null }, sent: string | null | undefined): string | null {
  return sent === undefined ? stored.parentId : sent;
}

/**
 * `task.unchanged` (`tasks/task/rules.ex:16-22`): `task.update` changes the title or the intent. A field the caller
 * does not send keeps its stored value, and an intent sent as `null` clears it, so this is plain code: a translated
 * `input.intent ?? &intent` would read that `null` as "not sent" and refuse the change (ACT-27).
 */
export function taskChanges(stored: { readonly title: string; readonly intent: string | null }, sent: { readonly title?: string | undefined; readonly intent?: string | null | undefined }): boolean {
  const intent = sent.intent === undefined ? stored.intent : sent.intent;
  return (sent.title ?? stored.title) !== stored.title || intent !== stored.intent;
}

/** The claims on the Task `taskId`, every state. */
export async function claimsOf(tx: Reads, taskId: string) {
  return tx.readClaim({ filter: { taskId: { eq: taskId } } });
}

/** `claim.current-fence`'s details for the Task `taskId`, read through `tx` (`fenceDetails`). */
export async function fenceDetailsOf(tx: Reads, taskId: string, fence: number | null | undefined, actorId: string, now: Date): Promise<{ currentFence: number | null; stale: boolean }> {
  const [task] = await tx.readTask({ filter: { id: { eq: taskId } }, limit: 1, load: ["maxFence", "claims"] });
  return fenceDetails(task?.maxFence ?? null, task?.claims ?? [], fence, actorId, now);
}

/** The Task's `inReview`: a submission of it is pending. */
export async function inReviewOf(tx: Reads, taskId: string): Promise<boolean> {
  const [task] = await tx.readTask({ filter: { id: { eq: taskId } }, limit: 1, load: ["inReview"] });
  return task?.inReview ?? false;
}

export type DerivedState = "ready" | "blocked" | "claimed" | "in-review" | "done" | "canceled";

/**
 * The Task's `derivedState` (`task.mesh.mx`, PROTOCOL.md:136-142): done and canceled as stored, then in review, then
 * claimed (an active claim whose lease has not run out), then blocked (a prerequisite not done), else ready. Null when
 * the Task does not exist.
 */
export async function derivedStateOf(tx: Reads, taskId: string): Promise<DerivedState | null> {
  const [task] = await tx.readTask({ filter: { id: { eq: taskId } }, limit: 1, load: ["derivedState"] });
  return task?.derivedState ?? null;
}

export interface SubmittedVersions {
  /** The submission's state, or null when there is no such submission. */
  readonly state: string | null;
  /** The Task's version when it was submitted. */
  readonly submitted: number | null;
  /** The Task's version now. */
  readonly current: number | null;
}

/** The submission `submissionId`'s state and its Task's versions, for `review.accept` and `review.return`. */
export async function submittedVersionsOf(tx: Reads, submissionId: string): Promise<SubmittedVersions> {
  const [submission] = await tx.readSubmission({ filter: { id: { eq: submissionId } }, limit: 1 });
  if (!submission) return { state: null, submitted: null, current: null };
  return { state: submission.state, submitted: submission.taskVersion, current: await taskVersionOf(tx, submission.taskId) };
}

/**
 * `submission.task-version` (`tasks/review/rules.ex:10-25`): a pending submission's Task is one version past the one
 * submitted (submitting touches it here, which Hyper's engine does not), so nothing changed it since. Refused when the submission does not exist.
 */
export function taskUnchangedSinceSubmit(versions: SubmittedVersions): boolean {
  if (versions.state === null) return false;
  return versions.state !== "pending" || (versions.submitted !== null && versions.current === versions.submitted + 1);
}

/** Which part of the reviewer rule names the reviewer of the Task `taskId` (`review.accept`'s `ruleApplied`). */
export async function reviewerRuleOf(tx: Reads, taskId: string): Promise<ReviewerRule> {
  return (await reviewerOfTask(tx, taskId)).rule;
}
