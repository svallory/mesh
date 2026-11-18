import type { DataLayer, DataOperations, DeliveryOperations, MultiProcessOperations, OutboxOperations } from "./data-layer.ts";
import { DatabaseBusyError, FrameworkError } from "./errors.ts";
import { outboxRow } from "./outbox-conformance.ts";

/**
 * The data-layer checks of the delivery operations of multi mode (`MultiProcessOperations`, delivery from several
 * processes): each operation on its own, against a database prepared for a bus that declares `multi-process`. Exported
 * from `@meshfw/runtime/testing` as `multiProcessConformance`; a data adapter that delivers such a project runs it.
 */

/** What `multiProcessConformance` takes beside the layer factory. */
export interface MultiProcessConformanceOptions {
  /**
   * A fresh database whose schema was built for a bus without `multi-process` (no process table, no added columns): the
   * multi-mode operations must fail on it with a `FrameworkError` naming `mesh db push`.
   */
  readonly singleLayer?: () => Promise<DataLayer>;
  /**
   * A second layer object over the same database as `layer`, so two transactions run at once, as two processes' would.
   * With it the "[two connections]" checks run: the row locks of `lockDeliveryState` and `lockHandlerProgress` and the
   * conditional moves, which a data adapter whose transactions run on several connections at once must keep. A waiter
   * may read the winner's row or fail with a retryable `DatabaseBusyError` (Postgres at `SERIALIZABLE`), never the row
   * as it was before the winner committed.
   */
  readonly sibling?: (layer: DataLayer) => Promise<DataLayer>;
  /**
   * The layer offers `DataLayer.renewProcess` (a renewal outside its transaction queue). With it the "[renewal outside
   * the queue]" checks run; with `sibling` too, the one that holds the row from the second layer.
   */
  readonly renewsOutsideTheQueue?: boolean;
}

