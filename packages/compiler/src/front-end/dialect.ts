/**
 * Mesh's dialect (MX decisions 202 and 212): the `&` member sigil in all three
 * trigger positions, `:name` atoms and the `kind :name` declaration sugar,
 * lowered to the shapes the front end reads.
 *
 * - In an expression, `&status` is `self.status`, a `MemberExpression`
 *   marked `extra.mxMember = { span, name }`, and `:status` is a
 *   `mesh:Atom` node listed in `Expr.nodes`, whose forward (the `StringLiteral`
 *   of its name) stands in its place in the expression.
 * - In an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` carrying `member: { name, span }`; after the kind,
 *   `:name` is a static attribute `name` carrying `node: { type: "mesh:Atom", name, span }`.
 * - As a whole attribute value, `:name` (`belongs-to=:List`) is claimed by
 *   the `atom-value` row as a `mesh:Atom` node, which lowers to the same
 *   static attribute, carrying the node on `node`, as the name sugar's.
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
 * `contracts`, `structural`, `unknownTags` and `imports` are the dialect's own fields (since MX 0.1.0-alpha.21), so a caller passes none
 * of them to `lowerSource` and the editor checks a Mesh file exactly as the CLI does. `meshfw`'s manifest closes the
 * file to the project's `mx.tags`, `mx.contracts` and `tags/` and reserves the vocabulary (`mx.dialect` in
 * `packages/cli/package.json`).
 *
 * `tagRules: "none"` makes `input`, `script` or `title` an ordinary Mesh tag
 * (`input` is a section of an action). The preset applies when the dialect is
 * passed directly; `test/dialect.test.ts` asserts it.
 *
 * `diagnosticCodes` (MX 0.1.0-alpha.27) renames MX's codes to Mesh's on every Mesh file, in the
 * compiler and in every tool: `MX_UNKNOWN_TAG` is `MESH_UNKNOWN_TAG` (`diagnostic-codes.ts`).
 *
 * `messageVocabulary` (MX 0.1.0-alpha.29) puts MX's messages in Mesh's words: an option, a Mesh file, a tag
 * spelled as its line is written (lead, MX-05).
 *
 * The syntax table sets `tagShorthands: false` (MX 0.1.0-alpha.28, `syntax/mesh.ts`): a line head has no `#id` or
 * `.class` shorthand, a `.` continues the tag name, and `#x`, `.x` or a `#` inside a head is `MESH_NO_TAG_SHORTHAND`.
 */
import type { Dialect, MessageVocabulary, UnknownTag, UnknownTagExplanation } from "@mxlang/core";
import { MESH_SYNTAX } from "./syntax/mesh.ts";
import MESH_CONTRACTS from "./contracts.ts";
import { MX_TO_MESH_CODES } from "./diagnostic-codes.ts";
import { deepFreeze } from "./deep-freeze.ts";
import { formatTag } from "./tag-spelling.ts";

export { formatTag };

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

/**
 * MX's words in its messages about a Mesh file (`Dialect.messageVocabulary`, `@unstable`, MX alpha.29, reworded in alpha.30).
 * A `key=value` is an option, since an attribute is an entity's data member; MX's "data file" is a "Mesh file".
 * `tree` is unset: since alpha.30 no message reads it. `file` is a string, whose plural is the string plus "s", so the static-file
 * messages read "Mesh files are static, so they do not evaluate `if`".
 */
export const MESH_MESSAGE_VOCABULARY: MessageVocabulary = {
  attribute: { one: "option", many: "options", article: "an" },
  file: "Mesh file",
  formatTag,
};

export const MESH_DIALECT: Dialect = deepFreeze({
  id: "mesh",
  name: "Mesh",
  tagRules: "none",
  // Mesh's vocabulary. `Dialect.contracts` is `@unstable` in MX (alpha.22). Every file of the dialect is checked against it, in the
  // compiler and in every tool, so `lowerSource` is never given `customTags`.
  contracts: MESH_CONTRACTS,
  // How strict Mesh files are: the one place these are stated (a caller's option would override them).
  structural: "reject",
  unknownTags: "reject",
  imports: "pass",
  // MX's codes as Mesh's. `Dialect.diagnosticCodes` is `@unstable` in MX (alpha.27).
  diagnosticCodes: MX_TO_MESH_CODES,
  // MX's words in its messages: `option`, `Mesh file`, tags spelled as written. `@unstable` in MX (alpha.29).
  messageVocabulary: MESH_MESSAGE_VOCABULARY,
  ...MESH_SYNTAX,
  explainUnknownTag,
});
