import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { moduleViews, type ModuleView } from "../views/module.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<output>/domain/<path>/index.ts`, a barrel per folder that holds an entity or a folder below it that does, and
 * `<output>/domain/index.ts` for the domain root: the file a project imports as `#mesh/domain/<path>`.
 * It exports its module's entity values, their types and load functions, and a namespace per subfolder. Two
 * exports of one barrel with one name are `MESH_EMIT_NAME`. Two folders that differ only in letter case would
 * write one file on a case-insensitive file system: `MESH_EMIT_PATH`.
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
          input.document.entities.find((entity) => entity.module === view.module || entity.module.startsWith(`${view.module}/`))!.position,
          "Rename one of the two module folders so that they differ in more than letter case");
      seen.set(full.toLowerCase(), full);
      return { path: full, view };
    });
  },
};
