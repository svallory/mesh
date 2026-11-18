/**
 * Core's bound on one renewal statement, shared by both claim strategies: the single-mode claim renewal
 * (`SingleClaim.tick`, `DataLayer.renewClaim`; mesh-yd0i) and the multi-mode process-row renewal (`MultiClaim.tick`,
 * `DataLayer.renewProcess`; mesh-vaxr). The adapter ends a lock wait at the deadline it is given, the time the claim or
 * the row lapses; core gives a renewal that is still unsettled `RENEW_GRACE_MS` later up, whatever it does afterwards,
 * so a connection that stopped answering (or, through `transaction`, a queue that never reaches the renewal) loses the
 * instance at the lapse instead of hanging the renewals.
 */

/**
 * How long past the lapse a renewal may still settle before core gives it up: the adapter's own deadline (its lock
 * wait, its retry) ends at the lapse, and its error should be the one reported.
 */
export const RENEW_GRACE_MS = 50;

/**
 * Core's own deadline for a renewal: still unsettled `RENEW_GRACE_MS` past the lapse. That is not a lock wait the
 * adapter reported; the database or the renewal's connection stopped answering, or (through `transaction`) the
 * renewal never left the layer's queue.
 */
export class RenewalUnsettled extends Error {}

/** One strategy's renewals: each raced against its lapse, and the last adapter statement, for `release` to wait on. */
export class Renewals {
  /** The adapter's last renewal statement (not core's race), settled either way, and the time core gives it up. */
  #last: { settled: Promise<void>; until: number } = { settled: Promise.resolve(), until: 0 };

  /**
   * The renewal `start` issues, raced against `deadline` (a `Date.now()` time) plus the grace: rejects with
   * `RenewalUnsettled` when it is still unsettled then. `start` gets the `onHeld` of `DataLayer.renewClaim`: while the
   * adapter says the renewal waits for the layer's own transaction holding the claim's row, core's deadline is off,
   * and it then counts to the moved deadline the adapter gives, which `moved` hears of.
   */
  async race(start: (onHeld: (deadline: Promise<number>) => void) => Promise<boolean>, deadline: number, moved?: (deadline: number) => void): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let expire!: (error: RenewalUnsettled) => void;
    const expired = new Promise<never>((_, reject) => { expire = reject; });
    const last = { settled: Promise.resolve(), until: deadline + RENEW_GRACE_MS };
    const arm = (at: number) => {
      clearTimeout(timer);
      last.until = at + RENEW_GRACE_MS;
      timer = setTimeout(() => { expire(new RenewalUnsettled()); }, Math.max(0, at - Date.now()) + RENEW_GRACE_MS);
    };
    arm(deadline);
    const onHeld = (later: Promise<number>) => {
      if (done) return;
      clearTimeout(timer);
      timer = undefined;
      last.until = Number.POSITIVE_INFINITY;
      void later.then((at) => { if (done) return; moved?.(at); arm(at); });
    };
    const renewal = start(onHeld);
    // `release` waits for the statement itself, which may outlive the race below, until core gives it up.
    last.settled = renewal.then(() => undefined, () => undefined);
    this.#last = last;
    try { return await Promise.race([renewal, expired]); }
    finally { done = true; clearTimeout(timer); renewal.catch(() => undefined); }
  }

  /**
   * Resolves once the last renewal statement settled, or once core gave it up: a release run beside a renewal still
   * waiting on the row lock could fail on that lock (or as a serialization failure) and leave the claim or the row to
   * lapse instead of going at once, while a statement that never answers must not hold the release, and stop, for good.
   * While the renewal waits for the layer's own transaction there is no bound: that transaction ends first.
   */
  async settled(): Promise<void> {
    const last = this.#last;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = () => new Promise<void>((resolve) => {
      const tick = () => {
        const left = last.until - Date.now();
        if (left <= 0) { resolve(); return; }
        timer = setTimeout(tick, Number.isFinite(left) ? left : 50);
      };
      tick();
    });
    await Promise.race([last.settled, bound()]);
    clearTimeout(timer);
  }
}
