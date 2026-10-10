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
/** The names a read's input reserves beside its own arguments. */
export const QUERY_FIELDS = ["filter", "sort", "limit", "offset"] as const;
export type QueryField = (typeof QUERY_FIELDS)[number];
export interface PlannedField {
  attribute: FieldShape;
  optional: boolean;
  reference?: Entity;
  /** Set on the four fields every read takes from its caller; their type and schema are not an attribute's. */
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
 * The columns of an entity that a caller's filter and sort can name: its attributes of a
 * queryable type (not `json`) and the key column of each `belongs-to`. A relationship itself
 * and a computed field are not columns.
 */
export function queryColumns(entity: Entity): QueryColumn[] {
  const columns: QueryColumn[] = entity.attributes
    .filter((attribute) => attributeTypeInfo(attribute.type).queryable)
    .map(({ name, type, nullable, values }) => ({ name, type, nullable, ...(values ? { values } : {}) }));
  for (const relation of entity.relationships)
    if (relation.keyColumn) columns.push({ name: relation.keyColumn, type: relation.keyType ?? "string", nullable: relation.nullable });
  return columns;
}
export const filterTypeName = (entity: Entity) => `${typeName(entity.name, entity.position)}Filter`;
export const sortTypeName = (entity: Entity) => `${typeName(entity.name, entity.position)}Sort`;
export const hasRead = (entity: Entity) => effectiveActions(entity).some((action) => action.kind === "read");
export interface PlannedInput {
  name: string;
  position: SourcePosition;
  fields: PlannedField[];
}
/** The TypeScript type of an attribute's values, without `null`: an enum's union, or its type's own. */
export function baseType(field: Pick<FieldShape, "type" | "values">): string {
  return field.type === "enum"
    ? (field.values ?? []).map((a) => JSON.stringify(a.value)).join(" | ") ||
        "never"
    : attributeTypeInfo(field.type).tsType;
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
      `Entity :${entity.name} has no primary key`,
      entity.position,
    );
  return effectiveActions(entity).map((action) => {
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
              `Entity :${reference.name} has no primary key`,
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
      if (action.kind === "read" && (QUERY_FIELDS as readonly string[]).includes(field.name))
        throw emitError(
          "MESH_DUPLICATE_INPUT",
          `Input ${field.name} conflicts with the ${QUERY_FIELDS.join(", ")} that a read takes from its caller`,
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
      for (const name of QUERY_FIELDS)
        fields.push({
          attribute: { name, type: name === "filter" || name === "sort" ? "json" : "integer", nullable: false, position: action.position },
          optional: true,
          query: name,
        });
    return {
      name: `${typeName(action.name, action.position)}${typeName(entity.name, entity.position)}Input`,
      position: action.position,
      fields,
    };
  });
}
export function entitySegment(entity: Entity): string {
  return pathSegment({
    value: entity.name[0]!.toLowerCase() + entity.name.slice(1),
    position: entity.position,
  });
}
export function entityPath(entity: Entity): string {
  const modules = entity.module === "" ? [] : entity.module.split("/").map((value) => pathSegment({ value, position: entity.position }));
  return [...modules, entitySegment(entity)].join("/");
}
/** PascalCase with the first letter lower-cased: the same word rule, for values (`publish`, `blogPost`). */
export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  const leading = /^_*/.exec(pascal)?.[0] ?? "";
  const rest = pascal.slice(leading.length);
  return leading + (rest[0] ?? "").toLowerCase() + rest.slice(1);
}
/** A value name: `camelCase(name)`, or `MESH_EMIT_NAME` when that is not a TypeScript identifier. */
export function valueName(name: string, position: SourcePosition): string {
  const result = camelCase(name);
  if (!IDENTIFIER.test(result))
    throw emitError("MESH_EMIT_NAME", `${JSON.stringify(name)} does not become a valid TypeScript name`, position);
  return result;
}
