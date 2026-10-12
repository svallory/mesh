// The execution commands whose effects cross aggregates: an attempt or a session report names its machine by host
// name, and an unknown name records the Machine (`machines/changes/report_machine.ex:23-43`), which is its own
// aggregate (`machines.ex:2`). Each is one application transaction over the generated actions. Names follow Hyper's
// method names in camelCase (`attempt.start` is `attemptStart`); a generated action is a method of the entity's value
// (`Attempt.start`, from `#mesh/domain/execution`).
import type { ActionContext } from "@meshfw/runtime";
import { privileged } from "#mesh";
import { Attempt, Machine, SessionReference, type RecordSessionReferenceInput, type StartAttemptInput } from "#mesh/domain/execution";
import { nested } from "../../context";
import { connected, type Binding } from "../binding";

/**
 * The Machine a report names: the one with that name, or a new one through `Machine.report` with the reporter as
 * actor, as a nested call (`system`, as Hyper's `nested_opts`). A retired one is returned too; the action that
 * records the report refuses it (`machine.retired`).
 */
async function machineNamed(name: string, context: ActionContext): Promise<string> {
  const [machine] = await privileged(Machine).read({ filter: { name: { eq: name } }, limit: 1 });
  return machine ? machine.id : (await Machine.report({ name }, nested(context))).id;
}

export type AttemptStartInput = Omit<StartAttemptInput, "machine"> & { readonly machine?: string | null };

/** `attempt.start` (`runs/attempt.ex:52-67`): resolves the machine by name, then `Attempt.start`. */
export async function attemptStart(input: AttemptStartInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly attempt: Attempt }> {
  return binding.transaction(async () => {
    const machine = input.machine == null ? null : await machineNamed(input.machine, context);
    return { attempt: await Attempt.start({ ...input, machine }, context) };
  });
}

export type SessionRecordInput = Omit<RecordSessionReferenceInput, "machine"> & { readonly machine: string };

/** `session.record` (`sessions/session_reference.ex:37-40`): resolves the machine by name, then `SessionReference.record`. */
export async function sessionRecord(input: SessionRecordInput, context: ActionContext, binding: Binding = connected): Promise<{ readonly sessionReference: SessionReference }> {
  return binding.transaction(async () => {
    const machine = await machineNamed(input.machine, context);
    return { sessionReference: await SessionReference.record({ ...input, machine }, context) };
  });
}
