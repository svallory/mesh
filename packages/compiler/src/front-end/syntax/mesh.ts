/**
 * Mesh's syntax: the rows and hooks that `MESH_DIALECT` (`../dialect.ts`) is
 * built from. Ported from MX's reference module `syntax/mesh.ts` at MX commit
 * `750c80ec1` (decision 183 addendum 6; the 2026-10-10 14:30 ruling that Mesh
 * owns all of its syntax). Mesh owns this copy.
 *
 * Rows: `atom` (`:name` in an expression), `atom-value` (`:name` as a whole
 * attribute value, `belongs-to=:List`), `name` (spaced `kind :name`),
 * `member` (`&name`; in an expression it claims a `mesh:Member` node) and
 * `transaction` (`%.now` in an expression; `transaction.ts`, Mesh's own, not
 * ported). One row per first character in
 * each list, so no two rows compete. MX's `#id` and `.class` rows are not
 * carried: Mesh writes neither. The table also turns the tag head's shorthands
 * off (`tagShorthands: false`, MX 0.1.0-alpha.28): a `.` continues the tag
 * name, so a dotted head (`billing.InvoiceVoided`) is one tag, and a `#`, or a
 * head that starts with `.`, is `MESH_NO_TAG_SHORTHAND`.
 *
 * The atom contract checks (`contractFields`, `checkContract`,
 * `afterLower`, `describeAttribute`) are in `atoms-sugars.ts`.
 *
 * It imports types only from `@mxlang/core`'s public entry.
 */
import type { Dialect, NodeType, Trigger } from "@mxlang/core";
import { ATOM, NAME_SUGAR, atomsHooks, checkAtomUse, type AtomNode } from "./atoms-sugars.ts";
import { MEMBER, MEMBER_NODE, Member, checkMemberSlots, lowerMember } from "./member.ts";
import { TRANSACTION, lowerTransaction } from "./transaction.ts";
import { checkFieldOptions } from "./field-options.ts";

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
 * `mesh:Atom`, the node every `:name` is: an expression operand (`atom` row),
 * a whole attribute value (`atom-value` row) and the `name` the `:name` sugar
 * places. It lowers to the string literal of its name, its forward. In an
 * expression it first refuses the uses an atom cannot take (`checkAtomUse`).
 * `lower` returns a fresh literal on every call: core finds the node by its
 * forward's identity, and so do Mesh's readers (`atomForwards` in
 * `front-end/tree.ts`, `atomsIn` in `atoms-sugars.ts`); the literal carries no
 * mark. The schema (MX 0.1.0-alpha.34) lists its one field and both positions
 * it fills: the `atom` row names it in an expression, the value row and the
 * sugar's `ctx.attribute` in value position. `label` is the word core's
 * contract messages show for it (`must be atom, got string`).
 */
const atomValue: NodeType<AtomNode> = {
  keys: [],
  schema: { fields: { name: "data" }, slot: ["expression", "value"] },
  label: "atom",
  parse: (text) => ({ name: text.slice(1) }),
  print: (node) => `:${node.name}`,
  lower: (node, ctx) => {
    if (ctx.position === "expression") checkAtomUse(node, ctx);
    return ctx.expression({
      type: "StringLiteral",
      value: node.name,
      extra: { raw: JSON.stringify(node.name), rawValue: node.name },
    });
  },
};
export const AtomValue: NodeType<AtomNode> = Object.freeze(atomValue);

/** The pieces of Mesh's dialect, minus its identity (`id`, `name`, `tagRules`), which `MESH_DIALECT` sets. */
export const MESH_SYNTAX = {
  table: Object.freeze({
    expressionTriggers: Object.freeze([ATOM, MEMBER_NODE, TRANSACTION]),
    attributeTriggers: Object.freeze([NAME_SUGAR, MEMBER]),
    lineTriggers: Object.freeze([MEMBER]),
    valueTriggers: Object.freeze([ATOM_VALUE]),
    tagShorthands: false,
  }),
  nodeTypes: Object.freeze({ Atom: AtomValue, Member }),
  lowerTrigger(id, text, span, ctx) {
    if (id === MEMBER.id) return lowerMember(text, span, ctx);
    if (id === TRANSACTION.id) return lowerTransaction(text, span, ctx);
    return atomsHooks.lowerTrigger(id, text, span, ctx);
  },
  contractFields: atomsHooks.contractFields,
  checkContract: atomsHooks.checkContract,
  describeAttribute: atomsHooks.describeAttribute,
  afterLower(unit) {
    atomsHooks.afterLower(unit);
    checkMemberSlots(unit);
    checkFieldOptions(unit);
  },
} satisfies Omit<Dialect, "id" | "name" | "tagRules">;
