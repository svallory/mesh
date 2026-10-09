/**
 * Mesh's layer-2 syntax module (MX decision 182 addendum 5): the `&` member
 * sigil in all three trigger positions, lowered to the four shapes the
 * compiler reads.
 *
 * - In an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`.
 * - In an attribute list (after a kind, `sort asc &dueOn`), an attribute
 *   `member` of kind `"member"` whose value is `dueOn`.
 * - On a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a `value`.
 * - Atoms are unchanged.
 *
 * Copied from MX's test-only module
 * (`packages/core/src/fixtures/syntax/member-syntax.ts`, MX commit
 * `bc9a87c6c`, shipped as `@mxlang/core` 0.1.0-alpha.13) with `productName`
 * set to "Mesh". The compiler passes it to `parseData` explicitly; nothing
 * names it in `package.json#mx.syntax`.
 */
import type { SyntaxModule, Trigger } from "@mxlang/core";

/** The member row. */
export const MEMBER: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$]*",
  standIn: "identifier",
  node: Object.freeze({ call: "member" }),
});

const memberSyntax = {
  productName: "Mesh",
  table: Object.freeze({
    expressionTriggers: [MEMBER],
    attributeTriggers: [MEMBER],
    lineTriggers: [MEMBER],
  }),
  lowerTrigger(_id, text, span, ctx) {
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
        return ctx.attribute("member", { kind: "member", name, span });
      case "line":
        return ctx.child("member", [
          ctx.attribute("name", name),
          ...(ctx.value ? [ctx.attribute("value", ctx.value)] : []),
        ]);
    }
  },
} satisfies SyntaxModule;

export const MESH_SYNTAX: SyntaxModule = Object.freeze(memberSyntax);
