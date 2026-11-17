// The claim's row lock on Postgres (spec, Events and commands, "The generation check"): readDeliveryState takes
// FOR UPDATE on mesh_outbox_state, so a takeover and a handler transaction of another connection are ordered as
// SQLite's one writer orders them; at SERIALIZABLE the side that waited behind a takeover fails with 40001, a
// retryable DatabaseBusyError that ends the round, and the next transaction sees the new generation.
import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  DECLARATION, DatabaseBusyError, DelivererLostError, DelivererTakenError, bindDomain, publishEvent,
  type DataOperations, type Declaration, type DeliveryOperations, type EventRecord, type EventsModule,
} from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import type { PostgresLayer } from "../src/layer.ts";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
afterAll(remove);

const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;
const FOREIGN_RUN = "00000000-0000-4000-8000-0000000000aa";

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
const pending = async (promise: Promise<unknown>, ms: number) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await Bun.sleep(ms);
  return !done;
};

class Paid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration = { kind: "event", fqn: "claims.Paid", is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
  readonly n: number;
  constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
}

/** A takeover from another connection: the generation check, then a claim under the next generation; held until `release`. */
function takeover(layer: PostgresLayer, release: Promise<void> = Promise.resolve()) {
  const claimed = gate();
  const done = layer.transaction(async (tx) => {
    const { generation } = await ops(tx).readDeliveryState();
    await ops(tx).writeClaim({ runId: FOREIGN_RUN, generation: generation + 1, host: "elsewhere", pid: 4242, startedAt: null });
    claimed.open();
    await release;
    return generation + 1;
  });
  return { claimed: claimed.wait, done };
}

