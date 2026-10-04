/**
 * The attribute type registry: the single source of attribute type names
 * (ADR-0037). The tag contract's `type` enum is built from it.
 *
 * Names follow the vocabulary mapping page, section 3.2:
 * - `string`, `boolean`, `uuid`, `datetime`: row 30
 * - `integer`, `float`: row 31, deviation D8 (replaces `number`)
 * - `atom`: row 32, deviation D9 (replaces `enum` with `values`; the allowed
 *   values are a `one-of` constraint)
 */
export interface AttributeTypeInfo {
  readonly name: string;
  /** The TypeScript type a value of this attribute has in generated code. */
  readonly tsType: string;
  /** Whether the `constraints` attribute is accepted for this type. */
  readonly takesConstraints: boolean;
}

export const ATTRIBUTE_TYPES = Object.freeze([
  Object.freeze({ name: "string", tsType: "string", takesConstraints: false }),
  Object.freeze({ name: "integer", tsType: "number", takesConstraints: false }),
  Object.freeze({ name: "float", tsType: "number", takesConstraints: false }),
  Object.freeze({ name: "boolean", tsType: "boolean", takesConstraints: false }),
  Object.freeze({ name: "uuid", tsType: "string", takesConstraints: false }),
  Object.freeze({ name: "datetime", tsType: "Date", takesConstraints: false }),
  Object.freeze({ name: "atom", tsType: "string", takesConstraints: true }),
] as const satisfies readonly AttributeTypeInfo[]);

export type AttributeTypeName = (typeof ATTRIBUTE_TYPES)[number]["name"];

const NAMES: ReadonlySet<string> = new Set(ATTRIBUTE_TYPES.map((t) => t.name));

/** True only for an exact, registered attribute type name (case and whitespace matter). */
export function isAttributeTypeName(value: unknown): value is AttributeTypeName {
  return typeof value === "string" && NAMES.has(value);
}

/** Registry entry for a name; throws for an unregistered one. */
export function attributeTypeInfo(name: AttributeTypeName): AttributeTypeInfo {
  const info = ATTRIBUTE_TYPES.find((t) => t.name === name);
  if (!info) {
    throw new Error(
      `"${String(name)}" is not a registered attribute type; registered: ${[...NAMES].join(", ")}`,
    );
  }
  return info;
}
