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
  | "length" | "now" | "today" | "coalesce" | "cond";

export type QuantifierId = "some" | "every" | "find" | "filter";

export type ExprNode = (
  /** `float` is set on a number written with a `.` or an exponent (`2.0`), which JavaScript cannot tell from `2` once parsed. */
  | { kind: "literal"; value: string | number | boolean | null; float?: true }
  | { kind: "atom"; value: string }
  /** `self`, `input`, `actor`, `context`, `before`, or a quantifier's parameter. */
  | { kind: "var"; name: string }
  | { kind: "member"; object: ExprNode; name: string; optional: boolean }
  | { kind: "call"; fn: FunctionId; args: ExprNode[] }
  /** An imported pure function that does not read the record. */
  | { kind: "helper"; name: string; from: string; args: ExprNode[] }
  | { kind: "quantify"; op: QuantifierId; source: ExprNode; param: string; body: ExprNode }
) & { position: SourcePosition };

export type PlainWhy =
  | "block-body"
  | "run-step"
  | "unsupported-construct"
  | "reads-record-in-helper"
  | "uses-tx"
  | "uses-actions"
  | "unsupported-parameter";

/** Replace `source.slice(from, to)` with `text` to turn the authored function into TypeScript (`&name` to `self.name`, `:atom` to a string). */
export interface SourceEdit {
  from: number;
  to: number;
  text: string;
}

export interface PlainReason {
  why: PlainWhy;
  detail: string;
  position: SourcePosition;
  edits: SourceEdit[];
  /**
   * The scope names (`self`, `input`, `actor`, `context`, `before`, `actions`, `tx`) the authored text reads as variables that its
   * parameters do not bind, `self` included when `&name` stands for `self.name`; the printed function takes these from the scope.
   */
  roots: string[];
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
}

export const FUNCTIONS: readonly FunctionSpec[] = Object.freeze([
  { id: "eq", spelling: "a === b", arity: 2, signature: "(T, T) -> boolean", nulls: "any operand null: unknown" },
  { id: "ne", spelling: "a !== b", arity: 2, signature: "(T, T) -> boolean", nulls: "any operand null: unknown" },
  { id: "isNull", spelling: "a === null", arity: 1, signature: "(any) -> boolean", nulls: "never unknown" },
  { id: "isNotNull", spelling: "a !== null", arity: 1, signature: "(any) -> boolean", nulls: "never unknown" },
  { id: "lt", spelling: "a < b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown" },
  { id: "lte", spelling: "a <= b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown" },
  { id: "gt", spelling: "a > b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown" },
  { id: "gte", spelling: "a >= b", arity: 2, signature: "(number | date, same) -> boolean", nulls: "any operand null: unknown" },
  { id: "and", spelling: "a && b", arity: 2, signature: "(boolean, boolean) -> boolean", nulls: "Kleene" },
  { id: "or", spelling: "a || b", arity: 2, signature: "(boolean, boolean) -> boolean", nulls: "Kleene" },
  { id: "not", spelling: "!a", arity: 1, signature: "(boolean) -> boolean", nulls: "null stays unknown" },
  { id: "add", spelling: "a + b", arity: 2, signature: "(number, number) -> number", nulls: "any operand null: null" },
  { id: "sub", spelling: "a - b", arity: 2, signature: "(number, number) -> number", nulls: "any operand null: null" },
  { id: "mul", spelling: "a * b", arity: 2, signature: "(number, number) -> number", nulls: "any operand null: null" },
  { id: "div", spelling: "a / b (a float or decimal operand)", arity: 2, signature: "(number, number) -> number", nulls: "exact division; any operand null, or a zero divisor: null" },
  { id: "idiv", spelling: "a / b (both integers)", arity: 2, signature: "(integer, integer) -> integer", nulls: "truncates toward zero; any operand null, or a zero divisor: null" },
  { id: "neg", spelling: "-a", arity: 1, signature: "(number) -> number", nulls: "null: null" },
  { id: "length", spelling: "a.length", arity: 1, signature: "(string | list) -> number", nulls: "null string: null; a list is never null" },
  { id: "now", spelling: "now()", arity: 0, signature: "() -> date", nulls: "never null; one instant per scope" },
  { id: "today", spelling: "today()", arity: 0, signature: "() -> date", nulls: "never null; now() at 00:00 UTC" },
  { id: "coalesce", spelling: "a ?? b", arity: 2, signature: "(T, T) -> T", nulls: "a unless a is null, else b" },
  { id: "cond", spelling: "c ? a : b", arity: 3, signature: "(boolean, T, T) -> T", nulls: "unknown test: the else branch" },
] satisfies FunctionSpec[]);

export const FUNCTION_IDS: ReadonlySet<string> = new Set(FUNCTIONS.map((f) => f.id));
export function functionSpec(id: FunctionId): FunctionSpec {
  return FUNCTIONS.find((f) => f.id === id)!;
}
