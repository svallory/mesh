/** The entity-file type tags and their generated TypeScript representation. */
export interface AttributeTypeInfo {
  readonly name: string;
  readonly tsType: string;
}
export const ATTRIBUTE_TYPES = Object.freeze([
  { name: "uuid", tsType: "string" },
  { name: "string", tsType: "string" },
  { name: "integer", tsType: "number" },
  { name: "float", tsType: "number" },
  { name: "decimal", tsType: "number" },
  { name: "boolean", tsType: "boolean" },
  { name: "enum", tsType: "string" },
  { name: "date", tsType: "Date" },
  { name: "datetime", tsType: "Date" },
  { name: "timestamp", tsType: "Date" },
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
