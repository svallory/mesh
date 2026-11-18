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
  /** The adapter's last renewal statement (not core's race), settled either way, and the time core gave it up. */
  #last: { readonly settled: Promise<void>; readonly until: number } = { settled: Promise.resolve(), until: 0 };

  /**
   * `renewal` raced against `deadline` (a `Date.now()` time) plus the grace: rejects with `RenewalUnsettled` when it is
   * still unsettled then.
   */
  async race(renewal: Promise<boolean>, deadline: number): Promise<boolean> {
    // `release` waits for the statement itself, which may outlive the race below, until core gives it up.
    this.#last = { settled: renewal.then(() => undefined, () => undefined), until: deadline + RENEW_GRACE_MS };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new RenewalUnsettled()); }, Math.max(0, deadline - Date.now()) + RENEW_GRACE_MS);
    });
    try { return await Promise.race([renewal, expired]); }
    finally { clearTimeout(timer); renewal.catch(() => undefined); }
  }

  /**
   * Resolves once the last renewal statement settled, or once core gave it up: a release run beside a renewal still
   * waiting on the row lock could fail on that lock (or as a serialization failure) and leave the claim or the row to
   * lapse instead of going at once, while a statement that never answers must not hold the release, and stop, for good.
   */
  async settled(): Promise<void> {
    const { settled, until } = this.#last;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, until - Date.now())); })]);
    clearTimeout(timer);
  }
}
