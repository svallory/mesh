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
/** The roots a translated expression reads, plus the two that only plain code can use: `actions` and `tx` (ADR-0068). */
const SCOPE_NAMES = new Set([...ROOTS, "tx", "actions"]);
/** A function that reaches the transaction is plain code: what it calls or reads is not an expression over the record. */
const composing = (root: string, n: N): Plain | undefined =>
  root === "tx" ? new Plain("uses-tx", "reads the transaction", n)
    : root === "actions" ? new Plain("uses-actions", "calls other actions", n) : undefined;
/** The globals a function may use. `structuredClone` is one: the expressions file binds it to `cloneValue`, which copies a read-only record. */
const GLOBALS = new Set([
  "Math", "Number", "String", "Boolean", "Date", "JSON", "Array", "Object", "Map", "Set", "Promise",
  "Error", "RegExp", "Symbol", "console", "undefined", "NaN", "Infinity", "isNaN", "isFinite", "parseInt", "parseFloat",
  "structuredClone",
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

/**
 * Free-variable errors for one function, at the identifier. Returns the scope names the function reads as variables
 * that its parameters do not bind (`&name` is `self.name`, so it reads `self`), in a fixed order: what the printed
 * function takes from the scope. A name a nested binding shadows still counts, so the function is never short of one.
 */
function freeVariables(fn: N, ctx: ConvertContext): string[] {
  const bound = bindings(fn);
  const parameters = bindings({ type: "ArrowFunctionExpression", params: fn.params ?? [], body: null } as unknown as N);
  const roots = new Set<string>();
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
      if (!property && !objectKey && !label && SCOPE_NAMES.has(n.name!) && !parameters.has(n.name!)) roots.add(n.name!);
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
  return [...SCOPE_NAMES].filter((name) => roots.has(name));
}

/** Whether the code uses an operator whose null rule differs between JavaScript and Mesh (`??` and `?.` do not). */
function hasDifferingOperator(root: unknown): boolean {
  const COMPARE = new Set(["<", "<=", ">", ">=", "===", "!==", "==", "!=", "+", "-", "*", "/"]);
  const walk = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(walk);
    const n = value as N;
    if (typeof n.type === "string" && n.type.startsWith("TS")) return false;
    if (n.type === "BinaryExpression" && COMPARE.has(n.operator as string)) return true;
    if (n.type === "UnaryExpression" && (n.operator === "!" || n.operator === "-")) return true;
    if (n.type === "LogicalExpression" && n.operator !== "??") return true;
    if (n.type === "ConditionalExpression") return true; // truthiness of the test
    return Object.entries(n).some(([k, child]) => k !== "loc" && k !== "extra" && walk(child));
  };
  return walk(root);
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

/** Written as a float (`2.0`, `1e3`): Babel's parsed value cannot tell, its raw text can. */
const isFloatLiteral = (n: N): boolean => {
  const raw = String((n.extra as { raw?: string } | undefined)?.raw ?? "");
  return !/^0[xXbBoO]/.test(raw) && /[.eE]/.test(raw);
};
const isNull = (n: SyntaxNode | undefined) => n?.type === "NullLiteral";

function convert(n: N, env: Env, ctx: ConvertContext, inArgs = false): ExprNode {
  const position: SourcePosition = ctx.at(start(n));
  const call = (fn: FunctionId, args: ExprNode[]): ExprNode => ({ kind: "call", fn, args, position });
  const sub = (child: SyntaxNode | null | undefined, inside = inArgs) => {
    if (!child) throw new Plain("unsupported-construct", "an empty slot", n);
    return convert(child as N, env, ctx, inside);
  };
  switch (n.type) {
    case "NumericLiteral": return { kind: "literal", value: n.value as number, ...(isFloatLiteral(n) ? { float: true as const } : {}), position };
    case "BooleanLiteral": return { kind: "literal", value: n.value as boolean, position };
    case "NullLiteral": return { kind: "literal", value: null, position };
    case "StringLiteral":
      return (n.extra as any)?.mxAtom ? { kind: "atom", value: String(n.value), position } : { kind: "literal", value: String(n.value), position };
    case "ParenthesizedExpression": return sub(n.expression);
    case "Identifier": {
      const name = n.name!;
      const root = env.roots.get(name);
      if (root) {
        const composes = composing(root, n);
        if (composes) throw composes;
        if (root === "self" || root === "before") env.reads.record = true;
        return { kind: "var", name: root, position };
      }
      if (env.locals.has(name)) { env.reads.record = true; return { kind: "var", name, position }; }
      if (name === "self") { env.reads.record = true; return { kind: "var", name: "self", position }; }
      if (name === "undefined") throw new Plain("unsupported-construct", "`undefined` (Mesh has no undefined; use null)", n);
      if (!ctx.imported.has(name) && !GLOBALS.has(name) && !SCOPE_NAMES.has(name)) {
        // Not bound in this expression's own scope (a quantifier parameter used outside its quantifier, say).
        ctx.report({
          severity: "error",
          code: "MESH_EXPR_FREE_VARIABLE",
          message: `\`${name}\` is not defined here: a function in an entity file may use its parameters, \`&members\`, imported helpers, \`now()\` and \`today()\``,
          position: ctx.at(start(n)),
          fix: "import it from a helper module, or pass it in through `context`",
        });
        throw new Plain("unsupported-construct", `the name \`${name}\``, n);
      }
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
        if (n.argument?.type === "NumericLiteral") return { kind: "literal", value: -Number(n.argument.value), ...(isFloatLiteral(n.argument as N) ? { float: true as const } : {}), position };
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
          if (env.reads.record) throw new Plain("reads-record-in-helper", `a call to ${name}, which is given the record`, n);
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
/** What printing a translated expression as plain code needs, for the checker if it later demotes one: its edits and the scope names it reads. */
export interface Demotion { edits: SourceEdit[]; roots: string[] }
const demotions = new WeakMap<object, Demotion>();
export const demotionOf = (expression: object): Demotion => demotions.get(expression) ?? { edits: [], roots: [] };
export const rememberDemotion = (expression: object, demotion: Demotion): void => { demotions.set(expression, demotion); };

export function translate(fn: SyntaxNode, span: { sourceStart: number; sourceEnd: number }, ctx: ConvertContext): { tree?: ExprNode; plain?: PlainReason; demotion?: Demotion } {
  const f = fn as N;
  const free = freeVariables(f, ctx);
  const roots = new Map<string, string>();
  /**
   * A body that is an object literal (a check's `details`) is plain only because of the literal. Each property value that Mesh can
   * translate on its own is kept as a tree, so the type pass can tell a comparison that cannot differ (non-null operands) from one that can.
   */
  const objectParts = (): { parts: ExprNode[]; rest: unknown[] } | undefined => {
    const body = f.body as N;
    if (body?.type !== "ObjectExpression") return undefined;
    const parts: ExprNode[] = [];
    const rest: unknown[] = [];
    for (const property of (body.properties ?? []) as N[]) {
      const value = property.value as N | undefined;
      if (property.type !== "ObjectProperty" || property.computed || !value) { rest.push(property); continue; }
      try { parts.push(convert(value, { roots, locals: new Set(), reads: { record: false } }, ctx)); }
      catch (error) { if (error instanceof Plain) rest.push(value); else throw error; }
    }
    return { parts, rest };
  };
  const plain = (e: Plain): { plain: PlainReason } => {
    const object = objectParts();
    return {
      plain: { why: e.why, detail: e.detail, position: ctx.at(start(e.node) || span.sourceStart), edits: editsFor(f, span.sourceStart), roots: free, ...((object ? hasDifferingOperator(object.rest) : hasDifferingOperator(f.body)) ? { operators: true as const } : {}), ...(object?.parts.length ? { parts: object.parts } : {}), ...(f.type === "FunctionExpression" ? { method: true as const } : {}) },
    };
  };
  try {
    if (ctx.runStep) throw new Plain("run-step", "a run step is plain code", f);
    const params = (f.params ?? []) as N[];
    if (params.length > 1) throw PARAMETER_ERROR(f);
    if (params[0]) {
      if (params[0].type !== "ObjectPattern") throw PARAMETER_ERROR(params[0]);
      for (const p of params[0].properties ?? []) {
        const key = (p as N).key as N | undefined;
        const value = (p as N).value as N | undefined;
        if ((p as N).type !== "ObjectProperty" || (p as N).computed || !key || value?.type !== "Identifier") throw PARAMETER_ERROR(f);
        const root = key.name!;
        const composes = composing(root, f);
        if (composes) throw composes;
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
    return { tree, demotion: { edits: editsFor(f, span.sourceStart), roots: free } };
  } catch (e) {
    if (e instanceof Plain) return plain(e);
    throw e;
  }
}
