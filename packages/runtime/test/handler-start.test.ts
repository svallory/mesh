import { describe, expect, test } from "bun:test";
import type { HandlerProgressRow, RegisteredHandler } from "@meshfw/runtime";
import { handlerStart } from "../src/deliverer.ts";

/**
 * The spec's Registration table ("Events and commands", "Registration") as one function: what each declared handler's
 * progress row starts as, whatever claim strategy writes it.
 */

function declared(name: string, events: readonly string[], renamedFrom?: string): { registered: RegisteredHandler; renamedFrom: string | undefined } {
  return { registered: Object.freeze({ name, kind: "process", events: Object.freeze([...events]), onFailure: "stop" }), renamedFrom };
}
function progress(...rows: HandlerProgressRow[]): ReadonlyMap<string, HandlerProgressRow> {
  return new Map(rows.map((row) => [row.name, row]));
}
const row = (name: string, position: number, events: readonly string[], kind: "process" | "listen" = "process"): HandlerProgressRow =>
  ({ name, kind, position, events, generation: 3 });

describe("handlerStart", () => {
  test("a new handler starts at the highest position ever assigned, with its own list, and logs nothing", () => {
    const start = handlerStart(declared("notify", ["billing.InvoicePaid"]), progress(), 812);
    expect(start).toEqual({ row: { name: "notify", kind: "process", position: 812, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });

  test("a known handler keeps its position and takes the list it registers now", () => {
    const start = handlerStart(declared("notify", ["billing.InvoicePaid"]), progress(row("notify", 40, ["billing.InvoicePaid", "billing.InvoiceVoided"])), 812);
    expect(start).toEqual({ row: { name: "notify", kind: "process", position: 40, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });

  test("an event added to a known handler's list is logged with the position it is handled from", () => {
    const start = handlerStart(declared("notify", ["billing.InvoicePaid", "billing.InvoiceVoided"]), progress(row("notify", 40, ["billing.InvoicePaid"])), 812);
    expect(start.row.position).toBe(40);
    expect(start.logs).toEqual(['Mesh: the handler "notify" now lists billing.InvoiceVoided, handled from position 40 on']);
  });

  test("the kind is the one registered now, not the stored one", () => {
    const start = handlerStart({ ...declared("notify", ["billing.InvoicePaid"]), registered: Object.freeze({ name: "notify", kind: "listen", events: ["billing.InvoicePaid"], onFailure: "stop" }) },
      progress(row("notify", 40, ["billing.InvoicePaid"], "process")), 812);
    expect(start.row.kind).toBe("listen");
  });

  test("renamedFrom takes over the former row's position and names it for deletion", () => {
    const start = handlerStart(declared("mail", ["billing.InvoicePaid"], "notify"), progress(row("notify", 40, ["billing.InvoicePaid"])), 812);
    expect(start).toEqual({
      row: { name: "mail", kind: "process", position: 40, events: ["billing.InvoicePaid"] },
      former: "notify",
      logs: ['Mesh: the handler "mail" takes over the progress of "notify" (renamedFrom), at position 40'],
    });
  });

  test("a rename that also adds an event logs both lines, the takeover first", () => {
    const start = handlerStart(declared("mail", ["billing.InvoicePaid", "billing.InvoiceVoided"], "notify"), progress(row("notify", 40, ["billing.InvoicePaid"])), 812);
    expect(start.former).toBe("notify");
    expect(start.logs).toEqual([
      'Mesh: the handler "mail" takes over the progress of "notify" (renamedFrom), at position 40',
      'Mesh: the handler "mail" now lists billing.InvoiceVoided, handled from position 40 on',
    ]);
  });

  test("renamedFrom is ignored once the new name has a row of its own", () => {
    const start = handlerStart(declared("mail", ["billing.InvoicePaid"], "notify"), progress(row("mail", 70, ["billing.InvoicePaid"]), row("notify", 40, ["billing.InvoicePaid"])), 812);
    expect(start).toEqual({ row: { name: "mail", kind: "process", position: 70, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });

  test("renamedFrom naming no row starts the handler as a new one", () => {
    const start = handlerStart(declared("mail", ["billing.InvoicePaid"], "notify"), progress(), 812);
    expect(start).toEqual({ row: { name: "mail", kind: "process", position: 812, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });
});
