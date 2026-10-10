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
 * - On a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`.
 *
 * The rows, the hooks and the atom contract checks (`values`, `pattern`, `ref`,
 * `declares`) are MX's combined reference dialect, `@mxlang/core/syntax/mesh`
 * (alpha.15). MX ships it as built JavaScript only, so Mesh wraps it instead of
 * copying the source: the wrapper gives it Mesh's identity and tag rules and
 * drops the `#id` and `.class` sugar rows, which Mesh writes nowhere. Nothing
 * in `package.json#mx` selects it: the compiler passes it to `lowerSource`.
 *
 * `tagRules: "none"` makes `input`, `script` or `title` an ordinary Mesh tag
 * (`input` is a section of an action). The preset applies when the dialect is
 * passed directly; `test/dialect.test.ts` asserts it.
 */
import meshReference from "@mxlang/core/syntax/mesh";
import type { Dialect } from "@mxlang/core";

/** The shorthand rows Mesh does not use: `#id` and `.class`. */
const DROPPED_ROWS = new Set(["id", "class"]);

const withoutShorthands = <Row extends { id: string }>(rows: readonly Row[] | undefined) =>
  rows && Object.freeze(rows.filter((row) => !DROPPED_ROWS.has(row.id)));

export const MESH_DIALECT: Dialect = Object.freeze({
  ...meshReference,
  id: "mesh",
  name: "Mesh",
  tagRules: "none",
  table: Object.freeze({
    ...meshReference.table,
    attributeTriggers: withoutShorthands(meshReference.table.attributeTriggers),
  }),
});
