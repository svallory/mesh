import { dirname, resolve } from "node:path";
import {
  attributeTypeInfo,
  type AttributeType,
  type Action,
  type Argument,
  type Attribute,
  type Entity,
  type ModelDocument,
  type SourcePosition,
} from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import { pathSegment } from "../emitters/order.ts";
import { globalAlias } from "./globals.ts";

/**
 * The decisions the types and validators views share: how names are cased and
 * quoted, which actions an entity has, and what each action's input holds. Nothing
 * here prints a file.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export function pascalCase(name: string): string {
  const leading = /^_*/.exec(name)?.[0] ?? "";
  return (
    leading +
    name
      .slice(leading.length)
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("")
  );
}
export function typeName(name: string, position: SourcePosition): string {
  const result = pascalCase(name);
  if (!IDENTIFIER.test(result))
    throw emitError(
      "MESH_EMIT_NAME",
      `${JSON.stringify(name)} does not become a valid TypeScript type name`,
      position,
    );
  return result;
}
export const propertyName = (name: string) =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);
export type FieldShape = Pick<
  Attribute,
  | "name"
  | "type"
  | "nullable"
  | "default"
  | "values"
  | "min"
  | "max"
  | "match"
  | "position"
>;
/** The names a read's input reserves beside its own arguments; `load` only on an entity that has something to load. */
export const QUERY_FIELDS = ["filter", "sort", "limit", "offset", "load"] as const;
export type QueryField = (typeof QUERY_FIELDS)[number];
/** The fields a read of this entity takes from its caller, in the order its input type lists them. */
export const queryFieldsOf = (entity: Entity): readonly QueryField[] =>
  QUERY_FIELDS.filter((name) => name !== "load" || entity.relationships.length + entity.computed.length > 0);
export interface PlannedField {
  attribute: FieldShape;
  optional: boolean;
  reference?: Entity;
  /** Set on the fields every read takes from its caller (`load` only when the entity has something to load); their type and schema are not an attribute's. */
  query?: QueryField;
}
/** A stored column a caller may filter and sort by. */
export interface QueryColumn {
  name: string;
  type: AttributeType;
  nullable: boolean;
  values?: Attribute["values"];
}
/**
 * What a caller's filter and sort can name: the entity's attributes of a queryable type (not
 * `json`), the key column of each `belongs-to`, and its computed fields of a queryable type. A
 * computed field is named so that using one is the not-implemented error that names M10 and not an
 * "unrecognized key" (filtering and sorting by one is evaluated in SQL, which arrives then). A
 * relationship itself is not a column.
 */
export function queryColumns(entity: Entity): QueryColumn[] {
  const columns: QueryColumn[] = entity.attributes
    .filter((attribute) => attributeTypeInfo(attribute.type).queryable)
    .map(({ name, type, nullable, values }) => ({ name, type, nullable, ...(values ? { values } : {}) }));
  for (const relation of entity.relationships)
    if (relation.keyColumn) columns.push({ name: relation.keyColumn, type: relation.keyType ?? "string", nullable: relation.nullable });
  columns.push(...computedColumns(entity));
  return columns;
}
/** The computed fields a filter or sort type names; an enum that lists no values has no type to compare. */
export function computedColumns(entity: Entity): QueryColumn[] {
  return entity.computed
    .filter((field) => attributeTypeInfo(field.type).queryable && (field.type !== "enum" || (field.values?.length ?? 0) > 0))
    .map((field) => ({ name: field.name, type: field.type, nullable: field.nullable ?? false, ...(field.values ? { values: field.values } : {}) }));
}
export const filterTypeName = (entity: Entity) => `${typeName(entity.name, entity.position)}Filter`;
export const sortTypeName = (entity: Entity) => `${typeName(entity.name, entity.position)}Sort`;
/**
 * The type parameter of a read's input type and of a read function: `N`, the names its `load` lists. The input type
 * is `<N extends keyof PostLoadable = never>` (a type alias takes no `const`); the function is the same with `const`,
 * so `load: ["author"]` is read as the tuple of literals without `as const`. With no `load`, `N` is `never` and the
 * result is the bare record.
 */
