import type { DataAttr, DataExpr, DataNode, DataTag } from "@mxlang/data/tree";
import type {
  Atom,
  Expression,
  Literal,
  MemberRef,
  SourcePosition,
} from "@mesh/model";

/** Small read-only projection of MX's Babel tree, including future member marks. */
export interface SyntaxNode {
  type: string;
  name?: string;
  value?: unknown;
  operator?: string;
  argument?: SyntaxNode;
  elements?: (SyntaxNode | null)[];
  properties?: SyntaxNode[];
  key?: SyntaxNode;
  params?: SyntaxNode[];
  pattern?: string;
  flags?: string;
  computed?: boolean;
  extra?: { mxAtom?: unknown; mxMember?: { name: string; span: Span } };
  loc?: { start: { index: number } };
}
type Span = { sourceStart: number; sourceEnd: number };
/** realignment-1 addendum #2, field names confirmed by MX: a sibling of atom.
 * Remove this local extension once the published DataAttr union includes it. */
export interface MemberAttribute {
  kind: "member";
  name: string;
  value: string;
  nameSpan?: Span;
  span: Span;
}
export type At = (offset: number) => SourcePosition;
export const tags = (nodes: readonly DataNode[]): DataTag[] =>
  nodes.filter((n): n is DataTag => n.kind === "tag");
export const attr = (tag: DataTag, name: string): DataAttr | undefined =>
  tag.attrs.find((a) => a.kind !== "spread" && a.name === name);
export const nodeOf = (a: DataAttr | undefined): SyntaxNode | undefined =>
  a?.kind === "expression"
    ? (a.value.node as SyntaxNode | undefined)
    : undefined;
export function attrOffset(a: DataAttr): number {
  if (a.kind === "expression" || a.kind === "spread")
    return a.value.span.sourceStart;
  if (a.kind === "atom") return a.span.sourceStart;
  return a.kind === "string" ? a.valueSpan.sourceStart : a.nameSpan.sourceStart;
}
export function readLiteral(n: SyntaxNode | null | undefined): Literal | Atom {
  if (!n) throw new Error("Missing literal node");
  if (n.type === "StringLiteral")
    return n.extra?.mxAtom ? { value: String(n.value) } : String(n.value);
  if (n.type === "NumericLiteral" || n.type === "BooleanLiteral")
    return n.value as number | boolean;
  if (n.type === "NullLiteral") return null;
  if (
    n.type === "UnaryExpression" &&
    n.operator === "-" &&
    n.argument?.type === "NumericLiteral"
  )
    return -Number(n.argument.value);
  if (n.type === "ArrayExpression")
    return (n.elements ?? []).map(readLiteral) as Literal[];
  if (n.type === "ObjectExpression") {
    const result: { [key: string]: Literal } = {};
    for (const p of n.properties ?? []) {
      if (p.type !== "ObjectProperty" || p.computed || !p.key)
        throw new Error("Expected literal object properties");
      Object.defineProperty(result, String(p.key.name ?? p.key.value), {
        value: readLiteral(p.value as SyntaxNode),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  throw new Error(`Expected a literal, got ${n.type}`);
}
export function valueOf(a: DataAttr | undefined): Literal | Atom {
  if (!a) throw new Error("Missing attribute");
  if (a.kind === "atom") return { value: a.value };
  if (a.kind === "string") return a.value;
  if (a.kind === "boolean") return true;
  return readLiteral(nodeOf(a));
}
export function atomList(a: DataAttr | undefined): string[] {
  if (!a) return [];
  const n = nodeOf(a);
  if (n?.type !== "ArrayExpression")
    throw new Error("Expected a list of atoms");
  return (n.elements ?? []).map((e) => {
    if (e?.type !== "StringLiteral" || !e.extra?.mxAtom)
      throw new Error("Expected an atom in list");
    return String(e.value);
  });
}
export function declaredName(tag: DataTag): string {
  const a = attr(tag, "name");
  if (a?.kind !== "atom") throw new Error("A declaration name must be an atom");
  return a.value;
}
export function memberNode(
  n: SyntaxNode | null | undefined,
  at: At,
): MemberRef | undefined {
  const mark = n?.extra?.mxMember;
  return n?.type === "MemberExpression" && mark
    ? { name: mark.name, position: at(mark.span.sourceStart) }
    : undefined;
}
/** MX lang-ext-syntax-table: after-kind `member` value, or a marked self.x expression. */
export function readMember(
  a: DataAttr | MemberAttribute | undefined,
  at: At,
): MemberRef {
  if (a?.kind === "member")
    return { name: a.value, position: at(a.span.sourceStart) };
  const ref = memberNode(nodeOf(a), at);
  if (!ref) throw new Error("Expected a member reference (&name)");
  return ref;
}
export function readMembers(a: DataAttr | undefined, at: At): MemberRef[] {
  const n = nodeOf(a);
  if (n?.type !== "ArrayExpression") throw new Error("Expected a member list");
  return (n.elements ?? []).map((e) => {
    const ref = memberNode(e, at);
    if (!ref) throw new Error("Expected a member reference (&name)");
    return ref;
  });
}
/** MX lang-ext-syntax-table: provisional accidental &title tags are read ONLY
 * here, alongside the promised member {name, value?} line-trigger shape. */
export function readMemberLine(
  tag: DataTag,
  at: At,
): { ref: MemberRef; value?: DataAttr; options: boolean } {
  const name = attr(tag, "name");
  const provisional = /^&([A-Za-z_][A-Za-z0-9_]*)$/.exec(tag.name);
  const text =
    provisional?.[1] ??
    (tag.name === "member" && name?.kind === "string" ? name.value : undefined);
  if (!text) throw new Error("Expected a tagless member line (&name)");
  const value = attr(tag, "value");
  return {
    ref: { name: text, position: at(tag.nameSpan.sourceStart) },
    ...(value ? { value } : {}),
    options:
      tag.attrs.some(
        (a) =>
          a.kind === "spread" ||
          (a.name !== "value" && !(tag.name === "member" && a.name === "name")),
      ) || !!tag.children.length,
  };
}
export function expression(
  a: DataAttr | undefined,
  source: string,
  at: At,
  visit: (ref: MemberRef) => void,
): Expression {
  if (a?.kind !== "expression")
    throw new Error("Expected a function expression");
  const n = nodeOf(a);
  if (!n || !["ArrowFunctionExpression", "FunctionExpression"].includes(n.type))
    throw new Error("Expected a function expression");
  walkMembers(n, at, visit);
  const params = (n.params ?? []).flatMap((p) =>
    p.type === "ObjectPattern"
      ? (p.properties ?? []).flatMap((property) =>
          property.key?.name ? [property.key.name] : [],
        )
      : [],
  );
  // alpha.11 uses spans; the layer-2 contract additionally promises authored text.
  const data = a.value as DataExpr & { text?: string };
  return {
    source:
      data.text ?? source.slice(data.span.sourceStart, data.span.sourceEnd),
    params,
    position: at(data.span.sourceStart),
  };
}
function walkMembers(
  value: unknown,
  at: At,
  visit: (ref: MemberRef) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v) => walkMembers(v, at, visit));
    return;
  }
  const n = value as SyntaxNode;
  const ref = memberNode(n, at);
  if (ref) visit(ref);
  for (const [key, child] of Object.entries(value))
    if (key !== "extra" && key !== "loc") walkMembers(child, at, visit);
}
