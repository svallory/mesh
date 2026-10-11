import { posix } from "node:path";
import type { Entity } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { compareText, orderedEntities } from "../emitters/order.ts";
import { actionsView } from "./actions.ts";
import { hasLoader, loaderName } from "./load.ts";
import { entityInputs, entitySegment, filterTypeName, hasRead, modulePath, moduleSpecifier, sortTypeName, typeName } from "./inputs.ts";

/**
 * What `module.ts.jig` renders: `.mesh/domain/<module>/index.ts`, one per module that holds an entity, which
 * application code imports as `#mesh/domain/<module>` (`#mesh/domain` for the domain root; CMP-17). It exports the
 * module's action functions, each a call on the default binding `connect()` opens, the record and input types of the
 * module's entities and their load functions. Nothing else: `bind`, `connect`, `disconnect`, `transaction` and the
 * adapter's `tables` are `#mesh`'s, and a module never re-exports another module. Every string is final; the template
 * prints, loops and branches on these fields and computes nothing. A project's own `module.ts.jig` depends on this shape.
 */
export interface ModuleView {
  /** The module path as the model names it (`sales/billing`), or the empty string for the domain root. */
  readonly module: string;
  /** What application code imports the file as, e.g. `#mesh/domain/sales/billing`. */
  readonly specifier: string;
  /** The module in words, for the header: `module "sales/billing"`, or `the domain root`. */
  readonly description: string;
  /** `.mesh/binding.ts` from this file, quoted, e.g. `"../../binding"`. */
  readonly bindingFromLiteral: string;
  /** One entry per entity of the module, in the fixed entity order of the other generators. */
  readonly entities: readonly ModuleEntity[];
  /** Every record and input type of the module's entities, in entity order: re-exported with `export type { ... }`. */
  readonly types: readonly string[];
  /** The module's load functions (`loadTaskFields`), re-exported from `.mesh/load.ts`; empty when no entity of the module has one. */
  readonly loaders: readonly string[];
  /** `.mesh/load.ts` from this file, quoted, e.g. `"../../load"`, or null when `loaders` is empty. */
  readonly loadFromLiteral: string | null;
  /** Every action function of the module's entities, in entity order, then action order. */
  readonly functions: readonly ModuleFunction[];
  /** True when at least one action exists in the module: only then are `$delegate` and `$ContextArgument` imported. */
  readonly hasFunctions: boolean;
}

/** The type import of one entity of the module. */
export interface ModuleEntity {
  /** The record and input types of the entity, imported with `import type`. */
  readonly types: readonly string[];
  /** The entity's types file, a sibling of the module's index, quoted, e.g. `"./post.types"`. */
  readonly typesFromLiteral: string;
}

/** One top-level action function: a call on the default binding. */
export interface ModuleFunction {
  /** The function's name, e.g. `publishPost`. */
  readonly name: string;
  /** The name as a quoted string literal, for the error a call before `connect()` throws. */
  readonly nameLiteral: string;
  /** The type parameter list as printed (a read that takes `load`: `<const N extends keyof PostLoadable = never>`), or the empty string. */
  readonly generics: string;
  /** The input type, e.g. `PublishPostInput`, or `ReadPostInput<N>`. */
  readonly inputType: string;
  /** The resolved type, e.g. `Post`. */
  readonly returnType: string;
}

/** The modules that hold an entity, each with its entities in the fixed entity order; the modules by path. */
export function modulesOf(entities: readonly Entity[]): { module: string; entities: Entity[] }[] {
  const byModule = new Map<string, Entity[]>();
  for (const entity of entities) byModule.set(entity.module, [...(byModule.get(entity.module) ?? []), entity]);
  return [...byModule].sort(([a], [b]) => compareText(a, b)).map(([module, members]) => ({ module, entities: members }));
}

/** A path relative to the module's folder, both below the output folder, quoted: `"../../binding"`. */
const fromModule = (folder: string, target: string) => {
  const path = posix.relative(folder, target);
  return JSON.stringify(path.startsWith(".") ? path : `./${path}`);
};

/** One module's view. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function moduleView(input: EmitInput, module: string, entities: readonly Entity[]): ModuleView {
  const { document } = input;
  const folder = modulePath(module, entities[0]!.position);
  const imports: ModuleEntity[] = [];
  const types: string[] = [];
  const loaders: string[] = [];
  const functions: ModuleFunction[] = [];
  for (const entity of entities) {
    const record = typeName(entity.name, entity.position);
    const entityTypes = [
      record,
      ...entityInputs(entity, document).map((i) => i.name),
      ...(hasRead(entity) ? [filterTypeName(entity), sortTypeName(entity)] : []),
      ...(hasLoader(entity) ? [`${record}Loadable`, `${record}With`] : []),
    ];
    types.push(...entityTypes);
    imports.push({ types: entityTypes, typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`) });
    if (hasLoader(entity)) loaders.push(loaderName(entity));
    for (const method of actionsView(input, entity).methods)
      functions.push({ name: method.functionName, nameLiteral: JSON.stringify(method.functionName), generics: method.generics, inputType: method.inputType, returnType: method.returnType });
  }
  return {
    module,
    specifier: moduleSpecifier(module),
    description: module === "" ? "the domain root" : `module ${JSON.stringify(module)}`,
    bindingFromLiteral: fromModule(folder, "binding"),
    entities: imports,
    types,
    loaders,
    loadFromLiteral: loaders.length ? fromModule(folder, "load") : null,
    functions,
    hasFunctions: functions.length > 0,
  };
}

/** Every module's view with the path of its file below the output folder (`domain/sales/billing/index.ts`), modules by path. */
export function moduleViews(input: EmitInput): { path: string; view: ModuleView }[] {
  return modulesOf(orderedEntities(input.document)).map(({ module, entities }) => ({
    path: `${modulePath(module, entities[0]!.position)}/index.ts`,
    view: moduleView(input, module, entities),
  }));
}
