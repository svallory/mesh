import type { DataLayer, DataOperations, DeliveryOperations } from "./data-layer.ts";
import { DatabaseBusyError, FrameworkError } from "./errors.ts";

/**
 * The data-layer checks of `DataLayer.renewClaim`, single mode's claim renewal outside the transaction queue
 * (mesh-yd0i). Exported from `@meshfw/runtime/testing` as `claimRenewalConformance`; a data adapter that offers the
 * method runs it.
 */

/** What `claimRenewalConformance` takes beside the layer factory. */
export interface ClaimRenewalConformanceOptions {
  /**
   * A second layer object over the same database as `layer`, so a transaction of it holds the claim's row (its lock on
   * Postgres, the write lock on SQLite) while `layer` renews. With it the deadline check runs.
   */
  readonly sibling?: (layer: DataLayer) => Promise<DataLayer>;
  /** A fresh database with no delivery tables: `renewClaim` must fail on it with the `FrameworkError` naming `mesh db push`. */
  readonly bareLayer?: () => Promise<DataLayer>;
  /**
   * True when every transaction of the layer takes the claim's row (SQLite: every transaction holds the one write
   * lock). Without it the queue check runs: a transaction that does not take the row holds the queue while the renewal
   * goes past it.
   */
  readonly everyTransactionTakesTheRow?: boolean;
}

