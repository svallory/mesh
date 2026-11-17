import type { ActionType } from "./action-types.ts";
import type { AttributeType, ValueType } from "./attribute-types.ts";
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

/**
 * Tells a `set` line's function from its literal (`Step` `set` assignments hold either). An Expression has a `source`
 * string, a `params` list and a `position` object; the builder refuses a literal of that shape (`MESH_SET_VALUE`), so no
 * literal answers true here, whatever its concept's or json value's keys. Every reader of a set value uses this one test.
 */
export function isExpression(value: Literal | Atom | Expression): value is Expression {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Record<"source" | "params" | "position", unknown>>;
  return typeof candidate.source === "string" && Array.isArray(candidate.params)
    && typeof candidate.position === "object" && candidate.position !== null && !Array.isArray(candidate.position);
}

export interface Attribute {
  name: string;
  /** An attribute type, or `concept` for a concept use (`Money :total`), which stores one JSON value (ADR-0092). */
  type: ValueType;
  /** Present exactly when `type` is `concept`: the concept's FQN (`billing.Money`, or `Money` at the domain root). */
  concept?: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  default?: Literal | Atom;
  values?: Atom[];
  min?: number;
  max?: number;
  match?: RegExpLiteral;
  /** `message="..."` on the line: what a broken `min`, `max` or `match` reports instead of Mesh's standard message. Absent unless written. */
  ruleMessage?: string;
  /** `code="..."` on the line: the issue's code instead of Mesh's standard one (`too_short`, ...). Absent unless written. */
  ruleCode?: string;
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
  /**
   * `has-many` and `has-one`: the name of the `belongs-to` this relationship follows, authored (`inverse=:name`), the only
   * candidate, or the candidate named after the owning entity. It is a `belongs-to` of the target, or, with `through`, of
   * the link entity. Set when the build resolves the target.
   */
  inverse?: string;
  /** `has-many` only, written `through=Link`: the relationship reaches its target through a link entity (many-to-many). Absent otherwise. */
  through?: Through;
  position: SourcePosition;
}
/**
 * The link of a `has-many ... through=`: the relationship enters the link entity by the `belongs-to` that
 * `Relationship.inverse` names (the entry) and leaves it by `exit`.
 */
export interface Through {
  /** The link entity, as `through=` writes it. */
  entity: EntityRef;
  /** The link's `belongs-to` that leads to the target: its only one, the entry aside, whose entity is the target. Set when the build resolves the link. */
  exit?: string;
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
  /** Never set: it makes `kind` the discriminant of `ValidateItem` without adding a key to `model.json`. */
  kind?: never;
  label: string;
  that: Expression;
  code: string;
  /** The text the failed check reports, or a function of the arguments `that` gets that returns it. */
  message: string | Expression;
  when?: Expression;
  /** A function returning data the caller receives on the failed check's issue (`details`, G22). */
  details?: Expression;
  /** Where the check is declared: its `check :name` line, in a `validate` block or under `checks`. */
  position: SourcePosition;
  /** Only on a check a `validate` block uses by reference: where its `check &name` is written. */
  reference?: SourcePosition;
}
/**
 * A `when=condition` line in `validate`: the lines under it run only when the condition holds (ADR-0053). The
 * condition sees what a check sees and is evaluated once per call; false or unknown skips the lines.
 */
export interface CheckGroup {
  kind: "when";
  condition: Expression;
  /** The lines under it, in written order: checks, and `when` lines nested further. */
  lines: ValidateItem[];
  position: SourcePosition;
}
/** One line of a `validate` block. */
export type ValidateItem = Check | CheckGroup;
/** Tells a group from the other lines of a `validate` block. Every consumer uses this, so a new line kind changes one function. */
export const isCheckGroup = (item: ValidateItem): item is CheckGroup => item.kind === "when";
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
/**
 * An event or a command an owner's (an entity's or an aggregate's) `events` or `commands` section names (a listing line,
 * `InvoicePaid` or `notices.InvoiceOverdue`, or an inline declaration), or an event a handler's `on=` names.
 */
