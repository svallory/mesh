/**
 * Mesh's dialect (MX decisions 202 and 212): the `&` member sigil in all three
 * trigger positions, `:name` atoms and the `kind :name` declaration sugar,
 * lowered to the shapes the front end reads.
 *
 * - In an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`, and `:status` is a
 *   `StringLiteral` marked `extra.mxAtom`.
 * - In an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` carrying `member: { name, span }`; after the kind,
 *   `:name` is a static attribute `name` carrying `atom: { name, span }`.
 * - As a whole attribute value, `:name` (`belongs-to=:List`) is claimed by
 *   the `atom-value` row as a `mesh:Atom` node, which lowers to the same
 *   atom-marked static attribute as an atom elsewhere.
 * - On a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`.
 *
 * Mesh owns all of this syntax (the operator's ruling of 2026-10-10 14:09).
 * The rows, the lowering hooks and the atom contract checks (`values`,
 * `pattern`, `ref`, `declares`) live in `syntax/`, ported from MX's reference
 * module at MX commit `750c80ec1`; from `@mxlang/core` Mesh imports only the
 * public dialect API (types), and `test/architecture.test.ts` fails on any
 * import of `@mxlang/core/syntax`. `MESH_DIALECT` adds the identity: `id` must
 * stay `mesh`, because the `Atom` node says `dialect: "mesh"`. The compiler
 * passes the dialect to `lowerSource`; tools find it through `meshfw`'s
 * `mx.dialect` registration, whose built module re-exports this value.
 *
 * `tagRules: "none"` makes `input`, `script` or `title` an ordinary Mesh tag
 * (`input` is a section of an action). The preset applies when the dialect is
 * passed directly; `test/dialect.test.ts` asserts it.
 */
import type { Dialect } from "@mxlang/core";
import { MESH_SYNTAX } from "./syntax/mesh.ts";

export const MESH_DIALECT: Dialect = Object.freeze({
  id: "mesh",
  name: "Mesh",
  tagRules: "none",
  ...MESH_SYNTAX,
});
