import type { SourcePosition } from "./position.ts";

/**
 * The expression tree and its function registry (M4, ADR-0010, ADR-0012 option A).
 * Plain data: a tree is JSON, the registry says what each function means. The
 * implementations are in `@meshfw/runtime`; the written definition of every entry
 * is its table (`@meshfw/runtime/testing`, `EXPRESSION_TABLES`).
 */
export type FunctionId =
  | "eq" | "ne" | "isNull" | "isNotNull" | "lt" | "lte" | "gt" | "gte"
  | "and" | "or" | "not" | "add" | "sub" | "mul" | "div" | "idiv" | "neg"
  | "length" | "now" | "today" | "coalesce" | "cond" | "isSystem";

export type QuantifierId = "some" | "every" | "find" | "filter";

export type ExprNode = (
  /** `float` is set on a number written with a `.` or an exponent (`2.0`), which JavaScript cannot tell from `2` once parsed. */
  | { kind: "literal"; value: string | number | boolean | null; float?: true }
  | { kind: "atom"; value: string }
  /** `self`, `input`, `actor`, `context`, `before`, or a quantifier's parameter. */
  | { kind: "var"; name: string }
  | { kind: "member"; object: ExprNode; name: string; optional: boolean }
  | { kind: "call"; fn: FunctionId; args: ExprNode[] }
  /**
   * An imported pure function that does not read the record. `name` is the callee as written: the import's local
   * (`isStaff`), or a member of a namespace import (`h.isStaff`).
   */
  | { kind: "helper"; name: string; from: string; args: ExprNode[] }
  | { kind: "quantify"; op: QuantifierId; source: ExprNode; param: string; body: ExprNode }
) & { position: SourcePosition };

export type PlainWhy =
  | "block-body"
  | "run-step"
  | "publish-step"
  | "unsupported-construct"
  | "reads-record-in-helper"
  | "uses-privileged"
  | "asks-policies"
  | "calls-entity"
  | "awaits-helper"
  | "unsupported-parameter";

/**
 * Replace `source.slice(from, to)` with `text` to turn the authored function into TypeScript: `&name` to `$self.name`,
 * `%.now` to `$now()`, `:atom` to a string. The names an edit reads are the printed function's own (`PlainReason.internal`).
 */
export interface SourceEdit {
  from: number;
  to: number;
  text: string;
  /** For `&name`: the member it reads, `name`. */
  member?: string;
  /** For `&x`: it is the right side of `input.x ?? &x`, read only when the caller did not send `x`. */
  fallback?: true;
}

/**
 * The names the printed function binds what the edits read under (`SourceEdit`): `self` for the record `&name` reads,
 * `now` and `today` for the current transaction's `%.now` and `%.today`. Each is `$self`, `$now` or `$today`, or
 * that name with a number (`$now1`) when the authored text already spells it, in its code, types, strings or comments: no
 * binding of the author's can hide it, so `&name` is the record's member and `%.now` the transaction's whatever the author
 * names a local (`self`, `$`, `$s`). A name the author writes (`self.title`, `input.id`) keeps JavaScript's scoping.
 */
export interface InternalNames {
  self?: string;
  now?: string;
  today?: string;
}

