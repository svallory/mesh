import { describe, expect, test } from "bun:test";
import { DECLARATION, FrameworkError, HANDLER_KIND, type EventBus, type HandlerKind, type KindHandler } from "@meshfw/runtime";
import { declaredHandlers } from "../src/deliverer.ts";
import type { EventClass, EventsModule } from "../src/events.ts";

/**
 * `declaredHandlers` called directly (ADR-0094): the kind checks it repeats for a caller that does not go through
 * `loadEvents`, and what a contributed kind's `check` is handed.
 */

function eventClass(fqn: string): EventClass {
  class Event { constructor(_fields: never) {} }
  return Object.assign(Event, { [DECLARATION]: { kind: "event" as const, fqn, is: (value: unknown): value is object => value instanceof Event } }) as unknown as EventClass;
}
const Paid = eventClass("billing.InvoicePaid");
const Refunded = eventClass("billing.RefundIssued");
const EVENTS = new Map([[ "billing.InvoicePaid", Paid ], [ "billing.RefundIssued", Refunded ]]);
const BUS = { manifest: { adapter: "test-bus", capabilities: ["ordered-delivery"] }, create() { throw new Error("not created"); } } as unknown as EventBus;

function modelKind(checked: KindHandler[] = []): HandlerKind {
  return Object.freeze({
    name: "model", owner: "@meshfw/test-kind",
    check: (handler: KindHandler) => { checked.push(handler); },
    start: async () => 0, adopt: async () => {}, stored: () => "model",
  });
}
const plain = (events: readonly EventClass[] = [Paid]) => ({ events, run() {} });
const carrying = (kind: HandlerKind, events: readonly EventClass[] = [Paid]) => ({ ...plain(events), [HANDLER_KIND]: kind });

describe("declaredHandlers", () => {
  test("a handler of a contributed kind listed under another kind's key is refused, naming the key it belongs under", () => {
    const module = { handlers: { process: { x: carrying(modelKind()) } } } as unknown as EventsModule;
    const run = () => declaredHandlers(module, BUS, EVENTS);
    expect(run).toThrow(FrameworkError);
    expect(run).toThrow('The events module lists the model handler "x" under handlers.process: list it under handlers.model');
  });

  test("a handler that carries no kind under a contributed kind's key is refused", () => {
    const module = { handlers: { model: { x: plain() } } } as unknown as EventsModule;
    const run = () => declaredHandlers(module, BUS, EVENTS);
    expect(run).toThrow(FrameworkError);
    expect(run).toThrow('The events module\'s handlers has the kind "model", and its handler "x" is not one an extension made for that kind: the kinds are process, listen and those an extension\'s handlers carry, such as project from @meshfw/event-sourcing');
  });

  test("core's keys are read first, so a misplaced handler under process is reported before a contributed key's", () => {
    const module = { handlers: { model: { y: plain() }, process: { x: carrying(modelKind()) } } } as unknown as EventsModule;
    expect(() => declaredHandlers(module, BUS, EVENTS)).toThrow('The events module lists the model handler "x" under handlers.process: list it under handlers.model');
  });

  test("check is handed the handler with its events sorted and without duplicates, frozen", () => {
    const checked: KindHandler[] = [];
    const kind = modelKind(checked);
    const handler = carrying(kind, [Refunded, Paid, Refunded]);
    const [declared] = declaredHandlers({ handlers: { model: { totals: handler } } } as unknown as EventsModule, BUS, EVENTS);
    expect(checked.length).toBe(1);
    expect(checked[0]!.name).toBe("totals");
    expect(checked[0]!.events).toEqual(["billing.InvoicePaid", "billing.RefundIssued"]);
    expect(Object.isFrozen(checked[0]!.events)).toBe(true);
    expect(checked[0]!.handler).toBe(handler as never);
    expect(declared!.registered).toEqual({ name: "totals", kind: "model", events: ["billing.InvoicePaid", "billing.RefundIssued"], onFailure: "stop" });
    expect(declared!.kind).toBe(kind);
  });
});
