import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { entityPath } from "../views/inputs.ts";
import { expressionsView, hasExpressions, type ExpressionsView } from "../views/expressions.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/**
 * `<module>/<entity>.expressions.ts` per entity that has at least one expression: each
 * one as a function of a scope, in the in-memory form (M4). The action lifecycle (M5)
 * calls them; nothing in an action does yet.
 */
export const expressionsGenerator: Generator<ExpressionsView> = {
  name: "expressions",
  template: "expressions.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    const paths = new Set<string>();
    return orderedEntities(input.document).filter(hasExpressions).map((entity) => {
      const path = `${outputPrefix(input.config)}/${entityPath(entity)}.expressions.ts`;
      if (paths.has(path.toLowerCase())) throw emitError("MESH_EMIT_PATH", `Generated path collision: ${path}`, entity.position);
      paths.add(path.toLowerCase());
      return { path, view: expressionsView(input, entity, path) };
    });
  },
};
