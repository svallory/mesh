import { relative } from "node:path";
import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { actionsView } from "./actions.ts";
import { camelCase, entityInputs, entityPath, typeName } from "./inputs.ts";

/**
 * What `index.ts.jig` renders: `.mesh/index.ts`, the one entry point a project imports
 * as `#mesh` (ADR-0047). Every string is final; the template prints, loops and
 * branches on these fields and computes nothing. A project's own `index.ts.jig`
 * depends on this shape.
 */
export interface IndexView {
  /** The relative module specifier of `mesh.config.ts` from the output folder, quoted, e.g. `"../mesh.config"`. */
  readonly configFromLiteral: string;
  /** One entry per entity, in the fixed entity order of the other generators. */
  readonly entities: readonly IndexEntity[];
  /** Every action function across the build, in entity order, then action order. */
  readonly functions: readonly IndexFunction[];
  /** Every record and input type, in entity order: re-exported with `export type { ... }`. */
  readonly types: readonly string[];
  /** The schema exports re-exported from `./schema`: `tables`, then each entity's table handle. */
  readonly schemaExports: readonly string[];
  /** True when at least one action exists; when false, `bind` returns an empty object. */
  readonly hasFunctions: boolean;
}

/** The imports for one entity, and its binding inside `bind`. */
export interface IndexEntity {
  /** The record and input types of the entity, imported with `import type`. */
  readonly types: readonly string[];
  /** The entity's types file, quoted, e.g. `"./blog/post.types"`. */
  readonly typesFromLiteral: string;
  /** True when the entity has actions: only then is its `bind<Entity>` imported and called. */
  readonly hasActions: boolean;
  /** The binding function of its actions file, e.g. `bindPost`. */
  readonly bindName: string;
  /** The entity's actions file, quoted, e.g. `"./blog/post.actions"`. */
  readonly actionsFromLiteral: string;
  /** The local name of the entity's bound object inside `bind`: the entity name, camelCase, plus `Actions`, e.g. `postActions`. A fixed suffix, so no entity name becomes a reserved word or `bind`'s `layer`. */
  readonly local: string;
}

/** One top-level action function and its entry in `bind`'s object. */
export interface IndexFunction {
  /** The function's name, e.g. `publishPost`. */
  readonly name: string;
  /** The name as a quoted string literal, for the error a call before `connect()` throws. */
  readonly nameLiteral: string;
  /** The input type, e.g. `PublishPostInput`. */
  readonly inputType: string;
  /** The resolved type, e.g. `Post`. */
  readonly returnType: string;
  /** The bound method it is, e.g. `postActions.publish`. */
  readonly method: string;
}

const quote = (path: string) => JSON.stringify(path.startsWith(".") ? path : `./${path}`);

/** The index view of the whole model. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function indexView(input: EmitInput): IndexView {
  const { document, config } = input;
  const entities: IndexEntity[] = [];
  const functions: IndexFunction[] = [];
  const types: string[] = [];
  const handles: string[] = [];
  for (const entity of orderedEntities(document)) {
    const actions = actionsView(input, entity);
    const key = camelCase(entity.name);
    const local = `${key}Actions`;
    const entityTypes = [typeName(entity.name, entity.position), ...entityInputs(entity, document).map((i) => i.name)];
    types.push(...entityTypes);
    handles.push(`${key}Table`);
    entities.push({
      types: entityTypes,
      typesFromLiteral: quote(`${entityPath(entity)}.types`),
      hasActions: actions.hasActions,
      bindName: actions.bindName,
      actionsFromLiteral: quote(`${entityPath(entity)}.actions`),
      local,
    });
    for (const method of actions.methods)
      functions.push({
        name: method.functionName,
        nameLiteral: JSON.stringify(method.functionName),
        inputType: method.inputType,
        returnType: method.returnType,
        method: `${local}.${method.name}`,
      });
  }
  const configModule = relative(config.output, config.configFile).replace(/\\/g, "/").replace(/\.ts$/, "");
  return {
    configFromLiteral: quote(configModule),
    entities,
    functions,
    types,
    schemaExports: ["tables", ...handles.sort()],
    hasFunctions: functions.length > 0,
  };
}
