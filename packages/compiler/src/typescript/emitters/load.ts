import type { Generator } from "../emit.ts";
import { hasLoader, loadView, type LoadView } from "../views/load.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/**
 * `<output>/load.ts`, once per build, when some entity has a relationship or a computed field: the load plan
 * and one typed function per entity that loads them by a second query, in memory, or through the data layer's
 * `count` and `max` (M7). The `load` step of an action (M5) calls these functions.
 */
export const loadGenerator: Generator<LoadView> = {
  name: "load",
  template: "load.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    if (!orderedEntities(input.document).some(hasLoader)) return [];
    const path = `${outputPrefix(input.config)}/load.ts`;
    return [{ path, view: loadView(input, path) }];
  },
};