export interface PlainReason {
  why: PlainWhy;
  detail: string;
  position: SourcePosition;
  edits: SourceEdit[];
  /**
   * The scope names (`self`, `input`, `actor`, `context`, `before`) the authored text reads as variables that its
   * parameters do not bind; the printed function takes these from the scope. `&name` reads none of them: it reads the
   * record through `internal.self`.
   */
  roots: string[];
  /** The members of the current transaction the authored text reads (`%.now`, `%.today`): `now` and `today`. */
  clock?: ("now" | "today")[];
  /** The names the printed function binds the record `&name` reads and the transaction's `%.now` and `%.today` under. */
  internal?: InternalNames;
  /** The authored text reads `Mesh.isSystem` (`Mesh.isSystem(context)`). */
  isSystem?: true;
  /** The authored text reads `Mesh.privileged` (`Mesh.privileged(Entity)`). */
  privileged?: true;
  /** The authored text reads `Mesh.checkPolicies` or `Mesh.can`: it asks another action's policies. */
  asks?: true;
  /**
   * The names the file imports `Mesh` under (`import { Mesh } from "meshfw"`) that the authored text reads, where
   * no binding of the function hides them, sorted. The expressions file imports `Mesh` under each, as it imports a helper.
   */
  mesh?: string[];
  /**
   * The entities the authored text names: the file's own and the ones it imports, by the name the file gives
   * them, sorted. The printed function binds each to its entity value, typed so that what it resolves with is read-only.
   */
  entities?: string[];
  /** The authored text calls a method of an entity it names (`Task.touch(...)`): it runs another action. */
  acts?: true;
  /**
   * The events and commands the authored text names, by the name the file gives the import that binds one (a named
   * import's local, or a namespace import's alias), sorted. The printed function binds each to its generated class,
   * which the expressions file imports from the declaration's module.
   */
  events?: string[];
  /**
   * The helpers the authored text reads as values (a call, a reference) that it imports from a helper module, by the name
   * the file imports them under, sorted (a policy that names one runs inside the transaction). The expressions file
   * imports these. A free scope name (`input`, `context`) is the root, never a helper of that name. A helper
   * named only in a type (`const x: Money`, `typeof fmt`) is not here: MX strips the types from the node the front end
   * reads, so the TypeScript back end finds it in the printed function and imports it as a type.
   */
  helpers?: string[];
  /**
   * The authored text calls the global `structuredClone`, which no binding of the function and no import of the file hides.
   * It cannot copy the read-only views the function is handed (they are proxies), so the printed function binds
   * it to `cloneValue`, which can.
   */
  structuredClone?: true;
  /** The authored text is a method (`(params) { body }`), so TypeScript needs `function` before it. */
  method?: true;
  /** The authored code uses an operator whose null rule differs from Mesh's (comparison, `!`, `&&`, `||`, arithmetic), so the build warns. */
  operators?: true;
  /** For an object literal (a check's `details`): the property values Mesh could translate, so the type pass can tell whether a comparison among them can differ. */
  parts?: ExprNode[];
}

export type TypeClass = "number" | "string" | "boolean" | "date" | "enum" | "json" | "list" | "record" | "any";

export interface FunctionSpec {
  id: FunctionId;
  /** What the author writes. */
  spelling: string;
  arity: number;
  /** Accepted operand classes; `T` stands for one class of number, string, boolean, date, enum, the same on both sides. */
  signature: string;
  /** One line; the table is the definition. */
  nulls: string;
  /**
   * The same rule as data, for the passes that ask whether a result can be null when an operand is (`newInstanceComputed`):
   * `propagates`: null when some operand is (`and`/`or` are Kleene, so false && null is false, but they are kept here:
   * a conservative answer is "may be null", which is never wrong); `never`: never null whatever the operands;
   * `all-operands`: null only when every operand can be null (`a ?? b`); `branches`: null when a branch is, whatever the
   * test gives (`c ? a : b`, an unknown test takes the else branch).
   */
  nullResult: "propagates" | "never" | "all-operands" | "branches";
  /**
   * The indexes of the operands the in-memory evaluation evaluates only when the others let it: the right side of
   * `&&`, `||` and `??`, and both branches of `?:`. The generated code passes each as a thunk (`() => ...`), so an imported
   * helper behind a guard runs only when the guard lets it. An unknown (`null`) guard still evaluates the operand, as SQL
   * would. Absent: every operand is evaluated first.
   */
  lazy?: readonly number[];
}

