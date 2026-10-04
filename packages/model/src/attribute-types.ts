/**
 * The attribute type registry: the single source of attribute type names
 * (ADR-0037). The tag contract's `type` enum is to be built from it, with a drift
 * test (roadmap M1, test 6); that is not done yet.
 *
 * Names follow the vocabulary mapping page, section 3.2:
 * - `string`, `boolean`, `uuid`, `datetime`: row 30
 * - `integer`, `float`: row 31, deviation D8 (replaces `number`)
 * - `atom`: row 32, deviation D9 (replaces `enum` with `values`; the allowed
 *   values are a `one-of` constraint)
 */
export interface AttributeTypeInfo {
  readonly name: string;
  /**
   * The TypeScript type a value of this attribute has in generated code. Free text the
   * emitter pastes into generated files, so keep it a valid type expression.
   *
   * `datetime` is `string` (an ISO 8601 timestamp), not `Date`: a `default` literal in
   * the model is a string, and the same generated type must hold across a JSON boundary
   * (API, client, `model.json`) without a conversion. A data adapter that wants `Date`
   * (Drizzle's default timestamp mode) converts at its own edge.
   */
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
  Object.freeze({ name: "datetime", tsType: "string", takesConstraints: false }),
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