export const loadGenerics = (entity: Entity, forFunction: boolean) => {
  const loadable = `${typeName(entity.name, entity.position)}Loadable`;
  // A function infers the tuple of names written (`const L`); a type alias takes the union of them.
  return forFunction ? `<const L extends readonly (keyof ${loadable})[] = readonly []>` : `<N extends keyof ${loadable} = never>`;
};
/** True for the input of a read that takes `load`. */
export const takesLoad = (input: PlannedInput) => input.fields.some((field) => field.query === "load");
export const hasRead = (entity: Entity) => effectiveActions(entity).some((action) => action.kind === "read");
export interface PlannedInput {
  /** The input's type: `ArchiveItemInput` for `:archive` of `Item` (`inputNames`). */
  name: string;
  /** The value of its validator: `archiveItemInputSchema` (`inputNames`). */
  validator: string;
  /** The action it is the input of, as written: what a message about a generated name names. */
  action: string;
  position: SourcePosition;
  fields: PlannedField[];
}
/**
 * The name of the validator (a Zod schema) of a generated type: the type's name with the first letter after any leading
 * underscores in lower case, then `Schema` (`CreateUserInput` gives `createUserInputSchema`, `UserFilter` gives
 * `userFilterSchema`). Every validator in a validators file is named this way, so none is spelled like a type there, even
 * where the first letter has no lower case (`_1stItemInput`): every other type it names ends in `Input`, `Filter`, `Sort`,
 * `Loadable` or `Shape`, and the record's type is the entity's name, which every validator holds and adds to.
 */
export function schemaName(type: string): string {
  const leading = /^_*/.exec(type)![0].length;
  return `${type.slice(0, leading)}${type.charAt(leading).toLowerCase()}${type.slice(leading + 1)}Schema`;
}
/**
 * The two names an action's input gives the generated files: its type, the action's name in PascalCase, the entity's and
 * `Input` (`ArchiveItemInput`), and its validator (`schemaName`: `archiveItemInputSchema`). PascalCase keeps leading
 * underscores and drops every other one (`pascalCase`), so `_archive` gives `_ArchiveItemInput` and
 * `_archiveItemInputSchema`, and `archive_` gives what `archive` gives. The method of the entity value is the action's
 * name as written, so it needs no name here.
 */
export function inputNames(action: Pick<Action, "name" | "position">, entity: Entity): { name: string; validator: string } {
  const name = `${typeName(action.name, action.position)}${typeName(entity.name, entity.position)}Input`;
  return { name, validator: schemaName(name) };
}
/**
 * Two actions whose inputs would get one generated name are `MESH_EMIT_NAME` naming both: PascalCase drops the
 * underscores inside and at the end of a name, so `fooBar` and `foo_bar`, or `archive` and `archive_`, give one type.
 * The build fails rather than spell the names apart, so that every generated name stays the PascalCase of the action
 * (PR #92, ENT-18).
 */
