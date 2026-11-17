// Wake-ups on Postgres (spec, Events and commands, "Phasing": "`LISTEN`/`NOTIFY` wake-ups"; the note on `localBus`:
// "woken by Postgres's `LISTEN`/`NOTIFY` in place of most polling"): a transaction that appended sends one NOTIFY on
// the layer's channel, which Postgres delivers after the commit and never after a rollback, and `onAppended` calls its
// listeners for it, so a deliverer hears commits of other processes without waiting for its poll. Best effort: a
// wake-up that is missed (the listen connection dropped) is caught by the bus's poll, which stays.
import { afterAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { DECLARATION, bindDomain, type Declaration, type EventRecord, type EventsModule } from "@meshfw/runtime";
import { outboxRow } from "@meshfw/runtime/testing";
import { postgres, postgresWith, type PostgresLayer } from "../src/layer.ts";
import { AppendedListeners, type WakeupTimers } from "../src/wakeup.ts";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
afterAll(remove);

const schemaOf = (layer: PostgresLayer) => layer.database!.split("#")[1]!;

async function until(check: () => boolean, what: string, ms: number): Promise<number> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > ms) throw new Error(`timed out after ${ms} ms waiting until ${what}`);
    await Bun.sleep(5);
  }
  return performance.now() - started;
}

