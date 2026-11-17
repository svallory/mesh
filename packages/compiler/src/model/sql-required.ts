import { dirname, resolve } from "node:path";
import type { Action, Computed, Diagnostic, Entity, Expression, ExprNode, ModelDocument, Policy, Rollup, SortKey, SourcePosition } from "@meshfw/model";
import { error } from "./diagnostics.ts";
import { loadPolicies, policiesCovering, policyExpressions, recordReason, type PolicyExpression } from "./policies.ts";
import { rollupRoute } from "./rollup-operation.ts";
import { lowerCondition, lowerSortKey, type LowerOptions, type LowerResult, type NotSql } from "./sql-condition.ts";

/** What the fix of a function that does not translate says, wherever SQL is required. */
export const NOT_SQL_FIX = "rewrite it as one expression with comparisons, `&&`, `||`, `!`, `??`, `?.`, `%.now`, `%.today` and the list methods some, every, find and filter to have Mesh translate it; a helper may be called, but neither awaited nor given the record";

/** One place of a read where SQL is required: its declared filter, or one key of its declared sort. */
export interface SqlPosition {
  readonly entity: Entity;
  readonly action: Action;
  readonly kind: "filter" | "sort";
  /** "the filter of read :forCustomer of billing.Invoice". */
  readonly subject: string;
  /** Where a problem with the whole condition is reported: the filter function, or the sort key. */
  readonly position: SourcePosition;
  /** The filter's function, absent for a sort key. */
  readonly expression?: Expression;
  /** The sort key, absent for a filter. */
  readonly key?: SortKey;
  /** The key's index in the read's `sort`. */
  readonly index?: number;
  readonly lower: () => LowerResult;
}

/** Every declared filter and sort key of the entity's reads, in written order. */
export function sqlPositions(document: ModelDocument, entity: Entity, options: Pick<LowerOptions, "reported"> = {}): SqlPosition[] {
  const out: SqlPosition[] = [];
  for (const action of entity.actions) {
    if (action.kind !== "read") continue;
    const filter = action.filter;
    if (filter)
      out.push({ entity, action, kind: "filter", subject: `the filter of read :${action.name} of ${entity.fqn}`, position: filter.position, expression: filter,
        lower: () => lowerCondition(document, entity, filter, options) });
    (action.sort ?? []).forEach((key, index) =>
      out.push({ entity, action, kind: "sort", subject: `the sort of read :${action.name} of ${entity.fqn}`, position: key.member.position, key, index,
        lower: () => lowerSortKey(document, entity, key, options) }));
  }
  return out;
}

/** A rollup's `filter=` (ruling D33, OD6-OD8): a condition on the rows of the last entity its path reaches, run as SQL only. */
export interface RollupFilter {
  /** The entity that declares the rollup. */
  readonly entity: Entity;
  readonly computed: Computed;
  readonly filter: NonNullable<Rollup["filter"]>;
  /** The entity whose rows the filter reads: the last one the path reaches (the far entity of a `through=`). */
  readonly last: Entity;
  /** "the filter of count :openLines of billing.Invoice". */
  readonly subject: string;
  /** Lowered with its parameter as the row at depth 0. */
  readonly lower: () => LowerResult;
}

/** Every rollup filter of the entity whose path the model resolves, in written order. */
export function rollupFilters(document: ModelDocument, entity: Entity, options: Pick<LowerOptions, "reported"> = {}): RollupFilter[] {
  return entity.computed.flatMap((computed): RollupFilter[] => {
    const filter = computed.rollup?.filter;
    const last = filter ? rollupRoute(document, entity, computed)?.entities.at(-1) : undefined;
    if (!filter || !last) return [];
    return [{ entity, computed, filter, last, subject: `the filter of ${computed.rollup!.fn} :${computed.name} of ${entity.fqn}`,
      lower: () => lowerCondition(document, last, filter, { ...options, root: { param: filter.param } }) }];
  });
}

/** What a rollup filter's fix says: it reads only its record's stored columns and fixed values (R18). */
const ROLLUP_FILTER_FIX = (param: string) => `compare columns of ${param} with literals, atoms, %.now or %.today`;

