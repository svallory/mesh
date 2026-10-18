// `events.read`, `events.subscribe` and `events.unsubscribe` (PROTOCOL.md §5, §8). A read pages the outbox through
// `readEvents`; a subscription is a Mesh subscription (`subscribe` of `#mesh`) under a fresh name, whose callback
// notifies the connection that opened it (`events.event { subscriptionId, event }`). The spec's filters are applied
// here: `types` become event FQNs for Mesh's `names`, and `taskSubtree` keeps the events whose `taskId` is that Task
// or one of its descendants at the time the event is read or delivered.
import type { Connection } from "@meshfw/jsonrpc";
import { Mesh } from "meshfw";
import { forgetSubscription, readEvents, subscribe, type Subscription } from "#mesh";
import { Task } from "#mesh/domain/work";
import { FQN_OF_WIRE_TYPE, toWire, type WireEvent } from "../events";
import { eventLog, head, theWorkspaceId } from "./event-log";

/** `events.read`'s default and largest `limit` (PROTOCOL.md §5). */
export const DEFAULT_LIMIT = 100;

/** Mesh's `names` filter for the spec's `types`: a type no event has matches nothing, so it is dropped. */
function namesOf(types: readonly string[] | undefined): string[] | undefined {
  if (types === undefined) return undefined;
  return types.flatMap((type) => {
    const fqn = FQN_OF_WIRE_TYPE.get(type);
    return fqn === undefined ? [] : [fqn];
  });
}

/**
 * True when the Task `taskId` is `root` or below it, read now with no policy: the walk follows `parentId` up from the
 * event's Task. A Task moved since the event names the subtree it is in now ("current descendants", PROTOCOL.md §5).
 */
async function inSubtree(taskId: string | null, root: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let id = taskId; id !== null && !seen.has(id); ) {
    if (id === root) return true;
    seen.add(id);
    const [task] = await Mesh.privileged(Task).read({ filter: { id: { eq: id } }, limit: 1 });
    id = task?.parentId ?? null;
  }
  return false;
}

/** What `events.read` takes, past its schema. */
export interface ReadParams {
  readonly after: number;
  readonly limit?: number;
  readonly taskSubtree?: string;
  readonly types?: readonly string[];
}

/**
 * `events.read`: a page of at most `limit` events after the cursor `after`, in seq order. The cursor is the seq of the
 * last event scanned, filtered ones included, so the next page never reads one again; `hasMore` is true while the log
 * holds events above it. Runs outside any transaction, as `readEvents` requires.
 */
export async function readPage(params: ReadParams): Promise<{ events: WireEvent[]; cursor: number; hasMore: boolean }> {
  const page = await readEvents({ after: params.after, limit: params.limit ?? DEFAULT_LIMIT, names: namesOf(params.types) });
  const workspaceId = page.events.length === 0 ? "" : await theWorkspaceId();
  const events: WireEvent[] = [];
  for (const record of page.events) {
    const wire = toWire(record, workspaceId);
    if (params.taskSubtree === undefined || (await inSubtree(wire.taskId, params.taskSubtree))) events.push(wire);
  }
  return { events, cursor: page.cursor, hasMore: page.cursor < (await head()) };
}

/** One open subscription: Mesh's handle and the connection it notifies. */
interface Open {
  readonly subscription: Subscription;
  readonly connection: Connection;
}

/** Every subscription this process serves, by its id. */
const served = new Map<string, Open>();
/** The timer that closes the subscriptions of connections that went away; runs only while one is open. */
let sweeping: ReturnType<typeof setInterval> | undefined;

/** How often the subscriptions of closed connections are closed. */
const SWEEP_MS = 500;

/** Closes subscription `id` and drops its row, so it holds nothing once its client is gone. */
async function end(id: string): Promise<void> {
  const entry = served.get(id);
  if (entry === undefined) return;
  served.delete(id);
  if (served.size === 0 && sweeping !== undefined) {
    clearInterval(sweeping);
    sweeping = undefined;
  }
  await entry.subscription.close();
  await eventLog().binding.run(() => forgetSubscription(id));
}

/** Starts the sweep that ends the subscriptions whose connection closed (`@meshfw/jsonrpc` reports it as `closed`). */
function watchConnections(): void {
  sweeping ??= setInterval(() => {
    for (const [id, entry] of served)
      if (entry.connection.closed) void end(id).catch((error: unknown) => console.error(`could not close subscription ${id}`, error));
  }, SWEEP_MS);
  sweeping.unref?.();
}

/** What `events.subscribe` takes, past its schema. */
export interface SubscribeParams {
  readonly after: number;
  readonly taskSubtree?: string;
  readonly types?: readonly string[];
}

/**
 * `events.subscribe` (PROTOCOL.md §8): opens a subscription from the cursor `after` and returns its id. Every matching
 * event is then sent as an `events.event` notification on this connection, in seq order, each once. Notifications wait
 * until the response is written, so the client always learns the id first. The subscription ends on
 * `events.unsubscribe` or when the connection closes.
 */
export async function openSubscription(params: SubscribeParams, connection: Connection): Promise<{ subscriptionId: string }> {
  const subscriptionId = crypto.randomUUID();
  const { binding } = eventLog();
  // Every wire event carries the workspace id, which never changes once bootstrap created the workspace: read it once.
  const workspaceId = await theWorkspaceId();
  // The server writes the response once this call resolves, before the next turn of the event loop: the gate opens on
  // that turn, and Mesh hands the callback one event at a time, so the notifications keep seq order behind it.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const subscription = await subscribe({ name: subscriptionId, after: params.after, names: namesOf(params.types) }, async (record) => {
    await gate;
    const wire = await binding.run(async () => {
      const event = toWire(record, workspaceId);
      return params.taskSubtree === undefined || (await inSubtree(event.taskId, params.taskSubtree)) ? event : undefined;
    });
    if (wire !== undefined) connection.notify("events.event", { subscriptionId, event: wire as unknown as Record<string, unknown> });
  });
  served.set(subscriptionId, { subscription, connection });
  // Mesh ends a stream on its own when the callback throws, the queue overflows or another process takes the database;
  // `done` then resolves with the error (null after `close()` or delivery's stop, which `end` already handles). The
  // subscription is ended here too, so its row is dropped; the connection stays open, since `@meshfw/jsonrpc` gives
  // the server no way to close one.
  void subscription.done.then((error) => {
    if (error === null || !served.has(subscriptionId)) return;
    console.error(`subscription ${subscriptionId} ended on its own`, error);
    return end(subscriptionId);
  }).catch((error: unknown) => console.error(`could not close subscription ${subscriptionId}`, error));
  watchConnections();
  setImmediate(release);
  return { subscriptionId };
}

/** `events.unsubscribe`: ends the subscription; an id that names none is answered the same, since the stream is over either way. */
export async function closeSubscription(subscriptionId: string): Promise<{ ok: true }> {
  await end(subscriptionId);
  return { ok: true };
}

/** Ends every subscription this process serves: the daemon calls it before it stops delivery. */
export async function closeAll(): Promise<void> {
  await Promise.all([...served.keys()].map((id) => end(id)));
}
