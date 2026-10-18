/**
 * Mesh's `&` member sigil, in all three trigger lists. Ported from MX's
 * reference module `syntax/member.ts` at MX commit `750c80ec1` (decision 183
 * addendum 6); Mesh owns this copy. Since MX 0.1.0-alpha.34 core has no member
 * vocabulary: a member is a node of Mesh's own type, `mesh:Member` (`Member`
 * below), as an atom is a `mesh:Atom`.
 *
 * - in an expression, `&status` is a `mesh:Member` node listed in
 *   `Expr.nodes`, whose forward (`self.status`, a `MemberExpression`) stands
 *   in its place; a reader finds the member by the forward's identity
 *   (`memberForwards` in `front-end/tree.ts`), never by a mark;
 * - in an attribute list (after a kind, `sort asc &dueOn`), a static
 *   attribute `member` carrying the `mesh:Member` node on `Attr.node`, placed
 *   once per tag (a second is refused at the later one, `MX_INVALID_TRIGGER_USE`,
 *   Mesh's `MESH_SYNTAX`); a value after it, `&dueOn=1` or `&dueOn(x) { … }`,
 *   is refused at the member;
 * - on a tagless line, a `member` child tag with a static `name` and, for
 *   `&amount=expr`, a dynamic `value`. The tag carries `trigger`
 *   (`{ id: "member", span, text }`), which an authored `<member>` lacks.
 *
 * It uses the public hook API only (`Trigger`, `NodeType` and the `ctx`
 * constructors) and imports types only.
 */
import type { ContractExpression, DialectNode, LoweredUnit, NodeType, SourceSpan, Trigger, TriggerContext, TriggerResult } from "@mxlang/core";
import { tagLabel } from "../tag-spelling.ts";

const NAME = "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$]*";

/** The member row in the attribute and line lists: `lowerMember` lowers it. */
export const MEMBER: Trigger = Object.freeze({
  id: "member",
  chars: "&",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ call: "member" }),
});

/** The member row in the expression list: it claims a `mesh:Member` node, which `Member.lower` lowers. */
export const MEMBER_NODE: Trigger = Object.freeze({
  ...MEMBER,
  node: Object.freeze({ type: "Member", dialect: "mesh" }),
});

/** A `mesh:Member`: `&name`, its name without the sigil. */
export interface MemberNode extends DialectNode {
  readonly type: "mesh:Member";
  readonly name: string;
}

/**
 * `mesh:Member`, the node every `&name` is: an expression operand (the
 * `member` expression row) and the `member` attribute the row places after a
 * kind. In an expression it lowers to `self.name`, the record's member; as a
 * whole value to the string literal of its name, the string every target
 * emits. Each call returns a fresh object: core, and Mesh's readers, find the
 * node by its forward's identity. `label` is the word core's contract
 * messages show for it (`must be member, got string`).
 */
const member: NodeType<MemberNode> = {
  keys: [],
  schema: { fields: { name: "data" }, slot: ["expression", "value"] },
  label: "member",
  parse: (text) => ({ name: text.slice(1) }),
  print: (node) => `&${node.name}`,
  lower: (node, ctx) =>
    ctx.position === "expression"
      ? ctx.expression({
          type: "MemberExpression",
          object: { type: "Identifier", name: "self" },
          property: { type: "Identifier", name: node.name },
          computed: false,
        })
      : ctx.expression({
          type: "StringLiteral",
          value: node.name,
          extra: { raw: JSON.stringify(node.name), rawValue: node.name },
        }),
};
export const Member: NodeType<MemberNode> = Object.freeze(member);

/**
 * The message of a second member after one kind (`sort asc &c &d`), at the second. `once` fills only `{written}` (the
 * second member as written) and `{first}` (the first one's `line:column`), so it cannot name the tag; only `asc` and
 * `desc` take a member (`notes/spec/actions.md`: each `asc` and `desc` line takes one member reference).
 */
export const SECOND_MEMBER =
  "a line takes one member reference: `{written}` follows the one at {first}";

/** Lowers the `member` row in the attribute and line lists. */
export function lowerMember(text: string, span: SourceSpan, ctx: TriggerContext): TriggerResult {
  const name = text.slice(1);
  switch (ctx.position) {
    case "attribute":
      // After a kind (`sort asc &dueOn`) a member names a field.
      if (ctx.valueForm !== null) ctx.fail(`\`${text}\` is a member reference and takes no value`, { code: "MESH_SYNTAX" });
      return ctx.attribute("member", { type: "mesh:Member", name, span }, { once: SECOND_MEMBER });
    case "line":
      return ctx.child("member", [
        ctx.attribute("name", name),
        ...(ctx.value ? [ctx.attribute("value", ctx.value)] : []),
      ]);
    default:
      // The `{ call }` row is in no other list; in an expression the node row claims `&name`.
      return ctx.fail(`\`${text}\` is not allowed here`, { code: "MESH_SYNTAX" });
  }
}

/** The expression inside the type wrappers MX lowers away (`x as T`, `x!`, `x satisfies T`, `<T>x`, `(x)`). */
function unwrapped(node: object | null): object | null {
  let current = node as { type?: string; expression?: object } | null;
  while (
    current?.expression &&
    (current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "ParenthesizedExpression")
  )
    current = current.expression as typeof current;
  return current;
}

/**
 * A `mesh:Member` slot (`on:load=&visible`, the `member` a kind places) takes one member and nothing else. Core's
 * node-type check refuses a string, a number, an array, a function or another node, but passes an expression with no
 * type it can know (`load=(&visible && x)`, `load=a.b`), so this hook refuses those: the value is the member node
 * itself, or an expression that is exactly one `mesh:Member`'s forward (`Expr.nodes`). Run from Mesh's `afterLower`.
 */
export function checkMemberSlots(unit: LoweredUnit): void {
  for (const call of unit.calls) {
    for (const attr of call.attrs) {
      if ("spread" in attr || attr.value?.type !== "mx:Expression") continue;
      const declaration = call.contract.attributes?.[attr.name] as { type?: unknown } | undefined;
      if (declaration?.type !== "mesh:Member") continue;
      const expression = attr.value as ContractExpression;
      const [only, ...rest] = expression.nodes ?? [];
      if (only?.type === "mesh:Member" && rest.length === 0 && only.forward === unwrapped(expression.node)) continue;
      unit.fail(`${tagLabel(call.tag)}: option ${attr.label} must be member, got expression`, {
        code: "MESH_OPTION_VALUE",
        ...(expression.span ? { at: expression.span } : {}),
      });
    }
  }
}