/**
 * What a rollup filter reads besides its parameter's stored columns, literals, atoms, `%.now`, `%.today` and the registry's
 * functions (R18): `&x`, `self`, `input`, `actor`, `context`, `before`, a helper, and a relationship or computed field of
 * the record, each `MESH_ROLLUP_FILTER`; a name the record does not have is `MESH_UNKNOWN_MEMBER`. A quantifier's own
 * parameter is a row too, but only over a relationship of the record, which is refused first. A filter Mesh did not
 * translate has no tree: its error is the "must run as SQL" one.
 */
export function rollupFilterProblems(place: RollupFilter): Diagnostic[] {
  const { filter, last, computed } = place;
  const param = filter.param;
  const named = `${computed.rollup!.fn} :${computed.name}`;
  const out: Diagnostic[] = [];
  const refuse = (message: string, position: SourcePosition) => out.push(error("MESH_ROLLUP_FILTER", message, position, ROLLUP_FILTER_FIX(param)));
  const tree = filter.tree;
  // A helper handed the record (`isOpen(line.state)`) leaves the function plain: it is still a helper call.
  const handed = filter.plain?.why === "reads-record-in-helper" ? /^a call to (.+), which is given the record$/.exec(filter.plain.detail)?.[1] : undefined;
  if (handed !== undefined) refuse(`the filter of ${named} calls ${handed}; it reads only ${param} and fixed values`, filter.plain!.position);
  if (!tree) return out;
  const walk = (node: ExprNode, rows: ReadonlySet<string>): void => {
    switch (node.kind) {
      case "var":
        if (!rows.has(node.name)) refuse(`the filter of ${named} reads ${node.name}; it reads only ${param}, the ${last.fqn} the path reaches, and fixed values`, node.position);
        return;
      case "member": {
        const names: string[] = [];
        let root: ExprNode = node;
        while (root.kind === "member") { names.unshift(root.name); root = root.object; }
        if (root.kind === "var" && root.name === "self" && !rows.has("self")) {
          refuse(`the filter of ${named} reads &${names[0]}; it reads only ${param}, the ${last.fqn} the path reaches, and fixed values`, node.position);
          return;
        }
        if (root.kind !== "var" || root.name !== param) { walk(root, rows); return; }
        const name = names[0]!;
        if (last.attributes.some((a) => a.name === name)) return;
        if (last.relationships.some((r) => r.kind === "belongs-to" && r.keyColumn === name)) return;
        const kind = last.relationships.some((r) => r.name === name) ? "relationship" : last.computed.some((c) => c.name === name) ? "computed field" : undefined;
        if (kind) {
          refuse(`the filter of ${named} reads ${param}.${name}, a ${kind} of ${last.fqn}; it reads only stored columns of ${param}`, node.position);
          return;
        }
        out.push(error("MESH_UNKNOWN_MEMBER", `${param}.${name}: \`${name}\` is not a member of ${last.fqn}`, node.position,
          `read a stored column of ${param}: ${[...last.attributes.map((a) => a.name), ...last.relationships.flatMap((r) => (r.keyColumn ? [r.keyColumn] : []))].join(", ")}`));
        return;
      }
      case "helper":
        refuse(`the filter of ${named} calls ${node.name}; it reads only ${param} and fixed values`, node.position);
        node.args.forEach((arg) => walk(arg, rows));
        return;
      case "call": node.args.forEach((arg) => walk(arg, rows)); return;
      case "quantify":
        walk(node.source, rows);
        walk(node.body, new Set([...rows, node.param]));
        return;
      default: return;
    }
  };
  walk(tree, new Set([param]));
  return out;
}

/** The entities a caller's load can reach (by file): the target of every relationship, and the link entity of a `through=`. */
function loadedFiles(document: ModelDocument): Set<string> {
  return new Set(document.entities.flatMap((from) => from.relationships.flatMap((relation) => [
    resolve(dirname(from.file), relation.entity.from),
    ...(relation.through ? [resolve(dirname(from.file), relation.through.entity.from)] : []),
  ])));
}

