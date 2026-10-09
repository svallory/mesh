import { relative, dirname, resolve } from "node:path";
import {
  attributeTypeInfo,
  type Action,
  type Argument,
  type Attribute,
  type Entity,
  type ModelDocument,
  type SourcePosition,
} from "@meshfw/model";
import { formatTypescript } from "../format.ts";
import { emitError } from "../emit-error.ts";
import type { Emitter } from "../emit.ts";
import { orderedEntities, outputPrefix, pathSegment } from "./order.ts";

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
const member = ({ attribute, optional, reference }: PlannedField) =>
  `${propertyName(attribute.name)}${optional ? "?" : ""}: ${reference ? `${typeName(reference.name, reference.position)}[${JSON.stringify(reference.attributes.find((a) => a.primaryKey)!.name)}]${attribute.nullable ? " | null" : ""}` : valueType(attribute)}${optional ? " | undefined" : ""};`;
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
export function header(entity: Entity): string {
  const file = entity.file.replace(
    /[\r\n\u2028\u2029]/g,
    (s) => `\\u${s.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `// Do not edit this file by hand.\n// It is generated by \`mesh build\` from ${file}; change that file and rebuild.\n`;
}
const declaration = (name: string, members: string[]) =>
  `export type ${name} = {\n${members.length ? members.join("\n") : "[key: string]: never;"}\n};`;
/** Stable legacy emitter id; round 3 owns emitter naming and content. */
export const entityTypesEmitter: Emitter = {
  name: "resource-types",
  async emit({ document, config }) {
    const paths = new Set<string>();
    return Promise.all(
      orderedEntities(document).map(async (entity) => {
        const path = `${outputPrefix(config)}/${entityPath(entity)}.types.ts`;
        if (paths.has(path.toLowerCase()))
          throw emitError(
            "MESH_EMIT_PATH",
            `Generated path collision: ${path}`,
            entity.position,
          );
        paths.add(path.toLowerCase());
        const recordName = typeName(entity.name, entity.position);
        const inputs = entityInputs(entity, document);
        const declared = new Set([recordName]);
        for (const input of inputs) {
          if (declared.has(input.name))
            throw emitError(
              "MESH_EMIT_NAME",
              `Duplicate generated type ${input.name}`,
              input.position,
            );
          declared.add(input.name);
        }
        const referenced = new Map<string, Entity>();
        for (const input of inputs)
          for (const field of input.fields)
            if (field.reference && field.reference.file !== entity.file) {
              const name = typeName(
                field.reference.name,
                field.reference.position,
              );
              if (
                declared.has(name) ||
                (referenced.has(name) &&
                  referenced.get(name)!.file !== field.reference.file)
              )
                throw emitError(
                  "MESH_EMIT_NAME",
                  `Imported type ${name} conflicts with another generated type`,
                  entity.position,
                );
              referenced.set(name, field.reference);
            }
        const allFields = [
          ...entity.attributes,
          ...inputs.flatMap((i) => i.fields.map((f) => f.attribute)),
        ];
        if (
          allFields.some((f) => attributeTypeInfo(f.type).tsType === "Date") &&
          (declared.has("Date") || referenced.has("Date"))
        )
          throw emitError(
            "MESH_EMIT_NAME",
            "Generated Date would shadow the Date type",
            entity.position,
          );
        const imports = [...referenced].map(([name, target]) => {
          let path = relative(
            dirname(entityPath(entity)),
            entityPath(target),
          ).replace(/\\/g, "/");
          if (!path.startsWith(".")) path = `./${path}`;
          return `import type { ${name} } from ${JSON.stringify(`${path}.types`)};`;
        });
        const fields = entity.attributes.map((attribute) =>
          member({ attribute, optional: false }),
        );
        for (const relation of entity.relationships)
          if (relation.keyColumn)
            fields.push(
              `${propertyName(relation.keyColumn)}: string${relation.nullable ? " | null" : ""};`,
            );
        const source = [
          header(entity),
          ...imports,
          declaration(recordName, fields),
          ...inputs.map((input) =>
            declaration(input.name, input.fields.map(member)),
          ),
        ].join("\n\n");
        return { path, contents: await formatTypescript(source) };
      }),
    );
  },
};
