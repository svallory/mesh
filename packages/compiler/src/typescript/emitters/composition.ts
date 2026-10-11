import type { Generator } from "../emit.ts";
import { compositionView, type CompositionView } from "../views/composition.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/composition.ts`, one per build: the `Actions` and `Reads` types of `actions` and `tx` (ADR-0068). The
 * expressions files type their scope with it and the index re-exports it; it imports only the entities' types files.
 */
export const compositionGenerator: Generator<CompositionView> = {
  name: "composition",
  template: "composition.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return [{ path: `${outputPrefix(input.config)}/composition.ts`, view: compositionView(input) }];
  },
};
