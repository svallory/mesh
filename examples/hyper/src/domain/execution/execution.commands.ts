// The execution commands whose effects cross aggregates: an attempt or a session report names its machine by host
// name, and an unknown name records the Machine (`machines/changes/report_machine.ex:23-43`), which is its own
// aggregate (`machines.ex:2`). Each is one application transaction over the generated actions. Names follow Hyper's
// method names in camelCase, so none can be a `#mesh` export (those put the action first).
import type { ActionContext } from "@meshfw/runtime";
import type { Actions, Attempt, RecordSessionReferenceInput, SessionReference, StartAttemptInput } from "#mesh";
import { connected, type Binding } from "../binding";
import type { Reads } from "../work/work.helpers";

/**
 * The Machine a report names: the one with that name, or a new one through `reportMachine` with the reporter as
 * actor. A retired one is returned too; the action that records the report refuses it (`machine.retired`).
 */
async function machineNamed(actions: Actions, tx: Reads, name: string): Promise<string> {
  const [machine] = await tx.readMachine({ filter: { name: { eq: name } }, limit: 1 });
  return machine ? machine.id : (await actions.reportMachine({ name })).id;
}

export type AttemptStartInput = Omit<StartAttemptInput, "machine"> & { readonly machine?: string | null };

/** `attempt.start` (`runs/attempt.ex:52-67`): resolves the machine by name, then `startAttempt`. */
export async function attemptStart(input: AttemptStartInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly attempt: Attempt }> {
  return binding.transaction(async ({ actions, tx }) => {
    const machine = input.machine == null ? null : await machineNamed(actions, tx, input.machine);
    return { attempt: await actions.startAttempt({ ...input, machine }) };
  }, context);
}

export type SessionRecordInput = Omit<RecordSessionReferenceInput, "machine"> & { readonly machine: string };

/** `session.record` (`sessions/session_reference.ex:37-40`): resolves the machine by name, then `recordSessionReference`. */
export async function sessionRecord(input: SessionRecordInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly sessionReference: SessionReference }> {
  return binding.transaction(async ({ actions, tx }) => {
    const machine = await machineNamed(actions, tx, input.machine);
    return { sessionReference: await actions.recordSessionReference({ ...input, machine }) };
  }, context);
}