function checkInputNames(entity: Entity, inputs: readonly PlannedInput[]): void {
  const taken = new Map<string, string>();
  for (const input of inputs) {
    for (const [kind, name] of [["type", input.name], ["value", input.validator]] as const) {
      const other = taken.get(name);
      if (other !== undefined)
        throw emitError("MESH_EMIT_NAME", `Entity ${entity.fqn} would generate the ${kind} ${name} twice: for :${other} and for :${input.action}`, input.position, "Rename one of the two actions");
      taken.set(name, input.action);
    }
  }
}
/** The TypeScript type of an attribute type's values as generated code prints it: `Date` through its `$` alias. */
export function tsTypeOf(type: AttributeType): string {
  const tsType = attributeTypeInfo(type).tsType;
  return tsType === "Date" ? globalAlias("Date") : tsType;
}
/** The TypeScript type of an attribute's values, without `null`: an enum's union, or its type's own. */
export function baseType(field: Pick<FieldShape, "type" | "values">): string {
  return field.type === "enum"
    ? (field.values ?? []).map((a) => JSON.stringify(a.value)).join(" | ") ||
        "never"
    : tsTypeOf(field.type);
}
export function valueType(field: FieldShape): string {
  const base = baseType(field);
  // `unknown` already holds null.
  return base + (field.nullable && base !== "unknown" ? " | null" : "");
}
export function effectiveActions(entity: Entity): Action[] {
  return [
    ...entity.actions,
    ...entity.auto.map(
      (kind): Action => ({
        kind,
        name: kind,
        input: [],
        validate: [],
        do: [],
        position: entity.position,
      }),
    ),
  ];
}
export function entityInputs(
  entity: Entity,
  document: ModelDocument,
): PlannedInput[] {
  const key = entity.attributes.find((a) => a.primaryKey);
  if (!key)
    throw emitError(
      "MESH_EMIT_KEY",
      `Entity ${entity.fqn} has no primary key`,
      entity.position,
    );
  const inputs = effectiveActions(entity).map((action): PlannedInput => {
    const fields: PlannedField[] =
      action.kind === "update" || action.kind === "destroy"
        ? [{ attribute: key, optional: false }]
        : [];
    for (const input of action.input) {
      let field: Attribute | Argument | FieldShape;
      let reference: Entity | undefined;
      if (input.kind === "argument") field = input;
      else {
        const attribute = entity.attributes.find(
          (a) => a.name === input.ref.name,
        );
        if (attribute) {
          field = attribute;
        } else {
          const relation = entity.relationships.find(
            (r) => r.name === input.ref.name && r.kind === "belongs-to",
          );
          if (!relation)
            throw emitError(
              "MESH_UNKNOWN_MEMBER",
              `Unknown input &${input.ref.name}`,
              input.ref.position,
            );
          const destination = resolve(
            dirname(entity.file),
            relation.entity.from,
          );
          reference = document.entities.find(
            (e) => resolve(e.file) === destination,
          );
          if (!reference)
            throw emitError(
              "MESH_UNKNOWN_ENTITY",
              `Imported entity ${relation.entity.identifier} is not in the model`,
              relation.position,
            );
          const relatedKey = reference.attributes.find((a) => a.primaryKey);
          if (!relatedKey)
            throw emitError(
              "MESH_EMIT_KEY",
              `Entity ${reference.fqn} has no primary key`,
              reference.position,
            );
          field = {
            ...relatedKey,
            name: relation.name,
            nullable: relation.nullable,
            position: relation.position,
          };
          // The target key's creation default does not supply a relationship input.
          delete field.default;
        }
      }
      if (fields.some((f) => f.attribute.name === field.name))
        throw emitError(
          "MESH_DUPLICATE_INPUT",
          `Input ${field.name} conflicts with the row selector`,
          field.position,
        );
      if (action.kind === "read" && (queryFieldsOf(entity) as readonly string[]).includes(field.name))
        throw emitError(
          "MESH_DUPLICATE_INPUT",
          `Input ${field.name} conflicts with the ${queryFieldsOf(entity).join(", ")} that a read takes from its caller`,
          field.position,
          `Rename the argument of read :${action.name}`,
        );
      const optional =
        (input.kind === "member" && action.kind !== "create") ||
        field.nullable ||
        field.default !== undefined;
      fields.push({
        attribute: field,
        optional,
        ...(reference ? { reference } : {}),
      });
    }
    if (action.kind === "read")
      for (const name of queryFieldsOf(entity))
        fields.push({
          attribute: { name, type: name === "filter" || name === "sort" || name === "load" ? "json" : "integer", nullable: false, position: action.position },
          optional: true,
          query: name,
        });
    return { ...inputNames(action, entity), action: action.name, position: action.position, fields };
  });
  checkInputNames(entity, inputs);
  return inputs;
}
export function entitySegment(entity: Entity): string {
  return pathSegment({
    value: entity.name[0]!.toLowerCase() + entity.name.slice(1),
    position: entity.position,
  });
}
/**
 * The folder under the output directory that holds everything generated from the domain: one folder per module,
 * mirroring the domain folder, each with the module's `index.ts` and its entities' files. Mesh's own files
 * (`index.ts`, `binding.ts`, `load.ts`, the adapter's `schema.ts`, `model.json`) sit beside it, so
 * no module name can reach one of them.
 */
