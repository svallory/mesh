import type { AttributeTypeName } from "./attribute-types.ts";
import type { SourcePosition } from "./position.ts";

/**
 * The resource model: plain data only (objects, arrays, strings, numbers, booleans,
 * null). Absent optional values are `null`, never `undefined`, so a model survives
 * `JSON.stringify`/`JSON.parse` unchanged.
 */

export type JsonPrimitive = string | number | boolean | null;

export interface AttributeConstraints {
  /** Allowed values of an `atom` attribute (`constraints={ one_of: [...] }`). */
  oneOf: string[] | null;
}

export interface Attribute {
  name: string;
  type: AttributeTypeName;
  /** `allow-nil`; Ash default is true. */
  allowNil: boolean;
  /** `public`; recorded as Ash records `public?`, nothing in v1 reads it (ADR-0035). */
  public: boolean;
  /** Literal default set on create, or null when there is none. */
  default: JsonPrimitive;
  constraints: AttributeConstraints | null;
  position: SourcePosition;
}

export interface PrimaryKey {
  name: string;
  /** `uuid-primary-key` is the only form in v1. */
  type: "uuid";
  position: SourcePosition;
}

/** `create-timestamp` / `update-timestamp`: the attribute name the author chose. */
export interface Timestamp {
  name: string;
  position: SourcePosition;
}

export type ActionKind = "create" | "read" | "update" | "destroy";

export interface Action {
  kind: ActionKind;
  name: string;
  /** Attribute names the action accepts. Always `[]` for `read`. */
  accept: string[];
  position: SourcePosition;
}

/** The `defaults` list: action kinds the resource gets without declaring them. */
export interface ActionDefaults {
  kinds: ActionKind[];
  position: SourcePosition;
}

export interface Resource {
  name: string;
  table: string | null;
  domain: string | null;
  primaryKey: PrimaryKey | null;
  attributes: Attribute[];
  createTimestamp: Timestamp | null;
  updateTimestamp: Timestamp | null;
  actions: Action[];
  defaults: ActionDefaults | null;
  position: SourcePosition;
}

/** The future `generated/model.json`: one document per resource of the project. */
export interface ModelDocument {
  resources: Resource[];
}
