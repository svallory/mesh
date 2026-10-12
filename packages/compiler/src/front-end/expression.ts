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
  /** The entities the file names: its own and the ones it imports, by the name the file gives them (CMP-16). */
  entities?: ReadonlySet<string>;
  report: (diagnostic: Diagnostic) => void;
  /** A `run` step is plain by form. */
  runStep?: boolean;
}

const ROOTS = new Set(["self", "input", "actor", "context", "before"]);
/**
 * The names of the scope a function is handed. They behave as the function's parameters do (EXP-12): inside the function
 * a free `input` or `context` is the root, even when the file imports something under that name (a helper, or an entity
 * under an alias such as `import { List as context }`), which stays the import everywhere outside the function.
 */
const SCOPE_NAMES: ReadonlySet<string> = ROOTS;
/** The globals a function may use. `structuredClone` is one: the expressions file binds it to `cloneValue`, which copies a read-only record. */
const GLOBALS = new Set([
  "Math", "Number", "String", "Boolean", "Date", "JSON", "Array", "Object", "Map", "Set", "Promise",
  "Error", "RegExp", "Symbol", "console", "undefined", "NaN", "Infinity", "isNaN", "isFinite", "parseInt", "parseFloat",
  "structuredClone",
]);
/**
 * The functions Mesh registers by name, which a function in an entity file calls without importing them. `privileged`
 * (TXN-16) has no `fn`: a function that calls it is plain code, since what it reads is not an expression over the record.
 * They behave as JavaScript's globals do (PRJ-20): a name the function binds or the file imports (a helper, or an entity
 * under an alias) is that, and hides the registered function of that name (`registeredCall`).
 */
const REGISTERED_CALLS: ReadonlyMap<string, { fn?: FunctionId; arity: number; example: string }> = new Map([
  ["now", { fn: "now", arity: 0, example: "now()" }],
  ["today", { fn: "today", arity: 0, example: "today()" }],
  ["isSystem", { fn: "isSystem", arity: 1, example: "isSystem(context)" }],
  ["privileged", { arity: 1, example: "privileged(Task)" }],
]);
/**
 * The registered function a free `name` is, or undefined when something nearer has the name: `bound` (a binding of the
 * function in scope where the name is read), an import of the file (a helper, or an entity under an alias such as
 * `import { List as now }`) or the file's own entity. One name has one meaning, so the printed function binds the
 * registered function only where nothing else has its name.
 */
function registeredCall(name: string, bound: (name: string) => boolean, ctx: ConvertContext) {
  if (bound(name) || ctx.imported.has(name) || ctx.helpers.has(name) || ctx.entities?.has(name)) return undefined;
  return REGISTERED_CALLS.get(name);
}
const FREE_VARIABLE = (name: string) =>
  `\`${name}\` is not defined here: a function in an entity file may use its parameters, \`&members\`, imported helpers, its own entity and the imported ones, \`now()\`, \`today()\`, \`isSystem()\` and \`privileged()\``;
const BINARY: Record<string, FunctionId> = {
  "<": "lt", "<=": "lte", ">": "gt", ">=": "gte", "+": "add", "-": "sub", "*": "mul", "/": "div",
};

class Plain extends Error {
  constructor(readonly why: PlainWhy, readonly detail: string, readonly node: N) { super(detail); }
}

const start = (n: N): number => n.start ?? n.loc?.start.index ?? 0;

/** Adds to `names` the names a binding pattern (a parameter, a declarator's id, a catch parameter) binds. */
function patternNames(p: N | null | undefined, names: Set<string>): void {
  if (!p) return;
  switch (p.type) {
    case "Identifier": names.add(p.name!); break;
    case "ObjectPattern": for (const prop of p.properties ?? []) patternNames((prop.type === "RestElement" ? prop.argument : prop.value) as N, names); break;
    case "ArrayPattern": for (const e of p.elements ?? []) patternNames(e as N | null, names); break;
    case "AssignmentPattern": patternNames(p.left as N, names); break;
    case "RestElement": patternNames(p.argument as N, names); break;
    case "TSParameterProperty": patternNames(p.parameter as N, names); break;
  }
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);

