/**
 * The names a printed plain function reads in its TypeScript types. MX strips the types from the Babel node the front
 * end reads (`const x: Money = 1 as Money` reaches it as `const x = 1`), so a helper an entity file imports and a
 * function names only in a type (`Money`, or `typeof fmt`) is not in `PlainReason.helpers`; the expressions file still
 * has to import it, since the function is printed as written. This module parses the printed function with the
 * TypeScript parser of Prettier, which the back end already formats with, and resolves each type position as
 * TypeScript does.
 */
import { parsers } from "prettier/plugins/typescript";

type Node = { type: string; [key: string]: any };
/** The keys of a node that hold no child node: positions, and the program's token and comment lists. */
const SKIP = new Set(["loc", "range", "parent", "tokens", "comments"]);
const children = (n: Node): unknown[] => Object.entries(n).flatMap(([key, child]) => (SKIP.has(key) ? [] : [child]));

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "TSDeclareFunction", "TSEmptyBodyFunctionExpression"]);
/** Nodes whose `typeParameters` are in scope for the whole node and nothing else. */
const GENERIC = new Set([
  "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "ClassDeclaration", "ClassExpression", "TSFunctionType",
  "TSConstructorType", "TSMethodSignature", "TSCallSignatureDeclaration", "TSConstructSignatureDeclaration",
]);

interface Scope { values: ReadonlySet<string>; types: ReadonlySet<string> }

/** Adds to `names` the names a binding pattern binds. */
function patternNames(p: Node | null | undefined, names: Set<string>): void {
  if (!p) return;
  switch (p.type) {
    case "Identifier": names.add(p.name); break;
    case "ObjectPattern": for (const property of p.properties) patternNames(property.type === "RestElement" ? property.argument : property.value, names); break;
    case "ArrayPattern": for (const element of p.elements) patternNames(element, names); break;
    case "AssignmentPattern": patternNames(p.left, names); break;
    case "RestElement": patternNames(p.argument, names); break;
    case "TSParameterProperty": patternNames(p.parameter, names); break;
  }
}

/** The `var`s of a function body, outside the functions nested in it. */
function hoistedVars(value: unknown, names: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const v of value) hoistedVars(v, names); return; }
  const n = value as Node;
  if (FUNCTIONS.has(n.type)) return;
  if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations) patternNames(d.id, names);
  for (const child of children(n)) hoistedVars(child, names);
}

/** What a statement list declares: values (`let`, `const`, functions, classes, enums) and types (aliases, interfaces, classes, enums). */
function declared(statements: readonly Node[], scope: { values: Set<string>; types: Set<string> }): void {
  for (const s of statements) {
    const statement = s.type === "ExportNamedDeclaration" && s.declaration ? s.declaration as Node : s;
    switch (statement.type) {
      case "VariableDeclaration": if (statement.kind !== "var") for (const d of statement.declarations) patternNames(d.id, scope.values); break;
      case "FunctionDeclaration": case "TSDeclareFunction": if (statement.id) scope.values.add(statement.id.name); break;
      case "ClassDeclaration": case "TSEnumDeclaration":
        if (statement.id) { scope.values.add(statement.id.name); scope.types.add(statement.id.name); }
        break;
      case "TSTypeAliasDeclaration": case "TSInterfaceDeclaration": scope.types.add(statement.id.name); break;
    }
  }
}

/** A type parameter's name: an identifier in the parser's tree, a string in older ones. */
const parameterName = (p: Node): string => (typeof p.name === "string" ? p.name : p.name.name);
const typeParameterNames = (declaration: Node | null | undefined): string[] => (declaration?.params ?? []).map(parameterName);

/** The `infer X` names of a conditional type's `extends` side, which its true branch sees. */
function inferNames(value: unknown, names: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const v of value) inferNames(v, names); return; }
  const n = value as Node;
  if (n.type === "TSInferType") names.add(parameterName(n.typeParameter));
  if (n.type === "TSConditionalType") return; // a nested conditional's `infer` is its own
  for (const child of children(n)) inferNames(child, names);
}

