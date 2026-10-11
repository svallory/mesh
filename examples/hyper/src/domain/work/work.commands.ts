// The work commands whose result an entity action cannot give alone: the late result a stale fence turns
// `task.complete` and `submission.submit` into, the `warnings` of `task.complete` and `review.accept`, and
// `task.cancel`, which also cancels the Task's runs, another aggregate (`runs.ex:2`). Each is one application
// transaction over the generated actions; the effects inside the Task aggregate stay in the entity files. Names follow
// Hyper's method names in camelCase (`task.complete` is `taskComplete`), so none can be a generated action function,
// whose names put the action first (`completeTask`, from `#mesh/domain/work`).
import type { ActionContext } from "@meshfw/runtime";
import type {
  AcceptReviewInput,
  CancelTaskInput,
  CompleteTaskInput,
  Completion,
  LateResult,
  Review,
  Submission,
  SubmitSubmissionInput,
  Task,
} from "#mesh/domain/work";
import { nested } from "../../context";
import { connected, type Binding } from "../binding";
import { blockReasonsOf, staleClaim, type BlockReason, type Reads } from "./work.helpers";

export type LateResultRecorded = { readonly outcome: "late-result-recorded"; readonly lateResult: LateResult };

export type TaskCompleted = {
  readonly outcome: "completed";
  readonly task: Task;
  readonly completion: Completion;
  readonly submission: Submission | null;
  readonly warnings: BlockReason[];
};

export type SubmissionSubmitted = { readonly outcome: "submitted"; readonly task: Task; readonly submission: Submission };

export type ReviewAccepted = { readonly task: Task; readonly review: Review; readonly completion: Completion; readonly warnings: BlockReason[] };

async function taskOf(tx: Reads, id: string): Promise<Task> {
  const [task] = await tx.readTask({ filter: { id: { eq: id } } });
  if (!task) throw new Error(`Task ${id} not found`);
  return task as Task;
}

/**
 * `task.complete` (PROTOCOL.md:321-333). A fence of a claim the actor held that has since expired or been revoked is
 * checked first and records a late result, leaving the Task unchanged; otherwise `completeTask` records the
 * completion, settles or records the submission and releases the claim, and the result lists the prerequisites that
 * are not done as `warnings` (`tasks/task/changes/record_completion.ex:15-43`, PROTOCOL.md:333).
 */
export async function taskComplete(input: CompleteTaskInput, context: ActionContext, binding: Binding = connected): Promise<TaskCompleted | LateResultRecorded> {
  return binding.transaction(async ({ actions, tx }) => {
    // Read inside the transaction: a call queued behind another one decides stale or not when it runs.
    const now = binding.clock();
    const stale = staleClaim(await tx.readClaim({ filter: { taskId: { eq: input.id } } }), input.fence, context.actor.id, now);
    if (stale) {
      const lateResult = await actions.recordLateResult({ task: input.id, fence: stale.fence, summary: input.summary ?? null, evidence: input.evidence ?? [] });
      return { outcome: "late-result-recorded", lateResult } as const;
    }
    const earlier = new Set((await tx.readCompletion({ filter: { taskId: { eq: input.id } } })).map((completion) => completion.id));
    const task = await actions.completeTask(input);
    const completion = (await tx.readCompletion({ filter: { taskId: { eq: task.id } } })).find((row) => !earlier.has(row.id));
    if (!completion) throw new Error(`completeTask recorded no completion for Task ${task.id}`);
    const [submission] = completion.submissionId === null ? [] : await tx.readSubmission({ filter: { id: { eq: completion.submissionId } } });
    return { outcome: "completed", task, completion, submission: submission ?? null, warnings: await blockReasonsOf(tx, task.id) } as const;
  }, context);
}

/**
 * `submission.submit` (PROTOCOL.md:313): a stale fence of the actor's records a late result and changes nothing
 * else; otherwise `submitSubmission` records the pending submission and releases the claim.
 */
export async function submissionSubmit(input: SubmitSubmissionInput, context: ActionContext, binding: Binding = connected): Promise<SubmissionSubmitted | LateResultRecorded> {
  return binding.transaction(async ({ actions, tx }) => {
    const now = binding.clock();
    const stale = staleClaim(await tx.readClaim({ filter: { taskId: { eq: input.task } } }), input.fence, context.actor.id, now);
    if (stale) {
      const lateResult = await actions.recordLateResult({ task: input.task, fence: stale.fence, summary: input.summary, evidence: input.evidence ?? [] });
      return { outcome: "late-result-recorded", lateResult } as const;
    }
    const submission = await actions.submitSubmission(input);
    return { outcome: "submitted", task: await taskOf(tx, submission.taskId), submission } as const;
  }, context);
}

/** `review.accept`: `acceptReview` settles the submission and completes the Task; the result adds the completion and the `warnings` (PROTOCOL.md:333). */
export async function reviewAccept(input: AcceptReviewInput, context: ActionContext, binding: Binding = connected): Promise<ReviewAccepted> {
  return binding.transaction(async ({ actions, tx }) => {
    const review = await actions.acceptReview(input);
    const [completion] = await tx.readCompletion({ filter: { submissionId: { eq: review.submissionId } } });
    if (!completion) throw new Error(`acceptReview recorded no completion for submission ${review.submissionId}`);
    return { task: await taskOf(tx, completion.taskId), review, completion, warnings: await blockReasonsOf(tx, completion.taskId) };
  }, context);
}

/**
 * `task.cancel` (`tasks/task/changes/settle_work.ex:14-33`): `cancelTask` revokes the claims and withdraws the
 * pending submission inside the Task aggregate; this function then cancels the Task's running runs, which belong to
 * the run aggregate, as nested calls (`system`): a Task manager who may not cancel a run (`run.canceler`) still
 * cancels the Task's, as Hyper's `nested_opts` does.
 */
export async function taskCancel(input: CancelTaskInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly task: Task }> {
  return binding.transaction(async ({ actions, tx }) => {
    const task = await actions.cancelTask(input);
    for (const run of await tx.readRun({ filter: { taskId: { eq: task.id }, state: { eq: "running" } } }))
      await actions.cancelRun({ id: run.id, reason: "task canceled" }, nested(context));
    return { task };
  }, context);
}
