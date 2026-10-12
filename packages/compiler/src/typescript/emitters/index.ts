import type { Generator } from "../emit.ts";
import { indexView, type IndexView } from "../views/index.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/index.ts`, one per build: the file a project's `#mesh` import names (ADR-0058). It re-exports `bind`,
 * `connect`, `disconnect`, `transaction` and `Binding` from `binding.ts`, the type `Privileged` from
 * `@meshfw/runtime` and `tables` from the adapter's `schema.ts`, and nothing of any entity: those are each module's (CMP-17).
 */
export const indexGenerator: Generator<IndexView> = {
  name: "index",
  template: "index.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return [{ path: `${outputPrefix(input.config)}/index.ts`, view: indexView(input) }];
  },
};
