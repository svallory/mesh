import type { SpannedIr } from "@mxlang/core";
import type { AtomNode } from "./syntax/atoms-sugars.ts";
import type { MemberNode } from "./syntax/member.ts";
import { asynchronyOfFunction, rememberAskCalls, rememberAsynchrony, rememberDemotion, rememberPrivilegedCalls, translate, type ConvertContext, type Demotion } from "./expression.ts";
import type {
  Atom,
  Diagnostic,
  Expression,
  Literal,
  SourceEdit,
  MemberRef,
  SourcePosition,
} from "@meshfw/model";

/** One node of the IR body: `lowerSource`'s spanned IR (IR version 8). */
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

/** Small read-only projection of MX's Babel tree, including the transaction mark Mesh's `%.` row sets. */
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
  extra?: { mxTransaction?: { name: string; span: Span } };
  loc?: { start: { index: number } };
  start?: number;
  end?: number;
}
type Span = { sourceStart: number; sourceEnd: number };
/**
 * The atoms an expression holds: each `mesh:Atom` node's forward (the `StringLiteral` that stands in its place in
 * `Expr.node`) with the node's span. MX lists a file's dialect nodes in `Expr.nodes` (since IR version 6), and a reader
 * finds one by the forward's identity: no mark is set on it.
 */
export type AtomForwards = ReadonlyMap<object, Span>;
const NO_ATOMS: AtomForwards = new Map();
/** The atoms of an attribute's expression (`AtomForwards`); none for a static, boolean or missing attribute. */
export function atomForwards(a: Attr | undefined): AtomForwards {
  if (!a || (a.kind !== "dynamic" && a.kind !== "bound" && a.kind !== "spread")) return NO_ATOMS;
  const atoms = new Map<object, Span>();
  for (const each of a.value.nodes ?? []) if (each.type === "mesh:Atom") atoms.set(each.forward as object, each.span);
  return atoms;
}
/** Where a member is written and its name: `&name`, without the sigil. */
export interface MemberMark { readonly name: string; readonly span: Span }
/**
 * The members an expression holds: each `mesh:Member` node's forward (the `self.name` `MemberExpression` that stands in
 * its place in `Expr.node`) with the node's name and span, from `Expr.nodes` (MX 0.1.0-alpha.34, IR version 7: core
 * has no members and reads no mark). A reader finds a member by the forward's identity, as an atom.
 */
export type MemberForwards = ReadonlyMap<object, MemberMark>;
const NO_MEMBERS: MemberForwards = new Map();
/** The members of an attribute's expression (`MemberForwards`); none for a static, boolean or missing attribute. */
export function memberForwards(a: Attr | undefined): MemberForwards {
  if (!a || (a.kind !== "dynamic" && a.kind !== "bound" && a.kind !== "spread")) return NO_MEMBERS;
  const members = new Map<object, MemberMark>();
  for (const each of a.value.nodes ?? [])
    if (each.type === "mesh:Member") members.set(each.forward as object, { name: (each.node as MemberNode).name, span: each.span });
  return members;
}
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
 * An atom in value position (`inverse=:owner`, `on=:create`, and the `name` the `:name` sugar places) is
 * claimed by Mesh's own `Atom` node type (`mesh:Atom`, `syntax/mesh.ts`). It lowers to the string literal of its
 * name, and the static attribute carries the node on `Attr.node`. An atom inside an expression (`values=[:a, :b]`) is
 * one of the expression's `Expr.nodes` (`atomForwards`).
 *
 * MX folds what its `data` tree called `atom`, `member` and `string` attributes into one `static` kind and
 * tells them apart by `node`: a `mesh:Atom`, or the `mesh:Member` a member after a kind places
 * (`sort asc &dueOn`). `atomOf`, `memberOf` and `plainString` read each shape; every other reader goes through
 * them.
 */
export const atomOf = (a: Attr | undefined): AtomNode | undefined =>
  a?.kind === "static" && a.node?.type === "mesh:Atom" ? (a.node as AtomNode) : undefined;
const memberOf = (a: Attr | undefined): MemberNode | undefined =>
  a?.kind === "static" && a.node?.type === "mesh:Member" ? (a.node as MemberNode) : undefined;
const plainString = (a: Attr | undefined): StaticAttr | undefined =>
  a?.kind === "static" && !a.node ? a : undefined;
