/**
 * The order between single mode's claim renewal outside the queue (`DataLayer.renewClaim`; mesh-yd0i) and the layer's
 * own transactions that hold the claim's row, shared by the SQL adapters. The renewal runs on a connection of its own,
 * so without this order it would meet the layer's own transactions in the database:
 *
 * - a renewal that waits in the database for a transaction of this layer holding the row would be bounded by the lapse
 *   and lose the claim, although no other process can take the claim while this layer holds its row (a takeover needs
 *   the same row lock on Postgres, the write lock on SQLite);
 * - a transaction of this layer that waits in the database for the renewal would fail at `SERIALIZABLE` (Postgres's
 *   `40001`) once the renewal committed, a failure that before mesh-yd0i only another process could cause;
 * - on SQLite the queue would start its next `BEGIN IMMEDIATE` as soon as the last transaction committed, so a renewal
 *   polling for the write lock under steady load could find it taken each time.
 *
 * So a renewal waits in the process for the layer's transaction that holds the row (the time it waits does not count
 * toward its deadline), and a transaction of the layer waits in the process for a renewal in flight before it takes the
 * row. The adapter calls `take` before the first statement that takes the row (Postgres: the state row read `FOR
 * UPDATE`; SQLite: `BEGIN IMMEDIATE`) and `end` once the transaction is over. In the database the renewal then waits
 * only for other connections, until its deadline.
 */
export class ClaimRowOrder {
  /** The transaction of this layer that holds the claim's row, until it ends. One at a time: the layer has one queue. */
  #held: { readonly ended: Promise<void>; readonly end: () => void } | undefined;
  /** The renewals in flight, each settled either way. */
  readonly #renewals = new Set<Promise<void>>();

  /**
   * In the running transaction, before its first statement that takes the claim's row: waits for every renewal in
   * flight, then marks the row held by this layer until `end`. A second call in the same transaction returns at once.
   */
  async take(): Promise<void> {
    while (!this.#held && this.#renewals.size > 0) await Promise.all([...this.#renewals]);
    if (this.#held) return;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    this.#held = { ended, end };
  }

  /** After every transaction and job of the layer, whatever its outcome. */
  end(): void {
    const held = this.#held;
    this.#held = undefined;
    held?.end();
  }

  /**
   * Runs one renewal, `run`, which calls `turn(deadline)` once its own turn came (after the renewals before it), right
   * before its statement. `turn` waits for the layer's transaction that holds the row, if one does, and resolves with
   * the deadline moved by the time it waited; `onHeld` hears of such a wait when it starts, with the moved deadline to
   * come. A transaction of the layer that takes the row meanwhile waits for the whole renewal.
   */
  renew<T>(run: (turn: (deadline: number) => Promise<number>) => Promise<T>, onHeld?: (deadline: Promise<number>) => void): Promise<T> {
    const turn = async (deadline: number): Promise<number> => {
      const held = this.#held;
      if (!held) return deadline;
      const waited = Date.now();
      const moved = held.ended.then(() => deadline + (Date.now() - waited));
      onHeld?.(moved);
      return moved;
    };
    const renewal = run(turn);
    const settled = renewal.then(() => undefined, () => undefined);
    this.#renewals.add(settled);
    void settled.then(() => { this.#renewals.delete(settled); });
    return renewal;
  }
}
