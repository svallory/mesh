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
