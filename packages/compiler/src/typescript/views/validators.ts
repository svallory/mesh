import type { AttributeType, Entity } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { entityInputs, entitySegment, filterTypeName, hasRead, propertyName, queryColumns, sortTypeName, type FieldShape, type QueryColumn, type QueryField } from "./inputs.ts";
import { entityFileComment } from "./types.ts";

/**
 * What `validators.ts.jig` renders for one entity: one Zod schema per action input,
 * each checked against the input type `types.ts.jig` declares. Every string is
 * final; the template prints, loops and branches on these fields and computes
 * nothing. A project's own `validators.ts.jig` depends on this shape.
 */
export interface ValidatorsView {
  /** The entity file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly entityFile: string;
  /** True when the entity has at least one action; when false the file holds only its header and imports nothing. */
  readonly hasInputs: boolean;
  /** The module specifier of the entity's types file as a quoted string literal, e.g. `"./post.types"`. */
  readonly typesFromLiteral: string;
  /** One schema per action input, in the order of `TypesView.inputs`. */
  readonly schemas: readonly InputSchema[];
  /** The schemas of what a caller may filter and sort a read by; `null` when the entity has no read action. */
  readonly query: QuerySchema | null;
}

/** The filter and sort schemas a read input uses. */
export interface QuerySchema {
  /** The filter type, imported from the types file with the input types. */
  readonly typeImports: readonly string[];
  /** The filter type's name, e.g. `PostFilter`. */
  readonly filterTypeName: string;
  /** The exported filter schema, e.g. `postFilter`: `export const postFilter: z.ZodType<PostFilter>`. */
  readonly filterConst: string;
  /** One property per column a filter may name: `<key>: comparison(<value schema>).optional(),`. */
  readonly filterFields: readonly SchemaField[];
  /** The exported sort schema, e.g. `postSort`. */
  readonly sortConst: string;
  /** The sort keys as printed in `z.enum([ ... ])`, ascending then descending per column. */
  readonly sortKeys: readonly string[];
}

/** `export const <constName> = z.strictObject({ ... }) satisfies z.ZodType<<typeName>>;` */
export interface InputSchema {
  /** The input type it validates, imported from the types file, e.g. `CreatePostInput`. */
  readonly typeName: string;
  /** The exported schema constant: `typeName` with its first letter lower-cased, e.g. `createPostInput`. */
  readonly constName: string;
  /** The exported compile-time assertion that schema output and input type agree, e.g. `CreatePostInputShape`. */
  readonly shapeTypeName: string;
  /** The schema's properties, in the order of the input type's members. */
  readonly fields: readonly SchemaField[];
}

/** `<key>: <schema>,` */
export interface SchemaField {
  /** The authored attribute, argument or relationship name. */
  readonly name: string;
  /** The property key as printed: the name, JSON-quoted when it is not an identifier. */
  readonly key: string;
  /** The Zod expression as printed, e.g. `z.string().min(1).nullable().optional()`. */
  readonly schema: string;
}

/** The Zod base schema of each attribute type; an enum's values are added by `fieldSchema`. */
export const VALIDATOR_TYPES = {
  string: "z.string()",
  integer: "z.int()",
  float: "z.number()",
  decimal: "z.number()",
  boolean: "z.boolean()",
  uuid: "z.uuid()",
  date: "z.date()",
  datetime: "z.date()",
  timestamp: "z.date()",
  enum: "z.string()",
  // Any JSON value, no shape; the cast gives the input type `unknown` (ADR-0069). `null` is the
  // absence of a value in the database, so only a nullable attribute takes it.
  json: '(z.json().refine((value) => value !== null, { message: "null is only allowed on a nullable attribute" }) as z.ZodType<unknown>)',
} as const satisfies Record<AttributeType, string>;

/** The validators view of one entity. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function validatorsView({ document }: EmitInput, entity: Entity): ValidatorsView {
  const inputs = entityInputs(entity, document);
  return {
    entityFile: entityFileComment(entity),
    hasInputs: inputs.length > 0,
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    schemas: inputs.map((input) => ({
      typeName: input.name,
      constName: input.name[0]!.toLowerCase() + input.name.slice(1),
      shapeTypeName: `${input.name}Shape`,
      fields: input.fields.map(({ attribute, optional, query }) => ({
        name: attribute.name,
        key: propertyName(attribute.name),
        schema: query ? querySchema(entity, query) : fieldSchema(attribute, optional),
      })),
    })),
    query: hasRead(entity) ? queryView(entity) : null,
  };
}

const lowerFirst = (name: string) => name[0]!.toLowerCase() + name.slice(1);
const filterConst = (entity: Entity) => lowerFirst(filterTypeName(entity));
const sortConst = (entity: Entity) => lowerFirst(sortTypeName(entity));

/** The schema of a read's `filter`, `sort`, `limit` or `offset`. All four are optional. */
function querySchema(entity: Entity, field: QueryField): string {
  return field === "filter" ? `${filterConst(entity)}.optional()`
    : field === "sort" ? `${sortConst(entity)}.optional()`
    : "z.int().min(0).optional()";
}

/** A column's value schema in a comparison: its type alone, with none of the attribute's bounds. */
function comparedSchema(column: QueryColumn): string {
  return column.type === "enum"
    ? `z.enum([${(column.values ?? []).map((v) => JSON.stringify(v.value)).join(", ")}])`
    : VALIDATOR_TYPES[column.type];
}

function queryView(entity: Entity): QuerySchema {
  const columns = queryColumns(entity);
  return {
    typeImports: [filterTypeName(entity)],
    filterTypeName: filterTypeName(entity),
    filterConst: filterConst(entity),
    filterFields: columns
      .filter((column) => column.name !== "and" && column.name !== "or")
      .map((column) => ({ name: column.name, key: propertyName(column.name), schema: `comparison(${comparedSchema(column)}).optional()` })),
    sortConst: sortConst(entity),
    sortKeys: columns.flatMap((column) => [JSON.stringify(column.name), JSON.stringify(`-${column.name}`)]),
  };
}

/** The Zod expression for one field: base type, bounds, pattern, then nullability and optionality. */
export function fieldSchema(field: FieldShape, optional: boolean): string {
  let base =
    field.type === "enum"
      ? `z.enum([${(field.values ?? []).map((v) => JSON.stringify(v.value)).join(", ")}])`
      : VALIDATOR_TYPES[field.type];
  if (field.min !== undefined) base += `.min(${field.min})`;
  if (field.max !== undefined) base += `.max(${field.max})`;
  if (field.match) base += `.regex(new RegExp(${JSON.stringify(field.match.pattern)}, ${JSON.stringify(field.match.flags)}))`;
  return base + (field.nullable ? ".nullable()" : "") + (optional ? ".optional()" : "");
}
