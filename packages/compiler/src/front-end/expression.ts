import type {
  Diagnostic,
  ExprNode,
  FunctionId,
  InternalNames,
  PlainReason,
  PlainWhy,
  SourceEdit,
  SourcePosition,
} from "@meshfw/model";
import type { At, SyntaxNode } from "./tree.ts";
import type { Resolution, WrittenReference } from "./references.ts";

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
  /**
   * The entities the file names: its own and the ones it imports, by the name the file gives them, and the alias
   * of each namespace import of an entity file (`billing`, read as `billing.Invoice`).
   */
  entities?: ReadonlySet<string>;
  /**
   * The aliases of the file's namespace imports, of entity files (also in `entities`) and of helper modules (also
   * in `helpers`, whose functions a function calls as `h.isStaff(...)`).
   */
  namespaces?: ReadonlySet<string>;
  /** Resolves `billing.Invoice`, a member of an entity file's namespace import, as `entity=` does (`resolveReference`). */
  reference?: (written: WrittenReference) => Resolution;
  /** The names two imports bind: `MESH_DUPLICATE_IMPORT` reports them, so a use of one reports nothing more. */
  duplicates?: ReadonlySet<string>;
  /** The names the file imports `Mesh` under, from "meshfw": `Mesh`, or its alias. */
  mesh?: ReadonlySet<string>;
  report: (diagnostic: Diagnostic) => void;
  /** A `run` step is plain by form. */
  runStep?: boolean;
}

const ROOTS = new Set(["self", "input", "actor", "context", "before"]);
/**
 * The names of the scope a function is handed. They behave as the function's parameters do: inside the function
 * a free `input` or `context` is the root, even when the file imports something under that name (a helper, or an entity
 * under an alias such as `import { List as context }`), which stays the import everywhere outside the function.
 */
export const SCOPE_NAMES: ReadonlySet<string> = ROOTS;
/** The globals a function may use. `structuredClone` is one: the expressions file binds it to `cloneValue`, which copies a read-only record. */
const GLOBALS = new Set([
  "Math", "Number", "String", "Boolean", "Date", "JSON", "Array", "Object", "Map", "Set", "Promise",
  "Error", "RegExp", "Symbol", "console", "undefined", "NaN", "Infinity", "isNaN", "isFinite", "parseInt", "parseFloat",
  "structuredClone",
]);
/**
 * Mesh's own functions, which a function in an entity file reads as members of `Mesh`, imported from "meshfw"
 * (`import { Mesh } from "meshfw"`, or under an alias). `privileged` and `checkPolicies` and `can` have no
 * `fn`: a function that calls one is plain code, since what it reads is not an expression over the record. `args` is what a call passes, for the examples.
 * The instant is not one of them: it is the current transaction's, `%.now` (`TRANSACTION_MEMBERS`).
 */
const MESH_FUNCTIONS: ReadonlyMap<string, { fn?: FunctionId; arity: number; args: string }> = new Map([
  ["isSystem", { fn: "isSystem", arity: 1, args: "context" }],
  ["privileged", { arity: 1, args: "Task" }],
  // ask another action's policies. Plain code too: what they read is not an expression over the record.
  ["checkPolicies", { arity: 3, args: "Task.complete, input, context" }],
  ["can", { arity: 3, args: "Task.complete, input, context" }],
]);
/** The functions of `MESH_FUNCTIONS` that ask another action's policies (`Mesh.checkPolicies`, `Mesh.can`). */
const ASKING = new Set(["checkPolicies", "can"]);
/**
 * What `%.` reads: `%` is the current transaction, and these are its properties, values and not calls: `%.now`,
 * its instant, and `%.today`, that instant at 00:00 UTC: the registry's `now` and `today`, one instant per transaction,
 * read by translated and plain code alike.
 */
const TRANSACTION_MEMBERS: ReadonlyMap<string, { fn: "now" | "today"; what: string }> = new Map([
  ["now", { fn: "now", what: "the current transaction's instant" }],
  ["today", { fn: "today", what: "the current transaction's date, its instant at 00:00 UTC" }],
]);
const TRANSACTION_LIST = [...TRANSACTION_MEMBERS.keys()].map((name) => `\`%.${name}\``).join(" and ");
/** The `%.name` mark MX's transaction row leaves on the node it lowers `%.name` to (`syntax/transaction.ts`). */
const transactionMark = (n: N | undefined): { name: string; span: { sourceStart: number; sourceEnd: number } } | undefined =>
  (n?.extra as { mxTransaction?: { name: string; span: { sourceStart: number; sourceEnd: number } } } | undefined)?.mxTransaction;
/**
 * The `%.name` reads an assignment, an update, a `for...in`/`for...of` head or a `delete` writes to or through (`%.now`,
 * `%.now.x`, `[%.now] = ...`), from the marks only: the target's member-access root is marked, as `&name` is.
 */
