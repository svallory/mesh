// `@meshfw/event-sourcing`: the event-sourcing extension (ADR-0081, ADR-0094). This first slice gives `project(...)`,
// which makes handlers of the kind `project`: each builds a read model from every event it lists, from the beginning of
// history unless `from: "now"`. Core runs the kind through its contributed-kind point (`HANDLER_KIND`); this package
// decides where a project handler starts, refuses a start that would build a read model from part of the history
// (`MESH_HANDLER_HISTORY`), and records in the progress row's stored kind whether the history it handled is complete.
import { HANDLER_KIND, HandlerOptionError, MeshError } from "@meshfw/runtime";
import type {
  BusManifest, EventBusCapabilities, EventRecord, Handler, HandlerKind, HandlerProgressRow, HandlerTools, KindHandler,
  ListedEvent, MeshErrorOptions, Registration,
} from "@meshfw/runtime";

/**
 * `from`, as `project()` takes it. On a bus whose capabilities include `replay`, it may be left out ("beginning", the
 * default) or set to either value; on one without `replay`, it is required and can only be "now", so the default that
 * would fail at start is a type error too.
 */
export type FromOption = "replay" extends keyof EventBusCapabilities
  ? { readonly from?: "beginning" | "now" }
  : { readonly from: "now" };

/** A handler `project()` made: a `Handler` that carries the `project` kind and its `from`. */
export interface ProjectHandler<E extends object = object> extends Handler<E> {
  readonly from: "beginning" | "now";
}

/** Why a project handler failed to start, as `HandlerHistoryError.reason` names it. */
export type HistoryReason = "deleted" | "kept-below" | "kind" | "from";

/**
 * `MESH_HANDLER_HISTORY`: a project handler that starts from the beginning of history would build its read model from
 * part of that history, so delivery does not start. Raised in the registration transaction, before anything is written;
 * `connect()`, `startDelivery()` or `deliver()` rejects with it. Never retryable: the same start fails the same way until
 * the handler or the database changes.
 */
export class HandlerHistoryError extends MeshError {
  readonly code = "MESH_HANDLER_HISTORY";
  declare readonly retryable: false;
  /** The handler that failed to start. */
  readonly handler: string;
  /** The events whose history it would miss: all it lists for a new handler or a refused row, the added ones otherwise. */
  readonly events: readonly string[];
  /**
   * `"deleted"`: outbox rows have been deleted on this database; `"kept-below"`: a kept row of an added event lies at or
   * below the handler's position; `"kind"`: its progress row was registered under another kind; `"from"`: its progress
   * row started from now.
   */
  readonly reason: HistoryReason;

  constructor(handler: string, events: readonly string[], reason: HistoryReason, message: string, options?: Omit<MeshErrorOptions, "retryable">) {
    super(message, { ...options, retryable: false });
    this.handler = handler;
    this.events = Object.freeze([...events]);
    this.reason = reason;
  }
}

const OWNER = "@meshfw/event-sourcing";
const NOW = "project:now";

const fromOf = (handler: KindHandler): unknown => (handler.handler as Partial<ProjectHandler>).from ?? "beginning";
const quoted = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : typeof value === "object" || typeof value === "function" ? `a ${typeof value === "function" ? "function" : Array.isArray(value) ? "list" : "plain object"}` : String(value));
const listed = (events: readonly string[]): string => events.join(", ");

/** The remedy of a refused row: rebuild it while no row was ever deleted, else stay on `from: "now"`. */
function rebuildOr(handler: KindHandler, row: HandlerProgressRow, registration: Registration, otherwise: string): string {
  if (registration.deletedAny) return otherwise;
  if (row.name !== handler.name)
    return `Clear its read model and forget the former row (mesh events forget ${row.name}) to build it again, or leave out renamedFrom so that it starts as a new handler`;
  return `Clear its read model and forget it (mesh events forget ${handler.name}) to build it again, or register it under a new name`;
}

/** H4: a `from: "beginning"` handler whose row says nothing of the rows before it (R22). */
function refusedRow(handler: KindHandler, row: HandlerProgressRow, registration: Registration): HandlerHistoryError {
  const takes = row.name === handler.name ? "" : ` (it takes over the progress of ${JSON.stringify(row.name)}, renamedFrom)`;
  if (row.kind === NOW) {
    const message = `The project handler ${JSON.stringify(handler.name)} starts from the beginning of history (from: "beginning", the default)${takes}, and its progress row started from now (from: "now"), at a position after earlier rows: its read model lacks every event before that start. `
      + rebuildOr(handler, row, registration, `Keep from: "now" (rows have been deleted, so the history cannot be rebuilt)`);
    return new HandlerHistoryError(handler.name, handler.events, "from", message);
  }
  const message = `The handler ${JSON.stringify(handler.name)}${takes} was registered as a ${row.kind} handler and is now a project handler that starts from the beginning of history: its progress, at position ${row.position}, says nothing of the rows before it. `
    + rebuildOr(handler, row, registration, `Set from: "now" (rows have been deleted, so the history cannot be rebuilt)`);
  return new HandlerHistoryError(handler.name, handler.events, "kind", message);
}

