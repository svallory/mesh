import { dirname, relative, resolve } from "node:path";
import { attributeTypeInfo, type Entity } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import {
  baseType,
  entityInputs,
  entityPath,
  filterTypeName,
  hasRead,
  propertyName,
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
  /** Type-only imports of other entities' record types, ordered as they are first referenced. */
  readonly imports: readonly TypeImport[];
  /** The entity's stored record: its attributes, then one key column per relationship that has one. */
  readonly record: RecordDeclaration;
  /** One input type per action, explicit actions in authored order, then the `auto` actions. */
  readonly inputs: readonly TypeDeclaration[];
  /** The filter and sort types a read's input names; `null` when the entity has no read action. */
  readonly query: QueryDeclaration | null;
  /** What `load` can attach to the record: one member per relationship and computed field; `null` when the entity has neither. */
  readonly loadable: LoadableDeclaration | null;
}

/**
 * `export type <name> = { ... };` and `export type <withName><N extends keyof <name>> = <record> & Pick<<name>, N>;`.
 * The record type has none of these members, so reading a relationship or a computed field that was not loaded is
 * a type error; a loaded record is the record `<withName><"parent" | "children">`.
 */
export interface LoadableDeclaration {
  /** The map's name, e.g. `TaskLoadable`. */
  readonly name: string;
  /** The loaded record's name, e.g. `TaskWith`. */
  readonly withName: string;
  /** One member per relationship (the related record, a list of them, or `| null`) and per computed field, in authored order; never optional. */
  readonly members: readonly TypeMember[];
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

/** `import type { <name> } from <fromLiteral>;` */
export interface TypeImport {
  /** The imported record type's name, PascalCase. */
  readonly name: string;
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
  const declared = new Set([recordName]);
  for (const input of inputs) {
    if (declared.has(input.name)) throw emitError("MESH_EMIT_NAME", `Duplicate generated type ${input.name}`, input.position);
    declared.add(input.name);
  }
  if (entity.relationships.length + entity.computed.length > 0)
    for (const name of [`${recordName}Loadable`, `${recordName}With`]) {
      if (declared.has(name)) throw emitError("MESH_EMIT_NAME", `Duplicate generated type ${name}`, entity.position);
      declared.add(name);
    }
  const referenced = new Map<string, Entity>();
  for (const input of inputs)
    for (const field of input.fields)
      if (field.reference && field.reference.file !== entity.file) {
        const name = typeName(field.reference.name, field.reference.position);
        if (declared.has(name) || (referenced.has(name) && referenced.get(name)!.file !== field.reference.file))
          throw emitError("MESH_EMIT_NAME", `Imported type ${name} conflicts with another generated type`, entity.position);
        referenced.set(name, field.reference);
      }
  // A relationship's record type is imported when the target is another file; its own type needs no import.
  for (const relation of entity.relationships) {
    const target = relationTarget(document, entity, relation);
    if (target.file === entity.file) continue;
    const name = typeName(target.name, target.position);
    if (declared.has(name) || (referenced.has(name) && referenced.get(name)!.file !== target.file))
      throw emitError("MESH_EMIT_NAME", `Imported type ${name} conflicts with another generated type`, entity.position);
    referenced.set(name, target);
  }
  const allFields = [...entity.attributes, ...inputs.flatMap((i) => i.fields.map((f) => f.attribute))];
  if (allFields.some((f) => attributeTypeInfo(f.type).tsType === "Date") && (declared.has("Date") || referenced.has("Date")))
    throw emitError("MESH_EMIT_NAME", "Generated Date would shadow the Date type", entity.position);

  const imports = [...referenced].map(([name, target]): TypeImport => {
    let path = relative(dirname(entityPath(entity)), entityPath(target)).replace(/\\/g, "/");
    if (!path.startsWith(".")) path = `./${path}`;
    return { name, fromLiteral: JSON.stringify(`${path}.types`) };
  });
  const recordMembers = entity.attributes.map((attribute) => member({ attribute, optional: false }, entity));
  for (const relation of entity.relationships)
    if (relation.keyColumn)
      recordMembers.push({
        name: relation.keyColumn,
        optional: false,
        key: propertyName(relation.keyColumn),
        type: `${attributeTypeInfo(relation.keyType ?? "string").tsType}${relation.nullable ? " | null" : ""}`,
      });
  return {
    entityFile: entityFileComment(entity),
    imports,
    record: { name: recordName, members: recordMembers },
    inputs: inputs.map((input) => declaration(input.name, input.fields.map((field) => member(field, entity)))),
    query: hasRead(entity) ? queryDeclaration(entity) : null,
    loadable: loadableDeclaration(document, entity, recordName),
  };
}

/** The entity a relationship points at; a model that has none was not checked by the build. */
export function relationTarget(document: EmitInput["document"], entity: Entity, relation: Entity["relationships"][number]): Entity {
  const path = resolve(dirname(entity.file), relation.entity.from);
  const target = document.entities.find((candidate) => resolve(candidate.file) === path);
  if (!target) throw emitError("MESH_UNKNOWN_ENTITY", `Imported entity ${relation.entity.identifier} is not in the model`, relation.position);
  return target;
}

function loadableDeclaration(document: EmitInput["document"], entity: Entity, recordName: string): LoadableDeclaration | null {
  const members: TypeMember[] = [];
  for (const relation of entity.relationships) {
    const target = typeName(relationTarget(document, entity, relation).name, relation.position);
    const type = relation.kind === "has-many" ? `${target}[]`
      : relation.kind === "has-one" || relation.nullable ? `${target} | null` : target;
    members.push({ name: relation.name, optional: false, key: propertyName(relation.name), type });
  }
  for (const field of entity.computed)
    members.push({
      name: field.name, optional: false, key: propertyName(field.name),
      // An enum that lists no values is a string, not `never`.
      type: field.type === "enum" && !field.values?.length ? `string${field.nullable ? " | null" : ""}` : valueType({ ...field, nullable: field.nullable ?? false }),
    });
  if (members.length === 0) return null;
  return { name: `${recordName}Loadable`, withName: `${recordName}With`, members };
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

function declaration(name: string, members: TypeMember[]): TypeDeclaration {
  return { name, empty: members.length === 0, members };
}

function member({ attribute, optional, reference, query }: PlannedField, entity: Entity): TypeMember {
  const type = query
    ? query === "filter" ? filterTypeName(entity) : query === "sort" ? sortTypeName(entity) : "number"
    : reference
    ? `${typeName(reference.name, reference.position)}[${JSON.stringify(reference.attributes.find((a) => a.primaryKey)!.name)}]${attribute.nullable ? " | null" : ""}`
    : valueType(attribute);
  return {
    name: attribute.name,
    optional,
    key: propertyName(attribute.name),
    type: `${type}${optional ? " | undefined" : ""}`,
  };
}
