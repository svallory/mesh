import type { Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { declarationPath, declarationView, declarationsOf, type DeclarationView } from "../views/declarations.ts";
import { outputPrefix } from "./order.ts";

/**
 * `<module>/<name>.event.ts` per event and `<module>/<name>.command.ts` per command: the class, whose constructor checks
 * every field and freezes the instance. The module's barrel exports it; `#mesh` holds `DomainEvent` and the table of
 * event classes by FQN. A project with no event and no command gets none of it, so its tree is what it was.
 */
export const declarationsGenerator: Generator<DeclarationView> = {
  name: "declarations",
  template: "declaration.ts.jig",
  requires: ["@meshfw/runtime", "zod"],
  views(input) {
    const paths = new Set<string>();
    return declarationsOf(input.document).map((declaration) => {
      const path = `${outputPrefix(input.config)}/${declarationPath(declaration)}.ts`;
      if (paths.has(path.toLowerCase())) throw emitError("MESH_EMIT_PATH", `Generated path collision: ${path}`, declaration.position);
      paths.add(path.toLowerCase());
      return { path, view: declarationView(declaration) };
    });
  },
};
