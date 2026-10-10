import type { Generator } from "../emit.ts";
import { entityPath } from "../views/inputs.ts";
import { validatorsView, type ValidatorsView } from "../views/validators.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/**
 * `<module>/<entity>.validators.ts` per entity: one Zod schema per action input.
 * The build only writes text; it never loads Zod, which the generated code imports.
 */
export const validatorsGenerator: Generator<ValidatorsView> = {
  name: "validators",
  template: "validators.ts.jig",
  requires: ["zod"],
  views(input) {
    return orderedEntities(input.document).map((entity) => ({
      path: `${outputPrefix(input.config)}/${entityPath(entity)}.validators.ts`,
      view: validatorsView(input, entity),
    }));
  },
};
