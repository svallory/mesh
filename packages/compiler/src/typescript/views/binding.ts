import { relative } from "node:path";
import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { actionsView } from "./actions.ts";
import { camelCase, entityPath } from "./inputs.ts";

/**
 * What `binding.ts.jig` renders: `.mesh/binding.ts`, Mesh's own file that binds every entity. It holds `bind`, the
 * default binding `connect()` opens and `disconnect()` closes, `transaction`, and `$delegate`, the call every module's
 * action function makes on the default binding. `#mesh` (`.mesh/index.ts`) re-exports the first four; each module's
 * `index.ts` imports `$delegate`. Every string is final; the template prints, loops and branches on these fields and
 * computes nothing. A project's own `binding.ts.jig` depends on this shape.
 */
export interface BindingView {
  /** The relative module specifier of `mesh.config.ts` from the output folder, quoted, e.g. `"../mesh.config"`. */
  readonly configFromLiteral: string;
  /** One entry per entity, in the fixed entity order of the other generators. */
  readonly entities: readonly BindingEntity[];
  /** Every action function across the build, in entity order, then action order: the members of `actions` and of what `bind` returns. */
  readonly functions: readonly BindingFunction[];
  /** True when at least one action exists; when false, `bind` returns only `transaction`. */
  readonly hasFunctions: boolean;
  /** Every read action's body without the authorizer slot, by its top-level name: what `tx` holds (ADR-0068). */
  readonly reads: readonly BindingRead[];
}

/** One entry of the table `tx` is built from: `readPost: postReads.read`. */
export interface BindingRead {
  /** The read's top-level name, e.g. `readPost`. */
  readonly name: string;
  /** The bound read body, e.g. `postReads.read`. */
  readonly method: string;
}

/** The import of one entity's actions file, and its binding inside `bind`. */
export interface BindingEntity {
  /** True when the entity has actions: only then is its `bind<Entity>` imported and called. */
  readonly hasActions: boolean;
  /** The binding function of its actions file, e.g. `bindPost`. */
  readonly bindName: string;
  /** The entity's actions file, quoted, e.g. `"./domain/blog/post.actions"`. */
  readonly actionsFromLiteral: string;
  /** The local name of the entity's bound object inside `bind`: the entity name, camelCase, plus `Actions`, e.g. `postActions`. A fixed suffix, so no entity name becomes a reserved word or `bind`'s `layer`. */
  readonly local: string;
  /** The entity's reads binding, e.g. `bindPostReads`, or null when it has no read action. */
  readonly readsBindName: string | null;
  /** The local name of its bound reads inside `bind`, e.g. `postReads`. */
  readonly readsLocal: string;
}

/** One action function's entry in `bind`'s object. */
export interface BindingFunction {
  /** The function's name, e.g. `publishPost`. */
  readonly name: string;
  /** The bound method it is, e.g. `postActions.publish`. */
  readonly method: string;
}

/** A module specifier relative to the output folder, quoted: `"./domain/blog/post.actions"`. */
export const quote = (path: string) => JSON.stringify(path.startsWith(".") ? path : `./${path}`);

/** The binding view of the whole model. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function bindingView(input: EmitInput): BindingView {
  const { document, config } = input;
  const entities: BindingEntity[] = [];
  const functions: BindingFunction[] = [];
  const reads: BindingRead[] = [];
  for (const entity of orderedEntities(document)) {
    const actions = actionsView(input, entity);
    const key = camelCase(entity.name);
    const local = `${key}Actions`;
    const readsLocal = `${key}Reads`;
    entities.push({
      hasActions: actions.hasActions,
      bindName: actions.bindName,
      actionsFromLiteral: quote(`${entityPath(entity)}.actions`),
      local,
      readsBindName: actions.readsBindName,
      readsLocal,
    });
    for (const method of actions.methods) {
      if (method.isRead) reads.push({ name: method.functionName, method: `${readsLocal}.${method.name}` });
      functions.push({ name: method.functionName, method: `${local}.${method.name}` });
    }
  }
  const configModule = relative(config.output, config.configFile).replace(/\\/g, "/").replace(/\.ts$/, "");
  return {
    configFromLiteral: quote(configModule),
    entities,
    functions,
    hasFunctions: functions.length > 0,
    reads,
  };
}
