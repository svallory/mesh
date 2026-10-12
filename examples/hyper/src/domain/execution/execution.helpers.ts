// Helpers for the execution entity files and functions. They take values (rows already loaded, ids), never the
// model; each names the Hyper change it follows. The ones whose names end in `Of` read through `privileged`: a create's check
// sees its `self` before the input is applied (ACT-27), so it reads the run, the machine or the attempt the caller
// names by the id in `input` (POL-08).
import { privileged } from "#mesh";
import { Attempt, Invocation, Machine, Run } from "#mesh/domain/execution";
import { Assignment } from "#mesh/domain/work";
import { roleOf } from "../identity/identity.helpers";
import { claimsOf, currentAssignment, type AssignmentFacts } from "../work/work.helpers";

/**
 * Policy `attemptClaimer`, Hyper's `attempt.claimer` (`runs/checks/reporter.ex:35-41`, `:84-91`, and the rule
 * `runs/attempt/rules.ex:15-30`, a permission denial through `Role.deny`): the actor holds a live claim on the run's
 * Task. A run that does not exist passes, as in Hyper, and `attempt.run-running` reports it.
 */
export async function claimerOf(runId: string, actorId: string, now: Date): Promise<boolean> {
  const [run] = await privileged(Run).read({ filter: { id: { eq: runId } }, limit: 1 });
  if (!run) return true;
  return (await claimsOf(run.taskId)).some((claim) => claim.state === "active" && claim.expiresAt.getTime() > now.getTime() && claim.holderId === actorId);
}

/**
 * Policy `runCanceler`, Hyper's `run.canceler` (`runs/checks/reporter.ex:71-82`): an owner, the run's responsible
 * collaborator, its starter or the Task's current delegator.
 */
export async function cancelsRunOf(run: { readonly taskId: string; readonly responsibleId: string; readonly startedById: string }, actorId: string): Promise<boolean> {
  if ((await roleOf(actorId)) === "owner") return true;
  if (actorId === run.responsibleId || actorId === run.startedById) return true;
  const assignments = await privileged(Assignment).read({ filter: { taskId: { eq: run.taskId }, endedAt: { nil: true } } });
  return currentAssignment(assignments)?.delegatorId === actorId;
}

/**
 * Policy `attemptPerformer` on `invocation.record`, Hyper's `attempt.performer` (`runs/checks/reporter.ex:43-50`):
 * the actor performs the attempt. An attempt that does not exist passes, as in Hyper.
 */
export async function performsAttemptOf(attemptId: string, actorId: string): Promise<boolean> {
  const [attempt] = await privileged(Attempt).read({ filter: { id: { eq: attemptId } }, limit: 1 });
  return attempt === undefined || attempt.performerId === actorId;
}

/**
 * Policy `invocationRecorder`, Hyper's `invocation.recorder` (`runs/checks/reporter.ex:52-69`): the corrected
 * invocation's recorder, or an owner. An invocation that does not exist, or none named, passes, as in Hyper.
 */
export async function correctsInvocationOf(invocationId: string | null | undefined, actorId: string): Promise<boolean> {
  if (invocationId == null) return true;
  const [invocation] = await privileged(Invocation).read({ filter: { id: { eq: invocationId } }, limit: 1 });
  if (invocation === undefined || invocation.recordedById === actorId) return true;
  return (await roleOf(actorId)) === "owner";
}

/** `attempt.run-running` and `run.parent-running`: the run exists and is running. */
export async function runRunningOf(runId: string): Promise<boolean> {
  return (await privileged(Run).read({ filter: { id: { eq: runId } }, limit: 1 }))[0]?.state === "running";
}

/** `attempt.step-idle`: no attempt of `step` is running on the run. */
export async function stepIdleOf(runId: string, step: string): Promise<boolean> {
  return (await privileged(Attempt).read({ filter: { runId: { eq: runId }, step: { eq: step }, state: { eq: "running" } }, limit: 1 })).length === 0;
}

/** `machine.retired`: the machine exists and is active. */
export async function machineActiveOf(machineId: string): Promise<boolean> {
  return (await privileged(Machine).read({ filter: { id: { eq: machineId } }, limit: 1 }))[0]?.state === "active";
}

/** `invocation.session`: the session the attempt `attemptId` ran in, or null (also when there is no such attempt). */
export async function attemptSessionOf(attemptId: string): Promise<string | null> {
  return (await privileged(Attempt).read({ filter: { id: { eq: attemptId } }, limit: 1 }))[0]?.sessionId ?? null;
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
