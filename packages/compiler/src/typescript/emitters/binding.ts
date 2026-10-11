import type { Generator } from "../emit.ts";
import { bindingView, type BindingView } from "../views/binding.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/binding.ts`, one per build: `bind`, which binds every entity, the default binding `connect()` opens and
 * `disconnect()` closes, `transaction`, and `$delegate`, the call each module's action functions make on the default
 * binding (ADR-0047, ADR-0068). `#mesh` re-exports the first four.
 */
export const bindingGenerator: Generator<BindingView> = {
  name: "binding",
  template: "binding.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return [{ path: `${outputPrefix(input.config)}/binding.ts`, view: bindingView(input) }];
  },
};
