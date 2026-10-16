import type { Generator } from "../emit.ts";
import { entityPath } from "../views/inputs.ts";
import { actionsView, type ActionsView } from "../views/actions.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/**
 * `<module>/<entity>.actions.ts` per entity: `bind<Entity>(layer)`, one method per
 * action with its steps written out, the entity value with the record type under the
 * entity's name and the entity's load function. It imports the entity's types and
 * validators, `tables` from the data adapter's `schema.ts`, the load plan and `@meshfw/runtime`.
 * Every name it declares is its own: the barrel that re-exports some of them keeps those unique.
 */
export const actionsGenerator: Generator<ActionsView> = {
  name: "actions",
  template: "actions.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return orderedEntities(input.document).map((entity) => ({
      path: `${outputPrefix(input.config)}/${entityPath(entity)}.actions.ts`,
      view: actionsView(input, entity),
    }));
  },
};
