// The binding the event methods use (PROTOCOL.md §5, §8), including callbacks that run after the call that opened
// a subscription has returned. The daemon attaches it when it starts; an in-process test attaches its own.
import { Mesh } from "meshfw";
import { readEvents, type Binding } from "#mesh";
import { Workspace } from "#mesh/domain/identity";

interface EventLog {
  readonly binding: Binding;
}

let attached: EventLog | undefined;

/** Attaches the binding the event methods use; `undefined` detaches it. */
export function attachEventLog(log: EventLog | undefined): void {
  attached = log;
}

/** The attached event log; an `Error` when none is, which is a bug of whoever started the engine. */
export function eventLog(): EventLog {
  if (attached === undefined) throw new Error("the event methods were called before the engine attached its event log (attachEventLog)");
  return attached;
}

/**
 * The highest seq the log has assigned, 0 when it is empty: what `workspace.get` returns as `head`. It is read outside
 * any transaction (`readEvents` refuses one), so it can be ahead of what the caller's own transaction saw.
 */
export async function head(): Promise<number> {
  return eventLog().binding.run(async () => (await readEvents({ limit: 1 })).highest);
}

/** The workspace's id, which every wire event carries (`toWire` in `src/events.ts`), read with no policy on the binding in scope. */
export async function theWorkspaceId(): Promise<string> {
  const [workspace] = await Mesh.privileged(Workspace).read({ limit: 1 });
  if (workspace === undefined) throw new Error("the event log was read before bootstrap created the workspace");
  return workspace.id;
}
