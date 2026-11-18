import { describe, expect, test } from "bun:test";
import { DECLARATION, FrameworkError, HANDLER_KIND, HandlerOptionError, mergeHandlers, type EventBus, type HandlerKind, type KindHandler, type SectionHandlers } from "@meshfw/runtime";
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

/**
 * Section handlers (handlers design, H17 to H19): the handlers a `.mesh.mx` file's `handlers` section declares, which the
 * generated `bind` hands to `bindDomain` merged by `mergeHandlers`. `declaredHandlers` checks them with the events
 * module's, through the same checks, and the two sources share one set of names.
 */
describe("section handlers", () => {
  const section = (handlers: { process?: Record<string, object>; listen?: Record<string, object> }, at: Record<string, string> = {}): SectionHandlers =>
    ({ ...handlers, at: { ...Object.fromEntries(Object.keys({ ...handlers.process, ...handlers.listen }).map((key) => [key, `billing/invoice.mesh.mx:9:5`])), ...at } }) as SectionHandlers;
  const names = (declared: ReturnType<typeof declaredHandlers>) => declared.map((entry) => [entry.registered.name, entry.registered.kind, entry.registered.events, entry.registered.onFailure, entry.renamedFrom]);

  test("they are declared beside the module's, with their kind, sorted events and onFailure stop, the list sorted by name", () => {
    const module = { handlers: { listen: { log: plain() } } } as unknown as EventsModule;
    const declared = declaredHandlers(module, BUS, EVENTS, section({ process: { "billing.Invoice.settle": plain([Refunded, Paid]) }, listen: { "billing.Invoice.receipt": { ...plain(), renamedFrom: "billing.Invoice.mail" } } }));
    expect(names(declared)).toEqual([
      ["billing.Invoice.receipt", "listen", ["billing.InvoicePaid"], "stop", "billing.Invoice.mail"],
      ["billing.Invoice.settle", "process", ["billing.InvoicePaid", "billing.RefundIssued"], "stop", undefined],
      ["log", "listen", ["billing.InvoicePaid"], "stop", undefined],
    ]);
  });

  test("an empty module, a module with no handlers and no section at all declare what the other source holds", () => {
    expect(names(declaredHandlers({} as EventsModule, BUS, EVENTS, section({ listen: { "a.B.c": plain() } })))).toEqual([["a.B.c", "listen", ["billing.InvoicePaid"], "stop", undefined]]);
    expect(names(declaredHandlers({ handlers: { listen: { log: plain() } } } as unknown as EventsModule, BUS, EVENTS))).toEqual([["log", "listen", ["billing.InvoicePaid"], "stop", undefined]]);
    expect(declaredHandlers({} as EventsModule, BUS, EVENTS, section({}))).toEqual([]);
  });

  test("a module handler and a section handler with one key are MESH_HANDLER_OPTION, naming both sources", () => {
    const module = { handlers: { process: { "billing.Invoice.receipt": plain() } } } as unknown as EventsModule;
    const run = () => declaredHandlers(module, BUS, EVENTS, section({ listen: { "billing.Invoice.receipt": plain() } }));
    expect(run).toThrow(HandlerOptionError);
    expect(run).toThrow('The listen handler "billing.Invoice.receipt" has the name of a process handler: a handler\'s name is unique across every kind, since it keys the handler\'s progress row (one in the events module, one in billing/invoice.mesh.mx:9:5)');
  });

  test("one key under both kinds of a section is refused, naming where each is written", () => {
    const run = () => declaredHandlers({} as EventsModule, BUS, EVENTS, { process: { "a.B.c": plain() }, listen: { "a.B.c": plain() }, at: { "a.B.c": "a/b.mesh.mx:4:5" } } as unknown as SectionHandlers);
    expect(run).toThrow('The listen handler "a.B.c" has the name of a process handler: a handler\'s name is unique across every kind, since it keys the handler\'s progress row (one in a/b.mesh.mx:4:5, one in a/b.mesh.mx:4:5)');
  });

  test("a renamed-from across the two sources that names a registered handler, or that both name, is MESH_HANDLER_OPTION naming the sources", () => {
    // A section handler naming a module handler, and a module handler naming a section handler.
    const module = { handlers: { listen: { log: plain() } } } as unknown as EventsModule;
    const naming = () => declaredHandlers(module, BUS, EVENTS, section({ listen: { "billing.Invoice.receipt": { ...plain(), renamedFrom: "log" } } }));
    expect(naming).toThrow(HandlerOptionError);
    expect(naming).toThrow('The handler "billing.Invoice.receipt" has renamedFrom "log", a handler still registered: a running handler\'s progress is never taken over. Remove the option, or the old handler (billing.Invoice.receipt in billing/invoice.mesh.mx:9:5, log in the events module)');
    const back = { handlers: { listen: { log: { ...plain(), renamedFrom: "billing.Invoice.receipt" } } } } as unknown as EventsModule;
    expect(() => declaredHandlers(back, BUS, EVENTS, section({ listen: { "billing.Invoice.receipt": plain() } }))).toThrow('(log in the events module, billing.Invoice.receipt in billing/invoice.mesh.mx:9:5)');
    const twice = { handlers: { listen: { log: { ...plain(), renamedFrom: "billing.Invoice.old" } } } } as unknown as EventsModule;
    const both = () => declaredHandlers(twice, BUS, EVENTS, section({ listen: { "billing.Invoice.receipt": { ...plain(), renamedFrom: "billing.Invoice.old" } } }));
    expect(both).toThrow(HandlerOptionError);
    expect(both).toThrow('The handlers "log" and "billing.Invoice.receipt" both have renamedFrom "billing.Invoice.old": one progress row cannot move to two names (log in the events module, billing.Invoice.receipt in billing/invoice.mesh.mx:9:5)');
  });

  test("the module-only messages are unchanged: no sources are appended when no section handler is involved", () => {
    const module = { handlers: { listen: { log: { ...plain(), renamedFrom: "mail" }, mail: plain() } } } as unknown as EventsModule;
    expect(() => declaredHandlers(module, BUS, EVENTS, section({ listen: { "a.B.c": plain() } }))).toThrow(/^The handler "log" has renamedFrom "mail", a handler the events module still registers: a running handler's progress is never taken over\. Remove the option, or the old handler$/);
  });

  test("a section handler goes through the module's checks: a bus without ordered-delivery, an event of another domain", () => {
    const unordered = { manifest: { adapter: "test-bus", capabilities: [] }, create() { throw new Error("not created"); } } as unknown as EventBus;
    expect(() => declaredHandlers({} as EventsModule, unordered, EVENTS, section({ listen: { "a.B.c": plain() } })))
      .toThrow('The listen handler "a.B.c" needs the bus\'s ordered-delivery, since a handler\'s progress is kept by position only, and the bus test-bus does not declare it');
    const stranger = eventClass("billing.InvoicePaid");
    expect(() => declaredHandlers({} as EventsModule, BUS, EVENTS, section({ listen: { "a.B.c": plain([stranger]) } })))
      .toThrow('The listen handler "a.B.c" lists the event billing.InvoicePaid, which is not one of this binding\'s domain');
  });
});

describe("mergeHandlers", () => {
  const one = (key: string, kind: "process" | "listen" = "listen") => ({ [kind]: { [key]: plain() }, at: { [key]: `${key}.mesh.mx:1:1` } }) as unknown as SectionHandlers;

  test("merges the per-owner records by kind, keeping each key's place", () => {
    const merged = mergeHandlers([one("a.A.x"), one("b.B.y", "process"), one("b.B.z")]);
    expect(Object.keys(merged.listen ?? {})).toEqual(["a.A.x", "b.B.z"]);
    expect(Object.keys(merged.process ?? {})).toEqual(["b.B.y"]);
    expect(merged.at).toEqual({ "a.A.x": "a.A.x.mesh.mx:1:1", "b.B.y": "b.B.y.mesh.mx:1:1", "b.B.z": "b.B.z.mesh.mx:1:1" });
    expect(Object.isFrozen(merged)).toBe(true);
  });

  test("an empty list merges to no handler", () => {
    expect(mergeHandlers([])).toEqual({ process: {}, listen: {}, at: {} });
  });

  test("a key two records hold, under one kind or two, is a FrameworkError", () => {
    expect(() => mergeHandlers([one("a.A.x"), one("a.A.x", "process")])).toThrow(FrameworkError);
    expect(() => mergeHandlers([one("a.A.x"), one("a.A.x")])).toThrow('Two handlers sections declare the handler a.A.x (a.A.x.mesh.mx:1:1 and a.A.x.mesh.mx:1:1): a generated file was edited by hand; rebuild with mesh build');
  });
});
