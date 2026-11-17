// A handler kind contributed the way an extension contributes one (ADR-0093), standing in for `project` from
// @meshfw/event-sourcing: `model(...)` makes a handler of the kind `model`, and `control` decides what its `check`,
// `start`, `adopt` and `stored` do, while `calls` records what core asked it.
import { HANDLER_KIND, Mesh, type EventRecord, type Handler, type HandlerKind, type HandlerTools, type ListedEvent } from "@meshfw/runtime";

export const calls: string[] = [];
const DEFAULTS: Pick<HandlerKind, "check" | "start" | "adopt" | "stored"> = {
  check() {},
  start: async () => 0,
  adopt: async () => {},
  stored: () => "model",
};
export const control: Pick<HandlerKind, "check" | "start" | "adopt" | "stored"> = { ...DEFAULTS };
export function resetKind(): void {
  Object.assign(control, DEFAULTS);
  calls.length = 0;
}

export const MODEL: HandlerKind = Object.freeze({
  name: "model",
  owner: "@meshfw/test-kind",
  check: (handler, bus) => { calls.push(`check ${handler.name}`); control.check(handler, bus); },
  start: (handler, registration) => { calls.push(`start ${handler.name}`); return control.start(handler, registration); },
  adopt: (handler, row, added, registration) => { calls.push(`adopt ${handler.name} ${row.kind} [${added.join(",")}]`); return control.adopt(handler, row, added, registration); },
  stored: (handler, row, added) => control.stored(handler, row, added),
});

export function model<const C extends readonly ListedEvent[]>(options: {
  readonly events: C;
  run(event: EventRecord<InstanceType<C[number]>>, tools: HandlerTools): void | Promise<void>;
  readonly onFailure?: "stop";
  readonly renamedFrom?: string;
}): Handler<InstanceType<C[number]>> {
  return Object.freeze({ ...Mesh.handler(options), [HANDLER_KIND]: MODEL });
}
