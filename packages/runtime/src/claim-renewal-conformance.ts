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
  }
  return checks;
}
