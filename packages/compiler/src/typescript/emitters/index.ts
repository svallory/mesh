import type { Generator } from "../emit.ts";
import { indexView, type IndexView } from "../views/index.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/index.ts`, one per build: `bind`, `connect`, `disconnect`, one function
 * per action delegating to the default binding, and the type and table re-exports
 * (ADR-0047). It is the file a project's `#mesh` import names.
 */
export const indexGenerator: Generator<IndexView> = {
  name: "index",
  template: "index.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return [{ path: `${outputPrefix(input.config)}/index.ts`, view: indexView(input) }];
  },
};
