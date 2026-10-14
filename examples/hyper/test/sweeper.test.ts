// The lease sweeper (`src/daemon/sweeper.ts`) in process, on the world's clock: `sweep` expires each claim whose lease
// has run out, as the engine, in a transaction of its own, and leaves every other claim alone; `startSweeper` sweeps on
// a timer, one sweep at a time, and `stop` ends the sweep in progress once the claim it is expiring commits.
// `test/daemon.test.ts` holds the running daemon to the protocol's 1000 ms (PROTOCOL.md:312).
import { describe, expect, spyOn, test } from "bun:test";
import { Claim, Task } from "#mesh/domain/work";
import { startSweeper, sweep, type SweepBinding } from "../src/daemon/sweeper";
import { ENGINE } from "../src/rpc/context";
import { as, minutes, one, within, type World } from "./world";

const claimOf = (w: World, id: string) => one(Claim.read({ filter: { id: { eq: id } } }, as(w.alice)));
const versionOf = async (w: World, id: string) => (await one(Task.read({ filter: { id: { eq: id } } }, as(w.alice)))).version;

/** A new Task and Bot's claim on it, with a lease of `leaseMs` (ten minutes when not given). */
async function claimed(w: World, title: string, leaseMs?: number) {
  const task = await Task.create({ title }, as(w.alice));
  const claim = await Claim.acquire({ task: task.id }, leaseMs === undefined ? as(w.bot) : { ...as(w.bot), leaseMs });
  return { task, claim };
}

/** The world's binding, counting the transactions the sweeper opens, with `before` run ahead of each one. */
function counted(w: World, before: (n: number) => Promise<void> = async () => {}) {
  const binding = {
    calls: 0,
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      await before(++binding.calls);
      return w.hyper.transaction(fn);
    },
  };
  return binding satisfies SweepBinding;
}

/** Resolves once `holds` does, checking every 5 ms; rejects after `ms`. */
async function until(holds: () => Promise<boolean>, ms = 2_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await holds())) {
    if (performance.now() > deadline) throw new Error(`the condition did not hold within ${ms} ms`);
    await Bun.sleep(5);
  }
}

describe("sweep", () => {
  test("expires every claim whose lease has run out and bumps its Task once; a live or ended claim is left alone", () => within(async (w) => {
    const due = await claimed(w, "Due now");
    const earlier = await claimed(w, "Due earlier", 5 * 60_000);
    const live = await claimed(w, "Live", 20 * 60_000);
    const released = await claimed(w, "Released");
    await Claim.release({ id: released.claim.id, fence: released.claim.fence }, as(w.bot));
    w.advance(10);
    const tasks = [due, earlier, live, released].map(({ task }) => task.id);
    const before = await Promise.all(tasks.map((id) => versionOf(w, id)));

    // The two lapsed claims' Tasks go up by one, the others not at all.
    const bumped = before.map((version, i) => (i < 2 ? version + 1 : version));

    // `due` runs out exactly now: a lease is over at its `expiresAt`.
    expect(await sweep(w.hyper, ENGINE, w.clock)).toBe(2);
    for (const { claim } of [due, earlier]) expect(await claimOf(w, claim.id)).toMatchObject({ state: "expired", endReason: "lease expired", endedAt: minutes(10) });
    expect(await claimOf(w, live.claim.id)).toMatchObject({ state: "active", endedAt: null });
    expect(await claimOf(w, released.claim.id)).toMatchObject({ state: "released" });
    expect(await Promise.all(tasks.map((id) => versionOf(w, id)))).toEqual(bumped);

    // Nothing is left to expire: a second sweep changes nothing.
    expect(await sweep(w.hyper, ENGINE, w.clock)).toBe(0);
    expect(await Promise.all(tasks.map((id) => versionOf(w, id)))).toEqual(bumped);
  }));

  test("a claim that claim.acquire expired between the sweep's read and its own transaction is not expired again", () => within(async (w) => {
    const { task, claim } = await claimed(w, "Contested");
    w.advance(11);
    let fresh: Claim | undefined;
    // The second transaction is the claim's own: before it opens, Bot claims the Task again, which expires the lapsed claim.
    const binding = counted(w, async (n) => { if (n === 2) fresh = await Claim.acquire({ task: task.id }, as(w.bot)); });
    const version = await versionOf(w, task.id);
    expect(await sweep(binding, ENGINE, w.clock)).toBe(0);
    expect(await claimOf(w, claim.id)).toMatchObject({ state: "expired", endReason: "lease expired", endedAt: minutes(11) });
    expect(await claimOf(w, fresh!.id)).toMatchObject({ state: "active", fence: claim.fence + 1 });
    // Only the acquire touched the Task.
    expect(await versionOf(w, task.id)).toBe(version + 1);
  }));

  test("a claim that fails to expire does not stop the others: the sweep rejects with every failure once all were tried", () => within(async (w) => {
    const first = await claimed(w, "First", 60_000);
    const second = await claimed(w, "Second", 2 * 60_000);
    w.advance(10);
    // The claims are swept in the order their leases ran out; the first one's transaction fails.
    const binding = counted(w, async (n) => { if (n === 2) throw new Error("disk full"); });
    const failed = await sweep(binding, ENGINE, w.clock).then(() => undefined, (error: unknown) => error);
    expect(failed).toBeInstanceOf(AggregateError);
    expect((failed as AggregateError).message).toBe("the lease sweeper could not expire 1 of 2 lapsed claims");
    // Each failure names its claim, with what it failed with as its cause.
    const errors = (failed as AggregateError).errors as Error[];
    expect(errors.map((error) => error.message)).toEqual([`the lease sweeper could not expire claim ${first.claim.id}`]);
    expect(errors.map((error) => (error.cause as Error).message)).toEqual(["disk full"]);
    expect(await claimOf(w, first.claim.id)).toMatchObject({ state: "active" });
    expect(await claimOf(w, second.claim.id)).toMatchObject({ state: "expired" });
    // The next sweep tries it again.
    expect(await sweep(w.hyper, ENGINE, w.clock)).toBe(1);
    expect(await claimOf(w, first.claim.id)).toMatchObject({ state: "expired" });
  }));
});

