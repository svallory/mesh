import type { DataLayer, DataOperations, DeliveryOperations, MultiProcessOperations } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";

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
}

type Ops = DataOperations & DeliveryOperations & MultiProcessOperations;
const ops = (tx: DataOperations) => tx as Ops;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Multi-process data-layer conformance: ${message}`);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
        "lockDeliveryState", "writeKeep", "lockHandlerProgress", "readHandlerLeases", "writeHandlerLease", "moveHandler", "moveSubscription",
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
        assert(same(b.handlers, { notify: ["a.A", "a.B"], audit: ["a.A"] }) && same(b.declared, ["a.A", "a.B"]), "handlers and declared round-trip");
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
  return checks;
}
