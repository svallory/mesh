// Helpers for the execution entity files and functions. They take values (rows already loaded, ids), never the
// model; each names the Hyper change it follows. The ones whose names end in `Of` read through `tx`: a create's check
// sees its `self` before the input is applied (ACT-27), so it reads the run, the machine or the attempt the caller
// names by the id in `input` (POL-08).
import { claimsOf, currentAssignment, type AssignmentFacts, type Reads } from "../work/work.helpers";

/** `attempt.claimer` (`runs/attempt/rules.ex:15-30`): the actor holds a live claim on the run's Task. */
export async function claimerOf(tx: Reads, runId: string, actorId: string, now: Date): Promise<boolean> {
  const [run] = await tx.readRun({ filter: { id: { eq: runId } }, limit: 1 });
  if (!run) return false;
  return (await claimsOf(tx, run.taskId)).some((claim) => claim.state === "active" && claim.expiresAt.getTime() > now.getTime() && claim.holderId === actorId);
}

/** `attempt.run-running` and `run.parent-running`: the run exists and is running. */
export async function runRunningOf(tx: Reads, runId: string): Promise<boolean> {
  return (await tx.readRun({ filter: { id: { eq: runId } }, limit: 1 }))[0]?.state === "running";
}

/** `attempt.step-idle`: no attempt of `step` is running on the run. */
export async function stepIdleOf(tx: Reads, runId: string, step: string): Promise<boolean> {
  return (await tx.readAttempt({ filter: { runId: { eq: runId }, step: { eq: step }, state: { eq: "running" } }, limit: 1 })).length === 0;
}

/** `machine.retired`: the machine exists and is active. */
export async function machineActiveOf(tx: Reads, machineId: string): Promise<boolean> {
  return (await tx.readMachine({ filter: { id: { eq: machineId } }, limit: 1 }))[0]?.state === "active";
}

/** `invocation.session`: the session the attempt `attemptId` ran in, or null (also when there is no such attempt). */
export async function attemptSessionOf(tx: Reads, attemptId: string): Promise<string | null> {
  return (await tx.readAttempt({ filter: { id: { eq: attemptId } }, limit: 1 }))[0]?.sessionId ?? null;
}

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
