import { dirname, posix, relative } from "node:path";
import type { Action, Entity, Expression, ExprNode, Policy, Step } from "@meshfw/model";
import { policyExpressions, readsRecord } from "../../model/policies.ts";
import type { EmitInput } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { newInstanceComputed, newInstanceGaps, newInstanceMembers } from "../../model/new-instance.ts";
import { emittedNothing, printExpression, ROOTS, type EntityLocals, type NamedInTypes } from "../expression-printer.ts";
import { typeNames } from "../type-names.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { hasLoader } from "./load.ts";
import { entityFileComment } from "./types.ts";
import { effectiveActions, entityInputs, entityLocal, entityPath, entitySegment, typeName } from "./inputs.ts";

/**
 * What `expressions.ts.jig` renders for one entity: every expression in its entity file as
 * one function of a scope, keyed by a stable id. Every string is final; the template prints,
 * loops and branches on these fields and computes nothing.
 */
export interface ExpressionsView {
  /** The entity file this file is generated from, project-relative, line terminators escaped as `\uXXXX`. */
  readonly entityFile: string;
  /** True when some entry is a translated tree, so the file calls `$`. */
  readonly usesExpr: boolean;
  /** True when a scope names `$SharedInput`: an `always` block or a policy covers actions with different inputs. */
  readonly usesSharedInput: boolean;
  /** The entity's record type name, e.g. `Invoice`, for the comments. */
  readonly recordName: string;
  /** The local the file imports the record type under, `entityLocal(entity, "Record")`, e.g. `$billing$Invoice$Record`. */
  readonly recordLocal: string;
  /** The module specifier of the entity's types file as a quoted string literal. */
  readonly typesFromLiteral: string;
  /**
   * What the file imports from the types file, as printed: the record type, its fully loaded type and the input types the
   * scopes name, each under its `entityLocal` (`Invoice as $billing$Invoice$Record`, `PayInvoiceInput as
   * $billing$Invoice$PayInvoiceInput`), so that no generated name at module level is one a helper import could have.
   */
  readonly typeImports: readonly string[];
  /**
   * The entity file's `Mesh` import (PRJ-22) as the file imports it from `@meshfw/runtime`, one entry per name the entity
   * file gives it that a function reads, as printed inside the runtime import's braces: `Mesh`, `Mesh as M`, or `type Mesh`
   * when the functions name it only in a type (`typeof Mesh.isSystem`). Empty when no function reads it. It is a constant,
   * the same object application code imports from `meshfw`, so the functions read it as they read a helper.
   */
  readonly meshImports: readonly string[];
  /**
   * The entity values the functions name (CMP-16), one import per entity's actions file: the value as
   * `entityLocal(target, "value")` and its read-only type as `entityLocal(target, "ReadOnly")` (`Task as $work$Task$value,
   * type $ReadOnly as $work$Task$ReadOnly`), so that two entities with one name never share a local. A function binds
   * each under the name the entity file gives it, the alias its import wrote included (`const BList: ... = $b$List$value`).
   * Another entity a function names as a type comes from the same file as `entityLocal(target, "Record")` (`type Task as
   * $work$Task$Record`, the record type the actions file exports with the value), and the function binds it as a type
   * (`type BList = $b$List$Record`); `keyword` is `import type` when that is all the file takes from it.
   */
  readonly entityImports: readonly { keyword: "import" | "import type"; names: string; fromLiteral: string }[];
  /**
   * The namespace imports of entity files (SYN-21) that the functions name in a type (`billing.Invoice | null`), each a
   * module-level `declare namespace billing { export type Invoice = $billing$Invoice$Record; }`: a function cannot declare
   * a namespace, and the value a function binds under the alias (`const billing = { Invoice: ... }`) has no types. `name`
   * is the alias, `members` the printed body, one `export type` per entity the file declares.
   */
  readonly entityNamespaces: readonly { name: string; members: string }[];
  /**
   * True when a plain function calls the global `structuredClone` (no binding of the function and no import of the file
   * has that name): the file imports `cloneValue` as `$cloneValue`, and each such function binds `structuredClone` to it,
   * since it copies a read-only record.
   */
  readonly shadowsStructuredClone: boolean;
  /**
   * The scope type's exported name, `entityLocal(entity, "Scope")`, e.g. `$billing$Invoice$Scope`; it takes the input type
   * as its parameter. Every scope type is named the same way (`StoredScope`, `CheckScope`, `NewScope`, `CreateScope`).
   */
  readonly scopeName: string;
  /** The scope type's definition, a generic over `I`, the input. */
  readonly scopeType: string;
  /** The scope of an expression that only runs on a stored record (an update or a destroy): the same, with `before` not null. */
  readonly storedScopeName: string;
  /**
   * The scope of a check, which sees `self` before the input is applied and has no `before` (ACT-01, ACT-27); null when no
   * check uses it.
   */
  readonly checkScope: ScopeDeclaration | null;
  /** The scope of a check that can run on a create, where `self` may be the new instance and some members are still null; null when none uses it. */
  readonly newScope: ScopeDeclaration | null;
  /** The scope of a step that can run on a create before the write, where the integer key is still null; null when none uses it. */
  readonly createScope: ScopeDeclaration | null;
  /** Imports of the helpers the expressions name, one per module. */
  readonly helperImports: readonly HelperImport[];
  /** One function per expression, in the order of the entity file. */
  readonly entries: readonly ExpressionEntry[];
  /** The globals the scope types name (`$Omit`), from `$globals.ts`; null when they name none. */
  readonly globals: GlobalsImport | null;
}
/** One import of the entity file's helpers into the expressions file. */
export interface HelperImport {
  /** `import type` when every name is named only in a type, else `import`. */
  readonly keyword: "import" | "import type";
  /**
   * What the import binds, as printed between `import` and `from`: the names in braces, sorted by the name the entity file
   * gives each, `{ fmt, type Money }`, where `type` marks a helper the functions name only in a type (`const x: Money`,
   * `typeof fmt`), or `{ Money }` alone when `keyword` is `import type`. A helper the entity file imports under an alias
   * keeps it: `{ fmt as format }`. A namespace import (SYN-21) is its own import: `* as h`.
   */
  readonly bindings: string;
  /** The helper module from the expressions file, a quoted string literal, e.g. `"../../../domain/work/money"`. */
  readonly fromLiteral: string;
}
/** A scope type the file declares: its exported name and its definition, a generic over `I`, the input. */
export interface ScopeDeclaration {
  readonly name: string;
  readonly type: string;
}
export interface ExpressionEntry {
  /** The stable id, as a quoted string literal: `"pay.check.invoiceIsSent.that"`. */
  readonly key: string;
  /** One line saying what it is and where it was written. */
  readonly comment: string;
  /** `(s: $billing$Invoice$CheckScope<$billing$Invoice$PayInvoiceInput>) => ...`. */
  readonly code: string;
}