describe("startSweeper", () => {
  test("sweeps again after each sweep: a claim that lapses while it runs is expired by a later sweep", () => within(async (w) => {
    const binding = counted(w);
    const sweeper = startSweeper(binding, { context: ENGINE, intervalMs: 5, clock: w.clock });
    try {
      const { claim } = await claimed(w, "Later");
      // Two sweeps that found nothing to expire.
      const seen = binding.calls;
      await until(async () => binding.calls >= seen + 2);
      expect(await claimOf(w, claim.id)).toMatchObject({ state: "active" });
      w.advance(10);
      await until(async () => (await claimOf(w, claim.id)).state === "expired");
      expect(await claimOf(w, claim.id)).toMatchObject({ endReason: "lease expired", endedAt: minutes(10) });
    } finally {
      await sweeper.stop();
    }
  }));

  test("stop lets the claim being expired commit, expires no other, returns the same promise each time, and no sweep starts after it", () => within(async (w) => {
    const { claim } = await claimed(w, "Draining", 60_000);
    const { claim: left } = await claimed(w, "Left", 2 * 60_000);
    w.advance(10);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered!: () => void;
    const inProgress = new Promise<void>((resolve) => (entered = resolve));
    // The first sweep reads both lapsed claims; the transaction that expires the first one waits at the gate.
    const binding = counted(w, async (n) => { if (n === 2) { entered(); await gate; } });
    const sweeper = startSweeper(binding, { context: ENGINE, intervalMs: 5, clock: w.clock });
    await inProgress;
    let stopped = false;
    const stopping = sweeper.stop();
    expect(sweeper.stop()).toBe(stopping);
    void stopping.then(() => (stopped = true));
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    open();
    await stopping;
    // The claim it waited for was expired, and the sweep stopped before the next one.
    expect(await claimOf(w, claim.id)).toMatchObject({ state: "expired" });
    expect(await claimOf(w, left.id)).toMatchObject({ state: "active" });
    expect(binding.calls).toBe(2);
    const calls = binding.calls;
    const { claim: next } = await claimed(w, "After the stop");
    w.advance(10);
    await Bun.sleep(30);
    expect(binding.calls).toBe(calls);
    expect(await claimOf(w, next.id)).toMatchObject({ state: "active" });
  }));

  test("stopped before its first sweep, it never sweeps", () => within(async (w) => {
    const binding = counted(w);
    await startSweeper(binding, { context: ENGINE, intervalMs: 5, clock: w.clock }).stop();
    await Bun.sleep(30);
    expect(binding.calls).toBe(0);
  }));

  test("a sweep that fails is logged on standard error, and the next sweep tries again", () => within(async (w) => {
    const { claim } = await claimed(w, "Retried");
    w.advance(10);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const binding = counted(w, async (n) => { if (n === 1) throw new Error("database is locked"); });
    const sweeper = startSweeper(binding, { context: ENGINE, intervalMs: 5, clock: w.clock });
    try {
      await until(async () => (await claimOf(w, claim.id)).state === "expired");
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]![0]).toBe("the lease sweeper failed; it tries again on its next sweep");
      expect((logged.mock.calls[0]![1] as Error).message).toBe("database is locked");
    } finally {
      await sweeper.stop();
      logged.mockRestore();
    }
  }));
});
