import type { Generator } from "../emit.ts";
import { bindingView, type BindingView } from "../views/binding.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/binding.ts`, one per build: `bind`, which binds every entity value the root barrel reaches, the
 * default binding `connect()` opens and `disconnect()` closes, `transaction`, and the `Binding` type (ADR-0047,
 * ADR-0068). `#mesh` re-exports them.
 */
export const bindingGenerator: Generator<BindingView> = {
  name: "binding",
  template: "binding.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return [{ path: `${outputPrefix(input.config)}/binding.ts`, view: bindingView(input) }];
  },
};
