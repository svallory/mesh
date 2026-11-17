// Core's deletion pass under a per-event keep (`events.keep: { default, events }`) over a data-postgres layer: rows of
// an event kept "all" stay while passed rows of the others are deleted above them, the hole record is written and read
// back from readOutbox's statement, and a history read from below a hole is MESH_EVENTS_DELETED naming the event.
import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  bindDomain, DECLARATION, EventsDeletedError, publishEvent, readEvents,
  type DataLayer, type DataOperations, type Declaration, type DeliveryOperations,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
afterAll(remove);

function eventClass(fqn: string) {
  return class {
    readonly #brand = true;
    static readonly [DECLARATION]: Declaration = { kind: "event", fqn, is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
    readonly n: number;
    constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
  };
}
const Kept = eventClass("audit.Kept");
const Gone = eventClass("core.Gone");

const publish = (layer: DataLayer, ...classes: ReturnType<typeof eventClass>[]) => layer.transaction(async (tx) => {
  for (const Class of classes) await publishEvent(tx, undefined, { entity: "core.Thing", action: "make", key: { id: "k" }, at: "test" }, new Class({ n: 0 }), {}, () => new Date());
});
const state = (layer: DataLayer) => layer.transaction(async (tx) => (tx as DataOperations & DeliveryOperations).readDeliveryState());

describeServer("the deletion pass under a per-event keep, Postgres", () => {
  const database = testDatabase(tables);

  test("keeps the \"all\" event's rows, deletes the others above them as holes, and refuses a history read from below one", async () => {
    const layer = await database.freshLayer();
    const frame = new AsyncLocalStorage();
    const binding = bindDomain({ Kept, Gone }, layer, {
      events: { bus: testBus({ retryDelays: [0, 0] }), keep: { default: "until-delivered", events: { "audit.Kept": "all" } }, load: async () => ({ handlers: { process: { h: { events: [Kept, Gone], run: () => {} } } } }) },
    }, frame as never);
    await binding.deliver();
    await publish(layer, Gone, Kept, Gone, Gone);
    await binding.deliver();
    expect((await layer.readOutbox!(0, 10)).rows.map((row) => row.position)).toEqual([2]);
    expect((await state(layer)).deletedThrough).toBe(1);
    expect((await state(layer)).holes).toEqual({ "core.Gone": 4 });
    expect((await layer.readOutbox!(0, 10)).holes).toEqual({ "core.Gone": 4 });
    const error = await readEvents(frame as never, binding, { after: 1 }).then(() => undefined, (thrown: unknown) => thrown) as EventsDeletedError;
    expect([error instanceof EventsDeletedError, error.eventName, error.oldestKept]).toEqual([true, "core.Gone", 5]);
    expect((await readEvents(frame as never, binding, { after: 1, names: ["audit.Kept"] })).events.map((event) => event.position)).toEqual([2]);
  });
});
