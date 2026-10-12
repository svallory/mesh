import type { Generator } from "../emit.ts";
import { globalsView, type GlobalsView } from "../views/globals.ts";
import { outputPrefix } from "./order.ts";

/** `<output>/$globals.ts`: the globals the generated files use, under `$` names no entity file can take. */
export const globalsGenerator: Generator<GlobalsView> = {
  name: "globals",
  template: "globals.ts.jig",
  views(input) {
    return [{ path: `${outputPrefix(input.config)}/$globals.ts`, view: globalsView() }];
  },
};