type Ops = DataOperations & DeliveryOperations & MultiProcessOperations & Pick<OutboxOperations, "appendEvent" | "deleteOutboxThrough">;
const ops = (tx: DataOperations) => tx as Ops;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Multi-process data-layer conformance: ${message}`);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
/** Resolves true when `promise` has not settled within `ms`: the transaction waits on a lock. */
async function waits(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return !done;
}
const settled = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
/** A waiter's failure is allowed only as a retryable `DatabaseBusyError`. */
function busyOrNothing(error: unknown, what: string): void {
  assert(error === undefined || (error instanceof DatabaseBusyError && error.retryable), `${what} failed with ${String(error)}, not a retryable DatabaseBusyError`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";
const NIL = "00000000-0000-0000-0000-000000000000";

/**
 * Named, runner-independent asynchronous checks, like `dataLayerConformanceV1`. `makeLayer` returns a fresh database
 * with core's tables and the multi-process additions (`coreTablesFor(document, { multiProcess: true })`) and no row in
 * them; each check closes it.
 */
export function multiProcessConformance(makeLayer: () => Promise<DataLayer>, options: MultiProcessConformanceOptions = {}): Record<string, () => Promise<void>> {
  const withLayer = (run: (layer: DataLayer) => Promise<void>) => async () => {
    const layer = await makeLayer();
    try { await run(layer); } finally { await layer.close(); }
  };
  const checks: Record<string, () => Promise<void>> = {
    "every multi-process operation is a function of the transaction's operations": withLayer((layer) => layer.transaction(async (tx) => {
      for (const name of [
        "lockDeliveryState", "readDeliveryStateUnlocked", "writeKeep", "lockHandlerProgress", "readHandlerLeases", "writeHandlerLease", "moveHandler", "moveSubscription",
        "readProcesses", "writeProcess", "renewProcess", "deleteProcess", "readSubscriptionOwners", "writeSubscriptionOwner",
      ] as const) assert(typeof (tx as Partial<Ops>)[name] === "function", `the transaction has no ${name}`);
    })),
    "lockDeliveryState reads what readDeliveryState reads, with keep null until writeKeep records one, which creates the row if needed": withLayer(async (layer) => {
      await layer.transaction(async (tx) => {
        const locked = await ops(tx).lockDeliveryState();
        const plain = await ops(tx).readDeliveryState();
        assert(locked.keep === null, "keep is null before any is recorded");
        assert(locked.deletedThrough === plain.deletedThrough && locked.highest === plain.highest && locked.generation === plain.generation && same(locked.claim, plain.claim),
          "lockDeliveryState reads the row readDeliveryState reads");
        assert(locked.now instanceof Date && Math.abs(locked.now.getTime() - plain.now.getTime()) < 5000, "lockDeliveryState carries the database's now");
        await ops(tx).writeKeep("all");
      });
      await layer.transaction(async (tx) => {
        assert((await ops(tx).lockDeliveryState()).keep === "all", "writeKeep records the keep");
        await ops(tx).writeClaim({ runId: NIL, generation: 4, host: null, pid: null, startedAt: null });
        await ops(tx).writeKeep("until-delivered");
      });
      await layer.transaction(async (tx) => {
        const locked = await ops(tx).lockDeliveryState();
        assert(locked.keep === "until-delivered", "writeKeep moves the keep either way");
        assert(locked.claim?.runId === NIL && locked.claim.generation === 4 && locked.generation === 4, "writeKeep leaves the claim as it is");
        assert(locked.claim.host === null && locked.claim.pid === null && locked.claim.startedAt === null, "a claim written with host: null keeps no host");
      });
      await layer.transaction(async (tx) => {
        const unlocked = await ops(tx).readDeliveryStateUnlocked();
        const plain = await ops(tx).readDeliveryState();
        assert(unlocked.deletedThrough === plain.deletedThrough && unlocked.highest === plain.highest && unlocked.generation === plain.generation && same(unlocked.claim, plain.claim),
          "readDeliveryStateUnlocked reads the row readDeliveryState reads");
        assert(unlocked.now instanceof Date && !("keep" in unlocked), "readDeliveryStateUnlocked carries the database's now and no keep");
      });
    }),
    "a lease round-trips: lockHandlerProgress and readHandlerLeases read what writeHandlerLease wrote, and readHandlerProgress the same row without it": withLayer(async (layer) => {
      await layer.transaction(async (tx) => {
        assert((await ops(tx).lockHandlerProgress("notify")) === undefined, "a handler with no row has no lease");
        await ops(tx).writeHandlerLease({ name: "notify", kind: "process", position: 3, events: ["a.A", "a.B"], generation: 2, runId: RUN_A });
        await ops(tx).writeHandlerLease({ name: "audit", kind: "listen", position: 0, events: ["a.A"], generation: 0, runId: null });
      });
      await layer.transaction(async (tx) => {
        const locked = await ops(tx).lockHandlerProgress("notify");
        assert(same(locked, { name: "notify", kind: "process", position: 3, events: ["a.A", "a.B"], generation: 2, runId: RUN_A }), `lockHandlerProgress reads the lease back, got ${JSON.stringify(locked)}`);
        const leases = await ops(tx).readHandlerLeases();
        assert(same(leases.map((row) => [row.name, row.runId]), [["audit", null], ["notify", RUN_A]]), "readHandlerLeases lists every row in name order with its run id");
        const plain = (await ops(tx).readHandlerProgress()).find((row) => row.name === "notify");
        assert(same(plain, { name: "notify", kind: "process", position: 3, events: ["a.A", "a.B"], generation: 2 }), "readHandlerProgress reads the same row");
        await ops(tx).writeHandlerLease({ ...locked!, runId: null, generation: 3 });
      });
      await layer.transaction(async (tx) => {
        const cleared = await ops(tx).lockHandlerProgress("notify");
        assert(cleared?.runId === null && cleared.generation === 3, "writeHandlerLease replaces the lease");
      });
    }),
    "moveHandler moves only a row still at from under the same lease, and moveSubscription only one still at from": withLayer(async (layer) => {
      await layer.transaction(async (tx) => {
        await ops(tx).writeHandlerLease({ name: "notify", kind: "process", position: 3, events: ["a.A"], generation: 2, runId: RUN_A });
        await ops(tx).writeSubscriptionOwner({ name: "feed", position: 5, filter: {}, open: true, generation: 0, runId: RUN_A });
      });
      await layer.transaction(async (tx) => {
        const o = ops(tx);
        assert(!(await o.moveHandler("notify", 2, 9, RUN_A, 2)), "a handler that moved is not moved");
        assert(!(await o.moveHandler("notify", 3, 9, RUN_B, 2)), "a handler another process holds is not moved");
        assert(!(await o.moveHandler("notify", 3, 9, RUN_A, 1)), "a handler taken over since (another generation) is not moved");
        assert(!(await o.moveHandler("gone", 3, 9, RUN_A, 2)), "a handler with no row is not moved");
        assert(await o.moveHandler("notify", 3, 9, RUN_A, 2), "a handler at from under the lease moves");
        assert(!(await o.moveSubscription("feed", 4, 8)), "a subscription that moved is not moved");
        assert(!(await o.moveSubscription("none", 5, 8)), "a subscription with no row is not moved");
        assert(await o.moveSubscription("feed", 5, 8), "a subscription at from moves");
      });
      await layer.transaction(async (tx) => {
        const lease = await ops(tx).lockHandlerProgress("notify");
        assert(lease?.position === 9 && lease.runId === RUN_A && lease.generation === 2, "the move changed the position only");
        const feed = (await ops(tx).readSubscriptionOwners()).find((row) => row.name === "feed");
        assert(feed?.position === 8 && feed.runId === RUN_A && feed.open, "the subscription's move changed the position only");
      });
    }),
    "process rows round-trip: writeProcess with the database's clock and the data layer's host, readProcesses in run id order, deleteProcess": withLayer(async (layer) => {
      const startedAt = new Date(Date.UTC(2026, 10, 17, 12, 0, 0));
      await layer.transaction(async (tx) => {
        assert((await ops(tx).readProcesses()).length === 0, "no process row before the first write");
        await ops(tx).writeProcess({ runId: RUN_B, pid: 42, startedAt, keep: "all", handlers: { notify: ["a.A", "a.B"], audit: ["a.A"] }, declared: ["a.A", "a.B"] });
        await ops(tx).writeProcess({ runId: RUN_A, host: null, pid: null, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] });
      });
      await layer.transaction(async (tx) => {
        const now = (await ops(tx).readDeliveryState()).now;
        const rows = await ops(tx).readProcesses();
        assert(same(rows.map((row) => row.runId), [RUN_A, RUN_B]), "readProcesses lists the rows in run id order");
        const [a, b] = rows as [typeof rows[number], typeof rows[number]];
        assert(a.host === null && a.pid === null && a.startedAt === null && a.keep === "until-delivered" && same(a.handlers, {}) && same(a.declared, []), "a row written with host: null keeps none");
        assert(typeof b.host === "string" && b.host !== "", "a row written without a host gets the data layer's host");
        assert(b.pid === 42 && b.startedAt?.getTime() === startedAt.getTime() && b.keep === "all", "pid, start time and keep round-trip");
        // a map's key order is not kept (Postgres's jsonb sorts the keys); each handler's list is, as written
        assert(same(Object.entries(b.handlers).sort(), [["audit", ["a.A"]], ["notify", ["a.A", "a.B"]]]) && same(b.declared, ["a.A", "a.B"]), "handlers and declared round-trip");
        assert(Math.abs(b.renewedAt.getTime() - now.getTime()) < 5000, "renewedAt is the database's clock");
        assert(await ops(tx).deleteProcess(RUN_A), "deleteProcess deletes a row");
        assert(!(await ops(tx).deleteProcess(RUN_A)), "deleteProcess of a row that is gone is false");
        assert(same((await ops(tx).readProcesses()).map((row) => row.runId), [RUN_B]), "the other row stays");
      });
    }),
    "renewProcess renews a row that has not lapsed, and refuses a lapsed or absent one": withLayer(async (layer) => {
      await layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN_A, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
      const first = (await layer.transaction((tx) => ops(tx).readProcesses()))[0]!.renewedAt.getTime();
      await sleep(40);
      assert(await layer.transaction((tx) => ops(tx).renewProcess(RUN_A, 60_000)), "a row renewed within the lapse is renewed");
      const second = (await layer.transaction((tx) => ops(tx).readProcesses()))[0]!.renewedAt.getTime();
      assert(second > first, "a renewal moves renewedAt");
      await sleep(40);
      assert(!(await layer.transaction((tx) => ops(tx).renewProcess(RUN_A, 20))), "a row older than the lapse is not renewed");
      assert((await layer.transaction((tx) => ops(tx).readProcesses()))[0]!.renewedAt.getTime() === second, "a refused renewal writes nothing");
      assert(!(await layer.transaction((tx) => ops(tx).renewProcess(RUN_B, 60_000))), "an absent row is not renewed");
    }),
    "subscription owners round-trip, and readSubscriptionProgress reads the same rows without the owner": withLayer(async (layer) => {
      const seenAt = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
      await layer.transaction(async (tx) => {
        await ops(tx).writeSubscriptionOwner({ name: "feed", position: 2, filter: { names: ["a.A"] }, open: true, generation: 0, runId: RUN_A, seenAt });
        await ops(tx).writeSubscriptionOwner({ name: "audit", position: 0, filter: {}, open: false, generation: 0, runId: null });
      });
      await layer.transaction(async (tx) => {
        const rows = await ops(tx).readSubscriptionOwners();
        assert(same(rows.map((row) => [row.name, row.runId, row.open, row.position]), [["audit", null, false, 0], ["feed", RUN_A, true, 2]]), "readSubscriptionOwners lists every row in name order with its owner");
        assert(rows[1]!.seenAt.getTime() === seenAt.getTime() && same(rows[1]!.filter, { names: ["a.A"] }), "seenAt and the filter round-trip");
        const now = (await ops(tx).readDeliveryState()).now;
        assert(Math.abs(rows[0]!.seenAt.getTime() - now.getTime()) < 5000, "a left-out seenAt is the database's clock");
        const plain = await ops(tx).readSubscriptionProgress();
        assert(same(plain.map((row) => [row.name, row.position, row.open]), [["audit", 0, false], ["feed", 2, true]]), "readSubscriptionProgress reads the same rows");
      });
    }),
  };
  const sibling = options.sibling;
  if (sibling) {
    /** A check with `layer` and a second layer object over the same database. */
    const withTwo = (run: (first: DataLayer, second: DataLayer) => Promise<void>) => withLayer(async (layer) => {
      const second = await sibling(layer);
      try { await run(layer, second); } finally { await second.close(); }
    });
    /** A transaction on `layer` that runs `body`, then holds its locks until the returned `release` is called. */
    const holding = (layer: DataLayer, body: (o: Ops) => Promise<void>) => {
      const held = gate();
      const release = gate();
      const done = layer.transaction(async (tx) => { await body(ops(tx)); held.open(); await release.wait; });
      return { held: held.wait, release: release.open, done };
    };
    checks["[two connections] lockHandlerProgress waits for another connection's lock on the row, and the waiter reads the takeover's lease or fails busy, never the lease as it was"] = withTwo(async (first, second) => {
      await first.transaction((tx) => ops(tx).writeHandlerLease({ name: "notify", kind: "process", position: 3, events: ["a.A"], generation: 1, runId: RUN_A }));
      const takeover = holding(first, async (o) => {
        const row = await o.lockHandlerProgress("notify");
        await o.writeHandlerLease({ ...row!, generation: row!.generation + 1, runId: RUN_B });
      });
      await takeover.held;
      const waiter = settled(second.transaction((tx) => ops(tx).lockHandlerProgress("notify")));
      assert(await waits(waiter), "a second lockHandlerProgress of the row returned while another connection held it");
      takeover.release();
      await takeover.done;
      const { value, error } = await waiter;
      busyOrNothing(error, "the waiting lockHandlerProgress");
      if (error === undefined) assert(value?.runId === RUN_B && value.generation === 2, `the waiter read the lease as it was before the takeover, ${JSON.stringify(value)}`);
      const after = await second.transaction((tx) => ops(tx).lockHandlerProgress("notify"));
      assert(after?.runId === RUN_B && after.generation === 2 && after.position === 3, "the next transaction reads the takeover's lease");
    });
    checks["[two connections] a deletion batch's moveHandler concurrent with a takeover moves nothing and never reverts the lease"] = withTwo(async (first, second) => {
      await first.transaction((tx) => ops(tx).writeHandlerLease({ name: "notify", kind: "process", position: 3, events: ["a.A"], generation: 2, runId: RUN_A }));
      const takeover = holding(first, async (o) => {
        const row = await o.lockHandlerProgress("notify");
        await o.writeHandlerLease({ ...row!, generation: 3, runId: RUN_B });
      });
      await takeover.held;
      // the batch locks mesh_outbox_state first, as every batch does, then moves under the lease it held
      const batch = settled(second.transaction(async (tx) => { await ops(tx).lockDeliveryState(); return ops(tx).moveHandler("notify", 3, 9, RUN_A, 2); }));
      assert(await waits(batch), "the batch's moveHandler ran while a takeover held the row");
      takeover.release();
      await takeover.done;
      const { value, error } = await batch;
      busyOrNothing(error, "the batch");
      assert(error !== undefined || value === false, "the batch's moveHandler moved a row taken over since");
      const after = await second.transaction((tx) => ops(tx).lockHandlerProgress("notify"));
      assert(after?.runId === RUN_B && after.generation === 3 && after.position === 3, `the takeover's lease stands, got ${JSON.stringify(after)}`);
    });
    checks["[two connections] a deletion batch's moveHandler concurrent with a handler transaction never lowers the position, either way round"] = withTwo(async (first, second) => {
      await first.transaction((tx) => ops(tx).writeHandlerLease({ name: "notify", kind: "process", position: 3, events: ["a.A"], generation: 2, runId: RUN_A }));
      // the handler transaction moves the position to 12 first; the batch read 3 before it and waits
      const handler = holding(first, async (o) => {
        const row = await o.lockHandlerProgress("notify");
        await o.writeHandlerLease({ ...row!, position: 12 });
      });
      await handler.held;
      const batch = settled(second.transaction((tx) => ops(tx).moveHandler("notify", 3, 9, RUN_A, 2)));
      assert(await waits(batch), "the batch's moveHandler ran while a handler transaction held the row");
      handler.release();
      await handler.done;
      const { value, error } = await batch;
      busyOrNothing(error, "the batch");
      assert(error !== undefined || value === false, "the batch's moveHandler moved a row the handler had moved since");
      assert((await second.transaction((tx) => ops(tx).lockHandlerProgress("notify")))?.position === 12, "the handler's position stands");
      // the batch moves 12 to 20 first; the handler transaction waits, then reads 20 (or fails busy and reads it next time)
      const moving = holding(second, async (o) => { assert(await o.moveHandler("notify", 12, 20, RUN_A, 2), "the batch moves a row still at from"); });
      await moving.held;
      const reader = settled(first.transaction((tx) => ops(tx).lockHandlerProgress("notify")));
      assert(await waits(reader), "the handler transaction's lockHandlerProgress returned while the batch's move held the row");
      moving.release();
      await moving.done;
      const read = await reader;
      busyOrNothing(read.error, "the handler transaction");
      if (read.error === undefined) assert(read.value?.position === 20, `the handler transaction read the position as it was before the batch's move, ${JSON.stringify(read.value)}`);
      assert((await first.transaction((tx) => ops(tx).lockHandlerProgress("notify")))?.position === 20, "the batch's move stands");
    });
    checks["[two connections] lockDeliveryState orders a subscription's open and a deletion batch, so neither works from a state the other changed"] = withTwo(async (first, second) => {
      const appended = await first.transaction(async (tx) => {
        const positions: number[] = [];
        for (let n = 1; n <= 3; n++) positions.push(await ops(tx).appendEvent(outboxRow(n)));
        return positions;
      });
      const top = appended.at(-1)!;
      // a batch that found no subscription deletes through the last row; an open that waited on it sees the deletion
      const batch = holding(first, async (o) => {
        await o.lockDeliveryState();
        assert((await o.readSubscriptionOwners()).length === 0, "no subscription row yet");
        await o.deleteOutboxThrough(top);
      });
      await batch.held;
      const open = settled(second.transaction(async (tx) => (await ops(tx).lockDeliveryState()).deletedThrough));
      assert(await waits(open), "a subscription's lockDeliveryState returned while a deletion batch held the state row");
      batch.release();
      await batch.done;
      const opened = await open;
      busyOrNothing(opened.error, "the subscription's open");
      if (opened.error === undefined) assert(opened.value === top, `the open read deletedThrough ${opened.value} from before the batch, not ${top}`);
      assert((await second.transaction((tx) => ops(tx).lockDeliveryState())).deletedThrough === top, "the next open reads the batch's deletion");
      // the other way round: an open writes its row at the deleted-through position, and a batch waited on it. The batch
      // either sees the row, or (Postgres at SERIALIZABLE: the lock wait does not renew the snapshot) works from a state
      // without it and then fails busy when it deletes, so it never deletes a row the subscription has not acknowledged
      const later = await first.transaction((tx) => ops(tx).appendEvent(outboxRow(4)));
      const opening = holding(second, async (o) => {
        const state = await o.lockDeliveryState();
        await o.writeSubscriptionOwner({ name: "feed", position: state.deletedThrough, filter: {}, open: true, generation: 0, runId: RUN_B });
      });
      await opening.held;
      const next = settled(first.transaction(async (tx) => {
        const state = await ops(tx).lockDeliveryState();
        const owners = await ops(tx).readSubscriptionOwners();
        // the bound, as a batch computes it: the lowest acknowledged position, else the highest
        const bound = Math.min(state.highest, ...owners.map((row) => row.position));
        if (bound > state.deletedThrough) await ops(tx).deleteOutboxThrough(bound);
        return owners.map((row) => [row.name, row.position]);
      }));
      assert(await waits(next), "a deletion batch's lockDeliveryState returned while a subscription's open held the state row");
      opening.release();
      await opening.done;
      const seen = await next;
      busyOrNothing(seen.error, "the batch");
      if (seen.error === undefined) assert(same(seen.value, [["feed", top]]), `the batch deleted from a state without the subscription opened before it, ${JSON.stringify(seen.value)}`);
      const state = await first.transaction((tx) => ops(tx).lockDeliveryState());
      assert(state.deletedThrough === top, `the batch deleted past the subscription's position ${top}, through ${state.deletedThrough}`);
      assert(later > top, "a later row has a higher position");
    });
    checks["[two connections] readDeliveryStateUnlocked takes no lock: a handler transaction holding its progress row does not hold up a registration's lockDeliveryState, nor waits for one"] = withTwo(async (first, second) => {
      await first.transaction(async (tx) => {
        await ops(tx).lockDeliveryState();
        await ops(tx).writeHandlerLease({ name: "notify", kind: "process", position: 3, events: ["a.A"], generation: 1, runId: RUN_A });
      });
      // the handler transaction: the claim check (L3), the progress row locked and moved, then the handler runs
      const handler = holding(first, async (o) => {
        await o.readDeliveryStateUnlocked();
        const row = await o.lockHandlerProgress("notify");
        await o.writeHandlerLease({ ...row!, position: 7 });
      });
      await handler.held;
      try {
        const registration = settled(second.transaction(async (tx) => (await ops(tx).lockDeliveryState()).generation));
        assert(!(await waits(registration)), "a lockDeliveryState waited for a handler transaction that read the state row with readDeliveryStateUnlocked");
        const registered = await registration;
        assert(registered.error === undefined, `the lockDeliveryState beside a handler transaction failed with ${String(registered.error)}`);
      } finally {
        handler.release();
        await handler.done;
      }
      // the other way round: a registration holds the state row, and a handler transaction's claim check reads it
      const registering = holding(second, async (o) => { await o.lockDeliveryState(); });
      await registering.held;
      try {
        const read = settled(first.transaction((tx) => ops(tx).readDeliveryStateUnlocked()));
        assert(!(await waits(read)), "readDeliveryStateUnlocked waited for another connection's lockDeliveryState");
        const { value, error } = await read;
        assert(error === undefined && value!.now instanceof Date && typeof value!.generation === "number", `readDeliveryStateUnlocked beside a lock failed with ${String(error)}`);
      } finally {
        registering.release();
        await registering.done;
      }
      assert((await first.transaction((tx) => ops(tx).lockHandlerProgress("notify")))?.position === 7, "the handler transaction's move stands");
    });
    checks["[two connections] a deletion batch's moveSubscription concurrent with the subscription's ack moves nothing and never lowers the position"] = withTwo(async (first, second) => {
      await first.transaction((tx) => ops(tx).writeSubscriptionOwner({ name: "feed", position: 3, filter: {}, open: true, generation: 0, runId: RUN_A }));
      // the ack moves the row from 3 to 12 and holds it; the batch read 3 before it and waits
      const ack = holding(first, async (o) => {
        const row = (await o.readSubscriptionOwners()).find((each) => each.name === "feed")!;
        await o.writeSubscriptionOwner({ name: row.name, position: 12, filter: row.filter, open: row.open, generation: row.generation, runId: row.runId });
      });
      await ack.held;
      const batch = settled(second.transaction((tx) => ops(tx).moveSubscription("feed", 3, 9)));
      assert(await waits(batch), "the batch's moveSubscription ran while the subscription's ack held the row");
      ack.release();
      await ack.done;
      const { value, error } = await batch;
      busyOrNothing(error, "the batch");
      assert(error !== undefined || value === false, "the batch's moveSubscription moved a row the ack had moved since");
      const after = (await second.transaction((tx) => ops(tx).readSubscriptionOwners())).find((each) => each.name === "feed");
      assert(after?.position === 12 && after.runId === RUN_A, `the ack's position stands, got ${JSON.stringify(after)}`);
    });
  }
  const singleLayer = options.singleLayer;
  if (singleLayer) {
    checks["on a schema built without multi-process, each multi-mode operation fails with a FrameworkError naming mesh db push"] = async () => {
      const layer = await singleLayer();
      try {
        const calls: [string, (o: Ops) => Promise<unknown>][] = [
          ["lockDeliveryState", (o) => o.lockDeliveryState()],
          ["writeKeep", (o) => o.writeKeep("all")],
          ["lockHandlerProgress", (o) => o.lockHandlerProgress("x")],
          ["readHandlerLeases", (o) => o.readHandlerLeases()],
          ["readProcesses", (o) => o.readProcesses()],
          ["renewProcess", (o) => o.renewProcess(RUN_A, 1000)],
          ["readSubscriptionOwners", (o) => o.readSubscriptionOwners()],
        ];
        for (const [name, call] of calls) {
          const error = await layer.transaction((tx) => call(ops(tx))).then(() => undefined, (thrown: unknown) => thrown);
          assert(error instanceof FrameworkError && error.message.includes("mesh db push"), `${name} on a single-mode schema fails with the mesh db push FrameworkError, got ${String(error)}`);
        }
        // the single-mode operations still run on it
        await layer.transaction((tx) => ops(tx).readDeliveryState());
      } finally { await layer.close(); }
    };
  }
  if (options.renewsOutsideTheQueue) {
    const renew = (layer: DataLayer, runId: string, lapseMs: number, deadline = Date.now() + 2000) => {
      assert(typeof layer.renewProcess === "function", "the layer has no renewProcess");
      return layer.renewProcess(runId, lapseMs, { deadline });
    };
    checks["[renewal outside the queue] renewProcess renews a row that has not lapsed, and refuses a lapsed or absent one"] = withLayer(async (layer) => {
      await layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN_A, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
      const first = (await layer.transaction((tx) => ops(tx).readProcesses()))[0]!.renewedAt.getTime();
      await sleep(40);
      assert(await renew(layer, RUN_A, 60_000), "a row renewed within the lapse is renewed");
      const second = (await layer.transaction((tx) => ops(tx).readProcesses()))[0]!.renewedAt.getTime();
      assert(second > first, "a renewal moves renewedAt, and the next transaction sees it committed");
      await sleep(40);
      assert(!(await renew(layer, RUN_A, 20)), "a row older than the lapse is not renewed");
      assert((await layer.transaction((tx) => ops(tx).readProcesses()))[0]!.renewedAt.getTime() === second, "a refused renewal writes nothing");
      assert(!(await renew(layer, RUN_B, 60_000)), "an absent row is not renewed");
      const [a, b] = await Promise.all([renew(layer, RUN_A, 60_000), renew(layer, RUN_A, 60_000)]);
      assert(a && b, "two renewals at once both renew");
    });
    checks["[renewal outside the queue] renewProcess is refused inside a transaction of the layer, which it would not join"] = withLayer(async (layer) => {
      await layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN_A, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
      const refused = await settled(layer.transaction(() => renew(layer, RUN_A, 60_000)));
      assert(refused.error instanceof FrameworkError && /inside a transaction/.test(refused.error.message), `a renewal inside a transaction gave ${String(refused.error)}`);
      assert(await renew(layer, RUN_A, 60_000), "the layer renews again once the transaction ended");
    });
    checks["[renewal outside the queue] a missing process table is the FrameworkError naming mesh db push"] = async () => {
      if (!options.singleLayer) return;
      const layer = await options.singleLayer();
      try {
        const missing = await settled(renew(layer, RUN_A, 60_000));
        assert(missing.error instanceof FrameworkError && missing.error.message.includes("mesh db push"), `renewProcess on a schema without the process table gave ${String(missing.error)}`);
      } finally { await layer.close(); }
    };
    if (options.sibling) {
      checks["[renewal outside the queue] renewProcess waits for a lock on its row no longer than its deadline, then fails with DatabaseBusyError"] = withLayer(async (layer) => {
        const other = await options.sibling!(layer);
        try {
          await layer.transaction((tx) => ops(tx).writeProcess({ runId: RUN_A, pid: 1, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }));
          const held = gate();
          const holding = gate();
          const holder = other.transaction(async (tx) => { await ops(tx).writeProcess({ runId: RUN_A, pid: 2, startedAt: null, keep: "until-delivered", handlers: {}, declared: [] }); holding.open(); await held.wait; });
          await holding.wait;
          const started = Date.now();
          const blocked = await settled(renew(layer, RUN_A, 60_000, started + 300));
          const took = Date.now() - started;
          held.open();
          await holder;
          assert(blocked.error instanceof DatabaseBusyError, `a renewal of a row another connection holds gave ${String(blocked.error ?? blocked.value)}`);
          assert(took >= 250 && took < 2000, `the renewal gave up at its deadline (300 ms), after ${took} ms`);
          assert(await renew(layer, RUN_A, 60_000), "once the lock is released the renewal renews");
        } finally { await other.close(); }
      });
    }
  }
  return checks;
}
