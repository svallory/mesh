import type { SpannedIr } from "@mxlang/core";
import { rememberEdits, translate, type ConvertContext } from "./expression.ts";
import type {
  Atom,
  Diagnostic,
  Expression,
  Literal,
  SourceEdit,
  MemberRef,
  SourcePosition,
} from "@meshfw/model";

/** One node of the IR body: `lowerSource`'s spanned IR (IR version 2). */
type IrNode = SpannedIr["body"][number];
/** A tag as MX lowered it (`DelegatedTag`); the IR wraps it in a node. */
export type Tag = Extract<IrNode, { kind: "DelegatedTag" }>["tag"];
export type Attr = Tag["attrs"][number];
/** An authored `import` statement; `from` and `names` are optional in MX's types, present on every parsed import. */
export type IrImport = SpannedIr["imports"][number];
/** An attribute that is not a spread: it has a name. */
type Named = Exclude<Attr, { kind: "spread" }>;
type StaticAttr = Extract<Attr, { kind: "static" }>;
type DynamicAttr = Extract<Attr, { kind: "dynamic" }>;

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
  start?: number;
  end?: number;
}
type Span = { sourceStart: number; sourceEnd: number };
export type At = (offset: number) => SourcePosition;
export type ReadResult<T> = { value: T; diagnostic?: never } | { value?: never; diagnostic: Diagnostic };
/** A recoverable tree-read boundary: report the offending tag, not its entity. */
export function readAt<T>(tag: Tag, at: At, read: () => T): ReadResult<T> {
  try { return { value: read() }; }
  catch (cause) {
    return { diagnostic: { severity: "error", code: "MESH_MODEL_SHAPE", message: cause instanceof Error ? cause.message : String(cause), position: at(tag.nameSpan.sourceStart), fix: null } };
  }
}
/** The tags among a node list (`Tag` unwraps MX's `DelegatedTag` node); comments and text are skipped. */
export const tags = (nodes: readonly IrNode[]): Tag[] =>
  nodes.flatMap((n) => (n.kind === "DelegatedTag" ? [n.tag] : []));
export const attr = (tag: Tag, name: string): Attr | undefined =>
  tag.attrs.find((a): a is Named => a.kind !== "spread" && a.name === name);
/**
 * MX folds what its `data` tree called `atom`, `member` and `string` attributes into one
 * `static` kind and tells them apart by `atom` and `member` (a dialect `node`, which Mesh does
 * not register, would be a third). These three read each shape; every other reader goes through them.
 */
/**
 * An atom in value position (`via=:owner`, `on=:create`) is claimed by Mesh's `Atom` node type (alpha.16,
 * `mesh:Atom`), which lowers to the atom-marked literal the expression trigger builds, so the IR holds
 * the same `atom` mark as before and `node` stays unset. Should MX keep the claimed node on the
 * attribute instead (its `Attr.node`, for a node that lowers to a string), it is read here too, so
 * both shapes reach the model as one atom.
 */
export const atomOf = (a: Attr | undefined): StaticAttr["atom"] => {
  if (a?.kind !== "static") return undefined;
  if (a.atom) return a.atom;
  const node = a.node as ({ type: string; name?: unknown; span: unknown } & object) | undefined;
  return node?.type === "mesh:Atom" && typeof node.name === "string"
    ? ({ kind: "atom", name: node.name, span: node.span } as StaticAttr["atom"])
    : undefined;
};
const memberOf = (a: Attr | undefined) => (a?.kind === "static" ? a.member : undefined);
const plainString = (a: Attr | undefined): StaticAttr | undefined =>
  a?.kind === "static" && !a.atom && !a.member && !a.node ? a : undefined;
export const nodeOf = (a: Attr | undefined): SyntaxNode | undefined =>
  a?.kind === "dynamic"
    ? (a.value.node as SyntaxNode | undefined)
    : undefined;
export function attrOffset(a: Attr): number {
  if (a.kind === "dynamic" || a.kind === "bound" || a.kind === "spread")
    return a.value.span.sourceStart;
  if (a.kind === "static") {
    const own = a.atom ?? a.member;
    // `valueSpan` is optional in MX's types; `lowerSource` fills it, and the name is the fallback.
    return (own?.span ?? a.valueSpan ?? a.nameSpan).sourceStart;
  }
  return a.nameSpan.sourceStart;
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
export function valueOf(a: Attr | undefined): Literal | Atom {
  if (!a) throw new Error("This option needs a value");
  const atom = atomOf(a);
  if (atom) return { value: atom.name };
  const text = plainString(a);
  if (text) return text.value;
  if (a.kind === "boolean") return true;
  return readLiteral(nodeOf(a));
}
/** True when an option value is an atom, or holds one anywhere inside a list or object literal. */
export function containsAtom(a: Attr | undefined): boolean {
  if (atomOf(a)) return true;
  const visit = (n: SyntaxNode | null | undefined): boolean => {
    if (!n) return false;
    if (n.type === "StringLiteral") return !!n.extra?.mxAtom;
    if (n.type === "ArrayExpression") return (n.elements ?? []).some(visit);
    if (n.type === "ObjectExpression") return (n.properties ?? []).some((p) => visit(p.value as SyntaxNode | undefined));
    return false;
  };
  return visit(nodeOf(a));
}
export function atomList(a: Attr | undefined): string[] {
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
export function declaredName(tag: Tag): string {
  const atom = atomOf(attr(tag, "name"));
  if (!atom) throw new Error("A declaration name must be an atom");
  return atom.name;
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
export function readMember(a: Attr | undefined, at: At): MemberRef {
  const member = memberOf(a);
  if (member) return { name: member.name, position: at(member.span.sourceStart) };
  const ref = memberNode(nodeOf(a), at);
  if (!ref) throw new Error("Expected a member reference (&name)");
  return ref;
}
export function readMembers(a: Attr | undefined, at: At): MemberRef[] {
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
export function isMemberLine(tag: Tag): boolean {
  return tag.name === "member" && tag.trigger?.id === "member";
}
/** A lowered tagless `&name` / `&name=value` line (see `isMemberLine`). */
export function readMemberLine(
  tag: Tag,
  at: At,
): { ref: MemberRef; value?: Attr } {
  const name = plainString(attr(tag, "name"));
  if (!isMemberLine(tag) || !name)
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
  a: Attr | undefined,
  source: string,
  at: At,
  visit: (ref: MemberRef) => void,
  assign: (assignment: MemberAssignment) => void = () => {},
  convert?: Omit<ConvertContext, "source" | "at">,
): Expression {
  if (a?.kind !== "dynamic")
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
  // Expr.code is printed (`self.x`); the authored text is the span's slice.
  const data: DynamicAttr["value"] = a.value;
  const translated = convert
    ? translate(n, data.span, { ...convert, source, at })
    : {};
  const { edits, ...fields } = translated as { edits?: SourceEdit[] };
  const result: Expression = {
    source: source.slice(data.span.sourceStart, data.span.sourceEnd),
    params,
    position: at(data.span.sourceStart),
    ...fields,
  };
  if (edits) rememberEdits(result, edits);
  return result;
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
