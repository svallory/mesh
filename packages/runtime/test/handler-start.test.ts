import { describe, expect, test } from "bun:test";
import { FrameworkError, type Handler, type HandlerKind, type HandlerProgressRow, type KindHandler, type Registration, type RegisteredHandler } from "@meshfw/runtime";
import { handlerStart } from "../src/deliverer.ts";

/**
 * The spec's Registration table ("Events and commands", "Registration") as one function: what each declared handler's
 * progress row starts as, whatever claim strategy writes it; and, for a handler of a kind an extension contributes
 * (ADR-0093), what its kind's `start`, `adopt` and `stored` decide.
 */

const HANDLER: Handler = Object.freeze({ events: [], run() {} });
function declared(name: string, events: readonly string[], renamedFrom?: string, kind?: HandlerKind) {
  const registered: RegisteredHandler = Object.freeze({ name, kind: kind?.name ?? "process", events: Object.freeze([...events]), onFailure: "stop" });
  return { registered, renamedFrom, handler: HANDLER, ...(kind ? { kind } : {}) };
}
function progress(...rows: HandlerProgressRow[]): ReadonlyMap<string, HandlerProgressRow> {
  return new Map(rows.map((row) => [row.name, row]));
}
const row = (name: string, position: number, events: readonly string[], kind = "process"): HandlerProgressRow =>
  ({ name, kind, position, events, generation: 3 });
/** A registration over a database whose positions run from `deletedThrough` to `highest`; `firstRow` answers `first`. */
function registration(highest: number, deletedThrough = 0, first: number | null = null): Registration & { asked: unknown[][] } {
  const asked: unknown[][] = [];
  return {
    deletedThrough, deletedAny: deletedThrough > 0, highest, keep: "all", asked,
    firstRow: async (...args: unknown[]) => { asked.push(args); return first; },
  };
}

