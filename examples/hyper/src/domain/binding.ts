// What Hyper's command functions run on. A command whose effects cross aggregates is a plain function in
// `src/domain/<module>/<module>.commands.ts` (decisions log, D5): it opens one application transaction and calls the
// generated actions through it. The functions default to the binding `connect()` opens; a test passes the one it bound.
import { transaction } from "#mesh";

export interface Binding {
  /** The application transaction: `transaction` from `#mesh`, or the one `bind(layer)` returns. */
  readonly transaction: typeof transaction;
  /**
   * The time a function reads before its first write: the stale-fence test of `task.complete` and
   * `submission.submit`. Pass the clock given to `bind`, so the function and the actions read the same time.
   */
  readonly clock: () => Date;
}

/** The binding `connect()` opens, read through the top-level `transaction`, with the system clock. */
export const connected: Binding = { transaction, clock: () => new Date() };
