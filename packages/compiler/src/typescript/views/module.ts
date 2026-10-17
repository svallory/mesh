import { posix, relative } from "node:path";
import type { Entity, SourcePosition } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { compareText, orderedEntities } from "../emitters/order.ts";
import { hasLoader, loaderName } from "./load.ts";
import { hasTxLoadable } from "./types.ts";
import { className, declarationFile, declarationsOf, type Declaration } from "./declarations.ts";
import { DOMAIN_FOLDER, entityInputs, entitySegment, filterTypeName, hasRead, modulePath, moduleSpecifier, namespaceName, sortTypeName, typeName } from "./inputs.ts";

/**
 * What `module.ts.jig` renders: a barrel, `.mesh/domain/<path>/index.ts`, one per folder of the domain that holds an
 * entity or a folder below it that does, and one for the domain root (`.mesh/domain/index.ts`).
 * Application code imports it as `#mesh/domain/<path>` (`#mesh/domain` for the root). It exports the entity value and
 * record type of each entity of the module (those of its `_name/` group folders included), the entities' other
 * types and load functions, and one namespace per subfolder that has a barrel (`export * as billing from
 * "./billing/index"`). `bind`, `connect`, `disconnect`, `transaction` and the adapter's `tables` are `#mesh`'s. Every
 * string is final; the template prints, loops and branches on these fields and computes nothing. A project's own
 * `module.ts.jig` depends on this shape.
 */
export interface ModuleView {
  /** The folder's path below the domain root as written (`sales/billing`), or the empty string for the domain root. */
  readonly module: string;
  /** What application code imports the file as, e.g. `#mesh/domain/sales/billing`. */
  readonly specifier: string;
  /** The folder in words, for the header: `module "sales/billing"`, `folder "sales"` for one that holds no entity, or `the domain root`. */
  readonly description: string;
  /** One entry per entity of the module, in the fixed entity order of the other generators. */
  readonly entities: readonly ModuleEntity[];
  /** One entry per event and command of the module, events first, each in the order of its file path. Empty when the module declares none. */
  readonly declarations: readonly ModuleDeclaration[];
  /** One namespace per subfolder that has a barrel, by folder name. */
  readonly namespaces: readonly ModuleNamespace[];
}

/** The export of one event or command class of the module (M6). */
export interface ModuleDeclaration {
  /** The class's name, e.g. `InvoicePaid`. */
  readonly name: string;
  /** The file that defines it, quoted, e.g. `"./invoicePaid.event"`. */
  readonly fromLiteral: string;
}

/** The exports of one entity of the module. */
export interface ModuleEntity {
  /** The name the entity value and the record type are exported under, e.g. `Post`. */
  readonly name: string;
  /** What the barrel exports from the actions file: `name`, then the entity's load function when it has one (`loadPostFields`). */
  readonly values: readonly string[];
  /** The entity's actions file, which defines them, quoted, e.g. `"./post.actions"`. */
  readonly actionsFromLiteral: string;
  /** The entity's other types (inputs, filter and sort, load types), re-exported with `export type`. */
  readonly types: readonly string[];
  /** True when `types` is not empty. */
  readonly hasTypes: boolean;
  /** The entity's types file, quoted, e.g. `"./post.types"`. */
  readonly typesFromLiteral: string;
}

/** `export * as <name> from "./<folder>/index"`: a subfolder's barrel. */
export interface ModuleNamespace {
  /** The export name: the folder name with every character that is invalid in an identifier replaced by `_`, and `_` in front of a leading digit. */
  readonly name: string;
  /** The subfolder's barrel from this file, quoted, e.g. `"./billing/index"`. */
  readonly fromLiteral: string;
}

/** The modules that hold an entity, each with its entities in the fixed entity order; the modules by path. */
export function modulesOf(entities: readonly Entity[], declarations: readonly Declaration[] = []): { module: string; entities: Entity[]; declarations: Declaration[]; position: SourcePosition }[] {
  const byModule = new Map<string, { entities: Entity[]; declarations: Declaration[]; position: SourcePosition }>();
  const moduleOf = (module: string, position: SourcePosition) => {
    let found = byModule.get(module);
    if (!found) byModule.set(module, (found = { entities: [], declarations: [], position }));
    return found;
  };
  for (const entity of entities) moduleOf(entity.module, entity.position).entities.push(entity);
  for (const declaration of declarations) moduleOf(declaration.module, declaration.position).declarations.push(declaration);
  return [...byModule].sort(([a], [b]) => compareText(a, b)).map(([module, members]) => ({ module, ...members, position: members.entities[0]?.position ?? members.position }));
}

export { namespaceName };

/** One folder that gets a barrel: its path below the domain root, its entities, and the folders below it that get one. */
export interface BarrelFolder {
  readonly module: string;
  readonly entities: Entity[];
  readonly declarations: Declaration[];
  readonly children: BarrelFolder[];
  /** Where an error about the folder points: its first entity, or the first entity below it. */
  position: SourcePosition;
}