/** The scope roots, in the order a function binds them. */
const SCOPE_NAMES: readonly string[] = ROOTS;
/** A name an import can print bare; any other export name is printed as a string literal (`import { "a-b" as ab }`). */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/**
 * Which scope an expression reads: `base` (a computed field, a step that can run on a create after the write),
 * `stored` (a step on an update or a destroy), `check` (a check or a policy on a stored record), `new` (a check or a policy
 * that can run on a create) or `create` (a step that can run on a create before the write).
 */
type ScopeKind = "base" | "stored" | "check" | "new" | "create";
/** `actions`: the actions whose input the expression reads as `input`; none (a computed field) reads no input. */
interface Found { id: string; what: string; expression: Expression; boolean: boolean; run?: true; scope: ScopeKind; actions: readonly Action[] }

function collect(entity: Entity): Found[] {
  const found: Found[] = [];
  let stored = false;
  let actions: readonly Action[] = [];
  let phase: "other" | "check" | "step" = "other";
  const add = (id: string, what: string, expression: Expression, boolean: boolean, run?: "before" | "after") => {
    const scope: ScopeKind = phase === "check" ? (stored ? "check" : "new")
      : phase === "step" ? (stored ? "stored" : run === "after" ? "base" : "create")
        : "base";
    found.push({ id, what, expression, boolean, actions, scope, ...(run ? { run: true as const } : {}) });
  };
  const covers = (scope: { types?: readonly string[]; actions?: readonly { name: string }[] }) => effectiveActions(entity).filter((action) => action.kind !== "read"
    && ((!scope.types && !scope.actions) || scope.types?.includes(action.kind) || scope.actions?.some((ref) => ref.name === action.name)));
  entity.computed.forEach((c) => { if (c.body) add(`computed.${c.name}`, `computed ${c.name}`, c.body, false); });
  const checks = (prefix: string, list: { label: string; that: Expression; when?: Expression; details?: Expression; message: string | Expression }[]) => {
    phase = "check";
    for (const check of list) {
      add(`${prefix}.check.${check.label}.that`, `check :${check.label} that`, check.that, true);
      if (check.when) add(`${prefix}.check.${check.label}.when`, `check :${check.label} when`, check.when, true);
      if (check.details) add(`${prefix}.check.${check.label}.details`, `check :${check.label} details`, check.details, false);
      if (typeof check.message !== "string") add(`${prefix}.check.${check.label}.message`, `check :${check.label} message`, check.message, false);
    }
  };
  const steps = (prefix: string, list: Step[], path: string) => {
    phase = "step";
    list.forEach((step, index) => {
      const here = path === "" ? String(index) : `${path}.${index}`;
      if (step.kind === "set") {
        for (const { member, value } of step.assignments)
          if (typeof value === "object" && value !== null && "source" in value)
            add(`${prefix}.step.${here}.set.${member.name}`, `set &${member.name}`, value as Expression, false);
      } else if (step.kind === "when") {
        add(`${prefix}.step.${here}.when`, "step when", step.condition, true);
        steps(prefix, step.steps, here);
      } else if (step.kind === "run") add(`${prefix}.step.${here}.run`, "run", step.fn, false, step.after === "write" ? "after" : "before");
    });
  };
  for (const action of entity.actions) {
    stored = action.kind === "update" || action.kind === "destroy";
    actions = [action];
    phase = "other";
    if (action.filter) add(`${action.name}.filter`, `${action.name} filter`, action.filter, true);
    checks(action.name, action.validate);
    steps(action.name, action.do, "");
  }
  entity.always.forEach((block, i) => {
    // Does the block reach a create? One that names neither a type nor an action reaches every action.
    const kinds = new Set<string>([
      ...(block.types ?? []),
      ...(block.actions ?? []).map((ref) => entity.actions.find((a) => a.name === ref.name)?.kind ?? ref.name),
    ]);
    stored = kinds.size > 0 && !kinds.has("create");
    actions = covers(block);
    checks(`always.${i}`, block.validate);
    steps(`always.${i}`, block.do, "");
  });
  // A policy sees what a check sees (POL-08): `self` before the input, no `before`; the new instance when it covers a create.
  phase = "check";
  for (const policy of entity.policies) {
    actions = covers(policy);
    stored = !actions.some((action) => action.kind === "create");
    policy.authorizeIf.forEach((e, i) => add(`policy.${policy.name}.authorize-if.${i}`, `policy :${policy.name} authorize-if`, e, true));
    policy.forbidIf.forEach((e, i) => add(`policy.${policy.name}.forbid-if.${i}`, `policy :${policy.name} forbid-if`, e, true));
    if (policy.when) add(`policy.${policy.name}.when`, `policy :${policy.name} when`, policy.when, true);
  }
  return found;
}

