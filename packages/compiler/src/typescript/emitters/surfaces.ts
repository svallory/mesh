import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { SURFACES_FOLDER, surfaceView, type SurfaceView } from "../views/surfaces.ts";
import { outputPrefix, pathSegment } from "./order.ts";

/**
 * `<output>/surfaces/<name>/index.ts`, one per surface: its manifest, which a project imports as `#mesh/surfaces/<name>`
 * (ruling D41, OD10 (a)). Nothing for a project without surfaces. Two surfaces whose names differ only in letter case
 * would write one file on a case-insensitive file system: `MESH_EMIT_PATH`.
 */
export const surfacesGenerator: Generator<SurfaceView> = {
  name: "surfaces",
  template: "surface.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    const seen = new Map<string, string>();
    return (input.document.surfaces ?? []).map((surface) => {
      const path = `${outputPrefix(input.config)}/${SURFACES_FOLDER}/${pathSegment({ value: surface.name, position: surface.position })}/index.ts`;
      const other = seen.get(path.toLowerCase());
      if (other !== undefined)
        throw emitError("MESH_EMIT_PATH", `Generated path collision: ${path} and ${other} differ only in letter case`, surface.position,
          "Rename one of the two surfaces so that they differ in more than letter case");
      seen.set(path.toLowerCase(), path);
      return { path, view: surfaceView(input, surface) };
    });
  },
};