/** What a policy of the entity covers that runs as SQL: `read :x` for each read, and the loads of it when a relationship reaches it. */
function coveredReads(entity: Entity, policy: Policy, loaded: ReadonlySet<string>): string[] {
  const reads = [...entity.actions, ...entity.auto.map((kind) => ({ kind, name: kind as string }))].filter((action) => action.kind === "read");
  const covered = reads.filter((action) => policiesCovering(entity, action).includes(policy)).map((action) => `read :${action.name}`);
  if (loaded.has(resolve(entity.file)) && loadPolicies(entity).includes(policy)) covered.push("the loads of it (a relationship or a rollup that reaches it)");
  return covered;
}

/**
 * One function of a policy that covers a read or a load and reads the record: a condition on each row of the query
 * (M10), lowered like a filter and folded into it by the authorizer (`rows`, `admitsRows`).
 */
export interface PolicyCondition extends PolicyExpression {
  readonly entity: Entity;
  readonly policy: Policy;
  /** "policy :owner authorize-if of billing.Invoice". */
  readonly subject: string;
  /** "policy :owner authorize-if must run as SQL, since the policy covers read :read of billing.Invoice". */
  readonly head: string;
  readonly lower: () => LowerResult;
}

/** Every function of the entity's policies that reads the record and covers a read or a load, in written order. */
export function policyConditions(document: ModelDocument, entity: Entity, options: Pick<LowerOptions, "reported"> = {}, loaded: ReadonlySet<string> = loadedFiles(document)): PolicyCondition[] {
  const out: PolicyCondition[] = [];
  for (const policy of entity.policies) {
    const covered = coveredReads(entity, policy, loaded);
    if (!covered.length) continue;
    for (const found of policyExpressions(policy)) {
      if (!recordReason(found.expression, "read")) continue;
      out.push({ ...found, entity, policy, subject: `${found.what} of ${entity.fqn}`,
        head: `${found.what} must run as SQL, since the policy covers ${covered.join(", ")} of ${entity.fqn}`,
        lower: () => lowerCondition(document, entity, found.expression, options) });
    }
  }
  return out;
}

/** The diagnostic for one problem of a function in a SQL position. `head` is "<subject> must run as SQL[, since ...]". */
function notSql(problem: Exclude<NotSql, { kind: "reported" }>, subject: string, head: string, kind: "filter" | "sort" | "policy"): Diagnostic {
  switch (problem.kind) {
    case "plain":
      return error("MESH_EXPR_NOT_SQL", `${head}, and Mesh does not translate it (${problem.detail})`, problem.position, NOT_SQL_FIX);
    case "plain-computed": {
      const name = problem.through ? problem.field.split(" ")[0]! : problem.field.split(".").at(-1)!.replace(/^&/, "");
      const message = problem.through
        ? `${head}, and ${problem.through} reads computed :${problem.field}, which Mesh runs in memory (${problem.detail})`
        : `${head}, and ${problem.field} is a computed field Mesh runs in memory (${problem.detail})`;
      return error("MESH_EXPR_NOT_SQL", message, problem.position, `rewrite computed :${name} as one expression Mesh translates, or write the condition over the members it reads`);
    }
    case "foreign-list":
      return error("MESH_EXPR_NOT_SQL", `${head}, and \`${problem.op}\` here goes over a list that is not a relationship of the record, which a query cannot do`,
        problem.position, "go over a has-many of the record, or test the list in a helper that does not read the record");
    case "self-reaching":
      return error("MESH_EXPR_NOT_SQL", `${head}, and computed :${problem.field} reaches itself again through a relationship, which a query cannot unfold`,
        problem.position, "store the value in an attribute, or write the condition over a fixed number of steps");
    case "rollup":
      return error("MESH_NOT_IMPLEMENTED", `${subject} reads ${problem.field}, a ${problem.fn} rollup, and filtering, sorting or authorizing by a rollup arrives with SQL rollups (M10)`,
        problem.position, `write the condition over the relationship itself, which translates: \`${problem.relation}.length > 2\`, \`${problem.relation}.some((x) => x.n > 2)\``);
    case "json":
      // A concept member is one JSON value as well (ADR-0092), named as the concept.
      if (problem.concept !== undefined)
        return error(kind === "sort" ? "MESH_SORT_TYPE" : "MESH_FILTER_TYPE",
          `${problem.member} is the concept ${problem.concept}, which a ${kind === "sort" ? "sort" : kind === "policy" ? "read policy" : "filter"} cannot use: it is stored as one JSON value`, problem.position);
      return kind === "sort"
        ? error("MESH_SORT_TYPE", `${problem.member} is :json, which a sort cannot use: the database does not look inside it`, problem.position)
        : kind === "policy"
          ? error("MESH_FILTER_TYPE", `${problem.member} is :json, which a read policy cannot use: it is a filter on the query, and the database does not look inside it`, problem.position)
          : error("MESH_FILTER_TYPE", `${problem.member} is :json, which a filter cannot use: the database does not look inside it`, problem.position);
    case "write-call":
      return error("MESH_EXPR_NOT_SQL", `${head}, and it calls ${problem.callee}, which in a write policy counts as reading the record`, problem.position, NOT_SQL_FIX);
  }
}

