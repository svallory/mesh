import { dirname, posix } from "node:path";
import type { Entity, Expression, ExprNode, Step } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { mentioned, printExpression } from "../expression-printer.ts";
import { entityFileComment } from "./types.ts";
import { entitySegment, typeName } from "./inputs.ts";

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
  /** The entity's record type name, e.g. `Invoice`. */
  readonly recordName: string;
  /** The module specifier of the entity's types file as a quoted string literal. */
  readonly typesFromLiteral: string;
  /** The scope type's exported name, e.g. `InvoiceScope`. */
  readonly scopeName: string;
  /** The scope type's definition. */
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
  /** `(s: InvoiceScope) => ...`. */
  readonly code: string;
}

interface Found { id: string; what: string; expression: Expression; boolean: boolean; run?: true; stored?: true }

function collect(entity: Entity): Found[] {
  const found: Found[] = [];
  let stored = false;
  const add = (id: string, what: string, expression: Expression, boolean: boolean, run?: true) => found.push({ id, what, expression, boolean, ...(run ? { run } : {}), ...(stored ? { stored: true as const } : {}) });
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
    checks(`always.${i}`, block.validate);
    steps(`always.${i}`, block.do, "");
  });
  stored = false;
  for (const policy of entity.policies) {
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

export function expressionsView({ config }: EmitInput, entity: Entity, generatedPath: string): ExpressionsView {
  const recordName = typeName(entity.name, entity.position);
  const scopeName = `${recordName}Scope`;
  const storedScopeName = `${recordName}StoredScope`;
  // Relationships and computed fields are loaded onto the record when an expression reads them (M7); a list is `any[]` so a callback parameter is typed.
  const loaded = [
    ...entity.relationships.map((r) => `${JSON.stringify(r.name)}: ${r.kind === "has-many" ? "any[]" : "any"}`),
    ...entity.computed.map((c) => `${JSON.stringify(c.name)}: any`),
  ];
  const scopeType = `$Scope<{ self: ${recordName}${loaded.length ? ` & { ${loaded.join("; ")} }` : ""}; input: any; actor: any; context: any; before: ${recordName} | null; tx: any }>`;
  const found = collect(entity);
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
    let relative = posix.relative(dirname(generatedPath), absolute);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    byModule.set(relative, [...(byModule.get(relative) ?? []), name]);
  }
  const entries = found.map((f) => ({
      key: JSON.stringify(f.id),
      comment: `${f.what}, ${f.expression.tree ? "translated" : `plain (${f.expression.plain!.why})`} (${entity.file}:${f.expression.position.line}:${f.expression.position.column + 1})`
        .replace(/[\r\n\u2028\u2029]/g, " "),
      code: printExpression(f.expression, f.stored ? storedScopeName : scopeName, f.boolean, f.run === true),
    }));
  const usesExpr = entries.some((e) => e.code.includes("$."));
  void config;
  return {
    entityFile: entityFileComment(entity),
    usesExpr,
    recordName,
    typesFromLiteral: JSON.stringify(`./${entitySegment(entity)}.types`),
    scopeName,
    scopeType,
    storedScopeName,
    helperImports: [...byModule].map(([from, names]) => ({ names: names.join(", "), fromLiteral: JSON.stringify(from) })),
    entries,
  };
}
