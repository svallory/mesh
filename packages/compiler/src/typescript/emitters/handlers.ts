import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { handlerOwners, handlersPath, handlersView, type HandlersView } from "../views/handlers.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<module>/<owner>.handlers.ts` per entity or aggregate whose `handlers` section has a line (handlers design, section
 * 5.5): the section's handlers by kind and key, which the generated `bind` merges and hands to `bindDomain`. Nothing
 * for a project without one.
 */
export const handlersGenerator: Generator<HandlersView> = {
  name: "handlers",
  template: "handlers.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    const paths = new Set<string>();
    return handlerOwners(input.document).map((owner) => {
      const path = `${outputPrefix(input.config)}/${handlersPath(owner)}.ts`;
      if (paths.has(path.toLowerCase()))
        throw emitError("MESH_EMIT_PATH", `Generated path collision: ${path} (the handlers of ${owner.fqn} and of another owner of that name)`, owner.position, "Rename the aggregate or the entity");
      paths.add(path.toLowerCase());
      return { path, view: handlersView(input, owner, path) };
    });
  },
};
