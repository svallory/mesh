import type { ActionType } from "./action-types.ts";
import type { AttributeType } from "./attribute-types.ts";
import type { ExprNode, PlainReason } from "./expression.ts";
import type { SourcePosition } from "./position.ts";

/** JSON data only. Optional properties are omitted, never assigned undefined. */
export type Literal =
  | string
  | number
  | boolean
  | null
  | Literal[]
  | { [key: string]: Literal };
export type JsonPrimitive = string | number | boolean | null;
export interface Atom {
  value: string;
}
/** A regular expression is data, not a live RegExp (which JSON would lose). */
export interface RegExpLiteral {
  pattern: string;
  flags: string;
}
export interface MemberRef {
  name: string;
  position: SourcePosition;
}
export interface EntityRef {
  identifier: string;
  from: string;
}
export interface Import {
  identifiers: string[];
  from: string;
  /** Present (true) when the import is a helper module and not an entity file. */
  helper?: true;
  position: SourcePosition;
}
/** Authored function text; no translation or evaluation during model building. */
export interface Expression {
  source: string;
  params: string[];
  position: SourcePosition;
  /** Present when Mesh translated the function: the tree the evaluators run (M4). */
  tree?: ExprNode;
  /** Present when it did not: the function stays authored TypeScript with JavaScript semantics. Exactly one of `tree` and `plain`. */
  plain?: PlainReason;
}

export interface Attribute {
  name: string;
  type: AttributeType;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  default?: Literal | Atom;
  values?: Atom[];
  min?: number;
  max?: number;
  match?: RegExpLiteral;
  on?: "create" | "update";
  position: SourcePosition;
}
export interface Relationship {
  kind: "belongs-to" | "has-many" | "has-one";
  name: string;
  entity: EntityRef;
  nullable: boolean;
  /** `belongs-to` only: the stored column that holds the target's key. */
  keyColumn?: string;
  /** `belongs-to` only: the type of the target's primary key, which is the type of `keyColumn`. Set when the build resolves the target. */
  keyType?: AttributeType;
  /** `has-many` and `has-one`: the name of the target's `belongs-to` this relationship follows, authored (`via=:name`) or the only candidate. Set when the build resolves the target. */
  via?: string;
  position: SourcePosition;
}
export type Rollup = {
  fn: "count" | "sum" | "avg" | "min" | "max";
  of: string;
};
/** Exactly one definition: a function body or a rollup. */
export type Computed = {
  name: string;
  type: AttributeType;
  /** An `enum` computed field names its values, as an enum attribute does. */
  values?: Atom[];
  /**
   * What loading this field needs on the record first (M7): dotted paths of relationships and
   * computed fields on `self`, such as `claims`, `dependencies.prerequisite` or `claimed`. A
   * prefix of a path is implied by it. Present on a field with a body; sorted, without duplicates.
   */
  needs?: string[];
  position: SourcePosition;
} & (
  | { body: Expression; rollup?: never; nullable?: boolean }
  | { body?: never; rollup: Rollup; nullable: boolean }
);
export type Argument = Omit<Attribute, "primaryKey" | "unique" | "on"> & {
  kind: "argument";
};
export type InputField = { kind: "member"; ref: MemberRef } | Argument;
export interface SortKey {
  direction: "asc" | "desc";
  member: MemberRef;
}
export interface Check {
  label: string;
  that: Expression;
  code: string;
  message: string;
  when?: Expression;
  position: SourcePosition;
}
export type Step = (
  | {
      kind: "set";
      assignments: { member: MemberRef; value: Literal | Atom | Expression }[];
    }
  | { kind: "when"; condition: Expression; steps: Step[] }
  | { kind: "load"; members: MemberRef[] }
  | { kind: "run"; fn: Expression }
) & { position: SourcePosition };
export interface Action {
  kind: ActionType;
  name: string;
  input: InputField[];
  validate: Check[];
  do: Step[];
  filter?: Expression;
  sort?: SortKey[];
  position: SourcePosition;
}
export interface Always {
  types?: ActionType[];
  actions?: MemberRef[];
  validate: Check[];
  do: Step[];
  position: SourcePosition;
}
export interface Policy {
  name: string;
  types?: ActionType[];
  actions?: MemberRef[];
  authorizeIf: Expression[];
  forbidIf: Expression[];
  when?: Expression;
  position: SourcePosition;
}
export interface Entity {
  name: string;
  table: string;
  file: string;
  module: string;
  imports: Import[];
  attributes: Attribute[];
  relationships: Relationship[];
  computed: Computed[];
  auto: ActionType[];
  onLoad?: MemberRef;
  actions: Action[];
  always: Always[];
  policies: Policy[];
  position: SourcePosition;
}
export interface ModelDocument {
  entities: Entity[];
  /** Selected adapter identity only; options may contain secrets and never serialize. */
  data?: { name: string };
}
