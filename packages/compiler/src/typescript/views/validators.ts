import type { AttributeType, Entity } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { entityInputs, entityPath, entitySegment, filterTypeName, hasRead, propertyName, typeName, queryColumns, schemaName, sortTypeName, takesLoad, type FieldShape, type QueryColumn, type QueryField } from "./inputs.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
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
  /** The globals the file names (`$RegExp`, `$Object`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
}

/** The filter and sort schemas a read input uses. */
export interface QuerySchema {
  /** The filter type, and the loadable map when the entity has one, imported from the types file with the input types. */
  readonly typeImports: readonly string[];
  /** The filter type's name, e.g. `PostFilter`. */
  readonly filterTypeName: string;
  /** The exported filter schema, e.g. `postFilterSchema`: `export const postFilterSchema: z.ZodType<PostFilter>`. */
  readonly filterConst: string;
  /** One property per column a filter may name: `<key>: comparison(<value schema>).optional(),` (`undefined` is a column left out). */
  readonly filterFields: readonly SchemaField[];
  /** The exported sort schema, e.g. `postSortSchema`. */
  readonly sortConst: string;
  /** The sort keys as printed in `z.enum([ ... ])`, ascending then descending per column. */
  readonly sortKeys: readonly string[];
}

/** `export const <constName> = z.strictObject({ ... }) satisfies z.ZodType<<typeName>>;` */
export interface InputSchema {
  /** The input type it validates, imported from the types file, e.g. `CreatePostInput`. */
  readonly typeName: string;
  /** The type argument the schema is checked at: `<keyof PostLoadable>` for a read that takes `load` (every name it may list), else the empty string. */
  readonly typeArguments: string;
  /** The exported schema constant: `typeName` with its first letter lower-cased, then `Schema` (`schemaName`), e.g. `createPostInputSchema`. */
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
  // Any JSON value, no shape; the cast gives the input type `unknown` (ADR-0069). `null` is JSON, and the model
  // marks every json attribute and argument nullable (ENT-03), so the field adds `.nullable()` and `.optional()`.
  json: "(z.json() as z.ZodType<unknown>)",
} as const satisfies Record<AttributeType, string>;

/** The validators view of one entity. Pure and synchronous; a model it cannot render is an `EmitError`. */
export function validatorsView({ document }: EmitInput, entity: Entity): ValidatorsView {
  const inputs = entityInputs(entity, document);
  const view = {
    entityFile: entityFileComment(entity),
    hasInputs: inputs.length > 0,
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    schemas: inputs.map((input) => ({
      typeName: input.name,
      typeArguments: takesLoad(input) ? `<keyof ${typeName(entity.name, entity.position)}Loadable>` : "",
      constName: input.validator,
      shapeTypeName: `${input.name}Shape`,
      fields: input.fields.map(({ attribute, optional, query }) => ({
        name: attribute.name,
        key: propertyName(attribute.name),
        schema: query ? querySchema(entity, query) : fieldSchema(attribute, optional),
      })),
    })),
    query: hasRead(entity) ? queryView(entity) : null,
  };
  // The template prints `$Object.keys` in the comparison schema a read's filter uses; a file with no input imports nothing.
  return { ...view, globals: view.hasInputs ? globalsImport(`${entityPath(entity)}.validators`, view, view.query ? ["Object"] : []) : null };
}

const filterConst = (entity: Entity) => schemaName(filterTypeName(entity));
const sortConst = (entity: Entity) => schemaName(sortTypeName(entity));

/** The schema of a read's `filter`, `sort`, `limit` or `offset`. All four are optional. */
function querySchema(entity: Entity, field: QueryField): string {
  return field === "filter" ? `${filterConst(entity)}.optional()`
    : field === "sort" ? `${sortConst(entity)}.optional()`
    : field === "load" ? `z.array(z.enum([${[...entity.relationships, ...entity.computed].map((member) => JSON.stringify(member.name)).join(", ")}])).readonly().optional()`
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
    typeImports: [filterTypeName(entity), ...(entity.relationships.length + entity.computed.length > 0 ? [`${typeName(entity.name, entity.position)}Loadable`] : [])],
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
  if (field.match) base += `.regex(new $RegExp(${JSON.stringify(field.match.pattern)}, ${JSON.stringify(field.match.flags)}))`;
  return base + (field.nullable ? ".nullable()" : "") + (optional ? ".optional()" : "");
}