/** Where an error points when the domain has no entity at all: only the root barrel exists, and nothing can clash in it. */
const NOWHERE: SourcePosition = Object.freeze({ file: "mesh.config.ts", line: 1, column: 1, offset: 0 });

/** Every folder that gets a barrel, by path: each module, each folder above one, and the domain root. */
export function barrelFolders(entities: readonly Entity[], declarations: readonly Declaration[] = []): BarrelFolder[] {
  const folders = new Map<string, BarrelFolder>();
  const folder = (module: string, position: SourcePosition): BarrelFolder => {
    let found = folders.get(module);
    if (!found) {
      found = { module, entities: [], declarations: [], children: [], position };
      folders.set(module, found);
      if (module !== "") {
        const parent = module.includes("/") ? module.slice(0, module.lastIndexOf("/")) : "";
        folder(parent, position).children.push(found);
      }
    }
    return found;
  };
  for (const { module, entities: members, declarations: declared, position } of modulesOf(entities, declarations)) {
    const found = folder(module, position);
    found.entities.push(...members);
    found.declarations.push(...declared);
    found.position = position;
  }
  if (!folders.has("")) folders.set("", { module: "", entities: [], declarations: [], children: [], position: NOWHERE });
  for (const found of folders.values()) found.children.sort((a, b) => compareText(a.module, b.module));
  return [...folders.values()].sort((a, b) => compareText(a.module, b.module));
}

/**
 * One barrel's view. Pure and synchronous. Two exports with one name (an entity and a subfolder namespace, two
 * subfolders whose names normalise alike, a generated type and either) are `MESH_EMIT_NAME` naming both:
 * an entity by FQN, a folder by its path in the project.
 */
export function moduleView(input: EmitInput, module: string, entities: readonly Entity[], children: readonly BarrelFolder[] = [], declarations: readonly Declaration[] = []): ModuleView {
  const { document, config } = input;
  const folderName = (path: string) => relative(config.root, posix.join(config.domainRoot, path)).replace(/\\/g, "/") || ".";
  const owners = new Map<string, string>();
  const claim = (name: string, owner: string, where: SourcePosition) => {
    const other = owners.get(name);
    if (other !== undefined)
      throw emitError("MESH_EMIT_NAME", `${other} and ${owner} would both be exported as ${name} from ${moduleSpecifier(module)}`, where,
        "Rename one of the two: an entity file, an entity or a folder");
    owners.set(name, owner);
  };
  const exported: ModuleEntity[] = [];
  for (const entity of entities) {
    const record = typeName(entity.name, entity.position);
    const types = [
      ...entityInputs(entity, document).map((i) => i.name),
      ...(hasRead(entity) ? [filterTypeName(entity), sortTypeName(entity)] : []),
      ...(hasLoader(entity) ? [`${record}Loadable`, `${record}With`, `${record}LoadNames`, `${record}LoadArg`] : []),
      ...(hasTxLoadable(entity) ? [`${record}TxLoadable`, `${record}TxWith`] : []),
    ];
    claim(record, `entity ${entity.fqn}`, entity.position);
    for (const type of types) claim(type, `the type ${type} of entity ${entity.fqn}`, entity.position);
    const values = [record];
    if (hasLoader(entity)) {
      claim(loaderName(entity), `the load function ${loaderName(entity)} of entity ${entity.fqn}`, entity.position);
      values.push(loaderName(entity));
    }
    exported.push({
      name: record,
      values,
      actionsFromLiteral: JSON.stringify(`./${entitySegment(entity)}.actions`),
      types,
      hasTypes: types.length > 0,
      typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    });
  }
  const exportedDeclarations = declarations.map((declaration): ModuleDeclaration => {
    const name = className(declaration);
    claim(name, `${declaration.kind} ${declaration.fqn}`, declaration.position);
    return { name, fromLiteral: JSON.stringify(`./${entitySegment(declaration)}${declarationFile(declaration)}`) };
  });
  const namespaces = children.map((child): ModuleNamespace => {
    const segment = child.module.slice(child.module.lastIndexOf("/") + 1);
    const name = namespaceName(segment);
    claim(name, `the folder ${folderName(child.module)}`, child.position);
    return { name, fromLiteral: JSON.stringify(`./${segment}/index`) };
  });
  return {
    module,
    specifier: moduleSpecifier(module),
    description: module === "" ? "the domain root" : `${entities.length || declarations.length ? "module" : "folder"} ${JSON.stringify(module)}`,
    entities: exported,
    declarations: exportedDeclarations,
    namespaces,
  };
}

/** Every barrel's view with the path of its file below the output folder (`domain/sales/billing/index.ts`), folders by path. */
export function moduleViews(input: EmitInput): { path: string; view: ModuleView }[] {
  return barrelFolders(orderedEntities(input.document), declarationsOf(input.document)).map(({ module, entities, declarations, children, position }) => ({
    path: module === "" ? `${DOMAIN_FOLDER}/index.ts` : `${modulePath(module, position)}/index.ts`,
    view: moduleView(input, module, entities, children, declarations),
  }));
}