class Paid {
  readonly #brand = true;
  static readonly [DECLARATION]: Declaration = { kind: "event", fqn: "wakeups.Paid", is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
  readonly n: number;
  constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
}
const paidRow = (n: number) => outboxRow(n, { name: "wakeups.Paid", payload: { n } });

/** Timers a test runs by hand: `due()` lists the pending delays, `run()` fires the oldest. */
function manualTimers(): WakeupTimers & { due(): number[]; run(): void } {
  const pending: { ms: number; run: () => void }[] = [];
  return {
    setTimeout(run, ms) { const timer = { ms, run }; pending.push(timer); return timer; },
    clearTimeout(timer) { const at = pending.indexOf(timer as never); if (at >= 0) pending.splice(at, 1); },
    due: () => pending.map((timer) => timer.ms),
    run() { pending.shift()?.run(); },
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("AppendedListeners, the listener set behind onAppended", () => {
  test("the first listener starts listening, the last unsubscribe stops it; each listener is called for each notification", async () => {
    let fire!: () => void;
    let started = 0;
    let stopped = 0;
    const set = new AppendedListeners(async (onNotify) => { started++; fire = onNotify; return { unlisten: async () => { stopped++; } }; });
    const calls: string[] = [];
    const offA = set.add(() => calls.push("a"));
    const offB = set.add(() => calls.push("b"));
    await tick();
    expect(started).toBe(1);
    fire();
    expect(calls).toEqual(["a", "b"]);
    offA();
    offA(); // idempotent
    fire();
    expect(calls).toEqual(["a", "b", "b"]);
    expect(stopped).toBe(0);
    offB();
    await tick();
    expect(stopped).toBe(1);
  });

  test("a throwing listener is reported and the others are still called", async () => {
    let fire!: () => void;
    const reported: unknown[] = [];
    const set = new AppendedListeners(async (onNotify) => { fire = onNotify; return { unlisten: async () => undefined }; }, { report: (error) => reported.push(error) });
    const calls: string[] = [];
    set.add(() => { throw new Error("boom"); });
    set.add(() => calls.push("after"));
    await tick();
    fire();
    expect(calls).toEqual(["after"]);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("boom");
  });

  test("a failing listen is reported once and retried with a back-off of 1 s doubling to 30 s while listeners remain", async () => {
    const timers = manualTimers();
    const reported: unknown[] = [];
    let attempts = 0;
    const set = new AppendedListeners(async () => { attempts++; throw new Error("refused"); }, { timers, report: (error) => reported.push(error) });
    const off = set.add(() => undefined);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await tick();
      delays.push(...timers.due());
      timers.run();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(attempts).toBe(8);
    expect(reported).toHaveLength(1);
    await tick();
    off();
    expect(timers.due()).toEqual([]);
  });

  test("after a success the next failure is reported again and its back-off starts over at 1 s", async () => {
    const timers = manualTimers();
    const reported: unknown[] = [];
    let fail = true;
    const set = new AppendedListeners(async () => { if (fail) throw new Error("down"); return { unlisten: async () => undefined }; }, { timers, report: (error) => reported.push(error) });
    set.add(() => undefined);
    await tick();
    timers.run(); // 1 s
    await tick();
    timers.run(); // 2 s
    fail = false;
    await tick();
    timers.run(); // 4 s: succeeds
    await tick();
    expect(timers.due()).toEqual([]);
    await set.stop();
    fail = true;
    set.resume();
    await tick();
    expect(timers.due()).toEqual([1000]);
    expect(reported).toHaveLength(2);
  });

  test("a reconnect (onListen after the first) wakes every listener, since notifications may have been missed meanwhile", async () => {
    let listened!: () => void;
    const set = new AppendedListeners(async (_onNotify, onListen) => { listened = onListen; onListen(); return { unlisten: async () => undefined }; });
    let calls = 0;
    set.add(() => { calls++; });
    await tick();
    expect(calls).toBe(0);
    listened();
    expect(calls).toBe(1);
  });

  test("stop() ends the subscription and keeps the listeners; resume() listens again; an unsubscribe during a start unlistens once it is made", async () => {
    let started = 0;
    let stopped = 0;
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    const set = new AppendedListeners(async () => { started++; if (started === 1) await slow; return { unlisten: async () => { stopped++; } }; });
    const off = set.add(() => undefined);
    off(); // while the first start is pending
    finish();
    await tick(); await tick();
    expect(stopped).toBe(1);
    set.add(() => undefined);
    await tick();
    expect(started).toBe(2);
    await set.stop();
    expect(stopped).toBe(2);
    set.resume();
    await tick();
    expect(started).toBe(3);
    set.resume(); // already listening
    await tick();
    expect(started).toBe(3);
  });

  test("resume() with no listener starts nothing", async () => {
    let started = 0;
    const set = new AppendedListeners(async () => { started++; return { unlisten: async () => undefined }; });
    set.resume();
    await tick();
    expect(started).toBe(0);
  });
});

describe("onAppended without a server", () => {
  test("on a layer whose url is missing it throws nothing and returns the unsubscribe; the failure is reported once", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const layer = postgres({ url: undefined });
      const off = layer.onAppended(() => undefined);
      await tick(); await tick();
      off();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.join(" ")).toContain("postgres needs a url");
    } finally {
      console.error = original;
    }
  });

  test("a test schema is at most 51 bytes, so its NOTIFY channel mesh_outbox_<schema> fits Postgres's 63-byte names", () => {
    expect(() => postgresWith({ url: undefined }, { schema: "s".repeat(51) })).not.toThrow();
    expect(() => postgresWith({ url: undefined }, { schema: "s".repeat(52) })).toThrow("A test schema must be a lowercase identifier");
  });
});