export const DOMAIN_FOLDER = "domain";
/** The import specifier of the domain root's module; a module's own is this, a `/` and the module path. */
export const DOMAIN_SPECIFIER = `#mesh/${DOMAIN_FOLDER}`;
/** A module's folder below the output directory: `domain` for the domain root, `domain/sales/billing` for `sales/billing`. */
export function modulePath(module: string, position: SourcePosition): string {
  const segments = module === "" ? [] : module.split("/").map((value) => pathSegment({ value, position }));
  return [DOMAIN_FOLDER, ...segments].join("/");
}
/** What application code imports a module as: `#mesh/domain` for the domain root, `#mesh/domain/sales/billing` for `sales/billing`. */
export function moduleSpecifier(module: string): string {
  return module === "" ? DOMAIN_SPECIFIER : `${DOMAIN_SPECIFIER}/${module}`;
}
/**
 * A folder name as an export name (PRJ-21): every character that cannot appear in a JavaScript identifier becomes `_`,
 * and `_` goes in front of a first character that cannot start one (`order-management` gives `order_management`,
 * `2024-reports` gives `_2024_reports`). A reserved word stays as it is: `export * as class` and `domain.class` are valid.
 */
export function namespaceName(folder: string): string {
  const name = folder.replace(/[^\p{ID_Continue}$‌‍]/gu, "_");
  return /^[\p{ID_Start}$_]/u.test(name) ? name : `_${name}`;
}
/**
 * The one rule for a local that generated code derives from an entity in a file that may name other entities (CMP-05:
 * generated locals never use a bare entity name): `$`, then the entity's path from the root barrel with `$` in place of
 * `.` (each module folder as its barrel's namespace name, `namespaceName`, then the entity's name as its barrel exports
 * it), then `$` and the local's role. `work.Task`'s expressions are `$work$Task$expressions` and its record type
 * `$work$Task$Record`; a root entity's are `$List$expressions` and `$List$Record`; `order-management.Invoice`'s loaded
 * type is `$order_management$Invoice$Loaded`.
 *
 * Two entities never get one local, and no local is one of Mesh's own. The last part is the role and the one before it
 * the entity's name, so two equal locals name entities with one name in folders whose namespace names are equal, and
 * each barrel refuses two folders that normalise alike (PRJ-21, `MESH_EMIT_NAME` in `moduleView`): those are one entity,
 * since FQNs are unique. `$` appears in no folder name (PRJ-20) and no entity name (`MESH_ENTITY_NAME`), and CMP-06 keeps
 * it out of the front of every name an entity file imports, a helper or an entity's alias (`MESH_HELPER_NAME` in
 * `front-end/build.ts`), so no authored name is one of these locals; every such local has at least two `$`, where
 * Mesh's own imports (`$Comparison`) have one.
 */
export function entityLocal(entity: Entity, role: string): string {
  const segments = entity.module === "" ? [] : entity.module.split("/").map(namespaceName);
  return `$${[...segments, typeName(entity.name, entity.position), role].join("$")}`;
}
/** An entity's generated files below the output directory, without the kind and extension: `domain/work/task`. */
export function entityPath(entity: Entity): string {
  return `${modulePath(entity.module, entity.position)}/${entitySegment(entity)}`;
}