function helpersIn(n: ExprNode, into: Set<string>): void {
  // `h.isStaff`: the import is the namespace's, `h` (SYN-21).
  if (n.kind === "helper") { into.add(n.name.split(".")[0]!); n.args.forEach((a) => helpersIn(a, into)); }
  else if (n.kind === "call") n.args.forEach((a) => helpersIn(a, into));
  else if (n.kind === "member") helpersIn(n.object, into);
  else if (n.kind === "quantify") { helpersIn(n.source, into); helpersIn(n.body, into); }
}

/**
 * The id each expression of the entity has in its expressions file (`"pay.check.invoiceIsSent.that"`), by the expression
 * object itself, so the actions file can name the function that runs a check or a step.
 */
export function expressionIds(entity: Entity): Map<Expression, string> {
  return new Map(collect(entity).map((found) => [found.expression, found.id]));
}

/**
 * The policies as `authorizer` from `@meshfw/runtime` takes them, an array literal: each with its `when` and its checks,
 * every function with its source, where it runs (`record`: inside the transaction) and `ref(expression)`, how the generated
 * file reads it from the expressions file.
 */
export function policySpecs(policies: readonly Policy[], ref: (expression: Expression) => string, on: "write" | "read"): string {
  const fn = (expression: Expression) => `check: ${JSON.stringify(expression.source)}, record: ${readsRecord(expression, on)}, run: ${ref(expression)}`;
  const specs = policies.map((policy) => {
    const checks = policyExpressions(policy).filter(({ kind }) => kind !== "when").map(({ kind, expression }) => `{ kind: ${JSON.stringify(kind)}, ${fn(expression)} }`);
    return `{ name: ${JSON.stringify(policy.name)}, when: ${policy.when ? `{ ${fn(policy.when)} }` : "null"}, checks: [${checks.join(", ")}] }`;
  });
  return `[${specs.join(", ")}]`;
}

