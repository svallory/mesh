/** The entity-file type tags and their generated TypeScript representation. */
export interface AttributeTypeInfo {
  readonly name: string;
  readonly tsType: string;
  /** False when a filter, a sort and a rollup cannot use the type (a `json` value is opaque to the query). */
  readonly queryable: boolean;
}
export const ATTRIBUTE_TYPES = Object.freeze([
  { name: "uuid", tsType: "string", queryable: true },
  { name: "string", tsType: "string", queryable: true },
  { name: "integer", tsType: "number", queryable: true },
  { name: "float", tsType: "number", queryable: true },
  { name: "decimal", tsType: "number", queryable: true },
  { name: "boolean", tsType: "boolean", queryable: true },
  { name: "enum", tsType: "string", queryable: true },
  { name: "date", tsType: "Date", queryable: true },
  { name: "datetime", tsType: "Date", queryable: true },
  { name: "timestamp", tsType: "Date", queryable: true },
  { name: "json", tsType: "unknown", queryable: false },
] as const);
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number]["name"];
export type AttributeTypeName = AttributeType;
/**
 * What a member or a field holds: an attribute type, or a concept (ADR-0092), whose FQN the member's `concept` names. Not an
 * attribute type: `concept` is the root tag of a concept file, and a concept use's head is the concept's own name.
 */
export type ValueType = AttributeType | "concept";
const NAMES: ReadonlySet<string> = new Set(ATTRIBUTE_TYPES.map((t) => t.name));
export function isAttributeTypeName(value: unknown): value is AttributeType {
  return typeof value === "string" && NAMES.has(value);
}
export function attributeTypeInfo(name: AttributeType): AttributeTypeInfo {
  const info = ATTRIBUTE_TYPES.find((t) => t.name === name);
  if (!info)
    throw new Error(
      `"${String(name)}" is not a registered attribute type; registered: ${[...NAMES].join(", ")}`,
    );
  return info;
}
/**
 * The attribute type of a member that cannot be a concept: a primary key (a concept use takes no `primary-key`), or the
 * number or date member of a rollup. Throws on a concept, which would be a bug in the build.
 */
export function keyTypeOf(attribute: { readonly name: string; readonly type: ValueType }): AttributeType {
  if (attribute.type === "concept") throw new Error(`:${attribute.name} is a concept member, which has no attribute type here`);
  return attribute.type;
}