/**
 * Where SQL is required, what Mesh cannot run there is a build error, never evaluated over loaded rows (M10, ADR-0056,
 * roadmap principle 2): a read's declared filter and each key of its declared sort are lowered to a condition
 * (`lowerCondition`, `lowerSortKey`) and each problem is reported; any plain function of a policy that covers a read or a
 * load is `MESH_EXPR_NOT_SQL`, whatever made it plain (a block body, a helper given the record), and one that reads the
 * record is lowered as a filter is (`policyConditions`), since the authorizer folds it into the query. A function that already
 * holds an error is left alone, and so is one that inlines a computed body that holds one; one that holds only a warning (`MESH_EXPR_PLAIN` from the type pass) still gets the error.
 */
export function checkSqlRequired(document: ModelDocument, diagnostics: Diagnostic[]): void {
  const holdsError = (position: SourcePosition, length: number) => diagnostics.some((d) => d.severity === "error"
    && d.position.file === position.file && d.position.offset >= position.offset && d.position.offset < position.offset + Math.max(length, 1));
  const loaded = loadedFiles(document);
  const found: Diagnostic[] = [];
  const reported = { reported: (body: Expression) => holdsError(body.position, body.source.length) };
  for (const entity of document.entities) {
    for (const place of sqlPositions(document, entity, reported)) {
      const length = place.expression ? place.expression.source.length : place.key!.member.name.length + 1;
      if (holdsError(place.position, length)) continue;
      const lowered = place.lower();
      if (lowered.ok) continue;
      for (const problem of lowered.problems) if (problem.kind !== "reported") found.push(notSql(problem, place.subject, `${place.subject} must run as SQL`, place.kind));
    }
    for (const policy of entity.policies) {
      const covered = coveredReads(entity, policy, loaded);
      if (!covered.length) continue;
      for (const { expression, what } of policyExpressions(policy)) {
        if (!expression.plain || recordReason(expression, "read")) continue;
        if (holdsError(expression.position, expression.source.length)) continue;
        const head = `${what} must run as SQL, since the policy covers ${covered.join(", ")} of ${entity.fqn}`;
        found.push(notSql({ kind: "plain", position: expression.plain.position, detail: expression.plain.detail }, `${what} of ${entity.fqn}`, head, "policy"));
      }
    }
    for (const place of policyConditions(document, entity, reported, loaded)) {
      if (holdsError(place.expression.position, place.expression.source.length)) continue;
      const lowered = place.lower();
      if (lowered.ok) continue;
      for (const problem of lowered.problems) if (problem.kind !== "reported") found.push(notSql(problem, place.subject, place.head, "policy"));
    }
    // A rollup's filter is new, so it must translate from the start (R19): what it reads is checked first (R18).
    for (const place of rollupFilters(document, entity, reported)) {
      if (holdsError(place.filter.position, place.filter.source.length)) continue;
      const reads = rollupFilterProblems(place);
      if (reads.length) { found.push(...reads); continue; }
      const lowered = place.lower();
      if (lowered.ok) continue;
      for (const problem of lowered.problems) if (problem.kind !== "reported") found.push(notSql(problem, place.subject, `${place.subject} must run as SQL`, "filter"));
    }
  }
  diagnostics.push(...found);
}