/** The `var` declarations of a function body, hoisted to the function: every one outside a nested function. */
function hoistedVars(body: unknown, names: Set<string>): void {
  if (!body || typeof body !== "object") return;
  if (Array.isArray(body)) { for (const b of body) hoistedVars(b, names); return; }
  const n = body as N;
  if (typeof n.type === "string" && (n.type.startsWith("TS") || FUNCTION_TYPES.has(n.type))) return;
  if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations ?? []) patternNames((d as N).id, names);
  for (const [k, child] of Object.entries(n)) if (k !== "loc" && k !== "extra") hoistedVars(child, names);
}

/** The lexical declarations of a statement list: `let`, `const`, `using`, classes and functions. */
function lexicalNames(statements: readonly N[], names: Set<string>): void {
  for (const statement of statements) {
    if (statement.type === "VariableDeclaration") for (const d of statement.declarations ?? []) patternNames((d as N).id, names);
    if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) patternNames(statement.id as N, names);
  }
}

/**
 * The names a node declares for the code inside it, or undefined when it opens no scope: a function's parameters, its
 * own name (an expression's) and its `var`s; a block's lexical declarations; a loop head's; a catch clause's parameter;
 * a class expression's name. A reference resolves to the nearest of these that has its name.
 *
 * A function's `var`s share the scope of its parameters, so `function f(at = now()) { var now = 0 }` binds no clock.
 * JavaScript gives that default the outer `now`, but Bun's engine does not when the outer binding is two or more
 * functions up, which a printed function's clock always is: it throws `ReferenceError: now is not defined` (Bun
 * 1.3.14 and 1.4.2; Node gives the outer one). Binding no clock keeps the failure at the type check (TS2304) instead of at run time.
 */
function scopeNames(n: N): Set<string> | undefined {
  const names = new Set<string>();
  if (FUNCTION_TYPES.has(n.type)) {
    if (n.type === "FunctionExpression" && n.id) patternNames(n.id as N, names);
    for (const p of n.params ?? []) patternNames(p as N, names);
    if (n.body?.type === "BlockStatement") hoistedVars(n.body.body, names);
    return names;
  }
  switch (n.type) {
    case "BlockStatement": case "Program": case "StaticBlock": lexicalNames((n.body ?? []) as N[], names); return names;
    case "SwitchStatement": lexicalNames(((n.cases ?? []) as N[]).flatMap((c) => (c.consequent ?? []) as N[]), names); return names;
    case "ForStatement": if (n.init?.type === "VariableDeclaration") lexicalNames([n.init as N], names); return names;
    case "ForInStatement": case "ForOfStatement": if (n.left?.type === "VariableDeclaration") lexicalNames([n.left as N], names); return names;
    case "CatchClause": patternNames(n.param as N, names); return names;
    case "ClassExpression": if (n.id) patternNames(n.id as N, names); return names;
    default: return undefined;
  }
}