/** The text of a plain string option (`message="..."`), or `undefined` when the option is anything else (a function, an atom, a number). */
export const textOf = (a: Attr | undefined): string | undefined => {
  const text = plainString(a);
  return text ? String(text.value) : undefined;
};
export const nodeOf = (a: Attr | undefined): SyntaxNode | undefined =>
  a?.kind === "dynamic"
    ? (a.value.node as SyntaxNode | undefined)
    : undefined;
export function attrOffset(a: Attr): number {
  if (a.kind === "dynamic" || a.kind === "bound" || a.kind === "spread")
    return a.value.span.sourceStart;
  if (a.kind === "static") {
    const own = atomOf(a) ?? memberOf(a);
    // `valueSpan` is optional in MX's types; `lowerSource` fills it, and the name is the fallback.
    return (own?.span ?? a.valueSpan ?? a.nameSpan).sourceStart;
  }
  return a.nameSpan.sourceStart;
}
/** A literal value; `atoms` names the string literals that are atoms (`atomForwards` of the attribute that holds `n`). */
export function readLiteral(n: SyntaxNode | null | undefined, atoms: AtomForwards = NO_ATOMS): Literal | Atom {
  if (!n) throw new Error("Use a literal value here");
  if (n.type === "StringLiteral")
    return atoms.has(n) ? { value: String(n.value) } : String(n.value);
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
    return (n.elements ?? []).map((e) => readLiteral(e, atoms)) as Literal[];
  if (n.type === "ObjectExpression") {
    const result: { [key: string]: Literal } = {};
    for (const p of n.properties ?? []) {
      if (p.type !== "ObjectProperty" || p.computed || !p.key)
        throw new Error("Use literal object properties here");
      Object.defineProperty(result, String(p.key.name ?? p.key.value), {
        value: readLiteral(p.value as SyntaxNode, atoms),
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
  return readLiteral(nodeOf(a), atomForwards(a));
}
/** True when an option value is an atom, or holds one anywhere inside a list or object literal. */
export function containsAtom(a: Attr | undefined): boolean {
  if (atomOf(a)) return true;
  const atoms = atomForwards(a);
  const visit = (n: SyntaxNode | null | undefined): boolean => {
    if (!n) return false;
    if (n.type === "StringLiteral") return atoms.has(n);
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
  const atoms = atomForwards(a);
  return (n.elements ?? []).map((e) => {
    if (e?.type !== "StringLiteral" || !atoms.has(e))
      throw new Error("Each value in this list must be an atom, such as :create");
    return String(e.value);
  });
}
export function declaredName(tag: Tag): string {
  const atom = atomOf(attr(tag, "name"));
  if (!atom) throw new Error("A declaration name must be an atom");
  return atom.name;
}
/** The member `n` is, when it is one of `members` (a `mesh:Member`'s forward). */
export function memberNode(
  n: SyntaxNode | null | undefined,
  at: At,
  members: MemberForwards,
): MemberRef | undefined {
  const mark = n ? members.get(n) : undefined;
  return mark ? { name: mark.name, position: at(mark.span.sourceStart) } : undefined;
}
/** A member slot: the `mesh:Member` a kind places (`sort asc &dueOn`), or a whole value that is one member (`on:load=&visible`). */
export function readMember(a: Attr | undefined, at: At): MemberRef {
  const member = memberOf(a);
  if (member) return { name: member.name, position: at(member.span.sourceStart) };
  const ref = memberNode(nodeOf(a), at, memberForwards(a));
  if (!ref) throw new Error("Expected a member reference (&name)");
  return ref;
}
/** A rollup's `of=&lines.amount`: a member and the plain property accesses after it, each with its position (no whitespace inside, so offsets add up). */
export function readMemberPath(a: Attr | undefined, at: At): MemberRef[] {
  const names: string[] = [];
  const members = memberForwards(a);
  let cursor = nodeOf(a) as (SyntaxNode & { property?: SyntaxNode }) | undefined;
  while (cursor && !members.has(cursor)) {
    if (cursor.type !== "MemberExpression" || cursor.computed || cursor.property?.type !== "Identifier") throw new Error("Expected a member reference (&relationship.attribute)");
    names.unshift(cursor.property.name!);
    cursor = cursor.object as typeof cursor;
  }
  const root = cursor ? members.get(cursor) : undefined;
  if (!root) throw new Error("Expected a member reference (&relationship.attribute)");
  let offset = root.span.sourceStart + 1 + root.name.length;
  return [
    { name: root.name, position: at(root.span.sourceStart) },
    ...names.map((name) => {
      const ref = { name, position: at(offset + 1) };
      offset += name.length + 1;
      return ref;
    }),
  ];
}
export function readMembers(a: Attr | undefined, at: At): MemberRef[] {
  const n = nodeOf(a);
  if (n?.type !== "ArrayExpression") throw new Error("Use a list of member references, such as [&title]");
  const members = memberForwards(a);
  return (n.elements ?? []).map((e) => {
    const ref = memberNode(e, at, members);
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
  convert?: Omit<ConvertContext, "source" | "at" | "atoms" | "members">,
): Expression {
  if (a?.kind !== "dynamic")
    throw new Error("This declaration needs a function body");
  const n = nodeOf(a);
  if (!n || !["ArrowFunctionExpression", "FunctionExpression"].includes(n.type))
    throw new Error("This declaration needs a function body");
  const members = memberForwards(a);
  walkMembers(n, at, visit, assign, members);
  const params = (n.params ?? []).flatMap((p) =>
    p.type === "ObjectPattern"
      ? (p.properties ?? []).flatMap((property) =>
          property.key?.name ? [property.key.name] : [],
        )
      : [],
  );
  // A pattern with a rest element, or a plain parameter (`(s) => s.self.x`), can reach any name in the scope.
  const rest = (n.params ?? []).some((p) => p.type !== "ObjectPattern" || (p.properties ?? []).some((property) => !property.key?.name));
  // Expr.code is the authored text with the triggers spliced in (`&title` lowered to its stand-in), and only a method shorthand's is printed; the model's `source` is the span's slice of the file.
  const data: DynamicAttr["value"] = a.value;
  const translated = convert
    ? translate(n, data.span, { ...convert, source, at, atoms: atomForwards(a), members })
    : {};
  const { demotion, privilegedCalls, askCalls, ...fields } = translated as { demotion?: Demotion; privilegedCalls?: SourcePosition[]; askCalls?: SourcePosition[] };
  const result: Expression = {
    source: source.slice(data.span.sourceStart, data.span.sourceEnd),
    params,
    ...(rest ? { rest: true as const } : {}),
    ...((n.params ?? []).length && !params.length ? { takesScope: true as const } : {}),
    position: at(data.span.sourceStart),
    ...fields,
  };
  if (demotion) rememberDemotion(result, demotion);
  if (privilegedCalls) rememberPrivilegedCalls(result, privilegedCalls);
  if (askCalls) rememberAskCalls(result, askCalls);
  const asynchrony = asynchronyOfFunction(n);
  if (asynchrony) rememberAsynchrony(result, asynchrony);
  return result;
}
/** The members an assignment or update writes to or through (`&a`, `&a.b`,
 * `&a[0]`): the target's member-access root is one of `members`. */
function assignedMembers(target: SyntaxNode | undefined, members: MemberForwards): MemberMark[] {
  if (!target) return [];
  let root = target;
  while (!members.has(root) && (root.type === "MemberExpression" || root.type === "OptionalMemberExpression") && root.object)
    root = root.object;
  const mark = members.get(root);
  if (mark) return [mark];
  if (target.type === "ArrayPattern")
    return (target.elements ?? []).flatMap((e) => assignedMembers(e ?? undefined, members));
  if (target.type === "ObjectPattern")
    return (target.properties ?? []).flatMap((p) => assignedMembers((p.value ?? p.argument) as SyntaxNode | undefined, members));
  if (target.type === "RestElement" || target.type === "AssignmentPattern")
    return assignedMembers(target.argument ?? target.left, members);
  return [];
}
function walkMembers(
  value: unknown,
  at: At,
  visit: (ref: MemberRef) => void,
  assign: (assignment: MemberAssignment) => void,
  members: MemberForwards,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v) => walkMembers(v, at, visit, assign, members));
    return;
  }
  const n = value as SyntaxNode;
  const ref = memberNode(n, at, members);
  if (ref) visit(ref);
  const target =
    n.type === "AssignmentExpression" ? n.left
    : n.type === "UpdateExpression" ? n.argument
    : n.type === "ForInStatement" || n.type === "ForOfStatement" ? n.left
    : undefined;
  for (const mark of assignedMembers(target, members)) {
    assign({
      ref: { name: mark.name, position: at(mark.span.sourceStart) },
      position: at(n.loc?.start.index ?? mark.span.sourceStart),
    });
  }
  for (const [key, child] of Object.entries(value))
    if (key !== "extra" && key !== "loc") walkMembers(child, at, visit, assign, members);
}
