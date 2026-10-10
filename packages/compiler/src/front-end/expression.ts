import type {
  Diagnostic,
  ExprNode,
  FunctionId,
  PlainReason,
  PlainWhy,
  SourceEdit,
  SourcePosition,
} from "@meshfw/model";
import type { At, SyntaxNode } from "./tree.ts";

/**
 * Babel node to Mesh's expression tree (M4, ADR-0056). The only code that reads the Babel
 * node types of a function body. A one-expression function whose every construct the
 * registry defines becomes a tree; anything else becomes a `PlainReason` and stays authored
 * TypeScript. A free variable is an error either way.
 */
type N = SyntaxNode & { [key: string]: any };

export interface ConvertContext {
  source: string;
  at: At;
  /** Imported names that are helper functions (not entities) and the module each comes from. */
  helpers: ReadonlyMap<string, string>;
  /** Every name the file imports, helpers and entities. */
  imported: ReadonlySet<string>;
  report: (diagnostic: Diagnostic) => void;
  /** A `run` step is plain by form. */
  runStep?: boolean;
}

const ROOTS = new Set(["self", "input", "actor", "context", "before"]);
const SCOPE_NAMES = new Set([...ROOTS, "tx"]);
const GLOBALS = new Set([
  "Math", "Number", "String", "Boolean", "Date", "JSON", "Array", "Object", "Map", "Set", "Promise",
  "Error", "RegExp", "Symbol", "console", "undefined", "NaN", "Infinity", "isNaN", "isFinite", "parseInt", "parseFloat",
]);
const REGISTERED_CALLS: Record<string, { fn: FunctionId; arity: number }> = {
  now: { fn: "now", arity: 0 },
  today: { fn: "today", arity: 0 },
};
const BINARY: Record<string, FunctionId> = {
  "<": "lt", "<=": "lte", ">": "gt", ">=": "gte", "+": "add", "-": "sub", "*": "mul", "/": "div",
};

class Plain extends Error {
  constructor(readonly why: PlainWhy, readonly detail: string, readonly node: N) { super(detail); }
}

const start = (n: N): number => n.start ?? n.loc?.start.index ?? 0;

/** Every name bound anywhere in the function. Flat on purpose: it never reports a false error. */
function bindings(root: N): Set<string> {
  const names = new Set<string>();
  const pattern = (p: N | null | undefined): void => {
    if (!p) return;
    switch (p.type) {
      case "Identifier": names.add(p.name!); break;
      case "ObjectPattern": for (const prop of p.properties ?? []) pattern((prop.type === "RestElement" ? prop.argument : prop.value) as N); break;
      case "ArrayPattern": for (const e of p.elements ?? []) pattern(e as N | null); break;
      case "AssignmentPattern": pattern(p.left as N); break;
      case "RestElement": pattern(p.argument as N); break;
    }
  };
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const n = value as N;
    if (typeof n.type === "string" && n.type.startsWith("TS")) return;
    switch (n.type) {
      case "VariableDeclarator": pattern(n.id); break;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": case "ObjectMethod": case "ClassMethod":
        if (n.id) pattern(n.id);
        for (const p of n.params ?? []) pattern(p);
        break;
      case "ClassDeclaration": case "ClassExpression": if (n.id) pattern(n.id); break;
      case "CatchClause": pattern(n.param); break;
    }
    for (const [k, child] of Object.entries(n)) if (k !== "loc" && k !== "extra") walk(child);
  };
  walk(root);
  return names;
}

/** Free-variable errors for one function, at the identifier. */
function freeVariables(fn: N, ctx: ConvertContext): void {
  const bound = bindings(fn);
  const known = (name: string) =>
    bound.has(name) || ctx.imported.has(name) || SCOPE_NAMES.has(name) || GLOBALS.has(name) || name in REGISTERED_CALLS;
  const walk = (value: unknown, parent?: N, key?: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walk(v, parent, key); return; }
    const n = value as N;
    if (typeof n.type === "string" && n.type.startsWith("TS")) return;
    if (n.type === "Identifier") {
      const property = parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed;
      const objectKey = parent && (parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") && key === "key" && !parent.computed;
      const label = parent && /^(LabeledStatement|BreakStatement|ContinueStatement)$/.test(parent.type) && key === "label";
      if (!property && !objectKey && !label && !known(n.name!) && n.start !== undefined) {
        ctx.report({
          severity: "error",
          code: "MESH_EXPR_FREE_VARIABLE",
          message: `\`${n.name}\` is not defined here: a function in an entity file may use its parameters, \`&members\`, imported helpers, \`now()\` and \`today()\``,
          position: ctx.at(start(n)),
          fix: "import it from a helper module, or pass it in through `context`",
        });
      }
      return;
    }
    for (const [k, child] of Object.entries(n)) if (k !== "loc" && k !== "extra") walk(child, n, k);
  };
  walk(fn.body);
  for (const p of fn.params ?? []) walk(p);
}

