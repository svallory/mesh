import { dirname, posix, relative } from "node:path";
import type { Action, Entity, Expression, ExprNode, Policy, Step } from "@meshfw/model";
import { policyExpressions, readsRecord } from "../../model/policies.ts";
import type { EmitInput } from "../emit.ts";
import { newInstanceComputed, newInstanceGaps, newInstanceMembers } from "../../model/new-instance.ts";
import { entityType, entityValue, mentioned, printExpression } from "../expression-printer.ts";
import { hasLoader } from "./load.ts";
import { entityFileComment } from "./types.ts";
import { effectiveActions, entityInputs, entityPath, entitySegment, typeName } from "./inputs.ts";

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
  /** The entity's record type name, e.g. `Invoice`. */
  readonly recordName: string;
  /** The module specifier of the entity's types file as a quoted string literal. */
  readonly typesFromLiteral: string;
  /** What the file imports from the types file: the record type, its fully loaded type and the input types the scopes name. */
  readonly typeImports: readonly string[];
  /** True when a function calls `privileged(Entity)` (TXN-16): the file imports it from `@meshfw/runtime` as `$privileged`. */
  readonly usesPrivileged: boolean;
  /**
   * The entity values the functions name (CMP-16), one import per entity's actions file: the value as `$e$<local>` and its
   * read-only type as `$t$<local>`, under the name the entity file gives it.
   */
  readonly entityImports: readonly { names: string; fromLiteral: string }[];
  /** True when an expression mentions `structuredClone`: the file then shadows it with `cloneValue`, which copies a read-only record. */
  readonly shadowsStructuredClone: boolean;
  /** The scope type's exported name, e.g. `InvoiceScope`; it takes the input type as its parameter. */
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
  /** Imports of the helper functions the expressions call, one per module. */
  readonly helperImports: readonly { names: string; fromLiteral: string }[];
  /** One function per expression, in the order of the entity file. */
  readonly entries: readonly ExpressionEntry[];
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
  /** `(s: InvoiceScope<PayInvoiceInput>) => ...`. */
  readonly code: string;
}

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
  const checks = (prefix: string, list: { label: string; that: Expression; when?: Expression; details?: Expression }[]) => {
    phase = "check";
    for (const check of list) {
      add(`${prefix}.check.${check.label}.that`, `check :${check.label} that`, check.that, true);
      if (check.when) add(`${prefix}.check.${check.label}.when`, `check :${check.label} when`, check.when, true);
      if (check.details) add(`${prefix}.check.${check.label}.details`, `check :${check.label} details`, check.details, false);
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
  if (n.kind === "helper") { into.add(n.name); n.args.forEach((a) => helpersIn(a, into)); }
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
export function policySpecs(policies: readonly Policy[], ref: (expression: Expression) => string): string {
  const fn = (expression: Expression) => `check: ${JSON.stringify(expression.source)}, record: ${readsRecord(expression)}, run: ${ref(expression)}`;
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
  const scopeName = `${recordName}Scope`;
  const storedScopeName = `${recordName}StoredScope`;
  // `self` carries every relationship and computed field, each related record the same way (M7): the action loads what
  // a function reads before calling it, and a member that was not loaded throws instead of being undefined.
  const selfType = hasLoader(entity) ? `${recordName}Loaded` : recordName;
  const scopeType = `$Scope<{ self: $DeepReadonly<${selfType}>; input: $DeepReadonly<I>; actor: any; context: any; before: $DeepReadonly<${recordName}> | null }>`;
  const found = collect(entity);
  // On a create, `self` is the new instance (ACT-27): the members nothing has filled yet are null there, so the scopes
  // of the functions that can run on one say so.
  const gaps = newInstanceGaps(entity);
  const withNulls = (members: readonly string[]) => {
    const names = members.map((name) => JSON.stringify(name)).join(" | ");
    return `$DeepReadonly<Omit<${selfType}, ${names}> & { [K in ${names}]: ${selfType}[K] | null }>`;
  };
  const unfilled = newInstanceMembers(gaps, selfType !== recordName);
  // A computed field that reads one of them is evaluated over the nulls: null too, whatever its stored type says.
  const nullOnNew = [...unfilled, ...newInstanceComputed(entity, new Set(unfilled))];
  const scopeOf = (kind: ScopeKind): string =>
    kind === "new" ? (unfilled.length ? `${recordName}NewScope` : `${recordName}CheckScope`)
      : kind === "check" ? `${recordName}CheckScope`
        : kind === "create" ? (gaps.key ? `${recordName}CreateScope` : scopeName)
          : kind === "stored" ? storedScopeName : scopeName;
  const usedScopes = new Set(found.map((f) => scopeOf(f.scope)));
  const checkScope = usedScopes.has(`${recordName}CheckScope`) || usedScopes.has(`${recordName}NewScope`)
    ? { name: `${recordName}CheckScope`, type: `Omit<${scopeName}<I>, "before">` } : null;
  const newScope = usedScopes.has(`${recordName}NewScope`)
    ? { name: `${recordName}NewScope`, type: `Omit<${recordName}CheckScope<I>, "self"> & { self: ${withNulls(nullOnNew)} }` } : null;
  const createScope = usedScopes.has(`${recordName}CreateScope`) && gaps.key
    ? { name: `${recordName}CreateScope`, type: `Omit<${scopeName}<I>, "self"> & { self: ${withNulls([gaps.key])} }` } : null;
  // The input an expression reads: its action's, the fields the covered actions share for an `always` block or a policy, none for a computed field.
  const inputs = entityInputs(entity, document);
  const inputNames = new Map(effectiveActions(entity).map((action, index) => [action.name, inputs[index]!.name]));
  const usedInputs = new Set<string>();
  let shared = false;
  const inputOf = (actions: readonly Action[]): string => {
    const names = [...new Set(actions.map((action) => inputNames.get(action.name)!))];
    names.forEach((name) => usedInputs.add(name));
    if (names.length === 0) return "unknown";
    if (names.length === 1) return names[0]!;
    shared = true;
    return `$SharedInput<${names.join(" | ")}>`;
  };
  // Helper imports: the entity file's non-entity imports, rewritten relative to the generated file.
  const helperFrom = new Map<string, string>();
  for (const imported of entity.imports)
    if (imported.helper) for (const name of imported.identifiers) helperFrom.set(name, imported.from);
  const used = new Set<string>();
  for (const { expression } of found) {
    if (expression.tree) helpersIn(expression.tree, used);
    else for (const name of mentioned(expression, helperFrom.keys())) used.add(name);
  }
  const byModule = new Map<string, string[]>();
  for (const name of [...used].filter((n) => helperFrom.has(n)).sort()) {
    const absolute = posix.join(dirname(entity.file), helperFrom.get(name)!);
    let relativePath = posix.relative(dirname(generatedPath), absolute);
    if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
    byModule.set(relativePath, [...(byModule.get(relativePath) ?? []), name]);
  }
  const entries = found.map((f) => ({
      key: JSON.stringify(f.id),
      comment: `${f.what}, ${f.expression.tree ? "translated" : `plain (${f.expression.plain!.why})`} (${entity.file}:${f.expression.position.line}:${f.expression.position.column + 1})`
        .replace(/[\r\n\u2028\u2029]/g, " "),
      code: printExpression(f.expression, `${scopeOf(f.scope)}<${inputOf(f.actions)}>`, f.boolean, f.run === true),
    }));
  const usesExpr = entries.some((e) => e.code.includes("$."));
  // `structuredClone` cannot copy the read-only views a function is handed (they are proxies), so the file shadows it.
  const shadowsStructuredClone = found.some(({ expression }) => !expression.tree && mentioned(expression, ["structuredClone"]).length > 0);
  // The entities the functions name, each from its actions file, by the name the entity file gives it (CMP-16).
  const named = new Set(found.flatMap(({ expression }) => expression.plain?.entities ?? []));
  const entityFrom = new Map<string, string[]>();
  for (const local of [...named].sort()) {
    const imported = entity.imports.find((entry) => !entry.helper && entry.identifiers.includes(local));
    const file = imported ? posix.normalize(posix.join(dirname(entity.file), imported.from)) : entity.file;
    const target = document.entities.find((candidate) => candidate.file === file);
    if (!target) continue; // the front end reported the import
    let from = relative(dirname(entityPath(entity)), `${entityPath(target)}.actions`).replace(/\\/g, "/");
    if (!from.startsWith(".")) from = `./${from}`;
    const exported = typeName(target.name, target.position);
    entityFrom.set(from, [...(entityFrom.get(from) ?? []), `${exported} as ${entityValue(local)}`, `type $ReadOnly as ${entityType(local)}`]);
  }
  return {
    entityFile: entityFileComment(entity),
    usesExpr,
    usesSharedInput: shared,
    recordName,
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    typeImports: [recordName, ...(selfType === recordName ? [] : [selfType]), ...[...usedInputs].sort()],
    usesPrivileged: found.some(({ expression }) => expression.plain?.privileged === true),
    entityImports: [...entityFrom].map(([from, names]) => ({ names: names.join(", "), fromLiteral: JSON.stringify(from) })),
    shadowsStructuredClone,
    scopeName,
    scopeType,
    storedScopeName,
    checkScope,
    newScope,
    createScope,
    helperImports: [...byModule].map(([from, names]) => ({ names: names.join(", "), fromLiteral: JSON.stringify(from) })),
    entries,
  };
}