function writtenTransaction(target: N | undefined): N[] {
  if (!target) return [];
  let root = target;
  while (!transactionMark(root) && (root.type === "MemberExpression" || root.type === "OptionalMemberExpression") && root.object)
    root = root.object as N;
  if (transactionMark(root)) return [root];
  if (target.type === "ArrayPattern") return ((target.elements ?? []) as (N | null)[]).flatMap((e) => writtenTransaction(e ?? undefined));
  if (target.type === "ObjectPattern")
    return ((target.properties ?? []) as N[]).flatMap((p) => writtenTransaction((p.value ?? p.argument) as N | undefined));
  if (target.type === "RestElement" || target.type === "AssignmentPattern") return writtenTransaction((target.argument ?? target.left) as N | undefined);
  return [];
}
/**
 * The `%.name` reads a call's callee or a tagged template's tag can be the value of, so that the call calls it: the read
 * itself (`%.now()`), through parentheses and type assertions, a sequence's last expression (`(0, %.now)()`), a
 * conditional's branches, and the operands of `||` and `??` and the right one of `&&`.
 */
function calledTransaction(callee: N | undefined): N[] {
  if (!callee) return [];
  if (transactionMark(callee)) return [callee];
  switch (callee.type) {
    case "ParenthesizedExpression": case "TSAsExpression": case "TSSatisfiesExpression": case "TSNonNullExpression": case "TSTypeAssertion": case "TypeCastExpression":
      return calledTransaction(callee.expression as N | undefined);
    case "SequenceExpression": return calledTransaction(((callee.expressions ?? []) as N[]).at(-1));
    case "ConditionalExpression": return [...calledTransaction(callee.consequent as N), ...calledTransaction(callee.alternate as N)];
    case "LogicalExpression":
      return callee.operator === "&&" ? calledTransaction(callee.right as N) : [...calledTransaction(callee.left as N), ...calledTransaction(callee.right as N)];
    default: return [];
  }
}
/** The members every object has, which TypeScript gives `Mesh` too: reading one is no unknown Mesh function. */
const OBJECT_MEMBERS = new Set(["constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]);
/** `a`, `a and b`, `a, b and c`: the last item joined with "and" (an item may hold commas). */
const listed = (items: readonly string[]): string => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** `Mesh.isSystem(context)` as a file that imports `Mesh` under `local` writes it, with the call's own arguments when it has them. */
const meshCall = (local: string, name: string, args?: string) => `${local}.${name}(${args ?? MESH_FUNCTIONS.get(name)?.args ?? ""})`;
/**
 * The authored arguments of the call whose callee is the identifier the walk is at (`Eone` for `privileged(Eone)`), when
 * their number is the arity of Mesh's function of that name: a fix that rewrites the call keeps them.
 */
function ownArguments(name: string, parent: N | undefined, key: string | undefined, ctx: ConvertContext): string | undefined {
  if (!parent || key !== "callee" || (parent.type !== "CallExpression" && parent.type !== "OptionalCallExpression")) return undefined;
  const args = (parent.arguments ?? []) as N[];
  if (args.length !== MESH_FUNCTIONS.get(name)?.arity || args.length === 0) return undefined;
  const end = args[args.length - 1]!.end;
  return typeof end === "number" ? ctx.source.slice(start(args[0]!), end) : undefined;
}
/**
 * The member a node reads from the file's `Mesh` import (`isSystem` for `Mesh.isSystem`, `Mesh?.isSystem` or `Mesh["isSystem"]`), or undefined
 * when the node reads no named member of it. `shadowed` says whether a binding of the function in scope hides the name;
 * a scope name (`input`) is always the root, never an import of that name.
 */
function meshMember(n: N, ctx: ConvertContext, shadowed: (name: string) => boolean): { local: string; name: string } | undefined {
  if (n.type !== "MemberExpression" && n.type !== "OptionalMemberExpression") return undefined;
  const object = n.object as N;
  if (object?.type !== "Identifier" || !isMeshImport(object.name!, ctx, shadowed)) return undefined;
  const property = n.property as N;
  const name = fixedKey(property, n.computed);
  return name === undefined ? undefined : { local: object.name!, name };
}
/** The fixed key a member name or an object pattern key writes: an identifier, a string, or a template literal with no `${}` (its cooked text). */
function fixedKey(key: N | undefined, computed: boolean | undefined): string | undefined {
  if (key?.type === "Identifier") return computed ? undefined : key.name;
  if (key?.type === "StringLiteral") return String(key.value);
  if (key?.type === "TemplateLiteral" && ((key.expressions ?? []) as N[]).length === 0) {
    const cooked = ((key.quasis ?? []) as N[])[0]?.value as { cooked?: string | null } | undefined;
    return cooked?.cooked ?? undefined;
  }
  return undefined;
}
const isMeshImport = (name: string, ctx: ConvertContext, shadowed: (name: string) => boolean) =>
  ctx.mesh?.has(name) === true && !shadowed(name) && !SCOPE_NAMES.has(name);
/**
 * The members of the file's `Mesh` import that a read of it (`n`, an identifier that is that import) names, each with the
 * node that names it: the member it reads (`Mesh.isSystem`, `Mesh?.isSystem`, `Mesh["isSystem"]`), or each fixed key of an object pattern
 * it initialises (`const { privileged, now: clock } = Mesh`, `({ today } = Mesh)`, a parameter's default `{ now } = Mesh`).
 * A rest element or a computed key names no member: such a read is opaque, as passing `Mesh` to a helper is. So is any read of
 * `Mesh` whole (`const M = Mesh; M.can(...)`, `(0, Mesh).can`, `Mesh[k]`, `[Mesh].map(...)`): the build sees no call in it and
 * adds no error for it, since `const M = Mesh; M.isSystem(context)` is legal in a policy. It hides a call as a helper does:
 * refused at run time where a hidden call is refused (a computed field, a read policy), and run in a write policy.
 */
function meshReads(n: N, parent: N | undefined, key: string | undefined, ctx: ConvertContext, shadowed: (name: string) => boolean): { local: string; name: string; at: N }[] {
  if (!parent) return [];
  if (key === "object") {
    const member = meshMember(parent, ctx, shadowed);
    return member ? [{ ...member, at: parent.property as N }] : [];
  }
  const destructured = (parent.type === "VariableDeclarator" && key === "init") ? parent.id as N
    : ((parent.type === "AssignmentExpression" || parent.type === "AssignmentPattern") && key === "right") ? parent.left as N
    : undefined;
  if (destructured?.type !== "ObjectPattern") return [];
  return ((destructured.properties ?? []) as N[]).flatMap((property) => {
    if (property.type !== "ObjectProperty") return [];
    const at = property.key as N;
    const name = at?.type === "StringLiteral" ? String(at.value) : fixedKey(at, property.computed);
    return name === undefined ? [] : [{ local: n.name!, name, at }];
  });
}
const FREE_VARIABLE = (name: string) =>
  `\`${name}\` is not defined here: a function in an entity file may use its parameters, \`&members\`, imported helpers, its own entity and the imported ones, the transaction's ${TRANSACTION_LIST}, and Mesh's functions through \`Mesh\`, imported from "meshfw"`;
/**
 * What fixes an unknown name: a Mesh function written bare is a member of `Mesh`, which the file may not import yet. The
 * fix names the file's `Mesh` import where it can be read: an alias that a binding hides at the reference (`shadowed`), or
 * that is a scope name (`input`, refused at the import), is not one, and the fix says so instead of naming it.
 */
function freeVariableFix(name: string, ctx: ConvertContext, shadowed: (name: string) => boolean, args?: string): string {
  // A bare `now` or `today` is the transaction's.
  if (TRANSACTION_MEMBERS.has(name)) return `write \`%.${name}\`, ${TRANSACTION_MEMBERS.get(name)!.what}, with no \`()\``;
  const locals = [...(ctx.mesh ?? [])];
  const local = locals.find((candidate) => isMeshImport(candidate, ctx, shadowed));
  const hidden = local === undefined ? locals.find((candidate) => !SCOPE_NAMES.has(candidate)) : undefined;
  if (MESH_FUNCTIONS.has(name)) {
    if (local !== undefined) return `write \`${meshCall(local, name, args)}\``;
    if (hidden !== undefined) return `write \`${meshCall(hidden, name, args)}\`, renaming the binding that hides \`${hidden}\` here`;
    return locals.length
      ? `write \`${meshCall("Mesh", name, args)}\` and import \`Mesh\` under a name that is not a scope name: \`import { Mesh } from "meshfw"\``
      : `write \`${meshCall("Mesh", name, args)}\` and import \`Mesh\` from "meshfw": \`import { Mesh } from "meshfw"\``;
  }
  if (name === "Mesh") {
    if (local !== undefined) return `write \`${local}\`, the name this file imports \`Mesh\` under`;
    if (hidden !== undefined) return `write \`${hidden}\`, the name this file imports \`Mesh\` under, renaming the binding that hides it here`;
    return `import it: \`import { Mesh } from "meshfw"\``;
  }
  return "import it from a helper module, or pass it in through `context`";
}
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
 * A function's `var`s share the scope of its parameters, so `function f(at = Mesh.isSystem(c)) { var Mesh = 0 }` binds no
 * `Mesh`. JavaScript gives that default the outer `Mesh`, but Bun's engine does not when the outer binding is two or more
 * functions up, which a printed function's `Mesh` always is: it throws `ReferenceError: Mesh is not defined` (Bun 1.3.14
 * and 1.4.2; Node gives the outer one). Binding none keeps the failure at the type check (TS2304) instead of at run time.
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
 * that no scope of the function binds, in a fixed order: what the printed function takes from the scope. `&name` reads
 * none of them: it is the record's member whatever the function names a local, so it sets `names.record` instead. Each reference is resolved against its own enclosing scopes, as the `Mesh` import is: a
 * loop variable, a nested parameter or a `catch` parameter called `input` shadows the root only where it is in scope,
 * and a read of `input` elsewhere in the function is still the root.
 * Adds to `called` each of Mesh's functions (`isSystem`, `privileged`) the function reads as a member of the file's `Mesh`
 * import, called or not, and each member of the transaction it reads (`now` for `%.now`, `today` for `%.today`), reports
 * a `%.` name, call or write it refuses, and adds to `names.mesh` each name of the `Mesh` import it reads, where no enclosing scope
 * binds the name: each reference is resolved against its own scopes, so `[1].some((Mesh) => Mesh === 1) && Mesh.isSystem(c)`
 * reads the import (a function's `var`s count for its parameters: `scopeNames`).
 */
/** The identifier a member chain starts at: `billing` in `billing?.Invoice["open"]`, through any wrapper MX leaves. */
function chainRoot(n: N): N | undefined {
  let at: N | undefined = n;
  while (at && at.type !== "Identifier") {
    if (at.type === "MemberExpression" || at.type === "OptionalMemberExpression") at = at.object as N;
    else if (CHAIN_WRAPPERS.has(at.type)) at = at.expression as N;
    else return undefined;
  }
  return at;
}
const CHAIN_WRAPPERS = new Set(["ParenthesizedExpression", "TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"]);

function freeVariables(fn: N, ctx: ConvertContext, called: Set<string>, names: Names): string[] {
  const bound = bindings(fn);
  const roots = new Set<string>();
  const entities = ctx.entities ?? new Set<string>();
  const known = (name: string) =>
    bound.has(name) || ctx.imported.has(name) || entities.has(name) || SCOPE_NAMES.has(name) || GLOBALS.has(name);
  /** Whether a free `name` read in `scope` is an entity the file names: no scope binds it and it is no scope name. */
  const namesEntity = (name: string, scope: ReadonlySet<string>) => entities.has(name) && !scope.has(name) && !SCOPE_NAMES.has(name);
  /**
   * Whether `n` names one entity: an entity's name (`Invoice`), or a member of an entity file's namespace import
   * (`billing.Invoice`) that the file declares. A namespace alias alone names a file, not an entity.
   */
  const isEntity = (n: N | undefined, scope: ReadonlySet<string>): boolean => {
    if (n?.type === "Identifier") return namesEntity(n.name!, scope) && !ctx.namespaces?.has(n.name!);
    const object = n?.object as N | undefined;
    return n?.type === "MemberExpression" && !n.computed && object?.type === "Identifier" && (n.property as N)?.type === "Identifier"
      && namesEntity(object.name!, scope) && ctx.namespaces?.has(object.name!) === true
      && ctx.reference?.({ qualifier: { name: object.name!, offset: start(object) }, name: (n.property as N).name!, offset: start(n.property as N) }).ok !== false;
  };
  const walk = (value: unknown, parent: N | undefined, key: string | undefined, scope: ReadonlySet<string>): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walk(v, parent, key, scope); return; }
    const n = value as N;
    if (typeof n.type === "string" && n.type.startsWith("TS")) return;
    if (n.type === "PrivateName") return; // `#x` names a class member, never a variable
    // `%.now`: the current transaction's. It is read as a value, never called; its object, `%`, is no variable.
    const mark = transactionMark(n);
    if (mark) {
      const member = TRANSACTION_MEMBERS.get(mark.name);
      if (!member)
        ctx.report({
          severity: "error",
          code: "MESH_UNKNOWN_TRANSACTION_MEMBER",
          message: `\`%.${mark.name}\` is not a member of the transaction: \`%\` is the current transaction, and holds ${TRANSACTION_LIST}`,
          position: ctx.at(mark.span.sourceStart),
          fix: `write \`%.now\` for ${TRANSACTION_MEMBERS.get("now")!.what}, or \`%.today\` for ${TRANSACTION_MEMBERS.get("today")!.what}`,
        });
      else called.add(member.fn);
      return;
    }
    // `%.now()`, `new %.now`, `%.now\`x\``, `(0, %.now)()`: a call of the transaction's value, which is no function.
    const calledValue = n.type === "CallExpression" || n.type === "OptionalCallExpression" || n.type === "NewExpression" ? n.callee as N
      : n.type === "TaggedTemplateExpression" ? n.tag as N
      : undefined;
    for (const target of calledTransaction(calledValue)) {
      const mark = transactionMark(target)!;
      const member = TRANSACTION_MEMBERS.get(mark.name);
      if (member)
        ctx.report({
          severity: "error",
          code: "MESH_TRANSACTION_CALL",
          message: `\`%.${mark.name}\` is a value, not a function: it is ${member.what}`,
          position: ctx.at(mark.span.sourceStart),
          fix: `write \`%.${mark.name}\`, without ${n.type === "TaggedTemplateExpression" ? "the template after it" : n.type === "NewExpression" ? "\`new\`" : "\`()\`"}`,
        });
    }
    // `&name`: the record's member, whatever the function names a local (`self`): its stand-in `self` is no variable.
    if ((n.extra as { mxMember?: unknown } | undefined)?.mxMember && (n.type === "MemberExpression" || n.type === "OptionalMemberExpression")) {
      names.record = true;
      return;
    }
    // Writing to `%.now`, or through it, is refused: the transaction pins its instant.
    const written = n.type === "AssignmentExpression" ? n.left as N
      : n.type === "UpdateExpression" || (n.type === "UnaryExpression" && n.operator === "delete") ? n.argument as N
      : n.type === "ForInStatement" || n.type === "ForOfStatement" ? n.left as N
      : undefined;
    for (const target of writtenTransaction(written)) {
      const name = transactionMark(target)!.name;
      ctx.report({
        severity: "error",
        code: "MESH_TRANSACTION_ASSIGN",
        message: `\`%.${name}\` cannot be written: \`%\` is the current transaction, and ${TRANSACTION_MEMBERS.get(name)?.what ?? `\`%.${name}\``} is read only`,
        position: ctx.at(start(n)),
        fix: `read it into a local of the function and change that: \`let at = %.${TRANSACTION_MEMBERS.has(name) ? name : "now"}\``,
      });
    }
    if (n.type === "Identifier") {
      const property = parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed;
      const objectKey = parent && (parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") && key === "key" && !parent.computed;
      const label = parent && /^(LabeledStatement|BreakStatement|ContinueStatement)$/.test(parent.type) && key === "label";
      if (!property && !objectKey && !label && SCOPE_NAMES.has(n.name!) && !scope.has(n.name!)) roots.add(n.name!);
      // The file's `Mesh` import, where no binding of the function hides it: the expressions file imports `Mesh` under
      // that name, as it imports a helper, and a member it reads is one of Mesh's functions.
      if (!property && !objectKey && !label && isMeshImport(n.name!, ctx, (name) => scope.has(name))) {
        names.mesh.add(n.name!);
        // A destructured member counts as a read of it, so `const { privileged } = Mesh` is still a call to `privileged`
        // for MESH_COMPUTED_COMPOSES, MESH_READ_POLICY_PRIVILEGED and a check's timing.
        for (const member of meshReads(n, parent, key, ctx, (name) => scope.has(name))) {
          if (MESH_FUNCTIONS.has(member.name)) {
            called.add(member.name);
            if (member.name === "privileged") (names.privileged ??= []).push(ctx.at(start(key === "object" ? n : member.at)));
            if (ASKING.has(member.name)) (names.asks ??= []).push(ctx.at(start(key === "object" ? n : member.at)));
            continue;
          }
          if (OBJECT_MEMBERS.has(member.name)) continue;
          const at = member.at;
          // `Mesh.now()` and `Mesh.today()` are gone: the instant is the current transaction's.
          const instant = TRANSACTION_MEMBERS.get(member.name);
          if (instant) {
            ctx.report({
              severity: "error",
              code: "MESH_UNKNOWN_MESH_FUNCTION",
              message: `\`${member.local}.${member.name}\` is not one of Mesh's functions: ${instant.what} is \`%.${member.name}\`, a property of \`%\`, the current transaction`,
              position: ctx.at(start(at)),
              fix: `write \`%.${member.name}\`, with no \`()\``,
            });
            continue;
          }
          ctx.report({
            severity: "error",
            code: "MESH_UNKNOWN_MESH_FUNCTION",
            message: `\`${member.local}.${member.name}\` is not one of Mesh's functions: \`${member.local}\` holds ${listed([...MESH_FUNCTIONS.keys()].map((name) => `\`${meshCall(member.local, name)}\``))}`,
            position: ctx.at(start(at)),
            fix: `call one of them, or import a function of your own from a helper module`,
          });
        }
      }
      // A scope name is the root wherever no scope of the function binds it, so an import of that name is not named here.
      if (!property && !objectKey && !label && !scope.has(n.name!) && !SCOPE_NAMES.has(n.name!)) {
        if (entities.has(n.name!)) names.entities.add(n.name!);
        if (ctx.helpers.has(n.name!)) names.helpers.add(n.name!);
        // `billing.Invoice`: what the namespace import's file declares, resolved as `entity=` resolves it.
        // A computed member written as a string (`billing["Invoice"]`) names the same member.
        const member = parent?.property as N | undefined;
        const memberName = !parent?.computed && member?.type === "Identifier" ? member.name
          : parent?.computed && member?.type === "StringLiteral" ? String(member.value) : undefined;
        if (entities.has(n.name!) && ctx.namespaces?.has(n.name!) && ctx.reference && key === "object"
          && (parent!.type === "MemberExpression" || parent!.type === "OptionalMemberExpression") && memberName !== undefined) {
          const resolved = ctx.reference({ qualifier: { name: n.name!, offset: start(n) }, name: memberName, offset: start(member!) });
          if (!resolved.ok && "code" in resolved)
            ctx.report({ severity: "error", code: resolved.code, message: resolved.message, position: ctx.at(resolved.offset), fix: resolved.fix ?? null });
        }
        // The global `structuredClone`, unless the file imports something under its name.
        if (n.name === "structuredClone" && !ctx.imported.has(n.name) && !entities.has(n.name)) names.structuredClone = true;
      }
      if (!property && !objectKey && !label && !known(n.name!) && n.start !== undefined) {
        ctx.report({
          severity: "error",
          code: "MESH_EXPR_FREE_VARIABLE",
          message: FREE_VARIABLE(n.name!),
          position: ctx.at(start(n)),
          fix: freeVariableFix(n.name!, ctx, (name) => scope.has(name), ownArguments(n.name!, parent, key, ctx)),
        });
      }
      return;
    }
    // One of Mesh's functions called with the wrong number of arguments is an error, translated or plain (N3 of the M8a review).
    const callee = n.type === "CallExpression" || n.type === "OptionalCallExpression" ? n.callee as N : undefined;
    const member = callee ? meshMember(callee, ctx, (name) => scope.has(name)) : undefined;
    const spec = member ? MESH_FUNCTIONS.get(member.name) : undefined;
    const args = (n.arguments ?? []) as N[];
    if (member && spec && args.length !== spec.arity)
      ctx.report({
        severity: "error",
        code: "MESH_EXPR_ARITY",
        message: `\`${member.local}.${member.name}()\` takes ${spec.arity === 0 ? "no arguments" : `${spec.arity} argument${spec.arity === 1 ? "" : "s"}`}, and this call passes ${args.length}`,
        position: ctx.at(start(n)),
        fix: `write \`${meshCall(member.local, member.name)}\``,
      });
    // `Mesh.privileged(X)` takes an entity the file names: its own or an imported one, never a variable that holds one.
    const argument = args[0];
    const argumentRoot = argument && chainRoot(argument)?.name;
    if (member?.name === "privileged" && argument && !isEntity(argument, scope)
      && !(argumentRoot !== undefined && !scope.has(argumentRoot) && ctx.duplicates?.has(argumentRoot)))
      ctx.report({
        severity: "error",
        code: "MESH_PRIVILEGED_ENTITY",
        message: `\`${member.local}.privileged()\` takes an entity this file names, its own or an imported one${argument.type === "Identifier" ? `, and \`${argument.name}\` is not one${ctx.namespaces?.has(argument.name!) ? `: it is a namespace import, and \`${argument.name}.Name\` names the entity it holds` : ""}` : ""}`,
        position: ctx.at(start(argument)),
        fix: `write \`${member.local}.privileged(Task)\`, naming the entity, and import it when it is another file's`,
      });
    // `Task.touch(...)`: a call to an entity's action, through a namespace import too (`billing.Invoice.open(...)`).
    // Any call on a member chain that starts at an entity the file names acts, whatever the member syntax
    // (`billing?.Invoice.open`, `billing["Invoice"].open`, `Task.touch.call`), so no spelling escapes `MESH_POLICY_ACTS`
    // and `MESH_COMPUTED_COMPOSES`.
    const root = callee && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") ? chainRoot(callee) : undefined;
    if (root && namesEntity(root.name!, scope)) names.acts = true;
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
 * What a function names besides its scope: the entities, whether it calls an entity's action, the helpers it reads as
 * values, whether it calls the global `structuredClone` and whether it reads the record through `&name` (`record`). The
 * node has no types (MX strips them), so a helper named only in a type is left to the TypeScript back end (`typeNames` in
 * `typescript/type-names.ts`).
 */
interface Names { entities: Set<string>; acts: boolean; helpers: Set<string>; mesh: Set<string>; structuredClone?: true; privileged?: SourcePosition[]; asks?: SourcePosition[]; record?: true }

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

/**
 * Every identifier the authored text spells, in its code, its types, its strings and its comments alike, with `\u`
 * escapes decoded (`$\u006eow` spells `$now`): more than the names it binds, which is never wrong for `internalNames`.
 */
function spelled(text: string): Set<string> {
  const decoded = text.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (escape, braced?: string, plain?: string) => {
    const code = parseInt(braced ?? plain!, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
  return new Set(decoded.match(/[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/gu) ?? []);
}

/**
 * The names the printed function binds what Mesh's own edits read under (`InternalNames`): `$self` for the record when
 * the function reads `&name`, `$now` and `$today` for the transaction's `%.now` and `%.today`, each with the first number
 * that makes it a name the authored text does not spell (`$now1`). An author's local or parameter (`self`, `$`, `$s`)
 * cannot hide one, so `&n` is the record's member and `%.now` the transaction's instant wherever they are written.
 */
function internalNames(text: string, record: boolean, clock: readonly ("now" | "today")[]): InternalNames {
  const taken = spelled(text);
  const fresh = (base: string) => {
    let name = base;
    for (let n = 1; taken.has(name); n++) name = `${base}${n}`;
    return name;
  };
  return {
    ...(record ? { self: fresh("$self") } : {}),
    ...(clock.includes("now") ? { now: fresh("$now") } : {}),
    ...(clock.includes("today") ? { today: fresh("$today") } : {}),
  };
}

/**
 * The edits that turn the authored text into TypeScript: `&name` to the record's member (`$self.name`), `:atom` to a
 * string, and `%.now` and `%.today` to calls of the printed function's own `$now()` and `$today()`, which call the
 * run-time functions a translated expression calls over the scope the printed function is handed, so plain and
 * translated code read one instant, a fresh `Date` each read. The names are `internal`'s, which the authored text
 * does not spell. A `%.` name Mesh does not know is reported by `freeVariables` and left as written.
 */
function editsFor(fn: N, base: number, internal: InternalNames): SourceEdit[] {
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
    if ((n.type === "MemberExpression" || n.type === "OptionalMemberExpression") && member)
      edits.push({ from: member.span.sourceStart - base, to: member.span.sourceEnd - base, text: `${internal.self}.${member.name}`, member: member.name, ...(fallbacks.has(n) ? { fallback: true as const } : {}) });
    const instant = transactionMark(n);
    if (instant) {
      const known = TRANSACTION_MEMBERS.get(instant.name);
      if (known) edits.push({ from: instant.span.sourceStart - base, to: instant.span.sourceEnd - base, text: `${internal[known.fn]}()` });
      return;
    }
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
          fix: freeVariableFix(name, ctx, (local) => env.roots.has(local) || env.locals.has(local)),
        });
        throw new Plain("unsupported-construct", `the name \`${name}\``, n);
      }
      throw new Plain("unsupported-construct", `the name \`${name}\``, n);
    }
    case "MemberExpression": case "OptionalMemberExpression": {
      // `%.now`: the transaction's instant, the function `now` of the scope. An unknown name was reported.
      const instant = transactionMark(n);
      if (instant) {
        const known = TRANSACTION_MEMBERS.get(instant.name);
        if (!known) throw new Plain("unsupported-construct", `\`%.${instant.name}\``, n);
        return { kind: "call", fn: known.fn, args: [], position: ctx.at(instant.span.sourceStart) };
      }
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
      // `Mesh.isSystem(context)`: one of Mesh's functions, through the file's `Mesh` import that no parameter hides.
      const member = meshMember(callee, ctx, (local) => env.roots.has(local) || env.locals.has(local));
      const spec = member && n.type === "CallExpression" ? MESH_FUNCTIONS.get(member.name) : undefined;
      if (member && spec) {
        if (args.length !== spec.arity)
          throw new Plain("unsupported-construct", spec.arity === 0 ? `\`${member.local}.${member.name}()\` takes no arguments` : `\`${member.local}.${member.name}()\` takes ${spec.arity} argument`, n);
        if (!spec.fn)
          throw ASKING.has(member.name) ? new Plain("asks-policies", `asks through \`${member.local}.${member.name}\``, n) : new Plain("uses-privileged", `reads through \`${member.local}.privileged\``, n);
        return call(spec.fn, args.map((arg) => sub(arg)));
      }
      if (callee.type === "Identifier") {
        const name = callee.name!;
        // A free scope name is the root, never a helper imported under that name.
        // A namespace import (`h`) is the module, not one of its functions: `h.isStaff(...)` is the call.
        const from = SCOPE_NAMES.has(name) || ctx.namespaces?.has(name) ? undefined : ctx.helpers.get(name);
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
        // `h.isStaff(...)`: a function of a helper module the file imports as a namespace, called as an imported one is.
        const local = object.type === "Identifier" ? object.name! : undefined;
        const from = local !== undefined && ctx.namespaces?.has(local) && !SCOPE_NAMES.has(local) && !env.roots.has(local) && !env.locals.has(local)
          ? ctx.helpers.get(local) : undefined;
        if (from !== undefined) {
          const name = `${local}.${op}`;
          const before = env.reads.record;
          env.reads.record = false;
          const converted = args.map((a) => sub(a, true));
          if (env.reads.record) throw new Plain("reads-record-in-helper", `a call to ${name}, which is given the record`, n);
          env.reads.record = before;
          return { kind: "helper", name, from, args: converted, position };
        }
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
      throw new Plain("unsupported-construct", describeConstruct(n), n);
  }
}

/**
 * What the author wrote, for a node `convert` does not translate. The message `MESH_EXPR_PLAIN` prints says "because of
 * <this>", so it names the construct in the author's own syntax, never the parser's node name (`OptionalCallExpression`).
 * A node the table does not know still gets a sentence the author can read.
 */
const CONSTRUCTS: Readonly<Record<string, string>> = {
  TemplateLiteral: "a template literal",
  TaggedTemplateExpression: "a tagged template literal",
  ArrayExpression: "an array literal",
  ObjectExpression: "an object literal",
  ArrowFunctionExpression: "an arrow function used as a value",
  FunctionExpression: "a function expression",
  ClassExpression: "a class expression",
  SequenceExpression: "the comma operator",
  ThisExpression: "`this`",
  Super: "`super`",
  RegExpLiteral: "a regular expression literal",
  BigIntLiteral: "a bigint literal",
  NewExpression: "a `new` expression",
  AssignmentExpression: "an assignment",
  UpdateExpression: "`++` or `--`",
  AwaitExpression: "`await`",
  YieldExpression: "`yield`",
  SpreadElement: "a spread (`...`)",
  MetaProperty: "`import.meta` or `new.target`",
  Import: "a dynamic `import()`",
  ImportExpression: "a dynamic `import()`",
  PrivateName: "a private name (`#name`)",
};
function describeConstruct(n: N): string {
  // `a?.()` is optional; `a?.b()` is a call inside a `?.` chain, which Babel also types as an optional call.
  if (n.type === "OptionalCallExpression") return n.optional === true ? "an optional call (`?.()`)" : "a method call in a `?.` chain";
  return CONSTRUCTS[n.type] ?? "a construct Mesh does not translate";
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

/** The names the scope of a function in an entity file no longer holds, each with what replaces it. */
const REMOVED_SCOPE_NAMES: Readonly<Record<string, { message: string; fix: string }>> = {
  tx: {
    message: "`tx` is gone: a function in an entity file is no longer handed a transaction handle, and reads with no policy through `Mesh.privileged`",
    fix: "write `Mesh.privileged(<Entity>).<read>(input)`, naming the entity (import it when it is another file's) and importing `Mesh` from \"meshfw\"; it joins the running transaction",
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
export interface Demotion { edits: SourceEdit[]; roots: string[]; clock?: ("now" | "today")[]; internal?: InternalNames; isSystem?: true; helpers?: string[]; mesh?: string[]; method?: true }
const demotions = new WeakMap<object, Demotion>();
export const demotionOf = (expression: object): Demotion => demotions.get(expression) ?? { edits: [], roots: [] };
export const rememberDemotion = (expression: object, demotion: Demotion): void => { demotions.set(expression, demotion); };
/** Where a function names Mesh's `privileged` (`Mesh.privileged`), each call at its callee: a read policy must not (MESH_READ_POLICY_PRIVILEGED). */
const privilegedCalls = new WeakMap<object, readonly SourcePosition[]>();
export const privilegedCallsOf = (expression: object): readonly SourcePosition[] => privilegedCalls.get(expression) ?? [];
export const rememberPrivilegedCalls = (expression: object, calls: readonly SourcePosition[]): void => { privilegedCalls.set(expression, calls); };
/** Where a function names `Mesh.checkPolicies` or `Mesh.can`, each at its callee: a policy must not ask (MESH_POLICY_ASKS). */
const askCalls = new WeakMap<object, readonly SourcePosition[]>();
export const askCallsOf = (expression: object): readonly SourcePosition[] => askCalls.get(expression) ?? [];
export const rememberAskCalls = (expression: object, calls: readonly SourcePosition[]): void => { askCalls.set(expression, calls); };
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

export function translate(fn: SyntaxNode, span: { sourceStart: number; sourceEnd: number }, ctx: ConvertContext): { tree?: ExprNode; plain?: PlainReason; demotion?: Demotion; privilegedCalls?: SourcePosition[]; askCalls?: SourcePosition[] } {
  const f = fn as N;
  const called = new Set<string>();
  const names: Names = { entities: new Set(), acts: false, helpers: new Set(), mesh: new Set() };
  const free = freeVariables(f, ctx, called, names);
  removedScopeNames(f, ctx);
  // `%.now` and `%.today` in code Mesh does not translate read the same instant as a translated expression, and
  // `Mesh.isSystem(context)` is the same function: the expressions file imports `Mesh` under each name the file gives it
  // that a function reads. The demotion keeps them for a tree the checker demotes. The record `&name` reads and
  // the instant are bound under names the authored text does not spell, which the edits read.
  const clock = (["now", "today"] as const).filter((name) => called.has(name));
  const internal = internalNames(ctx.source.slice(span.sourceStart, span.sourceEnd), names.record === true, clock);
  const edits = editsFor(f, span.sourceStart, internal);
  const clocked = {
    ...(clock.length ? { clock } : {}),
    ...(Object.keys(internal).length ? { internal } : {}),
    ...(called.has("isSystem") ? { isSystem: true as const } : {}),
    ...(names.mesh.size ? { mesh: [...names.mesh].sort() } : {}),
  };
  // `Mesh.privileged(...)`, the entities, the helpers and `structuredClone` the function names: the printed function binds
  // the entities and `structuredClone`, and its file imports the helpers.
  const named = {
    ...(called.has("privileged") ? { privileged: true as const } : {}),
    ...(called.has("checkPolicies") || called.has("can") ? { asks: true as const } : {}),
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
  const plain = (e: Plain): { plain: PlainReason; privilegedCalls?: SourcePosition[]; askCalls?: SourcePosition[] } => {
    // A parameter Mesh does not translate (`(s) => ({ n: s.self.n })`) binds no scope name, so the parts cannot be read on their own.
    const object = e.why === "unsupported-parameter" ? undefined : objectParts();
    return {
      plain: { why: e.why, detail: e.detail, position: ctx.at(start(e.node) || span.sourceStart), edits, roots: free, ...clocked, ...named, ...((object ? hasDifferingOperator(object.rest) : hasDifferingOperator(f.body)) ? { operators: true as const } : {}), ...(object?.parts.length ? { parts: object.parts } : {}), ...(f.type === "FunctionExpression" ? { method: true as const } : {}) },
      // A function that names `privileged` is always plain (`uses-privileged`), so only a plain one carries the calls.
      ...(names.privileged ? { privilegedCalls: names.privileged } : {}),
      ...(names.asks ? { askCalls: names.asks } : {}),
    };
  };
  try {
    if (ctx.runStep) throw new Plain("run-step", "a run step is plain code", f);
    // A function that reads through `Mesh.privileged` or names an entity is plain code as a whole, whatever else it does: what
    // it reads is not an expression over the record, so its `await` or its comparisons are no reason to warn.
    if (called.has("privileged")) throw new Plain("uses-privileged", "reads through `Mesh.privileged`", f);
    // `Mesh.checkPolicies` and `Mesh.can` run another action's policies, which read what they read: plain code as well.
    if (called.has("checkPolicies") || called.has("can")) throw new Plain("asks-policies", "asks another action's policies", f);
    if (names.entities.size || names.acts) throw new Plain("calls-entity", "names an entity", f);
    // An imported function it awaits reads what it needs (through `Mesh.privileged`, say): the `await` is how it is called,
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
    // A method (`() { return ... }`) printed as plain code needs `function` before it, whatever arrows its body holds.
    return { tree, demotion: { edits, roots: free, ...clocked, ...(names.helpers.size ? { helpers: [...names.helpers].sort() } : {}), ...(f.type === "FunctionExpression" ? { method: true as const } : {}) } };
  } catch (e) {
    if (e instanceof Plain) return plain(e);
    throw e;
  }
}