/** The edits that turn the authored text into TypeScript: `&name` to `self.name`, `:atom` to a string. */
function editsFor(fn: N, base: number): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const n = value as N;
    const extra = n.extra as any;
    const member = extra?.mxMember;
    if (n.type === "MemberExpression" && member)
      edits.push({ from: member.span.sourceStart - base, to: member.span.sourceEnd - base, text: `self.${member.name}` });
    const atom = extra?.mxAtom;
    if (n.type === "StringLiteral" && atom)
      edits.push({ from: atom.span.sourceStart - base, to: atom.span.sourceEnd - base, text: JSON.stringify(String(n.value)) });
    for (const [k, child] of Object.entries(n)) if (k !== "loc" && k !== "extra") walk(child);
  };
  walk(fn);
  return edits.sort((a, b) => a.from - b.from);
}

interface Env {
  /** Parameter name in the function to the root it stands for. */
  roots: Map<string, string>;
  /** Quantifier parameters in scope. */
  locals: Set<string>;
  /** Whether the walk so far reads the record (self, before or a quantifier parameter). */
  reads: { record: boolean };
}

const isNull = (n: SyntaxNode | undefined) => n?.type === "NullLiteral";

function convert(n: N, env: Env, ctx: ConvertContext, inArgs = false): ExprNode {
  const position: SourcePosition = ctx.at(start(n));
  const call = (fn: FunctionId, args: ExprNode[]): ExprNode => ({ kind: "call", fn, args, position });
  const sub = (child: SyntaxNode | null | undefined, inside = inArgs) => {
    if (!child) throw new Plain("unsupported-construct", "an empty slot", n);
    return convert(child as N, env, ctx, inside);
  };
  switch (n.type) {
    case "NumericLiteral": return { kind: "literal", value: n.value as number, position };
    case "BooleanLiteral": return { kind: "literal", value: n.value as boolean, position };
    case "NullLiteral": return { kind: "literal", value: null, position };
    case "StringLiteral":
      return (n.extra as any)?.mxAtom ? { kind: "atom", value: String(n.value), position } : { kind: "literal", value: String(n.value), position };
    case "ParenthesizedExpression": return sub(n.expression);
    case "Identifier": {
      const name = n.name!;
      const root = env.roots.get(name);
      if (root) {
        if (root === "tx") throw new Plain("uses-tx", "reads the transaction", n);
        if (root === "self" || root === "before") env.reads.record = true;
        return { kind: "var", name: root, position };
      }
      if (env.locals.has(name)) { env.reads.record = true; return { kind: "var", name, position }; }
      if (name === "self") { env.reads.record = true; return { kind: "var", name: "self", position }; }
      if (name === "undefined") throw new Plain("unsupported-construct", "`undefined` (Mesh has no undefined; use null)", n);
      throw new Plain("unsupported-construct", `the name \`${name}\``, n);
    }
    case "MemberExpression": case "OptionalMemberExpression": {
      if (n.computed) throw new Plain("unsupported-construct", "computed member access", n);
      const name = String(n.property.name);
      const mark = (n.extra as any)?.mxMember as { name: string; span: { sourceStart: number } } | undefined;
      const here = mark ? ctx.at(mark.span.sourceStart) : position;
      if (mark && n.object?.type === "Identifier" && n.object.name === "self") {
        env.reads.record = true;
        return { kind: "member", object: { kind: "var", name: "self", position: here }, name, optional: false, position: here };
      }
      if (name === "length" && !mark) return { kind: "call", fn: "length", args: [sub(n.object)], position };
      return { kind: "member", object: sub(n.object), name, optional: n.type === "OptionalMemberExpression" && n.optional === true, position: here };
    }
    case "UnaryExpression": {
      if (n.operator === "!") return call("not", [sub(n.argument)]);
      if (n.operator === "-") {
        if (n.argument?.type === "NumericLiteral") return { kind: "literal", value: -Number(n.argument.value), position };
        return call("neg", [sub(n.argument)]);
      }
      throw new Plain("unsupported-construct", `unary \`${n.operator}\``, n);
    }
    case "BinaryExpression": {
      const op = n.operator as string;
      if (op === "===" || op === "!==" || op === "==" || op === "!=") {
        const loose = op === "==" || op === "!=";
        const negate = op === "!==" || op === "!=";
        if (isNull(n.left) || isNull(n.right)) {
          const other = isNull(n.left) ? n.right : n.left;
          return call(negate ? "isNotNull" : "isNull", [sub(other)]);
        }
        if (loose) throw new Plain("unsupported-construct", `\`${op}\` (loose equality; only \`== null\` is translated)`, n);
        return call(negate ? "ne" : "eq", [sub(n.left), sub(n.right)]);
      }
      const fn = BINARY[op];
      if (!fn) throw new Plain("unsupported-construct", `operator \`${op}\``, n);
      return call(fn, [sub(n.left), sub(n.right)]);
    }
    case "LogicalExpression": {
      const fn = ({ "&&": "and", "||": "or", "??": "coalesce" } as Record<string, FunctionId>)[n.operator as string];
      if (!fn) throw new Plain("unsupported-construct", `operator \`${n.operator}\``, n);
      return call(fn, [sub(n.left), sub(n.right)]);
    }
    case "ConditionalExpression": return call("cond", [sub(n.test), sub(n.consequent), sub(n.alternate)]);
    case "CallExpression": {
      const callee = n.callee as N;
      const args = (n.arguments ?? []) as N[];
      if (callee.type === "Identifier") {
        const name = callee.name!;
        const registered = REGISTERED_CALLS[name];
        if (registered && !env.roots.has(name) && !ctx.helpers.has(name)) {
          if (args.length !== registered.arity) throw new Plain("unsupported-construct", `\`${name}()\` takes no arguments`, n);
          return call(registered.fn, []);
        }
        const from = ctx.helpers.get(name);
        if (from !== undefined) {
          const before = env.reads.record;
          env.reads.record = false;
          const converted = args.map((a) => sub(a, true));
          if (env.reads.record) throw new Plain("reads-record-in-helper", `the call to ${name} reads the record`, n);
          env.reads.record = before;
          return { kind: "helper", name, from, args: converted, position };
        }
        throw new Plain("unsupported-construct", `the call to \`${name}\``, n);
      }
      if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed && !callee.optional && n.type === "CallExpression") {
        const op = String(callee.property.name);
        if (op === "some" || op === "every" || op === "find" || op === "filter") {
          const fn = args[0] as N | undefined;
          if (args.length === 1 && fn?.type === "ArrowFunctionExpression" && fn.params?.length === 1 && fn.params[0]!.type === "Identifier" && fn.body?.type !== "BlockStatement") {
            const param = fn.params[0]!.name!;
            if (SCOPE_NAMES.has(param) || env.roots.has(param)) throw new Plain("unsupported-construct", `the parameter \`${param}\` shadows a scope name`, n);
            const inner: Env = { roots: env.roots, locals: new Set([...env.locals, param]), reads: env.reads };
            return { kind: "quantify", op, source: sub(callee.object), param, body: convert(fn.body, inner, ctx), position };
          }
        }
      }
      throw new Plain("unsupported-construct", "a method call", n);
    }
    default:
      throw new Plain("unsupported-construct", `${n.type.replace(/Expression$|Literal$/, "").toLowerCase() || n.type}`, n);
  }
}

