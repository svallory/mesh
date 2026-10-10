/**
 * Mesh's syntax: the rows and hooks that `MESH_DIALECT` (`../dialect.ts`) is
 * built from. Ported from MX's reference module `syntax/mesh.ts` at MX commit
 * `750c80ec1` (decision 183 addendum 6; the 2026-10-10 14:30 ruling that Mesh
 * owns all of its syntax). Mesh owns this copy.
 *
 * Rows: `atom` (`:name` in an expression), `atom-value` (`:name` as a whole
 * attribute value, `belongs-to=:List`), `name` (spaced `kind :name`) and
 * `member` (`&name`). One row per first character in each list, so the
 * atom and member rows never compete. MX's `#id` and `.class` rows are not
 * carried: Mesh writes neither.
 *
 * The atom contract checks (`contractFields`, `checkContract`,
 * `afterLower`, `describeAttribute`) are in `atoms-sugars.ts`.
 *
 * It imports types only from `@mxlang/core`'s public entry.
 */
import type { Dialect, DialectNode, NodeType, Trigger } from "@mxlang/core";
import { ATOM, NAME_SUGAR, atomsHooks } from "./atoms-sugars.ts";
import { MEMBER, lowerMember } from "./member.ts";

/** A whole attribute value `:name`, claimed in the value position. */
interface Atom extends DialectNode {
  readonly name: string;
}

/**
 * `:name` as a whole attribute value: the value row claims it as a
 * `mesh:Atom`. `::x` is left to the `atom` expression row, whose error
 * names it reserved. A claimed default value ends where a spaced `:name`
 * starts, so `belongs-to=:List :list` is the default `:List` and the name
 * `:list`.
 */
export const ATOM_VALUE: Trigger = Object.freeze({
  id: "atom-value",
  chars: ":",
  match: ":[A-Za-z_$][\\w$]*(?:-[\\w$]+)*",
  standIn: "keep",
  node: Object.freeze({ type: "Atom", dialect: "mesh" }),
});

/**
 * Lowers to the literal the `atom` expression row builds (a `StringLiteral`
 * marked `extra.mxAtom`), so the attribute keeps its atom mark and the atom
 * contracts read it as before. A plain string would drop the mark.
 */
const atomValue: NodeType<Atom> = {
  keys: [],
  parse: (text) => ({ name: text.slice(1) }),
  print: (node) => `:${node.name}`,
  lower: (node, ctx) =>
    ctx.expression({
      type: "StringLiteral",
      value: node.name,
      extra: {
        raw: JSON.stringify(node.name),
        rawValue: node.name,
        mxAtom: { span: node.span },
      },
    }),
};
export const AtomValue: NodeType<Atom> = Object.freeze(atomValue);

/** The pieces of Mesh's dialect, minus its identity (`id`, `name`, `tagRules`), which `MESH_DIALECT` sets. */
export const MESH_SYNTAX = {
  table: Object.freeze({
    expressionTriggers: Object.freeze([ATOM, MEMBER]),
    attributeTriggers: Object.freeze([NAME_SUGAR, MEMBER]),
    lineTriggers: Object.freeze([MEMBER]),
    valueTriggers: Object.freeze([ATOM_VALUE]),
  }),
  nodeTypes: Object.freeze({ Atom: AtomValue }),
  lowerTrigger(id, text, span, ctx) {
    return id === MEMBER.id ? lowerMember(text, span, ctx) : atomsHooks.lowerTrigger(id, text, span, ctx);
  },
  contractFields: atomsHooks.contractFields,
  checkContract: atomsHooks.checkContract,
  describeAttribute: atomsHooks.describeAttribute,
  afterLower: atomsHooks.afterLower,
} satisfies Omit<Dialect, "id" | "name" | "tagRules">;