/** The entities that have at least one expression get a file; the rest get none. */
export function hasExpressions(entity: Entity): boolean {
  return collect(entity).length > 0;
}

export function expressionsView({ document }: EmitInput, entity: Entity, generatedPath: string): ExpressionsView {
  const recordName = typeName(entity.name, entity.position);
  // Every module-level name the file takes from generated code is a `$` local (CMP-05, CMP-06): Mesh's own imports have
  // one `$`, and the entity's own types and scopes, like the entity values it imports, are `entityLocal`s. The only
  // names without one are the entity file's helper imports, which cannot start with `$`.
  const recordLocal = entityLocal(entity, "Record");
  const scopeName = entityLocal(entity, "Scope");
  const storedScopeName = entityLocal(entity, "StoredScope");
  const checkScopeName = entityLocal(entity, "CheckScope");
  const newScopeName = entityLocal(entity, "NewScope");
  const createScopeName = entityLocal(entity, "CreateScope");
  // `self` carries every relationship and computed field, each related record the same way (M7): the action loads what
  // a function reads before calling it, and a member that was not loaded throws instead of being undefined.
  const loaded = hasLoader(entity);
  const selfType = loaded ? entityLocal(entity, "Loaded") : recordLocal;
  // `context` is the project's `ActionContext` (PRJ-02, PRJ-12) and `actor` its `actor` member, so a read of a member the
  // project did not declare fails tsc (EXP-12: a root is like a parameter, and a parameter has a type). A project that
  // declares no `actor` gets `undefined`, which is what the runtime binds (`options.actor`), so a read fails at the read,
  // not at this alias, and `actor` is assignable to nothing. The test is on `keyof`, so an optional `actor?: User`
  // is `User | undefined` (an `infer` pattern on `{ actor: infer A }` would miss it). `$ActionContext extends infer C` makes
  // `C` a type variable: TypeScript 7 refuses the index `C["actor"]` on the concrete interface in the branch of a conditional.
  const scopeType = `$Scope<{ self: $DeepReadonly<${selfType}>; input: $DeepReadonly<I>; actor: $ActionContext extends infer C ? "actor" extends keyof C ? { [K in keyof C]-?: C[K] }["actor"] | (C extends { actor: unknown } ? never : undefined) : undefined : never; context: $ActionContext; before: $DeepReadonly<${recordLocal}> | null }>`;
  const found = collect(entity);
  // On a create, `self` is the new instance (ACT-27): the members nothing has filled yet are null there, so the scopes
  // of the functions that can run on one say so.
  const gaps = newInstanceGaps(entity);
  const withNulls = (members: readonly string[]) => {
    const names = members.map((name) => JSON.stringify(name)).join(" | ");
    return `$DeepReadonly<$Omit<${selfType}, ${names}> & { [K in ${names}]: ${selfType}[K] | null }>`;
  };
  const unfilled = newInstanceMembers(gaps, loaded);
  // A computed field that reads one of them is evaluated over the nulls: null too, whatever its stored type says.
  const nullOnNew = [...unfilled, ...newInstanceComputed(entity, new Set(unfilled))];
  const scopeOf = (kind: ScopeKind): string =>
    kind === "new" ? (unfilled.length ? newScopeName : checkScopeName)
      : kind === "check" ? checkScopeName
        : kind === "create" ? (gaps.key ? createScopeName : scopeName)
          : kind === "stored" ? storedScopeName : scopeName;
  const usedScopes = new Set(found.map((f) => scopeOf(f.scope)));
  const checkScope = usedScopes.has(checkScopeName) || usedScopes.has(newScopeName)
    ? { name: checkScopeName, type: `$Omit<${scopeName}<I>, "before">` } : null;
  const newScope = usedScopes.has(newScopeName)
    ? { name: newScopeName, type: `$Omit<${checkScopeName}<I>, "self"> & { self: ${withNulls(nullOnNew)} }` } : null;
  const createScope = usedScopes.has(createScopeName) && gaps.key
    ? { name: createScopeName, type: `$Omit<${scopeName}<I>, "self"> & { self: ${withNulls([gaps.key])} }` } : null;
  // The input an expression reads: its action's, the fields the covered actions share for an `always` block or a policy, none for a computed field.
  const inputs = entityInputs(entity, document);
  const inputNames = new Map(effectiveActions(entity).map((action, index) => [action.name, inputs[index]!.name]));
  const usedInputs = new Set<string>();
  let shared = false;
  const inputOf = (actions: readonly Action[]): string => {
    const names = [...new Set(actions.map((action) => inputNames.get(action.name)!))];
    names.forEach((name) => usedInputs.add(name));
    const locals = names.map((name) => entityLocal(entity, name));
    if (locals.length === 0) return "unknown";
    if (locals.length === 1) return locals[0]!;
    shared = true;
    return `$SharedInput<${locals.join(" | ")}>`;
  };
  // Helper imports: the entity file's non-entity imports, rewritten relative to the generated file, each by the name the
  // entity file gives it and the name its module exports it under (`import { fmt as format }`).
  const helperFrom = new Map<string, { from: string; imported: string; namespace?: true }>();
  for (const imported of entity.imports)
    if (imported.helper)
      imported.identifiers.forEach((name, index) => helperFrom.set(name, { from: imported.from, imported: imported.imported?.[index] ?? name, ...(imported.namespace ? { namespace: true as const } : {}) }));
  const used = new Set<string>();
  for (const { expression } of found) {
    if (expression.tree) helpersIn(expression.tree, used);
    else for (const name of expression.plain!.helpers ?? []) used.add(name);
  }
  // The entities the functions can name, each under the name the entity file gives it (CMP-16): its own and the imported
  // ones. Each is imported from its actions file under FQN-derived locals and bound in each function under that name.
  // A namespace import of an entity file (SYN-21) names that file's entities under its alias, `billing` for
  // `billing.Invoice`: a function binds the alias to an object of their values, and the file declares a namespace of
  // their record types.
  const targets = new Map<string, Entity>();
  const namespaceTargets = new Map<string, Entity[]>();
  for (const local of new Set([entity.name, ...entity.imports.filter((entry) => !entry.helper && !entry.mesh).flatMap((entry) => entry.identifiers)])) {
    const imported = entity.imports.find((entry) => !entry.helper && !entry.mesh && entry.identifiers.includes(local));
    const file = imported ? posix.normalize(posix.join(dirname(entity.file), imported.from)) : entity.file;
    const target = document.entities.find((candidate) => candidate.file === file);
    if (target && imported?.namespace) namespaceTargets.set(local, [target]);
    else if (target) targets.set(local, target); // else the front end reported the import
  }
  /** The entities a name the functions read stands for: the one it names, or each one of a namespace import's file. */
  const entitiesOf = (name: string): readonly Entity[] => namespaceTargets.get(name) ?? (targets.has(name) ? [targets.get(name)!] : []);
  const locals: EntityLocals = (name) => {
    const members = namespaceTargets.get(name);
    if (members) {
      const named = (local: (target: Entity) => string) => members.map((target) => `${typeName(target.name, target.position)}: ${local(target)}`);
      return {
        value: `{ ${named((target) => entityLocal(target, "value")).join(", ")} }`,
        type: `{ ${named((target) => entityLocal(target, "ReadOnly")).map((member) => `readonly ${member}`).join("; ")} }`,
        record: "",
      };
    }
    const target = targets.get(name);
    if (!target) throw emitError("MESH_UNKNOWN_ENTITY", `Entity ${name} is not imported by ${entity.file}`, entity.position);
    return { value: entityLocal(target, "value"), type: entityLocal(target, "ReadOnly"), record: entityLocal(target, "Record") };
  };
  // Each function is printed again when it names something only in a type; `emitted` is the last print's record of what
  // the printer wrote (the runtime's `expr`), which the file's import follows from, never a search of the text.
  let emitted = emittedNothing();
  const print = (f: Found, inTypes?: NamedInTypes) => {
    emitted = emittedNothing();
    return printExpression(f.expression, `${scopeOf(f.scope)}<${inputOf(f.actions)}>`, f.boolean, f.run === true, locals, inTypes, emitted);
  };
  let usesExpr = false;
  // What a plain function names only in a type: the front end never sees it (MX strips the types from the node it reads),
  // so the printed function is parsed for it (`typeNames`). A helper is imported as a type. A scope root read in a
  // `typeof` is bound as a root read as a value is (EXP-12: a root is like a parameter, so it hides a helper of its name
  // there), while a type reference never names a root (a root is a value) and is the helper of that name. An entity is
  // bound to its record type where it is named as a type, and to its value where it is read in a `typeof`.
  const unread = new Set([...helperFrom.keys()].filter((name) => !used.has(name)));
  const typed = new Set<string>();
  const valued = new Set<string>(found.flatMap(({ expression }) => expression.plain?.entities ?? []));
  const recordTypes = new Set<string>();
  const meshLocals = new Set(entity.imports.filter((entry) => entry.mesh).flatMap((entry) => entry.identifiers));
  const namespaceTypes = new Set<string>();
  const candidates = new Set([...unread, ...SCOPE_NAMES, ...targets.keys(), ...namespaceTargets.keys(), ...meshLocals]);
  // The names of the file's `Mesh` import the functions read as values, as the front end found them, and those `typeNames`
  // finds only in a type, never from the printed text, where a string could spell `Mesh`: the file imports each.
  const meshValues = new Set<string>(found.flatMap(({ expression }) => expression.plain?.mesh ?? []));
  const meshTypes = new Set<string>();
  const entries = found.map((f): ExpressionEntry => {
    let code = print(f);
    if (f.expression.plain) {
      const { types, values } = typeNames(code, candidates);
      const roots = SCOPE_NAMES.filter((name) => values.has(name));
      const inTypes: NamedInTypes = {
        roots,
        values: [...values].filter((name) => (targets.has(name) || namespaceTargets.has(name)) && !SCOPE_NAMES.includes(name) && !helperFrom.has(name)).sort(),
        types: [...types].filter((name) => targets.has(name) && !helperFrom.has(name)).sort(),
      };
      // `billing.Invoice` as a type: the alias is the file's namespace, declared once at module level.
      for (const name of types) if (namespaceTargets.has(name) && !helperFrom.has(name)) namespaceTypes.add(name);
      for (const name of values) if (meshLocals.has(name) && !SCOPE_NAMES.includes(name)) meshTypes.add(name);
      for (const name of [...types, ...[...values].filter((name) => !SCOPE_NAMES.includes(name))]) if (unread.has(name)) typed.add(name);
      if (roots.includes("before") && (f.scope === "check" || f.scope === "new")) {
        const policy = f.id.startsWith("policy.");
        throw emitError(policy ? "MESH_POLICY_BEFORE" : "MESH_VALIDATE_BEFORE",
          `${f.what} reads \`before\` in a type, which ${policy ? "a policy" : "`validate`"} does not have: it sees \`self\` before the input is applied (the stored record, or a create's new instance), and the caller's values as \`input.x\``,
          f.expression.position, "write `typeof self` for the record before the input, and `typeof input` for the caller's values");
      }
      if (inTypes.roots.length || inTypes.values.length || inTypes.types.length) {
        inTypes.values.forEach((name) => valued.add(name));
        inTypes.types.forEach((name) => recordTypes.add(name));
        code = print(f, inTypes);
      }
    }
    usesExpr ||= emitted.expr;
    return {
      key: JSON.stringify(f.id),
      comment: `${f.what}, ${f.expression.tree ? "translated" : `plain (${f.expression.plain!.why})`} (${entity.file}:${f.expression.position.line}:${f.expression.position.column + 1})`
        .replace(/[\r\n\u2028\u2029]/g, " "),
      code,
    };
  });
  // The entity imports: each value with its read-only type, and each record type, from the entity's actions file; its own
  // record type is already imported from its types file.
  const entityFrom = new Map<string, { names: Set<string>; value: boolean }>();
  for (const name of [...new Set([...valued, ...recordTypes, ...namespaceTypes])].sort()) {
    for (const target of entitiesOf(name)) { // none: `locals` reported it
      if (!valued.has(name) && target === entity) continue;
      let from = relative(dirname(entityPath(entity)), `${entityPath(target)}.actions`).replace(/\\/g, "/");
      if (!from.startsWith(".")) from = `./${from}`;
      const exported = typeName(target.name, target.position);
      const [value, type, record] = [entityLocal(target, "value"), entityLocal(target, "ReadOnly"), entityLocal(target, "Record")];
      const entry = entityFrom.get(from) ?? { names: new Set<string>(), value: false };
      if (valued.has(name)) { entry.names.add(`${exported} as ${value}`).add(`type $ReadOnly as ${type}`); entry.value = true; }
      if ((recordTypes.has(name) || namespaceTypes.has(name)) && target !== entity) entry.names.add(`type ${exported} as ${record}`);
      entityFrom.set(from, entry);
    }
  }
  const byModule = new Map<string, string[]>();
  for (const name of [...used, ...typed].filter((n) => helperFrom.has(n)).sort()) {
    const absolute = posix.join(dirname(entity.file), helperFrom.get(name)!.from);
    let relativePath = posix.relative(dirname(generatedPath), absolute);
    if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
    byModule.set(relativePath, [...(byModule.get(relativePath) ?? []), name]);
  }
  const helperImports = [...byModule].flatMap(([from, all]): HelperImport[] => {
    const named = (name: string) => {
      const { imported } = helperFrom.get(name)!;
      return imported === name ? name : `${IDENTIFIER.test(imported) ? imported : JSON.stringify(imported)} as ${name}`;
    };
    // A namespace import (SYN-21) cannot share braces: `import * as h from …`, a type import when the functions name `h`
    // only in a type.
    const namespaces = all.filter((name) => helperFrom.get(name)!.namespace).map((name): HelperImport => ({
      keyword: typed.has(name) && !used.has(name) ? "import type" : "import",
      bindings: `* as ${name}`,
      fromLiteral: JSON.stringify(from),
    }));
    const names = all.filter((name) => !helperFrom.get(name)!.namespace);
    if (!names.length) return namespaces;
    const typeOnly = names.every((name) => typed.has(name));
    return [{
      keyword: typeOnly ? "import type" : "import",
      bindings: `{ ${names.map((name) => (!typeOnly && typed.has(name) ? `type ${named(name)}` : named(name))).join(", ")} }`,
      fromLiteral: JSON.stringify(from),
    }, ...namespaces];
  });
  // `structuredClone` cannot copy the read-only views a function is handed (they are proxies), so a function that calls
  // the global binds it to `cloneValue`. The front end decided which functions do: not one that binds the name itself,
  // nor one whose file imports something under it, as a JavaScript global is hidden by either.
  const shadowsStructuredClone = found.some(({ expression }) => expression.plain?.structuredClone === true);
  return {
    entityFile: entityFileComment(entity),
    usesExpr,
    usesSharedInput: shared,
    recordName,
    recordLocal,
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    typeImports: [
      `${recordName} as ${recordLocal}`,
      ...(loaded ? [`${recordName}Loaded as ${selfType}`] : []),
      ...[...usedInputs].sort().map((name) => `${name} as ${entityLocal(entity, name)}`),
    ],
    meshImports: [...new Set([...meshValues, ...meshTypes])].sort()
      .map((name) => `${meshValues.has(name) ? "" : "type "}Mesh${name === "Mesh" ? "" : ` as ${name}`}`),
    entityImports: [...entityFrom].map(([from, { names, value }]) => ({
      keyword: value ? "import" as const : "import type" as const,
      names: [...names].map((name) => (value ? name : name.replace(/^type /, ""))).join(", "),
      fromLiteral: JSON.stringify(from),
    })),
    entityNamespaces: [...namespaceTypes].sort().map((name) => ({
      name,
      members: namespaceTargets.get(name)!
        .map((target) => `export type ${typeName(target.name, target.position)} = ${entityLocal(target, "Record")};`).join(" "),
    })),
    shadowsStructuredClone,
    scopeName,
    scopeType,
    storedScopeName,
    checkScope,
    newScope,
    createScope,
    helperImports,
    entries,
    // Only the scope types: the functions' code is authored, and a `$Omit` in a string there is no reference.
    globals: globalsImport(`${entityPath(entity)}.expressions`, { checkScope, newScope, createScope }),
  };
}
