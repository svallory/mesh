import { dirname, resolve } from "node:path";
import {
  attributeTypeInfo,
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
export interface PlannedField {
  attribute: FieldShape;
  optional: boolean;
  reference?: Entity;
}
export interface PlannedInput {
  name: string;
  position: SourcePosition;
  fields: PlannedField[];
}
export function valueType(field: FieldShape): string {
  const base =
    field.type === "enum"
      ? (field.values ?? []).map((a) => JSON.stringify(a.value)).join(" | ") ||
        "never"
      : attributeTypeInfo(field.type).tsType;
  return base + (field.nullable ? " | null" : "");
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
