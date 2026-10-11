import type { SourcePosition } from "@meshfw/model";
import type { EmitInput, Generator } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { effectiveActions, entityPath } from "../views/inputs.ts";
import { actionsView, tableKey, type ActionsView } from "../views/actions.ts";
import { hasLoader, loaderName } from "../views/load.ts";
import { orderedEntities, outputPrefix } from "./order.ts";

/**
 * `<module>/<entity>.actions.ts` per entity: `bind<Entity>(layer)`, one method per
 * action with its steps written out. It imports the entity's types and validators,
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
 * Names `.mesh/index.ts` defines itself; an action function may not take one. An action
 * function ends in an entity's PascalCase name, so these lower-case words cannot be reached
 * today; the check keeps it so if the naming rule changes.
 */
export const INDEX_NAMES: readonly string[] = Object.freeze(["bind", "connect", "disconnect", "tables", "transaction"]);

const at = ({ file, line, column }: SourcePosition) => `${file}:${line}:${column + 1}`;

/**
 * Every top-level value `.mesh/index.ts` will hold is unique: each action function
 * (`publishPost`), each `bind<Entity>`, each table handle it re-exports from the
 * schema (`postTable`), and the index's own names. A clash is
 * `MESH_EMIT_NAME` at the second declaration, naming the first one's position.
 */
function checkNames({ document }: EmitInput, views: readonly ActionsView[]): void {
  const entities = orderedEntities(document);
  const owners = new Map<string, { what: string; position: SourcePosition | null }>();
  for (const name of INDEX_NAMES) owners.set(name, { what: `\`${name}\`, which .mesh/index.ts defines`, position: null });
  const claim = (name: string, what: string, position: SourcePosition) => {
    const owner = owners.get(name);
    if (owner) throw emitError("MESH_EMIT_NAME",
      `${what} and ${owner.what}${owner.position ? ` (${at(owner.position)})` : ""} both become the top-level name \`${name}\``,
      position, "Rename one of them: every action function is exported by name from .mesh/index.ts");
    owners.set(name, { what, position });
  };
  views.forEach((view, index) => {
    const entity = entities[index]!;
    claim(view.bindName, `Entity :${entity.name}'s binding`, entity.position);
    if (view.readsBindName) claim(view.readsBindName, `Entity :${entity.name}'s reads binding`, entity.position);
    claim(`${tableKey(entity)}Table`, `Entity :${entity.name}'s table handle`, entity.position);
    if (hasLoader(entity)) claim(loaderName(entity), `Entity :${entity.name}'s load function`, entity.position);
    view.methods.forEach((method, position) => {
      const action = effectiveActions(entity)[position]!;
      claim(method.functionName, `Action :${action.name} of :${entity.name}`, action.position);
    });
  });
}
