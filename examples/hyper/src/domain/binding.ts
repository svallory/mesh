// What Hyper's command functions run on. A command whose effects cross aggregates is a plain function in
// `src/domain/<module>/<module>.commands.ts` (decisions log, D5): it opens one application transaction and calls the
// generated actions through it. The functions default to the binding `connect()` opens; a test passes the one it bound.
import { transaction } from "#mesh";

export interface Binding {
  /**
   * The application transaction: `transaction` from `#mesh`, or the one `bind(layer)` returns. It has one instant
   * (ACT-29), which every action and read inside it reads, so a function judges a lease the way the actions it calls
   * do: through a field that reads `%.now`, such as Claim's `lapsed`, never through a clock of its own.
   */
  readonly transaction: typeof transaction;
}

/** The binding `connect()` opens, read through the top-level `transaction`. */
export const connected: Binding = { transaction };
