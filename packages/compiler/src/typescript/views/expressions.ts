import { dirname, posix, relative } from "node:path";
import type { Action, Entity, Expression, ExprNode, Step } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { mentioned, printExpression } from "../expression-printer.ts";
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
  /** The module specifier of the project's `composition.ts` (the `Actions` and `Reads` types) as a quoted string literal. */
  readonly compositionFromLiteral: string;
  /** True when an expression mentions `structuredClone`: the file then shadows it with `cloneValue`, which copies a read-only record. */
  readonly shadowsStructuredClone: boolean;
  /** The scope type's exported name, e.g. `InvoiceScope`; it takes the input type as its parameter. */
  readonly scopeName: string;
  /** The scope type's definition, a generic over `I`, the input. */
  readonly scopeType: string;
  /** The scope of an expression that only runs on a stored record (an update or a destroy): the same, with `before` not null. */
  readonly storedScopeName: string;
  /** Imports of the helper functions the expressions call, one per module. */
  readonly helperImports: readonly { names: string; fromLiteral: string }[];
  /** One function per expression, in the order of the entity file. */
  readonly entries: readonly ExpressionEntry[];
}
export interface ExpressionEntry {
  /** The stable id, as a quoted string literal: `"pay.check.invoiceIsSent.that"`. */
  readonly key: string;
  /** One line saying what it is and where it was written. */
  readonly comment: string;
  /** `(s: InvoiceScope<PayInvoiceInput>) => ...`. */
  readonly code: string;
}

/** `actions`: the actions whose input the expression reads as `input`; none (a computed field) reads no input. */
interface Found { id: string; what: string; expression: Expression; boolean: boolean; run?: true; stored?: true; actions: readonly Action[] }

function collect(entity: Entity): Found[] {
  const found: Found[] = [];
  let stored = false;
  let actions: readonly Action[] = [];
  const add = (id: string, what: string, expression: Expression, boolean: boolean, run?: true) => found.push({ id, what, expression, boolean, actions, ...(run ? { run } : {}), ...(stored ? { stored: true as const } : {}) });
  const covers = (scope: { types?: readonly string[]; actions?: readonly { name: string }[] }) => effectiveActions(entity).filter((action) => action.kind !== "read"
    && ((!scope.types && !scope.actions) || scope.types?.includes(action.kind) || scope.actions?.some((ref) => ref.name === action.name)));
  entity.computed.forEach((c) => { if (c.body) add(`computed.${c.name}`, `computed ${c.name}`, c.body, false); });
  const checks = (prefix: string, list: { label: string; that: Expression; when?: Expression; details?: Expression }[]) => {
    for (const check of list) {
      add(`${prefix}.check.${check.label}.that`, `check :${check.label} that`, check.that, true);
      if (check.when) add(`${prefix}.check.${check.label}.when`, `check :${check.label} when`, check.when, true);
      if (check.details) add(`${prefix}.check.${check.label}.details`, `check :${check.label} details`, check.details, false);
    }
  };
  const steps = (prefix: string, list: Step[], path: string) => {
    list.forEach((step, index) => {
      const here = path === "" ? String(index) : `${path}.${index}`;
      if (step.kind === "set") {
        for (const { member, value } of step.assignments)
          if (typeof value === "object" && value !== null && "source" in value)
            add(`${prefix}.step.${here}.set.${member.name}`, `set &${member.name}`, value as Expression, false);
      } else if (step.kind === "when") {
        add(`${prefix}.step.${here}.when`, "step when", step.condition, true);
        steps(prefix, step.steps, here);
      } else if (step.kind === "run") add(`${prefix}.step.${here}.run`, "run", step.fn, false, true);
    });
  };
  for (const action of entity.actions) {
    stored = action.kind === "update" || action.kind === "destroy";
    actions = [action];
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
  stored = false;
  for (const policy of entity.policies) {
    actions = covers(policy);
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
  const scopeType = `$Scope<{ self: $DeepReadonly<${selfType}>; input: $DeepReadonly<I>; actor: any; context: any; before: $DeepReadonly<${recordName}> | null; actions: $ReadOnlyResults<$Actions>; tx: $ReadOnlyResults<$Reads> }>`;
  const found = collect(entity);
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
      code: printExpression(f.expression, `${f.stored ? storedScopeName : scopeName}<${inputOf(f.actions)}>`, f.boolean, f.run === true),
    }));
  const usesExpr = entries.some((e) => e.code.includes("$."));
  // `structuredClone` cannot copy the read-only views a function is handed (they are proxies), so the file shadows it.
  const shadowsStructuredClone = found.some(({ expression }) => !expression.tree && mentioned(expression, ["structuredClone"]).length > 0);
  let composition = relative(dirname(entityPath(entity)), "composition").replace(/\\/g, "/");
  if (!composition.startsWith(".")) composition = `./${composition}`;
  return {
    entityFile: entityFileComment(entity),
    usesExpr,
    usesSharedInput: shared,
    recordName,
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    typeImports: [recordName, ...(selfType === recordName ? [] : [selfType]), ...[...usedInputs].sort()],
    compositionFromLiteral: JSON.stringify(composition),
    shadowsStructuredClone,
    scopeName,
    scopeType,
    storedScopeName,
    helperImports: [...byModule].map(([from, names]) => ({ names: names.join(", "), fromLiteral: JSON.stringify(from) })),
    entries,
  };
}