/**
 * The `project` kind, as core receives it (ADR-0094). Its handlers run in the handler transaction with a quiet call chain
 * (core's), never skip an event, and start at position 0 (`from: "beginning"`) or at the highest position (`from: "now"`).
 * A progress row stores `"project"` while the history it handled is complete, and `"project:now"` otherwise.
 */
export const PROJECT: HandlerKind = Object.freeze({
  name: "project",
  owner: OWNER,
  check(handler: KindHandler, bus: BusManifest): void {
    const name = JSON.stringify(handler.name);
    const from = fromOf(handler);
    if (from !== "beginning" && from !== "now")
      throw new HandlerOptionError(handler.name, `The project handler ${name} has from ${quoted(from)}: it is "beginning" (the default) or "now"`);
    if ((handler.handler as { onFailure?: unknown }).onFailure === "skip")
      throw new HandlerOptionError(handler.name, `The project handler ${name} has onFailure "skip": a project handler never skips an event, since a read model built without one is wrong. Leave onFailure out (it defaults to "stop")`);
    if (from === "beginning" && !bus.capabilities.includes("replay"))
      throw new HandlerOptionError(handler.name, `The project handler ${name} starts from the beginning of history (from: "beginning", the default), which needs the bus's replay, and the bus ${bus.adapter} does not declare it. Set from: "now" and backfill the read model from current rows`);
  },
  async start(handler: KindHandler, registration: Registration): Promise<number> {
    if (fromOf(handler) === "now") return registration.highest;
    if (!registration.deletedAny) return 0;
    const one = handler.events.length === 1;
    throw new HandlerHistoryError(handler.name, handler.events, "deleted",
      `The project handler ${JSON.stringify(handler.name)} starts from the beginning of history, and outbox rows have been deleted on this database (up to position ${registration.deletedThrough}; keep is ${JSON.stringify(registration.keep)}), so its read model would be built from part of the history of ${listed(handler.events)}. Set from: "now" and backfill the read model from current rows. If ${one ? "this event is" : "these events are"} new and none has been published yet, from: "now" misses nothing`);
  },
  async adopt(handler: KindHandler, row: HandlerProgressRow, added: readonly string[], registration: Registration): Promise<void> {
    if (fromOf(handler) === "now") return;
    if (row.kind !== "project") throw refusedRow(handler, row, registration);
    if (added.length === 0) return;
    const name = JSON.stringify(handler.name);
    if (registration.deletedAny)
      throw new HandlerHistoryError(handler.name, added, "deleted",
        `The project handler ${name} now lists ${listed(added)}, and outbox rows have been deleted on this database (up to position ${registration.deletedThrough}), so it would miss part of ${added.length === 1 ? "that event's" : "those events'"} history. Set from: "now" (the handler keeps its position for the events it already lists) and backfill the read model for ${listed(added)} from current rows`);
    const kept = await registration.firstRow(registration.deletedThrough, row.position + 1, added);
    if (kept !== null)
      throw new HandlerHistoryError(handler.name, added, "kept-below",
        `The project handler ${name} now lists ${listed(added)}, and the kept row at position ${kept} (of an added event, or of a name no event declares) lies at or below its position, ${row.position}, so it would never be handled. `
        + (row.name === handler.name
          ? `Clear its read model and forget it (mesh events forget ${handler.name}) to build it again, register it under a new name, or set from: "now" and backfill`
          : `Clear its read model and forget the former row (mesh events forget ${row.name}) to build it again, leave out renamedFrom so that it starts as a new handler, or set from: "now" and backfill`));
  },
  stored(handler: KindHandler, row: HandlerProgressRow | undefined, added: readonly string[]): string {
    if (fromOf(handler) !== "now") return "project";
    return row?.kind === "project" && added.length === 0 ? "project" : NOW;
  },
});

/**
 * A project handler: builds a read model from every event it lists, from the beginning of history unless
 * `from: "now"`. Its body runs in the handler transaction and may neither publish nor dispatch. It never skips an event.
 * Returns the options, frozen, with `from` filled in and `[HANDLER_KIND]` set to `PROJECT`.
 */
export function project<const C extends readonly ListedEvent[]>(options: {
  readonly events: C;
  run(event: EventRecord<InstanceType<C[number]>>, tools: HandlerTools): void | Promise<void>;
  readonly renamedFrom?: string;
} & FromOption): ProjectHandler<InstanceType<C[number]>> {
  const from = (options as { from?: unknown }).from ?? "beginning";
  return Object.freeze({ ...options, from, [HANDLER_KIND]: PROJECT }) as unknown as ProjectHandler<InstanceType<C[number]>>;
}