/** The first name of `A`, `A.B.C` (a qualified type name) or `a.b` (an expression in a heritage clause). */
function leftmost(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "Identifier") return n.name;
  if (n.type === "TSQualifiedName") return leftmost(n.left);
  if (n.type === "MemberExpression") return leftmost(n.object);
  return undefined;
}

const extend = (scope: Scope, values: Iterable<string>, types: Iterable<string>): Scope => {
  const v = [...values], t = [...types];
  return v.length === 0 && t.length === 0 ? scope : { values: new Set([...scope.values, ...v]), types: new Set([...scope.types, ...t]) };
};

/**
 * The names among `candidates` that `code`, one printed function, reads in a type position no scope of its own
 * declares: a type reference (`Money`, the `Money` of `Money.Amount`, an `extends`/`implements` clause) that no type
 * parameter, `infer`, local type, interface, class or enum of that name hides, or a `typeof` query (`typeof fmt`) that
 * no local variable of that name hides. A local variable does not hide a type of its name, as in TypeScript. Code the
 * parser refuses gives nothing: the formatter then reports it, positioned, when the file is formatted.
 */
export function typeNames(code: string, candidates: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  if (![...candidates].some((name) => code.includes(name))) return found;
  let program: Node;
  try { program = parsers.typescript.parse(code, {} as never) as Node; }
  catch { return found; }
  const read = (name: string | undefined, bound: ReadonlySet<string>) => {
    if (name !== undefined && candidates.has(name) && !bound.has(name)) found.add(name);
  };
  const walk = (value: unknown, scope: Scope): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) walk(v, scope); return; }
    const n = value as Node;
    if (typeof n.type !== "string") return;
    switch (n.type) {
      case "TSTypeReference": read(leftmost(n.typeName), scope.types); walk(n.typeArguments, scope); return;
      case "TSTypeQuery": read(leftmost(n.exprName), scope.values); walk(n.typeArguments, scope); return;
      case "TSInterfaceHeritage": case "TSClassImplements": read(leftmost(n.expression), scope.types); walk(n.typeArguments, scope); return;
      case "TSMappedType": {
        const key = n.key ? leftmost(n.key) : n.typeParameter ? parameterName(n.typeParameter) : undefined;
        const inner = extend(scope, [], key ? [key] : []);
        for (const child of children(n)) walk(child, inner);
        return;
      }
      case "TSConditionalType": {
        const infer = new Set<string>();
        inferNames(n.extendsType, infer);
        walk(n.checkType, scope);
        walk(n.extendsType, extend(scope, [], infer));
        walk(n.trueType, extend(scope, [], infer));
        walk(n.falseType, scope);
        return;
      }
    }
    let inner = scope;
    if (FUNCTIONS.has(n.type)) {
      const values = new Set<string>();
      if (n.type === "FunctionExpression" && n.id) values.add(n.id.name);
      for (const p of n.params ?? []) patternNames(p, values);
      hoistedVars(n.body, values);
      inner = extend(scope, values, typeParameterNames(n.typeParameters));
    } else if (GENERIC.has(n.type)) {
      const values = n.type === "ClassExpression" && n.id ? [n.id.name] : [];
      inner = extend(scope, values, [...typeParameterNames(n.typeParameters), ...values]);
    } else {
      const own = { values: new Set<string>(), types: new Set<string>() };
      switch (n.type) {
        case "Program": case "BlockStatement": case "StaticBlock": case "TSModuleBlock": declared(n.body, own); break;
        case "SwitchStatement": declared(n.cases.flatMap((c: Node) => c.consequent), own); break;
        case "ForStatement": if (n.init?.type === "VariableDeclaration") declared([n.init], own); break;
        case "ForInStatement": case "ForOfStatement": if (n.left?.type === "VariableDeclaration") declared([n.left], own); break;
        case "CatchClause": patternNames(n.param, own.values); break;
      }
      inner = extend(scope, own.values, own.types);
    }
    for (const child of children(n)) walk(child, inner);
  };
  walk(program, { values: new Set(), types: new Set() });
  return found;
}
