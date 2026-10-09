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
 * The rows and hooks are MX's reference module, `@mxlang/core/syntax/member`
 * (shipped since `@mxlang/core` 0.1.0-alpha.14; Mesh changes no row), with
 * `productName` set to "Mesh". The compiler passes it to `parseData`
 * explicitly; nothing names it in `package.json#mx.syntax`.
 */
import memberSyntax from "@mxlang/core/syntax/member";
import type { SyntaxModule } from "@mxlang/core";

export const MESH_SYNTAX: SyntaxModule = Object.freeze({
  ...memberSyntax,
  productName: "Mesh",
});
