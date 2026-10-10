/**
 * Mesh's `&` member sigil, in all three trigger lists, lowered to four shapes.
 * Ported from MX's reference module `syntax/member.ts` at MX commit
 * `750c80ec1` (decision 183 addendum 6); Mesh owns this copy.
 *
 * - in an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`;
 * - in an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` whose value is `{ kind: "member", name: "dueOn" }`
 *   (a value after it, `&dueOn=1` or `&dueOn(x) { … }`, is refused at the
 *   member);
 * - on a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`. The tag carries `trigger`
 *   (`{ id: "member", span, text }`), which an authored `<member>` lacks.
 *
 * It uses the public hook API only (`Trigger` and the `ctx` constructors) and
 * imports types only.
 */
import type { SourceSpan, Trigger, TriggerContext, TriggerResult } from "@mxlang/core";

/** The member row in all three trigger lists. */
export const MEMBER: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$]*",
  standIn: "identifier",
  node: Object.freeze({ call: "member" }),
});

/** Lowers the `member` row in every position. */
export function lowerMember(text: string, span: SourceSpan, ctx: TriggerContext): TriggerResult {
  const name = text.slice(1);
  switch (ctx.position) {
    case "expression":
      return ctx.expression({
        type: "MemberExpression",
        object: { type: "Identifier", name: "self" },
        property: { type: "Identifier", name },
        computed: false,
        extra: { mxMember: { span, name } },
      });
    case "attribute":
      // After a kind (`sort asc &dueOn`) a member names a field.
      if (ctx.valueForm !== null) ctx.fail(`\`${text}\` is a member reference and takes no value`);
      return ctx.attribute("member", { kind: "member", name, span });
    case "line":
      return ctx.child("member", [
        ctx.attribute("name", name),
        ...(ctx.value ? [ctx.attribute("value", ctx.value)] : []),
      ]);
    default:
      // The member row is registered in no other list.
      return ctx.fail(`\`${text}\` is not allowed here`);
  }
}