/** A kind that records what core asks it and answers what the test sets. */
function testKind(answers: { start?: unknown; stored?: unknown; adopt?: (row: HandlerProgressRow, added: readonly string[], at: Registration) => Promise<void> } = {}) {
  const calls: string[] = [];
  const seen: { handler?: KindHandler; row?: HandlerProgressRow | undefined; added?: readonly string[] } = {};
  const kind: HandlerKind = {
    name: "model", owner: "@meshfw/test-kind",
    check() {},
    async start(handler, at) { calls.push("start"); seen.handler = handler; return ("start" in answers ? answers.start : at.highest) as number; },
    async adopt(handler, found, added, at) { calls.push("adopt"); seen.handler = handler; seen.row = found; seen.added = added; await answers.adopt?.(found, added, at); },
    stored(_handler, found, added) { calls.push(`stored ${found?.kind ?? "-"} [${added.join(",")}]`); return ("stored" in answers ? answers.stored : "model") as string; },
  };
  return { kind, calls, seen };
}
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("handlerStart", () => {
  test("a new handler starts at the highest position ever assigned, with its own list, and logs nothing", async () => {
    const start = await handlerStart(declared("notify", ["billing.InvoicePaid"]), progress(), registration(812));
    expect(start).toEqual({ row: { name: "notify", kind: "process", position: 812, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });

  test("a known handler keeps its position and takes the list it registers now", async () => {
    const start = await handlerStart(declared("notify", ["billing.InvoicePaid"]), progress(row("notify", 40, ["billing.InvoicePaid", "billing.InvoiceVoided"])), registration(812));
    expect(start).toEqual({ row: { name: "notify", kind: "process", position: 40, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });

  test("an event added to a known handler's list is logged with the position it is handled from", async () => {
    const start = await handlerStart(declared("notify", ["billing.InvoicePaid", "billing.InvoiceVoided"]), progress(row("notify", 40, ["billing.InvoicePaid"])), registration(812));
    expect(start.row.position).toBe(40);
    expect(start.logs).toEqual(['Mesh: the handler "notify" now lists billing.InvoiceVoided, handled from position 40 on']);
  });

  test("the kind is the one registered now, not the stored one", async () => {
    const start = await handlerStart({ ...declared("notify", ["billing.InvoicePaid"]), registered: Object.freeze({ name: "notify", kind: "listen", events: ["billing.InvoicePaid"], onFailure: "stop" }) },
      progress(row("notify", 40, ["billing.InvoicePaid"], "process")), registration(812));
    expect(start.row.kind).toBe("listen");
  });

  test("renamedFrom takes over the former row's position and names it for deletion", async () => {
    const start = await handlerStart(declared("mail", ["billing.InvoicePaid"], "notify"), progress(row("notify", 40, ["billing.InvoicePaid"])), registration(812));
    expect(start).toEqual({
      row: { name: "mail", kind: "process", position: 40, events: ["billing.InvoicePaid"] },
      former: "notify",
      logs: ['Mesh: the handler "mail" takes over the progress of "notify" (renamedFrom), at position 40'],
    });
  });

  test("a rename that also adds an event logs both lines, the takeover first", async () => {
    const start = await handlerStart(declared("mail", ["billing.InvoicePaid", "billing.InvoiceVoided"], "notify"), progress(row("notify", 40, ["billing.InvoicePaid"])), registration(812));
    expect(start.former).toBe("notify");
    expect(start.logs).toEqual([
      'Mesh: the handler "mail" takes over the progress of "notify" (renamedFrom), at position 40',
      'Mesh: the handler "mail" now lists billing.InvoiceVoided, handled from position 40 on',
    ]);
  });

  test("renamedFrom is ignored once the new name has a row of its own", async () => {
    const start = await handlerStart(declared("mail", ["billing.InvoicePaid"], "notify"), progress(row("mail", 70, ["billing.InvoicePaid"]), row("notify", 40, ["billing.InvoicePaid"])), registration(812));
    expect(start).toEqual({ row: { name: "mail", kind: "process", position: 70, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });

  test("renamedFrom naming no row starts the handler as a new one", async () => {
    const start = await handlerStart(declared("mail", ["billing.InvoicePaid"], "notify"), progress(), registration(812));
    expect(start).toEqual({ row: { name: "mail", kind: "process", position: 812, events: ["billing.InvoicePaid"] }, former: undefined, logs: [] });
  });
});

describe("handlerStart with a contributed kind", () => {
  test("a new handler starts where its kind's start says, anywhere from the deleted-through position to the highest", async () => {
    for (const [at, deletedThrough, highest] of [[0, 0, 12], [7, 3, 12], [3, 3, 12], [12, 3, 12]] as const) {
      const { kind, calls, seen } = testKind({ start: at });
      const start = await handlerStart(declared("totals", ["billing.InvoicePaid"], undefined, kind), progress(), registration(highest, deletedThrough));
      expect(start.row).toEqual({ name: "totals", kind: "model", position: at, events: ["billing.InvoicePaid"] });
      expect(calls).toEqual(["start", "stored - []"]);
      expect(seen.handler).toEqual({ name: "totals", events: ["billing.InvoicePaid"], handler: HANDLER });
    }
  });

  test("a start that is not a whole position within the bounds is a FrameworkError naming the kind, its owner and the bounds", async () => {
    for (const bad of [7.5, 2, 13, -1, Number.NaN, "4", undefined]) {
      const { kind } = testKind({ start: bad });
      const error = await rejection(handlerStart(declared("totals", ["billing.InvoicePaid"], undefined, kind), progress(), registration(12, 3)));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith(`The model kind of @meshfw/test-kind started the handler "totals" at ${typeof bad === "number" ? String(bad) : bad === undefined ? "undefined" : "a string"}: a start is a position from the deleted-through position, 3, to the highest, 12`);
    }
  });

  test("a known row is handed to adopt with the events the list gained, and keeps its position", async () => {
    const { kind, calls, seen } = testKind();
    const known = row("totals", 40, ["billing.InvoicePaid"], "model");
    const start = await handlerStart(declared("totals", ["billing.InvoicePaid", "billing.InvoiceVoided", "billing.RefundIssued"], undefined, kind), progress(known), registration(812));
    expect(calls).toEqual(["adopt", "stored model [billing.InvoiceVoided,billing.RefundIssued]"]);
    expect(seen.row).toBe(known);
    expect(seen.added).toEqual(["billing.InvoiceVoided", "billing.RefundIssued"]);
    expect(start.row.position).toBe(40);
  });

  test("an unchanged list and a list that lost events are adopted with nothing added", async () => {
    for (const events of [["billing.InvoicePaid"], []]) {
      const { kind, seen } = testKind();
      await handlerStart(declared("totals", events, undefined, kind), progress(row("totals", 40, ["billing.InvoicePaid"], "model")), registration(812));
      expect(seen.added).toEqual([]);
    }
  });

  test("a renamedFrom move hands adopt the former row, whatever kind it was stored under", async () => {
    const { kind, calls, seen } = testKind();
    const former = row("notify", 40, ["billing.InvoicePaid"], "process");
    const start = await handlerStart(declared("totals", ["billing.InvoicePaid"], "notify", kind), progress(former), registration(812));
    expect(seen.row).toBe(former);
    expect(calls).toEqual(["adopt", "stored process []"]);
    expect(start.former).toBe("notify");
    expect(start.row).toEqual({ name: "totals", kind: "model", position: 40, events: ["billing.InvoicePaid"] });
  });

  test("adopt can read the outbox through firstRow, and its throw fails the start", async () => {
    const at = registration(812, 0, 37);
    const refused = new Error("refused by the kind");
    const { kind, calls } = testKind({ adopt: async (found, added, reg) => { if ((await reg.firstRow(0, found.position + 1, added)) !== null) throw refused; } });
    const error = await rejection(handlerStart(declared("totals", ["billing.InvoicePaid", "billing.InvoiceVoided"], undefined, kind), progress(row("totals", 40, ["billing.InvoicePaid"], "model")), at));
    expect(error).toBe(refused);
    expect(at.asked).toEqual([[0, 41, ["billing.InvoiceVoided"]]]);
    expect(calls).toEqual(["adopt"]);
  });

  test("stored names the row's kind: the kind's name, or its name, a colon and one lowercase word", async () => {
    for (const stored of ["model", "model:now"]) {
      const { kind } = testKind({ stored });
      expect((await handlerStart(declared("totals", ["billing.InvoicePaid"], undefined, kind), progress(), registration(812))).row.kind).toBe(stored);
    }
  });

  test("a malformed stored kind is a FrameworkError naming the kind", async () => {
    for (const stored of ["other", "model:", "model:Now", "model:now:x", "modelnow", "process", 5, undefined]) {
      const { kind } = testKind({ stored });
      const error = await rejection(handlerStart(declared("totals", ["billing.InvoicePaid"], undefined, kind), progress(), registration(812)));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toStartWith(`The model kind of @meshfw/test-kind stored the kind ${typeof stored === "string" ? JSON.stringify(stored) : typeof stored === "number" ? "a number" : "undefined"} for the handler "totals": a stored kind is "model", or "model:" followed by one lowercase word`);
    }
  });
});
