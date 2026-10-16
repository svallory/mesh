/**
 * Mesh's `%.` sigil: `%` is the current transaction, and `%.now` and `%.today` are its instant and its date,
 * properties, not calls. An expression row only, modeled on the `&name` row (`member.ts`), with `%\.` in front: the match
 * keeps the `.`, so `%`, `%now` and `%.` with no name stay the TypeScript errors they are, and the stand-in is an
 * identifier of the same length, so `%.now.getTime()` reads as a member access on it. Expression rows arm only where an
 * operand is expected, so `a %.now` stays a syntax error, never a modulo by `now`.
 *
 * In an expression `%.now` is a `MemberExpression` of `now` on an identifier `%`, marked `extra.mxTransaction = { span,
 * name }`. The identifier is no JavaScript name on purpose: nothing but the mark gives it a meaning, so a reader that
 * missed the mark could not take it for a variable. The front end reads the mark (`front-end/expression.ts`): it knows
 * the names (`now`, `today`), refuses any other, a call and a write, and gives `%.now` its meaning, the registry's `now`.
 *
 * It uses the public hook API only (`Trigger` and the `ctx` constructors) and imports types only.
 */
import type { SourceSpan, Trigger, TriggerContext, TriggerResult } from "@mxlang/core";

/** The transaction row, in the expression trigger list only. */
export const TRANSACTION: Trigger = Object.freeze({
  id: "transaction",
  chars: "%",
  match: "%\\.[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
  standIn: "identifier",
  node: Object.freeze({ call: "transaction" }),
});

/** What the mark on a lowered `%.name` holds: where the authored `%.name` is, and the name after `%.`. */
export interface TransactionMark {
  readonly span: SourceSpan;
  readonly name: string;
}

/** Lowers the `transaction` row: in an expression, the marked member read. */
export function lowerTransaction(text: string, span: SourceSpan, ctx: TriggerContext): TriggerResult {
  if (ctx.position !== "expression")
    // The row is registered in the expression list only.
    return ctx.fail(`\`${text}\` is not allowed here`, { code: "MESH_SYNTAX" });
  const name = text.slice(2);
  return ctx.expression({
    type: "MemberExpression",
    object: { type: "Identifier", name: "%" },
    property: { type: "Identifier", name },
    computed: false,
    extra: { mxTransaction: { span, name } satisfies TransactionMark },
  });
}
