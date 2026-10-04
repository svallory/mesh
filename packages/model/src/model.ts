import type { ActionKind } from "./action-types.ts";
import type { AttributeTypeName } from "./attribute-types.ts";
import type { SourcePosition, Spanned } from "./position.ts";

/**
 * The resource model: plain data only (objects, arrays, strings, numbers, booleans,
 * null). Absent optional values are `null`, never `undefined`, so a model survives
 * `JSON.stringify`/`JSON.parse` unchanged. `findNonJsonValue` checks a document.
 *
 * Every name or value the author writes is a `Spanned`, so a check can point at the
 * bad name rather than at the tag that holds it.
 */

/** A literal default. Numbers must be finite: `Infinity` would become `null` in JSON. */
export type JsonPrimitive = string | number | boolean | null;

/** Which tag produced an attribute. */
export type AttributeSource =
  | "attribute"
  | "uuid-primary-key"
  | "create-timestamp"
  | "update-timestamp";

interface AttributeBase {
  name: string;
  source: AttributeSource;
  /** `allow-nil`; Ash default is true. */
  allowNil: boolean;
  /** `public`; recorded as Ash records `public?`, nothing in v1 reads it (ADR-0035). */
  public: boolean;
  /** `writable`; false for the primary key and the timestamps (mapping page D4, row 18). */
  writable: boolean;
  primaryKey: boolean;
  /** Literal default set on create, or null when there is none. */
  default: Spanned<JsonPrimitive> | null;
  position: SourcePosition;
}

/** `constraints={ one_of: [...] }`, allowed on `atom` only (D9). */
export interface AtomConstraints {
  oneOf: Spanned<string>[];
}

export interface AtomAttribute extends AttributeBase {
  type: "atom";
  /** null when the author wrote no `constraints`. */
  constraints: AtomConstraints | null;
}

export interface PlainAttribute extends AttributeBase {
  type: Exclude<AttributeTypeName, "atom">;
  constraints: null;
}

/**
 * One attribute. The primary key and the timestamps are attributes too, in source order
 * with the declared ones, carrying the facts the mapping page records for them:
 * - `uuid-primary-key` (row 15, D4): type `uuid`, `public` true, `writable` false,
 *   `primaryKey` true, `allowNil` false (a primary key is never nil in Ash).
 * - `create-timestamp` / `update-timestamp` (row 18): type `datetime`, `writable` false,
 *   `allowNil` false, `public` false (Ash's default; the row does not set it).
 * No consumer hardcodes these; they read the fields.
 */
export type Attribute = AtomAttribute | PlainAttribute;

/** `create`, `update` and `destroy` accept attribute names (D14); `read` has no `accept`. */
export interface AcceptingAction {
  kind: Exclude<ActionKind, "read">;
  name: string;
  accept: Spanned<string>[];
  position: SourcePosition;
}

export interface ReadAction {
  kind: "read";
  name: string;
  position: SourcePosition;
}

export type Action = AcceptingAction | ReadAction;

/** The `defaults` list: action kinds the resource gets without declaring them. */
export interface ActionDefaults {
  kinds: Spanned<ActionKind>[];
  position: SourcePosition;
}

export interface Resource {
  name: string;
  table: string | null;
  domain: string | null;
  attributes: Attribute[];
  actions: Action[];
  defaults: ActionDefaults | null;
  position: SourcePosition;
}

/** The future `generated/model.json`: one document per resource of the project. */
export interface ModelDocument {
  resources: Resource[];
}
