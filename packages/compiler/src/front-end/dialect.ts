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
 * public dialect API (types), and `test/no-core-syntax-import.test.ts` fails on
 * any import of core's `syntax` modules. `MESH_DIALECT` adds the identity: `id` must
 * stay `mesh`, because the `Atom` node says `dialect: "mesh"`. The compiler
 * passes the dialect to `lowerSource`; tools find it through `meshfw`'s
 * `mx.dialect` registration, whose built module re-exports this value.
 *
 * `contracts`, `structural`, `unknownTags` and `imports` are the dialect's own fields (MX 0.1.0-alpha.21), so a caller passes none
 * of them to `lowerSource` and the editor checks a Mesh file exactly as the CLI does. `meshfw`'s manifest closes the
 * file to the project's `mx.tags`, `mx.contracts` and `tags/` and reserves the vocabulary (`mx.dialect` in
 * `packages/cli/package.json`).
 *
 * `tagRules: "none"` makes `input`, `script` or `title` an ordinary Mesh tag
 * (`input` is a section of an action). The preset applies when the dialect is
 * passed directly; `test/dialect.test.ts` asserts it.
 */
import type { Dialect, UnknownTag, UnknownTagExplanation } from "@mxlang/core";
import { MESH_SYNTAX } from "./syntax/mesh.ts";
import MESH_CONTRACTS from "./contracts.ts";

/** The message, from the tag name alone: `uuid:id` is written `uuid :id`; `:x` has no kind, the parent's default tag names it. */
function unspacedMessage(name: string, defaultTag: string | undefined): string {
  const colon = name.indexOf(":");
  const kind = name.slice(0, colon);
  if (kind === "") {
    if (defaultTag === undefined)
      return `\`${name}\` is a name with no tag before it; Mesh writes a tag, a space, then the name: \`kind ${name}\``;
    return `\`${name}\` writes the name against the tag; Mesh writes a name after a space: \`${defaultTag} ${name}\``;
  }
  return `\`${name}\` writes the name against the tag; Mesh writes a name after a space: \`${kind} ${name.slice(colon)}\``;
}

/**
 * Since MX 0.1.0-alpha.17 a colon in a tag head is part of the tag name (`uuid:id`, `<string:title/>`, `entity:Todo`,
 * `<:x/>`), so such a tag is an unknown tag to MX. Mesh's error replaces MX's for it, since a line is `kind :name`.
 * Every other unknown tag keeps MX's own error (`undefined`). `Dialect.explainUnknownTag` is `@unstable` in MX
 * (MX #511). The error sits at the tag name, as MX's does.
 */
function explainUnknownTag(tag: UnknownTag): UnknownTagExplanation | undefined {
  if (!tag.name.includes(":")) return undefined;
  const parent = tag.ancestors[tag.ancestors.length - 1];
  return {
    message: unspacedMessage(tag.name, parent?.contract?.defaultTag),
    code: "MESH_UNSPACED_NAME",
    at: tag.nameSpan,
  };
}

export const MESH_DIALECT: Dialect = Object.freeze({
  id: "mesh",
  name: "Mesh",
  tagRules: "none",
  // Mesh's vocabulary. `Dialect.contracts` is `@unstable` in MX (alpha.21). Every file of the dialect is checked against it, in the
  // compiler and in every tool, so `lowerSource` is never given `customTags`.
  contracts: MESH_CONTRACTS,
  // How strict Mesh files are: the one place these are stated (a caller's option would override them).
  structural: "reject",
  unknownTags: "reject",
  imports: "pass",
  ...MESH_SYNTAX,
  explainUnknownTag,
});