describeServer("wake-ups through LISTEN/NOTIFY", () => {
  const database = testDatabase(tables);

  test("onAppended fires within 1 s for a commit made on another layer object; once for a transaction with three appends", async () => {
    const listening = await database.freshLayer();
    const writer = database.sibling(listening);
    let calls = 0;
    const off = listening.onAppended(() => { calls++; });
    try {
      await Bun.sleep(200); // the LISTEN is acknowledged
      await writer.transaction(async (tx) => { for (const n of [1, 2, 3]) await tx.appendEvent!(outboxRow(n)); });
      expect(await until(() => calls > 0, "the commit wakes the listener", 1000)).toBeLessThan(1000);
      await Bun.sleep(300);
      expect(calls).toBe(1);
    } finally {
      off();
    }
  }, 60_000);

  test("a rollback never fires it, and a transaction that appended nothing does not either", async () => {
    const listening = await database.freshLayer();
    const writer = database.sibling(listening);
    let calls = 0;
    const off = listening.onAppended(() => { calls++; });
    try {
      await Bun.sleep(200);
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); throw new Error("roll back"); }).catch(() => undefined);
      await writer.transaction(async (tx) => { await tx.readDeliveryState!(); });
      await Bun.sleep(300);
      expect(calls).toBe(0);
      // Notifications come in commit order, so once this one arrived, none of the two before it was sent.
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
      await until(() => calls > 0, "the commit wakes the listener", 1000);
      expect(calls).toBe(1);
    } finally {
      off();
    }
  }, 60_000);

  test("after the last unsubscribe no listener is called; a layer of another schema has a channel of its own", async () => {
    const listening = await database.freshLayer();
    const elsewhere = await database.freshLayer();
    const writer = database.sibling(listening);
    let mine = 0;
    let theirs = 0;
    const off = listening.onAppended(() => { mine++; });
    const offOther = elsewhere.onAppended(() => { theirs++; });
    try {
      await Bun.sleep(200);
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
      await until(() => mine === 1, "the commit wakes the listener", 1000);
      await Bun.sleep(200);
      expect(theirs).toBe(0);
      off();
      await Bun.sleep(100);
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
      await Bun.sleep(300);
      expect(mine).toBe(1);
    } finally {
      off();
      offOther();
    }
  }, 60_000);

  test("a listener registered before close() hears commits once the layer opens again", async () => {
    const listening = await database.freshLayer();
    const writer = database.sibling(listening);
    let calls = 0;
    const off = listening.onAppended(() => { calls++; });
    try {
      await Bun.sleep(200);
      await listening.close();
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
      await Bun.sleep(300);
      expect(calls).toBe(0);
      await listening.readOutbox(0, 1); // opens the layer again
      await Bun.sleep(200);
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); });
      await until(() => calls === 1, "the commit wakes the listener", 1000);
    } finally {
      off();
    }
  }, 60_000);

  test("with localBus({ pollInterval: 60_000 }) here, an append committed by a child process is handled within 2 s", async () => {
    const layer = await database.freshLayer();
    const seen: number[] = [];
    const module: EventsModule = { handlers: { process: { h: { events: [Paid], run(event: EventRecord<object>) { seen.push((event.payload as { n: number }).n); } } } } };
    const binding = bindDomain({ Paid }, layer, { events: { bus: localBus({ pollInterval: 60_000 }), load: async () => module } }, new AsyncLocalStorage());
    const delivery = await binding.startDelivery();
    try {
      await Bun.sleep(300); // the start-up round ran and the LISTEN is acknowledged
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "append-worker.ts"), database.url, schemaOf(layer), "7"], { stdout: "inherit", stderr: "inherit", env: { ...process.env } });
      expect(await child.exited).toBe(0);
      expect(await until(() => seen.length === 1, "the handler runs", 2000)).toBeLessThan(2000);
      expect(seen).toEqual([7]);
    } finally {
      await delivery.stop();
    }
  }, 60_000);

  test("after the listen connection is terminated, a commit is still delivered by the poll", async () => {
    const layer = await database.freshLayer();
    const writer = database.sibling(layer);
    const seen: number[] = [];
    const module: EventsModule = { handlers: { process: { h: { events: [Paid], run(event: EventRecord<object>) { seen.push((event.payload as { n: number }).n); } } } } };
    const binding = bindDomain({ Paid }, layer, { events: { bus: localBus({ pollInterval: 500 }), load: async () => module } }, new AsyncLocalStorage());
    const delivery = await binding.startDelivery();
    try {
      await Bun.sleep(300);
      const [row] = await database.admin.unsafe(`SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%${schemaOf(layer)}%') AS killed`);
      expect(row.n).toBe(1);
      await writer.transaction(async (tx) => { await tx.appendEvent!(paidRow(3)); });
      await until(() => seen.length === 1, "the handler runs", 3000);
      expect(seen).toEqual([3]);
    } finally {
      await delivery.stop();
    }
  }, 60_000);
});