export interface DeclarationRef {
  /** As written: `InvoicePaid`, the alias `Paid`, or `notices.InvoiceOverdue`. Only messages read it. */
  identifier: string;
  /** The file that declares it, as an import of the owner's file writes the path. */
  from: string;
  /**
   * The declaration's FQN (`billing.InvoicePaid`), set when the build resolves it. `""` until then, as `CommandRef.fqn` is:
   * a ref left unresolved always comes with an error, and a build with an error writes no `model.json`.
   */
  fqn: string;
  /** The listing line, or the item of a handler's `on=`. */
  position: SourcePosition;
}
export interface Action {
  kind: ActionType;
  name: string;
  /** The command this action answers, when it has an `on=`. */
  command?: CommandRef;
  input: InputField[];
  validate: ValidateItem[];
  do: Step[];
  filter?: Expression;
  sort?: SortKey[];
  position: SourcePosition;
}
export interface Always {
  types?: ActionType[];
  actions?: MemberRef[];
  validate: ValidateItem[];
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
/** `max-limit=N` on the `actions` line: the largest `limit` a caller read takes, and the rows it reads when none is given. */
export interface LimitCap {
  max: number;
  /** Where the option's name `max-limit` is written: the issue of a refused `limit` points here (ADR-0039). */
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
  /** `max-limit=` of the `actions` line. Present only when it is written and valid. */
  maxLimit?: LimitCap;
  actions: Action[];
  always: Always[];
  policies: Policy[];
  /**
   * The events this entity owns, in written order: its `events` section's lines. Present only when the section has a line.
   * An event that owners list is published only by its owners' actions.
   */
  events?: DeclarationRef[];
  /** The commands this entity owns: its `commands` section's lines. Present only when the section has a line. */
  commands?: DeclarationRef[];
  /** The handlers of the entity's `handlers` section, in written order. Present only when the section has a line. */
  handlers?: HandlerDeclaration[];
  position: SourcePosition;
}
/**
 * A line of an owner's `handlers` section (`listen :receipt [on=InvoicePaid] async ({ event }) { ... }`): a handler of one
 * of core's two kinds, run once per event it lists, registered and stored under its key.
 */
export interface HandlerDeclaration {
  kind: "process" | "listen";
  /** The declared name, as written (`receipt`). */
  name: string;
  /** `<owner FQN>.<name>` (`billing.Invoice.receipt`): the name it is registered and its progress row stored under. */
  key: string;
  /** The events `on=` names, in written order, each once. */
  events: DeclarationRef[];
  /** The body, a function of `{ event, context }`: always plain code (`plain.why` is `"handler"`). */
  run: Expression;
  /** `renamed-from=:old`, as the former key (`billing.Invoice.old`): the progress row that moves to this handler. */
  renamedFrom?: string;
  position: SourcePosition;
}
/**
 * One field of an event or a command: an attribute line without what concerns storage or creation, so it has no
 * `primaryKey`, `unique`, `default` or `on`.
 */
export type Field = Pick<Attribute, "name" | "type" | "concept" | "nullable" | "values" | "min" | "max" | "match" | "ruleMessage" | "ruleCode" | "position"> & {
  /** Command fields only: the caller may omit the field without admitting null. Absent unless enabled on a non-nullable field. */
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
/**
 * A concept (ADR-0080, ADR-0092): a value with no identity, declared in `concepts/<Name>.mesh.mx` (`concept :Money` and
 * its field lines). Plain data; the generated type and Zod schema come from it.
 */
export interface ConceptDeclaration {
  /** As declared, PascalCase: `Money`. */
  name: string;
  /** The module's folders joined by `.`, then the name: `billing.Money`; `Money` at the domain root. */
  fqn: string;
  /** Project-relative path of the concept file. */
  file: string;
  /** The folder that holds the `concepts` folder, relative to the domain root, `_group` segments dropped. */
  module: string;
  /** In written order. No field is a date type (a concept is stored as one JSON value, which keeps no `Date`). */
  fields: Field[];
  position: SourcePosition;
}
/** One part of an aggregate: a line of its `entities` section (`Dependency prop=:dependent`). */
export interface AggregatePart {
  /** The part entity, as the line head writes it (`Dependency`, `talk.Comment`). */
  entity: EntityRef;
  /**
   * The part's `belongs-to` that ties it to the root: the one `prop=` names, or the part's only `belongs-to` to the root.
   * Set when the build resolves it.
   */
  prop?: string;
  /** The line's head. */
  position: SourcePosition;
}
/**
 * An aggregate file (`aggregate :TaskAggregate`, ADR-0080): a root entity and its parts, one consistency boundary, and the
 * events and commands it owns. No code is generated from it.
 */
export interface Aggregate {
  /** The declared name, as written: nothing is generated from it, so it is not converted to a class name. */
  name: string;
  /** `<module>.<Name>`, the module's folders joined by `.`; the name alone at the domain root. */
  fqn: string;
  file: string;
  module: string;
  imports: Import[];
  /** `root entity=Task`: the root entity, and where the `root` line is. */
  root: { entity: EntityRef; position: SourcePosition };
  parts: AggregatePart[];
  /** The events the aggregate owns: its `events` section's lines. The root's and the parts' actions may publish them. */
  events?: DeclarationRef[];
  /** The commands the aggregate owns: its `commands` section's lines. */
  commands?: DeclarationRef[];
  /** The handlers of the aggregate's `handlers` section, keyed by the aggregate's FQN. Present only when the section has a line. */
  handlers?: HandlerDeclaration[];
  position: SourcePosition;
}
/** One `action :name` line of an expose line: an action of the exposed entity the audience may call. */
export interface ExposedAction {
  /** The action's name, as written (`complete`). */
  name: string;
  position: SourcePosition;
}
/** One `expose` line of a surface: an entity the audience may reach, under the exposed name. */
export interface Exposure {
  /** The exposed name, as written (`tasks`): the name the audience sees. */
  name: string;
  /** The exposed entity's FQN (`work.Task`), resolved from `entity=`. */
  entity: string;
  /** `entity=` as written (`Task`, `work.Task`), for messages. */
  identifier: string;
  /** `label=` as written; absent when the line has none (a reader shows `name`). */
  label?: string;
  /**
   * `fields=`: the member names listed, in written order, or `"all"`. `[]` when the line has no `fields=` (no property
   * leaves). Names are members as the entity file names them (`author` for a belongs-to, never `authorId`).
   */
  fields: string[] | "all";
  actions: ExposedAction[];
  position: SourcePosition;
}
/** A surface (`surface :admin`, a surface file): what one audience may call and see, under which names. */
export interface Surface {
  /** The surface's name, as written (`admin`). A surface has no module: its identity is its name. */
  name: string;
  /** Project-relative path of the surface file. */
  file: string;
  expose: Exposure[];
  position: SourcePosition;
}
export interface ModelDocument {
  entities: Entity[];
  /** Present only when the project declares an event, so a project with none keeps its `model.json` as it was. */
  events?: EventDeclaration[];
  /** Present only when the project declares a command. */
  commands?: CommandDeclaration[];
  /** Present only when the project declares an aggregate, so a project with none keeps its `model.json` as it was. */
  aggregates?: Aggregate[];
  /** Present only when the project declares a concept, so a project with none keeps its `model.json` as it was. */
  concepts?: ConceptDeclaration[];
  /** Present only when the project declares a surface, so a project with none keeps its `model.json` as it was. */
  surfaces?: Surface[];
  /** Selected adapter identity only; options may contain secrets and never serialize. */
  data?: { name: string };
}
