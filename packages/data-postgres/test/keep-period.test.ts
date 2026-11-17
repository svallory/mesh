// Core's deletion pass under a keep period (`events.keep: { days }`) over a data-postgres layer: a passed row is
// deleted only once its occurredAt is at least the period before the database's clock, the prefix stops before the
// first row that is too young, and the longest legal period gives a `since` Postgres's timestamptz can hold.
import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  bindDomain, DECLARATION, MAX_KEEP_DAYS, publishEvent,
  type DataLayer, type DataOperations, type Declaration, type DeliveryOperations, type Keep,
} from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
afterAll(remove);

class Alpha {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration = { kind: "event", fqn: "core.Alpha", is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
  readonly n: number;
  constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
}
const DAY = 86_400_000;

/** Publish one event per age in ms, each stamped `age` before now, in one transaction. */
const publish = (layer: DataLayer, ...ages: number[]) => layer.transaction(async (tx) => {
  for (const age of ages)
    await publishEvent(tx, undefined, { entity: "core.Thing", action: "make", key: { id: "k" }, at: "test" }, new Alpha({ n: age }), {}, () => new Date(Date.now() - age));
});
const kept = async (layer: DataLayer) => (await layer.readOutbox!(0, 100)).rows.map((row) => row.position);
const deletedThrough = (layer: DataLayer) => layer.transaction(async (tx) => (await (tx as DataOperations & DeliveryOperations).readDeliveryState()).deletedThrough);

describeServer("the deletion pass under keep: { days }, Postgres", () => {
  const database = testDatabase(tables);

  async function world(keep: Keep) {
    const layer = await database.freshLayer();
    const binding = bindDomain({ Alpha }, layer, { events: { bus: testBus({ retryDelays: [0, 0] }), keep, load: async () => ({ handlers: { process: { h: { events: [Alpha], run: () => {} } } } }) } }, new AsyncLocalStorage());
    // The first round registers h at the highest position, 0, so it reads every row published after it.
    await binding.deliver();
    return { layer, binding };
  }

  test("deletes the passed rows older than the period and stops the prefix at the first young one", async () => {
    const { layer, binding } = await world({ days: 30 });
    await publish(layer, 40 * DAY, 40 * DAY, 60_000, 40 * DAY);
    await binding.deliver();
    expect(await deletedThrough(layer)).toBe(2);
    expect(await kept(layer)).toEqual([3, 4]);
  });

  test("the longest legal period keeps every young row: its start is a date timestamptz holds", async () => {
    const { layer, binding } = await world({ days: MAX_KEEP_DAYS });
    await publish(layer, 0, 40 * DAY);
    await binding.deliver();
    expect(await kept(layer)).toEqual([1, 2]);
  });
});
