import type { Generator } from "../emit.ts";
import { entityPath } from "../views/inputs.ts";
import { typesView, type TypesView } from "../views/types.ts";
import { emitError } from "../emit-error.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/** `<module>/<entity>.types.ts` per entity: the record type and one input type per action. */
export const typesGenerator: Generator<TypesView> = {
  name: "types",
  template: "types.ts.jig",
  views(input) {
    const paths = new Set<string>();
    return orderedEntities(input.document).map((entity) => {
      const path = `${outputPrefix(input.config)}/${entityPath(entity)}.types.ts`;
      if (paths.has(path.toLowerCase())) throw emitError("MESH_EMIT_PATH", `Generated path collision: ${path}`, entity.position);
      paths.add(path.toLowerCase());
      return { path, view: typesView(input, entity) };
    });
  },
};