/** Every name bound anywhere in the function. Flat on purpose: it never reports a false error. */
function bindings(root: N): Set<string> {
  const names = new Set<string>();
  const pattern = (p: N | null | undefined): void => patternNames(p, names);
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
 * that no scope of the function binds (`&name` is `self.name`, so it reads `self`), in a fixed order: what the printed
 * function takes from the scope. Each reference is resolved against its own enclosing scopes, as the clock names are: a
 * loop variable, a nested parameter or a `catch` parameter called `input` shadows the root only where it is in scope,
 * and a read of `input` elsewhere in the function is still the root.
 * Adds to `clock` each clock function (`now`, `today`) the function reads somewhere that no enclosing scope binds that
 * name and the file does not import: each reference is resolved against its own scopes, so
 * `[1].some((now) => now === 1) && now()` reads the clock (a function's `var`s count for its parameters: `scopeNames`).
 */
function freeVariables(fn: N, ctx: ConvertContext, clock: Set<string>, names: Names): string[] {
  const bound = bindings(fn);
  const roots = new Set<string>();
  const entities = ctx.entities ?? new Set<string>();
  const known = (name: string) =>
    bound.has(name) || ctx.imported.has(name) || entities.has(name) || SCOPE_NAMES.has(name) || GLOBALS.has(name) || REGISTERED_CALLS.has(name);
  /** Whether a free `name` read in `scope` is an entity the file names: no scope binds it and it is no scope name (EXP-12). */
  const namesEntity = (name: string, scope: ReadonlySet<string>) => entities.has(name) && !scope.has(name) && !SCOPE_NAMES.has(name);
  const walk = (value: unknown, parent: N | undefined, key: string | undefined, scope: ReadonlySet<string>): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walk(v, parent, key, scope); return; }
    const n = value as N;
    if (typeof n.type === "string" && n.type.startsWith("TS")) return;
    if (n.type === "PrivateName") return; // `#x` names a class member, never a variable
    if (n.type === "Identifier") {
      const property = parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed;
      const objectKey = parent && (parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") && key === "key" && !parent.computed;
      const label = parent && /^(LabeledStatement|BreakStatement|ContinueStatement)$/.test(parent.type) && key === "label";
      if (!property && !objectKey && !label && SCOPE_NAMES.has(n.name!) && !scope.has(n.name!)) roots.add(n.name!);
      // An imported `now` or `today`, a helper or an entity's alias, is the import, as it is in translated code (`convert`).
      if (!property && !objectKey && !label && registeredCall(n.name!, (name) => scope.has(name), ctx)) {
        clock.add(n.name!);
        if (n.name === "privileged") (names.privileged ??= []).push(ctx.at(start(n)));
      }
      // A scope name is the root wherever no scope of the function binds it, so an import of that name is not named here (EXP-12).
      if (!property && !objectKey && !label && !scope.has(n.name!) && !SCOPE_NAMES.has(n.name!)) {
        if (entities.has(n.name!)) names.entities.add(n.name!);
        if (ctx.helpers.has(n.name!)) names.helpers.add(n.name!);
        // The global `structuredClone`, unless the file imports something under its name (PRJ-20).
        if (n.name === "structuredClone" && !ctx.imported.has(n.name) && !entities.has(n.name)) names.structuredClone = true;
      }
      if (!property && !objectKey && !label && !known(n.name!) && n.start !== undefined) {
        ctx.report({
          severity: "error",
          code: "MESH_EXPR_FREE_VARIABLE",
          message: FREE_VARIABLE(n.name!),
          position: ctx.at(start(n)),
          fix: "import it from a helper module, or pass it in through `context`",
        });
      }
      return;
    }
    // A registered function called with the wrong number of arguments is an error, translated or plain (N3 of the M8a review).
    const callee = n.type === "CallExpression" || n.type === "OptionalCallExpression" ? n.callee as N : undefined;
    const registered = callee?.type === "Identifier" ? registeredCall(callee.name!, (name) => scope.has(name), ctx) : undefined;
    const args = (n.arguments ?? []) as N[];
    if (registered && args.length !== registered.arity)
      ctx.report({
        severity: "error",
        code: "MESH_EXPR_ARITY",
        message: `\`${callee!.name}()\` takes ${registered.arity === 0 ? "no arguments" : `${registered.arity} argument${registered.arity === 1 ? "" : "s"}`}, and this call passes ${args.length}`,
        position: ctx.at(start(n)),
        fix: `write \`${registered.example}\``,
      });
    // `privileged(X)` takes an entity the file names (TXN-16): its own or an imported one, never a variable that holds one.
    const argument = args[0];
    if (registered && callee!.name === "privileged" && argument && !(argument.type === "Identifier" && namesEntity(argument.name!, scope)))
      ctx.report({
        severity: "error",
        code: "MESH_PRIVILEGED_ENTITY",
        message: `\`privileged()\` takes an entity this file names, its own or an imported one${argument.type === "Identifier" ? `, and \`${argument.name}\` is not one` : ""}`,
        position: ctx.at(start(argument)),
        fix: "write `privileged(Task)`, naming the entity, and import it when it is another file's",
      });
    // `Task.touch(...)`: a call to an entity's action (CMP-16).
    const target = callee && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") ? callee.object as N : undefined;
    if (target?.type === "Identifier" && namesEntity(target.name!, scope)) names.acts = true;
    const opened = scopeNames(n);
    const inner = opened && opened.size > 0 ? new Set([...scope, ...opened]) : scope;
    for (const [k, child] of Object.entries(n)) if (k !== "loc" && k !== "extra") walk(child, n, k, inner);
  };
  // The function's own parameters, name and `var`s; its body block adds its lexical declarations when the walk enters it.
  const own = scopeNames(fn) ?? new Set<string>();
  walk(fn.body, fn, "body", own);
  for (const p of fn.params ?? []) walk(p, fn, "params", own);
  return [...SCOPE_NAMES].filter((name) => roots.has(name));
}

/**
 * What a function names besides its scope: the entities, whether it calls an entity's action, the helpers it names and
 * whether it calls the global `structuredClone`.
 */
interface Names { entities: Set<string>; acts: boolean; helpers: Set<string>; structuredClone?: true; privileged?: SourcePosition[] }

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
  // The `&x` of an `input.x ?? &x`.
  const fallbacks = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const n = value as N;
    const extra = n.extra as any;
    const member = extra?.mxMember;
    if (n.type === "LogicalExpression" && n.operator === "??") {
      const left = n.left as N, right = n.right as N;
      const name = (right?.extra as any)?.mxMember?.name;
      if (left?.type === "MemberExpression" && (left.object as N)?.type === "Identifier" && (left.object as N).name === "input"
        && !left.computed && (left.property as N)?.name === name && name !== undefined) fallbacks.add(right);
    }
    if (n.type === "MemberExpression" && member)
      edits.push({ from: member.span.sourceStart - base, to: member.span.sourceEnd - base, text: `self.${member.name}`, ...(fallbacks.has(n) ? { fallback: true as const } : {}) });
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
        if (root === "self" || root === "before") env.reads.record = true;
        return { kind: "var", name: root, position };
      }
      if (env.locals.has(name)) { env.reads.record = true; return { kind: "var", name, position }; }
      if (name === "self") { env.reads.record = true; return { kind: "var", name: "self", position }; }
      if (name === "undefined") throw new Plain("unsupported-construct", "`undefined` (Mesh has no undefined; use null)", n);
      if (ctx.entities?.has(name) && !SCOPE_NAMES.has(name)) throw new Plain("calls-entity", `the entity \`${name}\``, n);
      if (!ctx.imported.has(name) && !GLOBALS.has(name) && !SCOPE_NAMES.has(name)) {
        // Not bound in this expression's own scope (a quantifier parameter used outside its quantifier, say).
        ctx.report({
          severity: "error",
          code: "MESH_EXPR_FREE_VARIABLE",
          message: FREE_VARIABLE(name),
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
        const registered = registeredCall(name, (local) => env.roots.has(local) || env.locals.has(local), ctx);
        if (registered) {
          if (args.length !== registered.arity)
            throw new Plain("unsupported-construct", registered.arity === 0 ? `\`${name}()\` takes no arguments` : `\`${name}()\` takes ${registered.arity} argument`, n);
          if (!registered.fn) throw new Plain("uses-privileged", "reads through `privileged`", n);
          return call(registered.fn, args.map((arg) => sub(arg)));
        }
        // A free scope name is the root, never a helper imported under that name (EXP-12).
        const from = SCOPE_NAMES.has(name) ? undefined : ctx.helpers.get(name);
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
        const object = callee.object as N;
        if (object.type === "Identifier" && ctx.entities?.has(object.name!) && !SCOPE_NAMES.has(object.name!) && !env.roots.has(object.name!) && !env.locals.has(object.name!))
          throw new Plain("calls-entity", `a call to \`${object.name}.${op}\``, n);
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

/** Whether `node` holds an `await`, in a nested function too. */
function awaits(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(awaits);
  const n = node as N;
  if (n.type === "AwaitExpression") return true;
  return Object.entries(n).some(([key, value]) => key !== "loc" && key !== "extra" && typeof value === "object" && awaits(value));
}

const PARAMETER_ERROR = (n: N) => new Plain("unsupported-parameter", "this parameter form is not translated; destructure { self, input, actor, context, before }", n);

/** The names the scope of a function in an entity file no longer holds (TXN-16), each with what replaces it. */
const REMOVED_SCOPE_NAMES: Readonly<Record<string, { message: string; fix: string }>> = {
  tx: {
    message: "`tx` is gone: a function in an entity file is no longer handed a transaction handle, and reads with no policy through `privileged`",
    fix: "write `privileged(<Entity>).<read>(input)`, naming the entity (import it when it is another file's); it joins the running transaction",
  },
  actions: {
    message: "`actions` is gone: a function in an entity file calls another action as a method of the entity value",
    fix: "write `<Entity>.<action>(input, context)`, naming the entity (import it when it is another file's), and pass the context explicitly",
  },
};

/** An error at each name the function destructures from its scope that the scope no longer holds (`({ self, tx }) => ...`). */
function removedScopeNames(fn: N, ctx: ConvertContext): void {
  const param = (fn.params as N[] | undefined)?.[0];
  if (param?.type !== "ObjectPattern") return;
  for (const property of (param.properties ?? []) as N[]) {
    const key = property.type === "ObjectProperty" && !property.computed ? property.key as N | undefined : undefined;
    const name = key?.type === "Identifier" ? key.name : key?.type === "StringLiteral" ? String(key.value) : undefined;
    const removed = name !== undefined && Object.hasOwn(REMOVED_SCOPE_NAMES, name) ? REMOVED_SCOPE_NAMES[name]! : undefined;
    if (removed) ctx.report({ severity: "error", code: "MESH_REMOVED_SCOPE_NAME", message: removed.message, position: ctx.at(start(key!)), fix: removed.fix });
  }
}

/** Translate one function (`fn` is its Babel node, `span` its authored extent). */
/** What printing a translated expression as plain code needs, for the checker if it later demotes one: its edits and the scope names it reads. */
export interface Demotion { edits: SourceEdit[]; roots: string[]; clock?: ("now" | "today")[]; isSystem?: true; helpers?: string[] }
const demotions = new WeakMap<object, Demotion>();
export const demotionOf = (expression: object): Demotion => demotions.get(expression) ?? { edits: [], roots: [] };
export const rememberDemotion = (expression: object, demotion: Demotion): void => { demotions.set(expression, demotion); };
/** Where a function names Mesh's `privileged`, each call at its callee: a read policy must not (MESH_READ_POLICY_PRIVILEGED). */
const privilegedCalls = new WeakMap<object, readonly SourcePosition[]>();
export const privilegedCallsOf = (expression: object): readonly SourcePosition[] => privilegedCalls.get(expression) ?? [];
export const rememberPrivilegedCalls = (expression: object, calls: readonly SourcePosition[]): void => { privilegedCalls.set(expression, calls); };
/** How a function is asynchronous, if it is: written `async`, or using `await` in its own body: a computed field must not be (MESH_COMPUTED_ASYNC). */
export type Asynchrony = "async" | "await";
const asynchronous = new WeakMap<object, Asynchrony>();
export const asynchronyOf = (expression: object): Asynchrony | undefined => asynchronous.get(expression);
export const rememberAsynchrony = (expression: object, how: Asynchrony): void => { asynchronous.set(expression, how); };
const FUNCTION_NODES = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
/** Whether `fn` is `async`, or awaits in its own body (`await x`, `for await`); a function nested in it is its own business. */
export function asynchronyOfFunction(fn: SyntaxNode): Asynchrony | undefined {
  if ((fn as N).async) return "async";
  const own = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(own);
    const n = node as N;
    if (n.type === "AwaitExpression" || (n.type === "ForOfStatement" && n.await)) return true;
    if (FUNCTION_NODES.has(n.type)) return false;
    return Object.entries(n).some(([key, value]) => key !== "loc" && key !== "extra" && typeof value === "object" && own(value));
  };
  return own((fn as N).body) ? "await" : undefined;
}

export function translate(fn: SyntaxNode, span: { sourceStart: number; sourceEnd: number }, ctx: ConvertContext): { tree?: ExprNode; plain?: PlainReason; demotion?: Demotion; privilegedCalls?: SourcePosition[] } {
  const f = fn as N;
  const called = new Set<string>();
  const names: Names = { entities: new Set(), acts: false, helpers: new Set() };
  const free = freeVariables(f, ctx, called, names);
  removedScopeNames(f, ctx);
  // `now()` and `today()` in code Mesh does not translate read the same clock as a translated expression.
  const clock = (["now", "today"] as const).filter((name) => called.has(name));
  // `isSystem(context)` in code Mesh does not translate is Mesh's own function, as in a translated expression.
  const clocked = { ...(clock.length ? { clock } : {}), ...(called.has("isSystem") ? { isSystem: true as const } : {}) };
  // `privileged(...)`, the entities, the helpers and `structuredClone` the function names: the printed function binds the
  // first two and `structuredClone`, and its file imports the helpers (CMP-16, TXN-16, PRJ-20).
  const named = {
    ...(called.has("privileged") ? { privileged: true as const } : {}),
    ...(names.entities.size ? { entities: [...names.entities].sort() } : {}),
    ...(names.acts ? { acts: true as const } : {}),
    ...(names.helpers.size ? { helpers: [...names.helpers].sort() } : {}),
    ...(names.structuredClone ? { structuredClone: true as const } : {}),
  };
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
  const plain = (e: Plain): { plain: PlainReason; privilegedCalls?: SourcePosition[] } => {
    // A parameter Mesh does not translate (`(s) => ({ n: s.self.n })`) binds no scope name, so the parts cannot be read on their own.
    const object = e.why === "unsupported-parameter" ? undefined : objectParts();
    return {
      plain: { why: e.why, detail: e.detail, position: ctx.at(start(e.node) || span.sourceStart), edits: editsFor(f, span.sourceStart), roots: free, ...clocked, ...named, ...((object ? hasDifferingOperator(object.rest) : hasDifferingOperator(f.body)) ? { operators: true as const } : {}), ...(object?.parts.length ? { parts: object.parts } : {}), ...(f.type === "FunctionExpression" ? { method: true as const } : {}) },
      // A function that names `privileged` is always plain (`uses-privileged`), so only a plain one carries the calls.
      ...(names.privileged ? { privilegedCalls: names.privileged } : {}),
    };
  };
  try {
    if (ctx.runStep) throw new Plain("run-step", "a run step is plain code", f);
    // A function that reads through `privileged` or names an entity is plain code as a whole, whatever else it does: what
    // it reads is not an expression over the record, so its `await` or its comparisons are no reason to warn.
    if (called.has("privileged")) throw new Plain("uses-privileged", "reads through `privileged`", f);
    if (names.entities.size || names.acts) throw new Plain("calls-entity", "names an entity", f);
    // An imported function it awaits reads what it needs (through `privileged`, say): the `await` is how it is called,
    // not something Mesh could translate, so it is no reason to warn either.
    if (names.helpers.size && awaits(f.body as N)) throw new Plain("awaits-helper", "awaits an imported function", f);
    const params = (f.params ?? []) as N[];
    if (params.length > 1) throw PARAMETER_ERROR(f);
    if (params[0]) {
      if (params[0].type !== "ObjectPattern") throw PARAMETER_ERROR(params[0]);
      for (const p of params[0].properties ?? []) {
        const key = (p as N).key as N | undefined;
        const value = (p as N).value as N | undefined;
        if ((p as N).type !== "ObjectProperty" || (p as N).computed || !key || value?.type !== "Identifier") throw PARAMETER_ERROR(f);
        const root = key.name!;
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
    return { tree, demotion: { edits: editsFor(f, span.sourceStart), roots: free, ...clocked, ...(names.helpers.size ? { helpers: [...names.helpers].sort() } : {}) } };
  } catch (e) {
    if (e instanceof Plain) return plain(e);
    throw e;
  }
}
