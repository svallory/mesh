import type { DataAttr, DataNode, DataTag } from "@mxlang/data/tree";
import type {
  Atom,
  Diagnostic,
  Expression,
  Literal,
  MemberRef,
  SourcePosition,
} from "@meshfw/model";

/** Small read-only projection of MX's Babel tree, including MX's atom and member marks. */
export interface SyntaxNode {
  type: string;
  name?: string;
  value?: unknown;
  operator?: string;
  argument?: SyntaxNode;
  elements?: (SyntaxNode | null)[];
  properties?: SyntaxNode[];
  key?: SyntaxNode;
  left?: SyntaxNode;
  object?: SyntaxNode;
  params?: SyntaxNode[];
  pattern?: string;
  flags?: string;
  computed?: boolean;
  extra?: { mxAtom?: unknown; mxMember?: { name: string; span: Span } };
  loc?: { start: { index: number } };
}
type Span = { sourceStart: number; sourceEnd: number };
export type At = (offset: number) => SourcePosition;
export type ReadResult<T> = { value: T; diagnostic?: never } | { value?: never; diagnostic: Diagnostic };
/** A recoverable tree-read boundary: report the offending tag, not its entity. */
export function readAt<T>(tag: DataTag, at: At, read: () => T): ReadResult<T> {
  try { return { value: read() }; }
  catch (cause) {
    return { diagnostic: { severity: "error", code: "MESH_MODEL_SHAPE", message: cause instanceof Error ? cause.message : String(cause), position: at(tag.nameSpan.sourceStart), fix: null } };
  }
}
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
  if (a.kind === "atom" || a.kind === "member") return a.span.sourceStart;
  return a.kind === "string" ? a.valueSpan.sourceStart : a.nameSpan.sourceStart;
}
export function readLiteral(n: SyntaxNode | null | undefined): Literal | Atom {
  if (!n) throw new Error("Use a literal value here");
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
        throw new Error("Use literal object properties here");
      Object.defineProperty(result, String(p.key.name ?? p.key.value), {
        value: readLiteral(p.value as SyntaxNode),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  throw new Error("Use a literal value here");
}
export function valueOf(a: DataAttr | undefined): Literal | Atom {
  if (!a) throw new Error("This option needs a value");
  if (a.kind === "atom") return { value: a.value };
  if (a.kind === "string") return a.value;
  if (a.kind === "boolean") return true;
  return readLiteral(nodeOf(a));
}
export function atomList(a: DataAttr | undefined): string[] {
  if (!a) return [];
  const n = nodeOf(a);
  if (n?.type !== "ArrayExpression")
    throw new Error("Use a list of atoms, such as [:create, :update]");
  return (n.elements ?? []).map((e) => {
    if (e?.type !== "StringLiteral" || !e.extra?.mxAtom)
      throw new Error("Each value in this list must be an atom, such as :create");
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
/** A member slot: `{ kind: "member" }` after a kind, or a whole value that is one marked member (`on:load=&visible`). */
export function readMember(a: DataAttr | undefined, at: At): MemberRef {
  if (a?.kind === "member")
    return { name: a.value, position: at(a.span.sourceStart) };
  const ref = memberNode(nodeOf(a), at);
  if (!ref) throw new Error("Expected a member reference (&name)");
  return ref;
}
export function readMembers(a: DataAttr | undefined, at: At): MemberRef[] {
  const n = nodeOf(a);
  if (n?.type !== "ArrayExpression") throw new Error("Use a list of member references, such as [&title]");
  return (n.elements ?? []).map((e) => {
    const ref = memberNode(e, at);
    if (!ref) throw new Error("Expected a member reference (&name)");
    return ref;
  });
}
/**
 * Whether a `member` tag is MX's lowering of a tagless `&name` line through
 * `MESH_SYNTAX`: MX marks a tag a syntax module's hook built with
 * `trigger: { id: "member", … }`. An authored `member name="x"` has no
 * `trigger`; `member` is lowering output, never authored.
 */
export function isMemberLine(tag: DataTag): boolean {
  return tag.name === "member" && tag.trigger?.id === "member";
}
/** A lowered tagless `&name` / `&name=value` line (see `isMemberLine`). */
export function readMemberLine(
  tag: DataTag,
  at: At,
): { ref: MemberRef; value?: DataAttr } {
  const name = attr(tag, "name");
  if (!isMemberLine(tag) || name?.kind !== "string")
    throw new Error("Expected a tagless member line (&name)");
  const value = attr(tag, "value");
  return {
    ref: { name: name.value, position: at(tag.nameSpan.sourceStart) },
    ...(value ? { value } : {}),
  };
}
/** A member written as an assignment target inside an expression (`&a = 1`, `&a++`). */
export interface MemberAssignment {
  ref: MemberRef;
  position: SourcePosition;
}
export function expression(
  a: DataAttr | undefined,
  source: string,
  at: At,
  visit: (ref: MemberRef) => void,
  assign: (assignment: MemberAssignment) => void = () => {},
): Expression {
  if (a?.kind !== "expression")
    throw new Error("This declaration needs a function body");
  const n = nodeOf(a);
  if (!n || !["ArrowFunctionExpression", "FunctionExpression"].includes(n.type))
    throw new Error("This declaration needs a function body");
  walkMembers(n, at, visit, assign);
  const params = (n.params ?? []).flatMap((p) =>
    p.type === "ObjectPattern"
      ? (p.properties ?? []).flatMap((property) =>
          property.key?.name ? [property.key.name] : [],
        )
      : [],
  );
  // DataExpr.code is printed (`self.x`); the authored text is the span's slice.
  const data = a.value;
  return {
    source: source.slice(data.span.sourceStart, data.span.sourceEnd),
    params,
    position: at(data.span.sourceStart),
  };
}
/** The members an assignment or update writes to or through (`&a`, `&a.b`,
 * `&a[0]`), from MX's marks only: the target's member-access root is marked. */
function assignedMembers(target: SyntaxNode | undefined): SyntaxNode[] {
  if (!target) return [];
  let root = target;
  while (!root.extra?.mxMember && (root.type === "MemberExpression" || root.type === "OptionalMemberExpression") && root.object)
    root = root.object;
  if (root.extra?.mxMember) return [root];
  if (target.type === "ArrayPattern")
    return (target.elements ?? []).flatMap((e) => assignedMembers(e ?? undefined));
  if (target.type === "ObjectPattern")
    return (target.properties ?? []).flatMap((p) => assignedMembers((p.value ?? p.argument) as SyntaxNode | undefined));
  if (target.type === "RestElement" || target.type === "AssignmentPattern")
    return assignedMembers(target.argument ?? target.left);
  return [];
}
function walkMembers(
  value: unknown,
  at: At,
  visit: (ref: MemberRef) => void,
  assign: (assignment: MemberAssignment) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v) => walkMembers(v, at, visit, assign));
    return;
  }
  const n = value as SyntaxNode;
  const ref = memberNode(n, at);
  if (ref) visit(ref);
  const target =
    n.type === "AssignmentExpression" ? n.left
    : n.type === "UpdateExpression" ? n.argument
    : n.type === "ForInStatement" || n.type === "ForOfStatement" ? n.left
    : undefined;
  for (const written of assignedMembers(target)) {
    const mark = written.extra!.mxMember!;
    assign({
      ref: { name: mark.name, position: at(mark.span.sourceStart) },
      position: at(n.loc?.start.index ?? mark.span.sourceStart),
    });
  }
  for (const [key, child] of Object.entries(value))
    if (key !== "extra" && key !== "loc") walkMembers(child, at, visit, assign);
}
