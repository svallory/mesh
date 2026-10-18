// What the event methods need beyond an entity call (PROTOCOL.md §5, §8): the data layer, for the log's head
// (`workspace.get`'s `head`, `events.read`'s `hasMore`), and the binding, for a subscription's filter, which runs after
// the call that opened it has returned. The daemon attaches both when it starts; an in-process test attaches its own.
import type { DataLayer } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import type { Binding } from "#mesh";
import { Workspace } from "#mesh/domain/identity";

interface EventLog {
  readonly layer: DataLayer;
  readonly binding: Binding;
}

let attached: EventLog | undefined;

/** Attaches the data layer and the binding the event methods use; `undefined` detaches them. */
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
 * any transaction (the data layer's `readOutbox` refuses one), so it can be ahead of what the caller's own transaction saw.
 */
export async function head(): Promise<number> {
  const { layer } = eventLog();
  if (typeof layer.readOutbox !== "function") throw new Error("the data layer has no readOutbox");
  return (await layer.readOutbox(0, 1)).highest;
}

/** The workspace's id, which every wire event carries (`toWire` in `src/events.ts`), read with no policy on the binding in scope. */
export async function theWorkspaceId(): Promise<string> {
  const [workspace] = await Mesh.privileged(Workspace).read({ limit: 1 });
  if (workspace === undefined) throw new Error("the event log was read before bootstrap created the workspace");
  return workspace.id;
}
