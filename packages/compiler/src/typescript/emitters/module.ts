import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { moduleViews, type ModuleView } from "../views/module.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/domain/<module>/index.ts` per module that holds an entity (`<output>/domain/index.ts` for the domain
 * root): the file a project imports as `#mesh/domain/<module>` (CMP-17). It exports the module's action functions,
 * each a call on the default binding, and its entities' types and load functions. Two modules whose folders differ
 * only in letter case would write one file on a case-insensitive file system: `MESH_EMIT_PATH`.
 */
export const moduleGenerator: Generator<ModuleView> = {
  name: "module",
  template: "module.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    const seen = new Map<string, string>();
    return moduleViews(input).map(({ path, view }) => {
      const full = `${outputPrefix(input.config)}/${path}`;
      const other = seen.get(full.toLowerCase());
      if (other !== undefined)
        throw emitError("MESH_EMIT_PATH", `Generated path collision: ${full} and ${other} differ only in letter case`,
          input.document.entities.find((entity) => entity.module === view.module)!.position,
          "Rename one of the two module folders so that they differ in more than letter case");
      seen.set(full.toLowerCase(), full);
      return { path: full, view };
    });
  },
};
