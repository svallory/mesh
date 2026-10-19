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
  /**
   * The reference as the entity file writes it: an imported identifier (`List`), a member of a namespace import
   * (`billing.Invoice`), or the entity's own name. Only messages read it; the target is the entity `from` declares.
   */
  identifier: string;
  /** The file the referenced entity is declared in, as the import writes it (relative to the entity file). */
  from: string;
}
export interface Import {
  /** The names the import binds in the entity file, in the order written: the alias where one is written. */
  identifiers: string[];
  /**
   * The name each of `identifiers` is exported under, in the same order; present only when the import renames one
   * (`import { fmt as format }` gives `identifiers: ["format"]` and `imported: ["fmt"]`).
   */
  imported?: string[];
  from: string;
  /** Present (true) when the import is a helper module and not an entity file. */
  helper?: true;
  /**
   * Present (true) for a namespace import, `import * as billing from "../billing/invoice.mesh.mx"`: `identifiers`
   * holds its one local, the alias the file gives that file, and a reference through it is a member access
   * (`billing.Invoice`, or `h.isStaff(...)` for a helper module). The alias is never part of an FQN.
   */
  namespace?: true;
  /**
   * Present (true) when the import is Mesh's own functions, `import { Mesh } from "meshfw"`: neither a helper
   * module nor an entity file. It binds `Mesh` alone, or its alias.
   */
  mesh?: true;
  position: SourcePosition;
}
/** Authored function text; no translation or evaluation during model building. */
export interface Expression {
  source: string;
  params: string[];
  /** The parameter is a rest pattern (`{ context, ...rest }`) or a plain name (`(s) => ...`), which can reach any name in the scope. */
  rest?: true;
  /** The authored function declares a parameter of any form (even `({})`), so the generated code calls it with the scope. Set only when `params` names nothing (`(s) => ...`, `({}) => ...`); a function that names scope members takes it anyway. */
  takesScope?: true;
  position: SourcePosition;
  /** Present when Mesh translated the function: the tree the evaluators run (M4). */
  tree?: ExprNode;
  /** Present when it did not: the function stays authored TypeScript with JavaScript semantics. Exactly one of `tree` and `plain`. */
  plain?: PlainReason;
  /**
   * What an action runs before this function (M5): dotted paths of relationships and computed fields on `self`,
   * such as `owner` or `owner.todoCount`, that the function reads, so the action loads them first. Sorted, without
   * duplicates. Set on the functions of actions, `always` blocks and policies that read any; absent when they read none.
   */
  needs?: string[];
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
  /** `has-many` and `has-one`: the name of the target's `belongs-to` this relationship follows, authored (`inverse=:name`), the only candidate, or the candidate named after the owning entity. Set when the build resolves the target. */
  inverse?: string;
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
  /** The text the failed check reports, or a function of the arguments `that` gets that returns it. */
  message: string | Expression;
  when?: Expression;
  /** A function returning data the caller receives on the failed check's issue (`details`, G22). */
  details?: Expression;
  position: SourcePosition;
}
export type Step = (
  | {
      kind: "set";
      assignments: { member: MemberRef; value: Literal | Atom | Expression }[];
    }
  | { kind: "when"; condition: Expression; steps: Step[] }
  | { kind: "load"; members: MemberRef[] }
  /** `after: "write"` (`run [after=:write]`) runs the step after the action's own row is written, with the stored record as `self` (ADR-0068). */
  | { kind: "run"; fn: Expression; after?: "write" }
  /**
   * `publish=() => new InvoicePaid({ ... })` raises the event the function returns (M6): plain code, whatever it holds
   * (`PlainReason.why` is `publish-step`), run after the action's row is written, in written order among the `run
   * [after=:write]` steps.
   */
  | { kind: "publish"; fn: Expression }
) & { position: SourcePosition };
/** The command an action answers (`on=PayInvoice`): the model's record of it, for `dispatch`, `explain` and the checks. */
export interface CommandRef {
  /** The reference as the entity file writes it: an imported identifier (`PayInvoice`, or the alias `Pay`) or `billing.PayInvoice`. Only messages read it. */
  identifier: string;
  /** The file the command is declared in, as the import writes it (relative to the entity file). */
  from: string;
  /** The command's FQN (`billing.PayInvoice`), the name a serialised command carries and `Mesh.fqnOf` returns. */
  fqn: string;
  /** Where `on=` is written. */
  position: SourcePosition;
}
export interface Action {
  kind: ActionType;
  name: string;
  /** The command this action answers, when it has an `on=`. */
  command?: CommandRef;
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
  /**
   * Fully qualified name, computed once by the front end: the module's folders joined by `.`, then `.` and the name
   * (`work.Review`); at the domain root, the name alone. Every other component reads it and never rebuilds it.
   */
  fqn: string;
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
/**
 * One field of an event or a command: an attribute line without what concerns storage or creation, so it has no
 * `primaryKey`, `unique`, `default` or `on`.
 */
export type Field = Pick<Attribute, "name" | "type" | "nullable" | "values" | "min" | "max" | "match" | "position"> & {
  /** Command fields only: the caller may omit the field without admitting null. Absent unless written. */
  optional?: true;
};
/**
 * An event declaration: the fields of a fact the domain records (`event :InvoicePaid`, a file of its own). Plain data;
 * the generated class and its checks come from it.
 */
export interface EventDeclaration {
  /** The declared name, as written (`InvoicePaid`). */
  name: string;
  /** `<module>.<Name>` (`billing.InvoicePaid`), the module's folders joined by `.`; the name alone at the domain root. The stored and wire name. */
  fqn: string;
  file: string;
  module: string;
  fields: Field[];
  position: SourcePosition;
}
/** A command declaration: the fields of a request to run a write action (`command :PayInvoice`, a file of its own). */
export type CommandDeclaration = EventDeclaration;
export interface ModelDocument {
  entities: Entity[];
  /** Present only when the project declares an event, so a project with none keeps its `model.json` as it was. */
  events?: EventDeclaration[];
  /** Present only when the project declares a command. */
  commands?: CommandDeclaration[];
  /** Selected adapter identity only; options may contain secrets and never serialize. */
  data?: { name: string };
}