const ops = (tx: DataOperations) => tx as DataOperations & DeliveryOperations;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Claim-renewal conformance: ${message}`);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settled = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));

const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";

/**
 * Named, runner-independent asynchronous checks, like `dataLayerConformanceV1`. `makeLayer` returns a fresh database
 * with core's delivery tables and no row in them, on a layer that has `renewClaim`; each check closes it.
 */
export function claimRenewalConformance(makeLayer: () => Promise<DataLayer>, options: ClaimRenewalConformanceOptions = {}): Record<string, () => Promise<void>> {
  const withLayer = (run: (layer: DataLayer) => Promise<void>) => async () => {
    const layer = await makeLayer();
    try { await run(layer); } finally { await layer.close(); }
  };
  const renew = (layer: DataLayer, runId: string, generation: number, deadline = Date.now() + 2000) => {
    assert(typeof layer.renewClaim === "function", "the layer has no renewClaim");
    return layer.renewClaim(runId, generation, { deadline });
  };
  const claim = (layer: DataLayer, generation = 1) =>
    layer.transaction((tx) => ops(tx).writeClaim({ runId: RUN_A, generation, host: null, pid: 1, startedAt: null }));
  const renewedAt = async (layer: DataLayer) => {
    const state = await layer.transaction((tx) => ops(tx).readDeliveryState());
    return state.claim?.renewedAt.getTime();
  };
  const checks: Record<string, () => Promise<void>> = {
    "renewClaim renews the claim that holds the run id and the generation, and no other": withLayer(async (layer) => {
      assert(!(await renew(layer, RUN_A, 1)), "with no claim written, nothing is renewed");
      await claim(layer, 3);
      const first = await renewedAt(layer);
      await sleep(40);
      assert(await renew(layer, RUN_A, 3), "the claim's own run id and generation renew it");
      const second = await renewedAt(layer);
      assert(first !== undefined && second !== undefined && second > first, "a renewal moves renewedAt, and the next transaction sees it committed");
      assert(!(await renew(layer, RUN_B, 3)), "another run id renews nothing");
      assert(!(await renew(layer, RUN_A, 2)), "another generation renews nothing");
      assert(await renewedAt(layer) === second, "a refused renewal writes nothing");
      const [a, b] = await Promise.all([renew(layer, RUN_A, 3), renew(layer, RUN_A, 3)]);
      assert(a && b, "two renewals at once both renew");
    }),
    "renewClaim is refused inside a transaction of the layer, which it would not join": withLayer(async (layer) => {
      await claim(layer);
      const refused = await settled(layer.transaction(() => renew(layer, RUN_A, 1)));
      assert(refused.error instanceof FrameworkError && /inside a transaction/.test(refused.error.message), `a renewal inside a transaction gave ${String(refused.error)}`);
      assert(await renew(layer, RUN_A, 1), "the layer renews again once the transaction ended");
    }),
  };
  // mesh-yd0i: the layer's own transaction holding the claim's row (a handler transaction's first statement) until
  // past the renewal's deadline, with another transaction queued behind it. No other process can take the claim
  // meanwhile, so the renewal waits for it without counting the wait and renews; it runs before the queued
  // transaction takes the row, which then neither waits for it in the database nor fails (Postgres's 40001).
  checks["renewClaim waits for this layer's own transaction holding the claim's row without counting the wait, and goes before the next one"] = withLayer(async (layer) => {
    await claim(layer);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const order: string[] = [];
    const holder = layer.transaction(async (tx) => { await ops(tx).readDeliveryState(); holding(); await released; order.push("holder ended"); });
    await held;
    const next = layer.transaction(async (tx) => { await ops(tx).readDeliveryState(); order.push("next took the row"); });
    let heard: Promise<number> | undefined;
    const deadline = Date.now() + 300;
    const renewal = settled(layer.renewClaim!(RUN_A, 1, { deadline, onHeld: (moved) => { heard = moved; } }).then((value) => { order.push("renewed"); return value; }));
    await sleep(600);
    assert(order.length === 0, `while this layer's transaction held the row nothing went on, got ${JSON.stringify(order)}`);
    release();
    const result = await renewal;
    await holder;
    const queued = await settled(next);
    assert(result.value === true, `the renewal renewed once the transaction ended, past its deadline, got ${String(result.error ?? result.value)}`);
    assert(queued.error === undefined, `the transaction queued behind the holder failed beside the renewal: ${String(queued.error)}`);
    assert(JSON.stringify(order) === JSON.stringify(["holder ended", "renewed", "next took the row"]), `the renewal goes right after the holder and before the next transaction, got ${JSON.stringify(order)}`);
    assert(heard !== undefined && (await heard) >= deadline + 250, "the layer told core of the wait, with the deadline moved by it");
  });
  if (!options.everyTransactionTakesTheRow) {
    // The bead's case: a transaction of the layer that does not take the claim's row (an application's, waiting on
    // another connection's locks) holds the queue, and another waits behind it. A renewal through the queue would wait
    // for both.
    checks["renewClaim renews while this layer's queue is held by a transaction that does not take the claim's row"] = withLayer(async (layer) => {
      await claim(layer);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let running!: () => void;
      const started = new Promise<void>((resolve) => { running = resolve; });
      const holder = layer.transaction(async () => { running(); await released; });
      await started;
      const behind = layer.transaction(async () => undefined);
      try {
        const result = await Promise.race([settled(renew(layer, RUN_A, 1)), sleep(1500).then(() => "timeout" as const)]);
        assert(result !== "timeout", "the renewal waited behind the layer's queue");
        assert(result.value === true, `the renewal renewed beside the held queue, got ${String(result.error ?? result.value)}`);
      } finally { release(); await holder; await behind; }
    });
  }
  if (options.bareLayer) {
    checks["a missing state table is the FrameworkError naming mesh db push"] = async () => {
      const layer = await options.bareLayer!();
      try {
        const missing = await settled(renew(layer, RUN_A, 1));
        assert(missing.error instanceof FrameworkError && missing.error.message.includes("mesh db push"), `renewClaim on a schema without the state table gave ${String(missing.error ?? missing.value)}`);
      } finally { await layer.close(); }
    };
  }
  if (options.sibling) {
    checks["renewClaim waits for another connection's hold on the claim's row no longer than its deadline, then fails with DatabaseBusyError"] = withLayer(async (layer) => {
      const other = await options.sibling!(layer);
      try {
        await claim(layer);
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let holding!: () => void;
        const held = new Promise<void>((resolve) => { holding = resolve; });
        // A handler transaction's first statement: the state row, locked (the write lock on SQLite).
        const holder = other.transaction(async (tx) => { await ops(tx).readDeliveryState(); holding(); await released; });
        await held;
        const started = Date.now();
        const blocked = await settled(renew(layer, RUN_A, 1, started + 300));
        const took = Date.now() - started;
        release();
        await holder;
        assert(blocked.error instanceof DatabaseBusyError, `a renewal of a claim another connection holds gave ${String(blocked.error ?? blocked.value)}`);
        assert(took >= 250 && took < 2000, `the renewal gave up at its deadline (300 ms), after ${took} ms`);
        assert(await renew(layer, RUN_A, 1), "once the hold is released the renewal renews");
      } finally { await other.close(); }
    });
    // The safety of a renewal outside the queue: one that waited for another connection's takeover re-reads the row
    // the takeover left, so a generation the takeover moved makes it renew nothing.
    checks["renewClaim that waited for another connection's takeover renews nothing once the takeover moved the generation"] = withLayer(async (layer) => {
      const other = await options.sibling!(layer);
      try {
        await claim(layer);
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let holding!: () => void;
        const held = new Promise<void>((resolve) => { holding = resolve; });
        const takeover = other.transaction(async (tx) => {
          const state = await ops(tx).readDeliveryState();
          holding();
          await released;
          await ops(tx).writeClaim({ runId: RUN_B, generation: state.generation + 1, host: null, pid: 2, startedAt: null });
        });
        await held;
        const renewal = settled(renew(layer, RUN_A, 1, Date.now() + 3000));
        await sleep(150);
        release();
        await takeover;
        const result = await renewal;
        assert(result.value === false, `a renewal after the takeover renewed nothing, got ${String(result.error ?? result.value)}`);
        const state = await layer.transaction((tx) => ops(tx).readDeliveryState());
        assert(state.claim?.runId === RUN_B && state.generation === 2, "the takeover's claim stands");
      } finally { await other.close(); }
    });
  }
  return checks;
}
