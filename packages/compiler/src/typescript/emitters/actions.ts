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
 * `bind<Entity>`. A clash is `MESH_EMIT_NAME` at the second declaration, naming both, the
 * first with its position, in the form of the barrels' clashes: an action by FQN and member
 * (`blog.Post#publish`), anything else by what it is and its entity's FQN.
 */
function checkNames({ document }: EmitInput, views: readonly ActionsView[]): void {
  const entities = orderedEntities(document);
  const owners = new Map<string, { what: string; action: boolean; position: SourcePosition | null }>();
  for (const name of INDEX_NAMES) owners.set(name, { what: `#mesh's own export ${name}`, action: false, position: null });
  const claim = (name: string, what: string, action: boolean, position: SourcePosition) => {
    const owner = owners.get(name);
    if (owner) {
      const first = `${owner.what}${owner.position ? ` (${at(owner.position)})` : ""}`;
      throw owner.action && action
        ? emitError("MESH_EMIT_NAME", `${first} and ${what} would both be actions.${name}`, position,
          "Rename one of the two: an action or an entity; `actions` and `tx` hold every action of the project by its action name followed by its entity's name")
        : emitError("MESH_EMIT_NAME", `${first} and ${what} would both be named ${name} in the generated code`, position,
          "Rename one of the two: an action or an entity; the generated code declares this name once for the whole project");
    }
    owners.set(name, { what, action, position });
  };
  views.forEach((view, index) => {
    const entity = entities[index]!;
    claim(view.bindName, `the bind function of entity ${entity.fqn}`, false, entity.position);
    if (view.readsBindName) claim(view.readsBindName, `the read binder of entity ${entity.fqn}`, false, entity.position);
    if (hasLoader(entity)) claim(loaderName(entity), `the load function of entity ${entity.fqn}`, false, entity.position);
    view.methods.forEach((method, position) => {
      const action = effectiveActions(entity)[position]!;
      claim(method.functionName, `the action ${entity.fqn}#${action.name}`, true, action.position);
    });
  });
}
