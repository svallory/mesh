// Helpers for the execution entity files and functions. They take values (rows already loaded, ids), never the
// model; each names the Hyper change it follows.
import { currentAssignment, type AssignmentFacts } from "../work/work.helpers";

/** `run.start`'s responsible collaborator (`runs/run/changes/start_run.ex:9-23`): the Task's assignee, else the starter. */
export function responsibleFor(assignments: readonly AssignmentFacts[], actorId: string): string {
  return currentAssignment(assignments)?.assigneeId ?? actorId;
}

/** `attempt.start`'s number (`runs/attempt/changes/start_attempt.ex:28-36`): the run's attempts at that step, plus one. */
export function nextNumber(attempts: readonly { readonly step: string }[], step: string): number {
  return attempts.filter((attempt) => attempt.step === step).length + 1;
}

/** `attempt.start`'s delegator (`start_attempt.ex:38-41`): the Task's current delegator, else the run's starter. */
export function delegatorFor(assignments: readonly AssignmentFacts[], startedById: string): string {
  return currentAssignment(assignments)?.delegatorId ?? startedById;
}

type Reported = Readonly<Record<string, unknown>>;

/**
 * An ended attempt's `outcome` (`runs/attempt/changes/end_attempt.ex:7-15`): the reported values, keyed by name, that
 * are neither null nor an empty list or map.
 */
export function attemptOutcome(reported: Reported): Record<string, unknown> {
  const empty = (value: unknown) => value === null || value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
  return Object.fromEntries(Object.entries(reported).filter(([, value]) => !empty(value)));
}

/** Whether a reported error is marked retryable (`runs/attempt/changes/settle_run.ex:16-17`). */
export function isRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true;
}

/** Whether `attempt.finish` settles its run (`settle_run.ex:18-27`): the run is running, and the attempt succeeded or its error is not retryable. */
export function settlesRun(runState: string, result: string, error: unknown): boolean {
  return runState === "running" && (result === "succeeded" || !isRetryable(error));
}
