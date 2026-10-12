import type { SourcePosition } from "@meshfw/model";
import type { EmitInput, Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { effectiveActions, entityPath } from "../views/inputs.ts";
import { actionsView, type ActionsView } from "../views/actions.ts";
import { hasLoader, loaderName } from "../views/load.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/**
 * `<module>/<entity>.actions.ts` per entity: `bind<Entity>(layer)`, one method per
 * action with its steps written out, and the entity value with the record type under the
 * entity's name (CMP-16). It imports the entity's types and validators,
 * `tables` from the data adapter's `schema.ts`, and `@meshfw/runtime`.
 */
export const actionsGenerator: Generator<ActionsView> = {
  name: "actions",
  template: "actions.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    const files = orderedEntities(input.document).map((entity) => ({
      path: `${outputPrefix(input.config)}/${entityPath(entity)}.actions.ts`,
      view: actionsView(input, entity),
    }));
    checkNames(input, files.map((file) => file.view));
    return files;
  },
};

/**
 * Names `#mesh` (`.mesh/index.ts`) exports itself; an action function may not take one. An
 * action function ends in an entity's PascalCase name, so these lower-case words cannot be
 * reached today; the check keeps it so if the naming rule changes.
 */
export const INDEX_NAMES: readonly string[] = Object.freeze(["bind", "connect", "disconnect", "tables", "transaction"]);

const at = ({ file, line, column }: SourcePosition) => `${file}:${line}:${column + 1}`;

/**
 * Every project-wide name the generated tree declares is unique: each action's name in
 * `actions` and `tx` (`publishPost`), the flat handles of an entity file, whatever module
 * its entity is in; each `bind<Entity>` and `bind<Entity>Reads`, whose entity name is also
 * the suffix of those names; each load function, which `.mesh/load.ts` declares side by
 * side; and `#mesh`'s own names. Same-named entities in two modules therefore clash on
 * `bind<Entity>`. A clash is `MESH_EMIT_NAME` at the second declaration, naming the first
 * one's position.
 */
function checkNames({ document }: EmitInput, views: readonly ActionsView[]): void {
  const entities = orderedEntities(document);
  const owners = new Map<string, { what: string; position: SourcePosition | null }>();
  for (const name of INDEX_NAMES) owners.set(name, { what: `\`${name}\`, which #mesh exports`, position: null });
  const claim = (name: string, what: string, position: SourcePosition) => {
    const owner = owners.get(name);
    if (owner) throw emitError("MESH_EMIT_NAME",
      `${what} and ${owner.what}${owner.position ? ` (${at(owner.position)})` : ""} both become the top-level name \`${name}\``,
      position, "Rename one of them: `actions` and `tx` hold every action of the project by this name");
    owners.set(name, { what, position });
  };
  views.forEach((view, index) => {
    const entity = entities[index]!;
    claim(view.bindName, `Entity ${entity.fqn}'s binding`, entity.position);
    if (view.readsBindName) claim(view.readsBindName, `Entity ${entity.fqn}'s reads binding`, entity.position);
    if (hasLoader(entity)) claim(loaderName(entity), `Entity ${entity.fqn}'s load function`, entity.position);
    view.methods.forEach((method, position) => {
      const action = effectiveActions(entity)[position]!;
      claim(method.functionName, `Action :${action.name} of ${entity.fqn}`, action.position);
    });
  });
}
