import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { conceptPath, conceptView, conceptsOf, type ConceptView } from "../views/concepts.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<module>/<name>.concept.ts` per concept (ADR-0092): its TypeScript type and its Zod schema. The module's barrel exports
 * both. A project with no concept gets none of it, so its tree is what it was.
 */
export const conceptsGenerator: Generator<ConceptView> = {
  name: "concepts",
  template: "concept.ts.jig",
  requires: ["@meshfw/runtime", "zod"],
  views(input) {
    const paths = new Set<string>();
    return conceptsOf(input.document).map((concept) => {
      const path = `${outputPrefix(input.config)}/${conceptPath(concept)}.ts`;
      if (paths.has(path.toLowerCase())) throw emitError("MESH_EMIT_PATH", `Generated path collision: ${path}`, concept.position);
      paths.add(path.toLowerCase());
      return { path, view: conceptView(concept) };
    });
  },
};
