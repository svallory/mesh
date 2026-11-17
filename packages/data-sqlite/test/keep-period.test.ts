// Core's deletion pass under a keep period (`events.keep: { days }`) over a data-sqlite layer: a passed row is deleted
// only once its occurredAt is at least the period before the database's clock, the prefix stops before the first row
// that is too young, and a row some reader has not passed is never deleted, however old.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import {
  bindDomain, DECLARATION, publishEvent,
  type DataLayer, type DataOperations, type Declaration, type DeliveryOperations, type EventsModule, type Keep, type TableHandle,
} from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";
import { openPolicies } from "./open-policy.ts";

const invoice = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
  actions
    create :open
      do
        publish=() => new InvoicePaid({ n: 1 })
`;
const paid = `event :InvoicePaid
  integer :n
`;

let dir: string;
let tables: Record<string, TableHandle>;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".scratch-keep-period-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  ({ tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { setDeliveryTiming(null); });

function eventClass(fqn: string) {
  return class {
    readonly #brand = true;
    static readonly [DECLARATION]: Declaration = { kind: "event", fqn, is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
    readonly n: number;
    constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
  };
}
const Alpha = eventClass("core.Alpha");
const Beta = eventClass("core.Beta");
const domain = { Alpha, Beta };
const DAY = 86_400_000;

/** Publish one event per `[class, age in ms]`, each stamped `age` before now, in one transaction. */
const publish = (layer: DataLayer, ...events: [typeof Alpha, number][]) => layer.transaction(async (tx) => {
  for (const [Class, age] of events)
    await publishEvent(tx, undefined, { entity: "core.Thing", action: "make", key: { id: "k" }, at: "test" }, new Class({ n: age }), {}, () => new Date(Date.now() - age));
});
const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;
const deletedThrough = (layer: DataLayer) => layer.transaction(async (tx) => (await ops(tx).readDeliveryState()).deletedThrough);
const kept = async (layer: DataLayer) => (await layer.readOutbox!(0, 100)).rows.map((row) => row.position);

/**
 * The layer, seen through transactions whose readDeliveryState reports the database's clock `shift` ms ahead of the
 * process clock, and whose firstOutboxRowSince records the `since` it is asked for.
 */
function instrumented(layer: DataLayer, shift: number, since: Date[]): DataLayer {
  const wrap = (tx: DataOperations) => new Proxy(tx, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "readDeliveryState")
        return async () => { const state = await ops(target).readDeliveryState(); return { ...state, now: new Date(state.now.getTime() + shift) }; };
      if (key === "firstOutboxRowSince")
        return async (after: number, through: number, at: Date) => { since.push(at); return (value as (...args: unknown[]) => unknown).call(target, after, through, at); };
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
  // The layer is frozen, so it is copied, each method bound to it, rather than proxied.
  const view: Record<string, unknown> = {};
  for (const key of Object.keys(layer)) {
    const value = (layer as unknown as Record<string, unknown>)[key];
    view[key] = typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(layer) : value;
  }
  view.transaction = <T>(run: (tx: DataOperations) => Promise<T>) => layer.transaction((tx) => run(wrap(tx)));
  return view as unknown as DataLayer;
}

async function world(keep: Keep, module: EventsModule = { handlers: { process: { h: { events: [Alpha], run: () => {} } } } }, view: (layer: DataLayer) => DataLayer = (layer) => layer) {
  const layer = sqlite({ file: ":memory:" });
  await createSchema(layer, tables);
  const binding = bindDomain(domain, view(layer), { events: { bus: testBus({ retryDelays: [0, 0] }), keep, load: async () => module } }, new AsyncLocalStorage());
  // The first round registers h at the highest position, 0, so it reads every row published after it.
  await binding.deliver();
  return { layer, binding };
}

describe("the deletion pass under keep: { days }", () => {
  test("deletes the passed rows older than the period, keeps a passed young row, and stops the prefix there (rows above it are kept, old or not)", async () => {
    const { layer, binding } = await world({ days: 30 });
    try {
      // 1 and 2 are 40 days old, 3 is a minute old, 4 is 40 days old again (a clock that went back, or a late publisher).
      await publish(layer, [Alpha, 40 * DAY], [Beta, 40 * DAY], [Alpha, 60_000], [Alpha, 40 * DAY]);
      await binding.deliver();
      expect(await deletedThrough(layer)).toBe(2);
      expect(await kept(layer)).toEqual([3, 4]);
    } finally { await layer.close(); }
  });

  test("a row just older than the period is deleted, one just younger kept", async () => {
    const { layer, binding } = await world({ days: 1 });
    try {
      await publish(layer, [Alpha, DAY + 60_000], [Alpha, DAY - 60_000]);
      await binding.deliver();
      expect(await kept(layer)).toEqual([2]);
    } finally { await layer.close(); }
  });

  test("a row no reader has passed is kept however old: the period only lowers the bound", async () => {
    let fail = true;
    const module: EventsModule = { handlers: { process: { h: { events: [Alpha], run: () => { if (fail) throw new Error("down"); } } } } };
    const { layer, binding } = await world({ days: 30 }, module);
    try {
      await publish(layer, [Beta, 40 * DAY], [Alpha, 40 * DAY], [Beta, 40 * DAY]);
      await expect(binding.deliver()).rejects.toThrow();
      // h passed 1 (it does not list Beta) and stopped at 2.
      expect(await deletedThrough(layer)).toBe(1);
      expect(await kept(layer)).toEqual([2, 3]);
      fail = false;
      await binding.deliver();
      expect(await kept(layer)).toEqual([]);
    } finally { await layer.close(); }
  });

  test("a prefix longer than a batch is deleted over several batches, up to the first young row", async () => {
    const { layer, binding } = await world({ days: 30 });
    try {
      setDeliveryTiming({ batch: 2 });
      await publish(layer, [Alpha, 40 * DAY], [Alpha, 40 * DAY], [Alpha, 40 * DAY], [Alpha, 40 * DAY], [Alpha, 40 * DAY], [Alpha, 0], [Alpha, 40 * DAY]);
      await binding.deliver();
      expect(await deletedThrough(layer)).toBe(5);
      expect(await kept(layer)).toEqual([6, 7]);
    } finally { await layer.close(); }
  });

  test("a young row with more than a batch of passed rows above it ends the pass: it is not capped, so the period is asked a bounded number of times", async () => {
    const since: Date[] = [];
    const { layer, binding } = await world({ days: 30 }, undefined, (inner) => instrumented(inner, 0, since));
    try {
      await publish(layer, [Alpha, 40 * DAY], [Alpha, 40 * DAY], [Alpha, 0], ...Array.from({ length: 7 }, () => [Alpha, 40 * DAY] as [typeof Alpha, number]));
      since.length = 0;
      setDeliveryTiming({ batch: 2 });
      await binding.deliver();
      expect(await kept(layer)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
      // The delivery batches ask once each at most; a pass left capped would ask again on every iteration until its guard.
      expect(since.length).toBeGreaterThan(0);
      expect(since.length).toBeLessThanOrEqual(10);
    } finally { await layer.close(); }
  });

  test("a row's age is measured on the database's clock, not the process clock", async () => {
    const since: Date[] = [];
    // The database's clock is 100 days ahead: a row the process stamped a minute ago is 100 days old to it.
    const { layer, binding } = await world({ days: 30 }, undefined, (inner) => instrumented(inner, 100 * DAY, since));
    try {
      await publish(layer, [Alpha, 60_000], [Alpha, 60_000]);
      const before = Date.now();
      await binding.deliver();
      expect(await kept(layer)).toEqual([]);
      expect(await deletedThrough(layer)).toBe(2);
      const at = since.at(-1)!.getTime();
      // SQLite's clock is read in whole milliseconds through julianday, so allow it a second either side.
      expect(at).toBeGreaterThanOrEqual(before - 1_000 + 100 * DAY - 30 * DAY);
      expect(at).toBeLessThanOrEqual(Date.now() + 1_000 + 100 * DAY - 30 * DAY);
    } finally { await layer.close(); }
  });

  test("the longest legal period keeps every young row", async () => {
    const { layer, binding } = await world({ days: 100_000_000 });
    try {
      await publish(layer, [Alpha, 0], [Alpha, 40 * DAY]);
      await binding.deliver();
      expect(await kept(layer)).toEqual([1, 2]);
    } finally { await layer.close(); }
  });

  test("legal neighbours: until-delivered deletes every passed row, young ones included; all deletes none", async () => {
    for (const [keep, left] of [["until-delivered", []], ["all", [1, 2, 3]]] as const) {
      const { layer, binding } = await world(keep);
      try {
        await publish(layer, [Alpha, 40 * DAY], [Alpha, 0], [Alpha, 40 * DAY]);
        await binding.deliver();
        expect(await kept(layer)).toEqual([...left]);
      } finally { await layer.close(); }
    }
  });

  test("a subscription not open for the orphan age is still reported under a period, since rows are deleted", async () => {
    const { layer, binding } = await world({ days: 30 });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await layer.transaction((tx) => ops(tx).writeSubscriptionProgress({ name: "away", position: 0, filter: {}, seenAt: new Date(Date.now() - 2 * 3_600_000), open: false, generation: 0 }));
      await binding.deliver();
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('the subscription "away" has not been open for more than an hour'))).toBe(true);
    } finally { warn.mockRestore(); await layer.close(); }
  });
});