describeServer("the claim's row lock", () => {
  const database = testDatabase(tables);

  test("readDeliveryState creates the state row, reads the database's clock and the highest position", async () => {
    const layer = await database.freshLayer();
    const before = Date.now();
    const state = await layer.transaction((tx) => ops(tx).readDeliveryState());
    expect(state).toMatchObject({ deletedThrough: 0, highest: 0, generation: 0, claim: null });
    expect(Math.abs(state.now.getTime() - before)).toBeLessThan(60_000);
    const [row] = await database.admin.unsafe(`SELECT count(*)::int AS n FROM "${layer.database!.split("#")[1]}".mesh_outbox_state`);
    expect(row.n).toBe(1);
  }, 60_000);

  test("two transactions that both create the state row: the later one fails with a retryable serialization failure", async () => {
    const first = await database.freshLayer();
    const second = database.sibling(first);
    const created = gate();
    const release = gate();
    const one = first.transaction(async (tx) => { await ops(tx).readDeliveryState(); created.open(); await release.wait; });
    await created.wait;
    const two = settle(second.transaction((tx) => ops(tx).readDeliveryState()));
    await Bun.sleep(100);
    release.open();
    await one;
    const outcome = await two;
    expect("error" in outcome && outcome.error).toBeInstanceOf(DatabaseBusyError);
    expect((outcome as { error: DatabaseBusyError }).error).toMatchObject({ reason: "serialization", retryable: true });
    expect(await second.transaction(async (tx) => (await ops(tx).readDeliveryState()).generation)).toBe(0);
  }, 60_000);

  test("a takeover waits for a handler transaction of another connection that holds the state row, and goes on once it commits", async () => {
    const handlerLayer = await database.freshLayer();
    const other = database.sibling(handlerLayer);
    // The state row exists (a first claim made it): two transactions that both create it are a serialization failure.
    await handlerLayer.transaction((tx) => ops(tx).readDeliveryState());
    const locked = gate();
    const release = gate();
    const handler = handlerLayer.transaction(async (tx) => { await ops(tx).readDeliveryState(); locked.open(); await release.wait; });
    await locked.wait;
    const taking = takeover(other);
    expect(await pending(taking.done, 300)).toBe(true);
    release.open();
    await handler;
    expect(await taking.done).toBe(1);
  }, 60_000);

  test("a handler transaction whose generation check waited behind a takeover fails with a retryable serialization failure, and the next one sees the new generation", async () => {
    const handlerLayer = await database.freshLayer();
    const other = database.sibling(handlerLayer);
    const release = gate();
    const taking = takeover(other, release.wait);
    await taking.claimed;
    const waited = settle(handlerLayer.transaction(async (tx) => (await ops(tx).readDeliveryState()).generation));
    expect(await pending(waited, 300)).toBe(true);
    release.open();
    await taking.done;
    const outcome = await waited;
    expect("error" in outcome && outcome.error).toBeInstanceOf(DatabaseBusyError);
    expect((outcome as { error: DatabaseBusyError }).error).toMatchObject({ reason: "serialization", sqlstate: "40001", retryable: true });
    expect(await handlerLayer.transaction(async (tx) => (await ops(tx).readDeliveryState()).generation)).toBe(1);
  }, 60_000);

  test("a deliverer whose next handler transaction waited behind a takeover ends the round with MESH_DATABASE_BUSY, counting no try, and the next round delivers nothing; the event handled before it is handled once", async () => {
    const layer = await database.freshLayer();
    const other = database.sibling(layer);
    const seen: number[] = [];
    let runs = 0;
    const inFirst = gate();
    const releaseFirst = gate();
    const module: EventsModule = {
      handlers: {
        process: {
          h: {
            events: [Paid],
            async run(event: EventRecord<object>) {
              runs++;
              seen.push((event.payload as { n: number }).n);
              if ((event.payload as { n: number }).n === 1) { inFirst.open(); await releaseFirst.wait; }
            },
          },
        },
      },
    };
    const binding = bindDomain({ Paid }, layer, { events: { bus: testBus({ retryDelays: [0, 0], pollMs: 20 }), load: async () => module } }, new AsyncLocalStorage());
    try {
      await binding.deliver();
      await binding.transaction(() => layer.transaction(async (tx) => {
        for (const n of [1, 2]) await publishEvent(tx, undefined, { entity: "claims.Thing", action: "make", key: { id: `k${n}` }, at: "claims" }, new Paid({ n }), {}, () => new Date());
      }));
      const round = settle(binding.deliver());
      await inFirst.wait;
      // The takeover waits on the row the first handler transaction holds, then holds it until released.
      const releaseTakeover = gate();
      const taking = takeover(other, releaseTakeover.wait);
      expect(await pending(taking.claimed, 300)).toBe(true);
      releaseFirst.open();
      await taking.claimed;
      // The round goes on to event 2, whose handler transaction waits behind the takeover; then the takeover commits.
      await Bun.sleep(200);
      releaseTakeover.open();
      await taking.done;
      const first = await round;
      expect("error" in first && first.error).toBeInstanceOf(DatabaseBusyError);
      expect((first as { error: DatabaseBusyError }).error).toMatchObject({ reason: "serialization", retryable: true });
      // The next round reads the new generation and delivers nothing: deliver() claims per call, so it finds the
      // takeover's live claim (a started delivery would stop with MESH_DELIVERER_LOST).
      const second = await settle(binding.deliver());
      const error = "error" in second ? second.error : undefined;
      expect(error instanceof DelivererTakenError || error instanceof DelivererLostError).toBe(true);
      expect(seen).toEqual([1]);
      expect(runs).toBe(1);
      const [progress] = await layer.transaction((tx) => ops(tx).readHandlerProgress());
      expect(progress).toMatchObject({ name: "h", position: 1 });
    } finally {
      releaseFirst.open();
    }
  }, 60_000);

  test("a claim another process holds is MESH_DELIVERER_TAKEN naming its pid and host, and is claimed once that process is killed and its claim lapses", async () => {
    const layer = await database.freshLayer();
    const schema = layer.database!.split("#")[1]!;
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "claim-worker.ts"), database.url, schema], { stdout: "pipe", stderr: "inherit", env: { ...process.env } });
    try {
      const reader = worker.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the claim worker exited before READY");
        line += new TextDecoder().decode(value);
      }
      expect(line).toStartWith("READY ");
      setDeliveryTiming({ lapseMs: 1000 });
      const binding = bindDomain({}, layer, { events: { bus: testBus(), load: async () => ({}) } }, new AsyncLocalStorage());
      const taken = await binding.deliver().then(() => undefined, (error: unknown) => error);
      expect(taken).toBeInstanceOf(DelivererTakenError);
      expect((taken as DelivererTakenError).holder).toMatchObject({ thisProcess: false, pid: worker.pid, host: hostname() });
      expect((taken as DelivererTakenError).retryable).toBe(true);
      worker.kill(9);
      await worker.exited;
      await Bun.sleep(1200);
      await binding.deliver();
    } finally {
      worker.kill(9);
      await worker.exited;
      setDeliveryTiming(null);
    }
  }, 60_000);
});