const PARAMETER_ERROR = (n: N) => new Plain("unsupported-parameter", "this parameter form is not translated; destructure { self, input, actor, context, before }", n);

/** Translate one function (`fn` is its Babel node, `span` its authored extent). */
/** The edits of every translated expression, for the checker if it later demotes one to plain code. */
const demotionEdits = new WeakMap<object, SourceEdit[]>();
export const editsOf = (expression: object): SourceEdit[] => demotionEdits.get(expression) ?? [];
export const rememberEdits = (expression: object, edits: SourceEdit[]): void => { demotionEdits.set(expression, edits); };

export function translate(fn: SyntaxNode, span: { sourceStart: number; sourceEnd: number }, ctx: ConvertContext): { tree?: ExprNode; plain?: PlainReason; edits?: SourceEdit[] } {
  const f = fn as N;
  freeVariables(f, ctx);
  const plain = (e: Plain): { plain: PlainReason } => ({
    plain: { why: e.why, detail: e.detail, position: ctx.at(start(e.node) || span.sourceStart), edits: editsFor(f, span.sourceStart), ...(f.type === "FunctionExpression" ? { method: true as const } : {}) },
  });
  try {
    if (ctx.runStep) throw new Plain("run-step", "a run step is plain code", f);
    const roots = new Map<string, string>();
    const params = (f.params ?? []) as N[];
    if (params.length > 1) throw PARAMETER_ERROR(f);
    if (params[0]) {
      if (params[0].type !== "ObjectPattern") throw PARAMETER_ERROR(params[0]);
      for (const p of params[0].properties ?? []) {
        const key = (p as N).key as N | undefined;
        const value = (p as N).value as N | undefined;
        if ((p as N).type !== "ObjectProperty" || (p as N).computed || !key || value?.type !== "Identifier") throw PARAMETER_ERROR(f);
        const root = key.name!;
        if (root === "tx") throw new Plain("uses-tx", "reads the transaction", f);
        if (!ROOTS.has(root)) throw PARAMETER_ERROR(f);
        roots.set(value.name!, root);
      }
    }
    let body = f.body as N;
    if (body.type === "BlockStatement") {
      const statements = body.body as N[];
      if (f.type !== "FunctionExpression" || statements.length !== 1 || statements[0]!.type !== "ReturnStatement" || !statements[0]!.argument)
        throw new Plain("block-body", `a block body of ${statements.length} statement${statements.length === 1 ? "" : "s"}`, f);
      body = statements[0]!.argument as N;
    }
    const tree = convert(body, { roots, locals: new Set(), reads: { record: false } }, ctx);
    return { tree, edits: editsFor(f, span.sourceStart) };
  } catch (e) {
    if (e instanceof Plain) return plain(e);
    throw e;
  }
}
