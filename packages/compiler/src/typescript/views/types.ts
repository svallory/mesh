import { dirname, relative, resolve } from "node:path";
import type { Entity } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { hasLoader } from "./load.ts";
import {
  baseType,
  entityInputs,
  entityLocal,
  entityPath,
  filterTypeName,
  hasRead,
  loadGenerics,
  propertyName,
  takesLoad,
  tsTypeOf,
  queryColumns,
  sortTypeName,
  typeName,
  valueType,
  type PlannedField,
} from "./inputs.ts";

/**
 * What `types.ts.jig` renders for one entity: the record type and one input type per
 * action. Every string is final; the template prints, loops and branches on these
 * fields and computes nothing. A project's own `types.ts.jig` depends on this shape.
 */
export interface TypesView {
  /** The entity file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly entityFile: string;
  /**
   * Type-only imports of other entities' record types, ordered as they are first referenced, each under its FQN-derived
   * local (CMP-05, `entityLocal`), which cannot clash with another entity's or with a name the file uses.
   */
  readonly imports: readonly TypeImport[];
  /** The entity's stored record: its attributes, then one key column per relationship that has one. */
  readonly record: RecordDeclaration;
  /** One input type per action, explicit actions in authored order, then the `auto` actions. */
  readonly inputs: readonly TypeDeclaration[];
  /** The filter and sort types a read's input names; `null` when the entity has no read action. */
  readonly query: QueryDeclaration | null;
  /** What `load` can attach to the record: one member per relationship and computed field; `null` when the entity has neither. */
  readonly loadable: LoadableDeclaration | null;
  /** The globals the file names (`$Date`, `$Pick`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/**
 * `export type <name> = { ... };` and `export type <withName><N extends keyof <name>> = <record> & Pick<<name>, N>;`.
 * The record type has none of these members, so reading a relationship or a computed field that was not loaded is
 * a type error; a loaded record is the record `<withName><"parent" | "children">`.
 */
export interface LoadableDeclaration {
  /**
   * The map's name, e.g. `TaskLoadable`: what a caller's `load` attaches. A caller's load runs the read policies of the
   * entity it reaches (POL-17), so a relationship to a record the caller may not read is `[]` or `null`: a `belongs-to`
   * is `| null` here even when its column is not.
   */
  readonly name: string;
  /** The loaded record's name, e.g. `TaskWith`. */
  readonly withName: string;
  /**
   * What a load through `privileged` attaches, which runs no policy (ADR-0068), so a `belongs-to` that is not nullable is always
   * there: `TaskTxLoadable` and `TaskTxWith`. `null` when that is the caller's map (the entity has no such `belongs-to`).
   */
  readonly tx: { readonly name: string; readonly withName: string; readonly members: readonly TypeMember[] } | null;
  /** `TaskLoadNames<L>`: the names of a `load` tuple `L`, none for a list that does not say which (a widened array). */
  readonly namesName: string;
  /** `TaskLoadArg<L>`: the `load` member of a read called with `L`, required when `L` names something. */
  readonly argName: string;
  /** One member per relationship (the related record, a list of them, or `| null`) and per computed field, in authored order; never optional. */
  readonly members: readonly TypeMember[];
  /** The fully loaded record's name, e.g. `TaskLoaded`: what the functions of the entity file see as `self`. */
  readonly loadedName: string;
  /** The members of `loadedName`: as `members`, with each related record itself fully loaded (`TaskLoaded`, `MemberLoaded[]`). */
  readonly loadedMembers: readonly TypeMember[];
}

/** `export type <filterName> = ...` and `export type <sortName> = ...`: what a caller of a read may filter and sort by. */
export interface QueryDeclaration {
  /** The filter type's name, e.g. `PostFilter`. */
  readonly filterName: string;
  /** One member per column a filter may name (not `json`): `<key>?: $Comparison<<type>>;` with `optional` true. */
  readonly filterMembers: readonly TypeMember[];
  /** The sort type's name, e.g. `PostSort`. */
  readonly sortName: string;
  /** Every sortable column as a quoted literal, ascending then descending, e.g. `"title"`, `"-title"`. */
  readonly sortKeys: readonly string[];
}

/** `import type { <names> } from <fromLiteral>;` */
export interface TypeImport {
  /**
   * The local the record type is imported under, the entity's FQN-derived local (`$identity$Member$Record`,
   * `entityLocal`), whatever alias the entity file's import wrote. Not the target's type name (`Member`).
   */
  readonly name: string;
  /**
   * What the import names, as printed: the record type, then its fully loaded type when the file needs it, e.g.
   * `Member as $identity$Member$Record, MemberLoaded as $identity$Member$Loaded`.
   */
  readonly names: string;
  /** The module specifier as a quoted string literal, e.g. `"./user.types"`. */
  readonly fromLiteral: string;
}

/** `export type <name> = { ... };` for the record. Never empty: an entity always has a primary key. */
export interface RecordDeclaration {
  /** The record type's name: the entity name, PascalCase, e.g. `Post`. */
  readonly name: string;
  /** The members, in order. */
  readonly members: readonly TypeMember[];
}

/** `export type <name> = { ... };` for an action input. */
export interface TypeDeclaration {
  /** The exported input type's name, e.g. `CreatePostInput`. */
  readonly name: string;
  /** The type parameter list as printed (`<N extends keyof PostLoadable = never>` on a read that takes `load`), or the empty string. */
  readonly generics: string;
  /** True when the type has no members; it is then printed as a closed empty object, `[key: string]: never`. */
  readonly empty: boolean;
  /** The members, in order; empty exactly when `empty` is true. */
  readonly members: readonly TypeMember[];
}

/** `<key>: <type>;`, or `<key>?: <type>;` when `optional`. */
export interface TypeMember {
  /** The authored attribute, argument or relationship name. */
  readonly name: string;
  /** Whether the member may be omitted; the template prints `?` after the key when true. Always false in a record. */
  readonly optional: boolean;
  /** The property key as printed: the name, JSON-quoted when it is not an identifier. */
  readonly key: string;
  /** The TypeScript type as printed, with `| null` when nullable and `| undefined` when optional. */
  readonly type: string;
}

/** The types view of one entity. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function typesView({ document }: EmitInput, entity: Entity): TypesView {
  const recordName = typeName(entity.name, entity.position);
  const inputs = entityInputs(entity, document);
  // `entityInputs` refuses two actions whose inputs get one name (`checkInputNames`).
  const declared = new Set([recordName, ...inputs.map((input) => input.name)]);
  if (entity.relationships.length + entity.computed.length > 0)
    for (const name of [`${recordName}Loadable`, `${recordName}With`, `${recordName}LoadNames`, `${recordName}LoadArg`, `${recordName}Loaded`, ...(hasTxLoadable(entity) ? [`${recordName}TxLoadable`, `${recordName}TxWith`] : [])]) {
      if (declared.has(name)) throw emitError("MESH_EMIT_NAME", `Entity ${entity.fqn} would generate the type ${name} twice`, entity.position);
      declared.add(name);
    }
  // Another entity's types are imported under its FQN-derived locals (`$b$List$Record`, `$b$List$Loaded`; CMP-05:
  // generated locals never use a bare entity name, and never the alias the entity file's import wrote, which could
  // hide a global the file uses, such as `Pick`). No such local is one of this file's own names or another entity's.
  const imported = new Map<string, { target: Entity; local: string; loadedLocal: string; loaded: boolean }>();
  const localOf = (target: Entity): string => {
    if (target.file === entity.file) return recordName;
    let found = imported.get(target.file);
    if (!found) {
      found = { target, local: entityLocal(target, "Record"), loadedLocal: entityLocal(target, "Loaded"), loaded: false };
      imported.set(target.file, found);
    }
    return found.local;
  };
  for (const input of inputs)
    for (const field of input.fields)
      if (field.reference) localOf(field.reference);
  // A relationship's record type is imported when the target is another file; its own type needs no import.
  // So is its fully loaded type, which this entity's own fully loaded type names.
  for (const relation of entity.relationships) {
    const target = relationTarget(document, entity, relation);
    localOf(target);
    const found = imported.get(target.file);
    if (found && hasLoader(target)) found.loaded = true;
  }
  const imports = [...imported.values()].map(({ target, local, loadedLocal, loaded }): TypeImport => {
    let path = relative(dirname(entityPath(entity)), entityPath(target)).replace(/\\/g, "/");
    if (!path.startsWith(".")) path = `./${path}`;
    const record = typeName(target.name, target.position);
    const names = [`${record} as ${local}`, ...(loaded ? [`${record}Loaded as ${loadedLocal}`] : [])];
    return { name: local, names: names.join(", "), fromLiteral: JSON.stringify(`${path}.types`) };
  });
  // What this file calls another entity's record type and its fully loaded type; the entity's own are its own names.
  const locals: Locals = (target) => {
    if (target.file === entity.file) return { record: recordName, loaded: `${recordName}Loaded` };
    const found = imported.get(target.file)!;
    return { record: found.local, loaded: found.loadedLocal };
  };
  const recordMembers = entity.attributes.map((attribute) => member({ attribute, optional: false }, entity, locals));
  for (const relation of entity.relationships)
    if (relation.keyColumn)
      recordMembers.push({
        name: relation.keyColumn,
        optional: false,
        key: propertyName(relation.keyColumn),
        type: `${tsTypeOf(relation.keyType ?? "string")}${relation.nullable ? " | null" : ""}`,
      });
  const view = {
    entityFile: entityFileComment(entity),
    imports,
    record: { name: recordName, members: recordMembers },
    inputs: inputs.map((input) => declaration(input.name, takesLoad(input) ? loadGenerics(entity, false) : "", input.fields.map((field) => member(field, entity, locals)))),
    query: hasRead(entity) ? queryDeclaration(entity) : null,
    loadable: loadableDeclaration(document, entity, recordName, locals),
  };
  // The template prints `$Pick` in the loaded types itself.
  return { ...view, globals: globalsImport(`${entityPath(entity)}.types`, view, view.loadable ? ["Pick"] : [], true) };
}

/** The entity a relationship points at; a model that has none was not checked by the build. */
export function relationTarget(document: EmitInput["document"], entity: Entity, relation: Entity["relationships"][number]): Entity {
  const path = resolve(dirname(entity.file), relation.entity.from);
  const target = document.entities.find((candidate) => resolve(candidate.file) === path);
  if (!target) throw emitError("MESH_UNKNOWN_ENTITY", `Imported entity ${relation.entity.identifier} is not in the model`, relation.position);
  return target;
}

/** Does a caller's load type a relationship differently from a load through `privileged`? Where a `belongs-to` is not nullable (POL-17). */
export const hasTxLoadable = (entity: Entity): boolean => entity.relationships.some((relation) => relation.kind === "belongs-to" && !relation.nullable);

/** The `Loadable` and `With` names that type a load through `privileged`, which runs no policy: the `Tx` pair, or the caller's when they are the same. */
export function txLoadTypes(entity: Entity): { loadable: string; with: string } {
  const record = typeName(entity.name, entity.position);
  return hasTxLoadable(entity) ? { loadable: `${record}TxLoadable`, with: `${record}TxWith` } : { loadable: `${record}Loadable`, with: `${record}With` };
}

/** What a types file calls an entity's record type and its fully loaded type. */
type Locals = (target: Entity) => { readonly record: string; readonly loaded: string };

function loadableDeclaration(document: EmitInput["document"], entity: Entity, recordName: string, locals: Locals): LoadableDeclaration | null {
  const members: TypeMember[] = [];
  const txMembers: TypeMember[] = [];
  const loadedMembers: TypeMember[] = [];
  const related = (relation: Entity["relationships"][number], target: string) =>
    relation.kind === "has-many" ? `${target}[]` : relation.kind === "has-one" || relation.nullable ? `${target} | null` : target;
  // A caller's load gives null for a record the caller may not read (POL-17).
  const forCaller = (relation: Entity["relationships"][number], target: string) => relation.kind === "has-many" ? `${target}[]` : `${target} | null`;
  for (const relation of entity.relationships) {
    const entityTarget = relationTarget(document, entity, relation);
    const { record: target, loaded } = locals(entityTarget);
    members.push({ name: relation.name, optional: false, key: propertyName(relation.name), type: forCaller(relation, target) });
    txMembers.push({ name: relation.name, optional: false, key: propertyName(relation.name), type: related(relation, target) });
    // A target with no relationship and no computed field is loaded when its record is.
    loadedMembers.push({ name: relation.name, optional: false, key: propertyName(relation.name), type: related(relation, hasLoader(entityTarget) ? loaded : target) });
  }
  for (const field of entity.computed) {
    const member = {
      name: field.name, optional: false, key: propertyName(field.name),
      // An enum that lists no values is a string, not `never`.
      type: field.type === "enum" && !field.values?.length ? `string${field.nullable ? " | null" : ""}` : valueType({ ...field, nullable: field.nullable ?? false }),
    };
    members.push(member);
    txMembers.push(member);
    loadedMembers.push(member);
  }
  if (members.length === 0) return null;
  const tx = hasTxLoadable(entity) ? { name: `${recordName}TxLoadable`, withName: `${recordName}TxWith`, members: txMembers } : null;
  return { name: `${recordName}Loadable`, withName: `${recordName}With`, tx, namesName: `${recordName}LoadNames`, argName: `${recordName}LoadArg`, members, loadedName: `${recordName}Loaded`, loadedMembers };
}

/** The columns a caller of a read may name. An attribute called `and` or `or` cannot be filtered: the contract reads those keys as combinators. */
function queryDeclaration(entity: Entity): QueryDeclaration {
  const columns = queryColumns(entity);
  return {
    filterName: filterTypeName(entity),
    filterMembers: columns
      .filter((column) => column.name !== "and" && column.name !== "or")
      .map((column): TypeMember => ({ name: column.name, optional: true, key: propertyName(column.name), type: `$Comparison<${baseType(column)}>` })),
    sortName: sortTypeName(entity),
    sortKeys: columns.flatMap((column) => [JSON.stringify(column.name), JSON.stringify(`-${column.name}`)]),
  };
}

/** The entity file name as it may appear inside a `//` comment: a line terminator would end the comment. */
export function entityFileComment(entity: Entity): string {
  return entity.file.replace(/[\r\n\u2028\u2029]/g, (s) => `\\u${s.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function declaration(name: string, generics: string, members: TypeMember[]): TypeDeclaration {
  return { name, generics, empty: members.length === 0, members };
}

function member({ attribute, optional, reference, query }: PlannedField, entity: Entity, locals: Locals): TypeMember {
  const type = query
    ? query === "filter" ? filterTypeName(entity) : query === "sort" ? sortTypeName(entity) : query === "load" ? "readonly N[]" : "number"
    : reference
    ? `${locals(reference).record}[${JSON.stringify(reference.attributes.find((a) => a.primaryKey)!.name)}]${attribute.nullable ? " | null" : ""}`
    : valueType(attribute);
  return {
    name: attribute.name,
    optional,
    key: propertyName(attribute.name),
    type: `${type}${optional ? " | undefined" : ""}`,
  };
}