export const FUNCTIONS: readonly FunctionSpec[] = Object.freeze([
  { id: "eq", spelling: "a === b", arity: 2, signature: "(T, T) -> boolean", nulls: "any operand null: unknown", nullResult: "propagates" },
  { id: "ne", spelling: "a !== b", arity: 2, signature: "(T, T) -> boolean", nulls: "any operand null: unknown", nullResult: "propagates" },
  { id: "isNull", spelling: "a === null", arity: 1, signature: "(any) -> boolean", nulls: "never unknown", nullResult: "never" },
  { id: "isNotNull", spelling: "a !== null", arity: 1, signature: "(any) -> boolean", nulls: "never unknown", nullResult: "never" },
  { id: "lt", spelling: "a < b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown", nullResult: "propagates" },
  { id: "lte", spelling: "a <= b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown", nullResult: "propagates" },
  { id: "gt", spelling: "a > b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown", nullResult: "propagates" },
  { id: "gte", spelling: "a >= b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown", nullResult: "propagates" },
  { id: "and", spelling: "a && b", arity: 2, signature: "(boolean, boolean) -> boolean", nulls: "Kleene", nullResult: "propagates", lazy: [1] },
  { id: "or", spelling: "a || b", arity: 2, signature: "(boolean, boolean) -> boolean", nulls: "Kleene", nullResult: "propagates", lazy: [1] },
  { id: "not", spelling: "!a", arity: 1, signature: "(boolean) -> boolean", nulls: "null stays unknown", nullResult: "propagates" },
  { id: "add", spelling: "a + b", arity: 2, signature: "(number, number) -> number", nulls: "any operand null: null", nullResult: "propagates" },
  { id: "sub", spelling: "a - b", arity: 2, signature: "(number, number) -> number", nulls: "any operand null: null", nullResult: "propagates" },
  { id: "mul", spelling: "a * b", arity: 2, signature: "(number, number) -> number", nulls: "any operand null: null", nullResult: "propagates" },
  { id: "div", spelling: "a / b (a float or decimal operand)", arity: 2, signature: "(number, number) -> number", nulls: "exact division; any operand null, or a zero divisor: null", nullResult: "propagates" },
  { id: "idiv", spelling: "a / b (both integers)", arity: 2, signature: "(integer, integer) -> integer", nulls: "truncates toward zero; any operand null, or a zero divisor: null", nullResult: "propagates" },
  { id: "neg", spelling: "-a", arity: 1, signature: "(number) -> number", nulls: "null: null", nullResult: "propagates" },
  { id: "length", spelling: "a.length", arity: 1, signature: "(string | list) -> number", nulls: "null string: null; a list is never null", nullResult: "propagates" },
  { id: "now", spelling: "%.now", arity: 0, signature: "date", nulls: "never null; the current transaction's instant, one per transaction", nullResult: "never" },
  { id: "today", spelling: "%.today", arity: 0, signature: "date", nulls: "never null; %.now at 00:00 UTC", nullResult: "never" },
  { id: "coalesce", spelling: "a ?? b", arity: 2, signature: "(T, T) -> T", nulls: "a unless a is null, else b", nullResult: "all-operands", lazy: [1] },
  { id: "cond", spelling: "c ? a : b", arity: 3, signature: "(boolean, T, T) -> T", nulls: "unknown test: the else branch", nullResult: "branches", lazy: [1, 2] },
  { id: "isSystem", spelling: "Mesh.isSystem(context)", arity: 1, signature: "(any) -> boolean", nulls: "never unknown: true only when the value is an object whose `system` is `true`", nullResult: "never" },
] satisfies FunctionSpec[]);

export const FUNCTION_IDS: ReadonlySet<string> = new Set(FUNCTIONS.map((f) => f.id));
/** The operands of the call `fn` that are evaluated lazily, in the order the call lists them (see `FunctionSpec.lazy`). */
export function lazyOperands(fn: FunctionId): readonly number[] {
  return functionSpec(fn).lazy ?? [];
}
export function functionSpec(id: FunctionId): FunctionSpec {
  return FUNCTIONS.find((f) => f.id === id)!;
}
