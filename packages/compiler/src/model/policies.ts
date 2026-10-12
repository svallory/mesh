import type { Action, ActionType, Entity, Expression, ExprNode, Policy } from "@meshfw/model";

/** One function of a policy: an `authorize-if`, a `forbid-if` or its `when`, with its id in the expressions file. */
export interface PolicyExpression {
  expression: Expression;
  kind: "authorize-if" | "forbid-if" | "when";
  /** The id the expressions file keys it by: `policy.owner.authorize-if.0`. */
  id: string;
  /** What to call it in a message: `policy :owner authorize-if`. */
  what: string;
}

/** Every function of a policy, in the order the expressions file lists them. */
export function policyExpressions(policy: Policy): PolicyExpression[] {
  return [
    ...policy.authorizeIf.map((expression, i) => ({ expression, kind: "authorize-if" as const, id: `policy.${policy.name}.authorize-if.${i}`, what: `policy :${policy.name} authorize-if` })),
    ...policy.forbidIf.map((expression, i) => ({ expression, kind: "forbid-if" as const, id: `policy.${policy.name}.forbid-if.${i}`, what: `policy :${policy.name} forbid-if` })),
    ...(policy.when ? [{ expression: policy.when, kind: "when" as const, id: `policy.${policy.name}.when`, what: `policy :${policy.name} when` }] : []),
  ];
}

/** The scope names a policy function reads the record through: `self`, and a related record from it. */
const RECORD_ROOTS: readonly string[] = ["self"];

function readsVar(n: ExprNode, names: readonly string[]): boolean {
  switch (n.kind) {
    case "var": return names.includes(n.name);
    case "member": return readsVar(n.object, names);
    case "call": case "helper": return n.args.some((arg) => readsVar(arg, names));
    case "quantify": return readsVar(n.source, names) || readsVar(n.body, names);
    default: return false;
  }
}

function callsHelper(n: ExprNode): boolean {
  switch (n.kind) {
    case "helper": return true;
    case "member": return callsHelper(n.object);
    case "call": return n.args.some(callsHelper);
    case "quantify": return callsHelper(n.source) || callsHelper(n.body);
    default: return false;
  }
}

/**
 * Why the function runs inside the transaction (ACT-28, POL-08, POL-11, POL-21, lead ruling 1 of M8a), or undefined when
 * it runs once, before the transaction opens. A function that reads `self` or a related record through it runs on the
 * locked row or a create's new instance; so does one that calls `privileged` or any imported function, or names an
 * entity, since what those read the build cannot tell. One that reads only `actor`, `context` and `input` runs before. A
 * plain function the build cannot analyse (a parameter that is not destructured, a rest pattern) counts as reading the
 * record.
 */
export function recordReason(expression: Expression): string | undefined {
  const reads = "reads the record";
  if (expression.rest) return reads;
  if (expression.params.some((name) => RECORD_ROOTS.includes(name))) return reads;
  if (expression.tree) return readsVar(expression.tree, RECORD_ROOTS) ? reads : callsHelper(expression.tree) ? "calls an imported function" : undefined;
  const plain = expression.plain;
  if (!plain) return reads;
  if (plain.edits.some((edit) => edit.text.startsWith("self")) || plain.roots.some((name) => RECORD_ROOTS.includes(name))) return reads;
  if (plain.privileged) return "calls `privileged`";
  if (plain.helpers) return "calls an imported function";
  if (plain.entities?.length) return "names an entity";
  return undefined;
}

/** Does the function run inside the transaction? See `recordReason`. */
export function readsRecord(expression: Expression): boolean {
  return recordReason(expression) !== undefined;
}

/** Does the policy cover actions of this kind, or this action, by its scope (`when=` aside)? One with neither covers every action. */
export function policyCovers(policy: Policy, action: { kind: ActionType; name: string }): boolean {
  return (!policy.types && !policy.actions) || (policy.types?.includes(action.kind) ?? false) || (policy.actions?.some((ref) => ref.name === action.name) ?? false);
}

/**
 * The policies a caller's load of the entity runs (POL-17): those that cover its `read`, by type (`types=[:read]`, or no
 * scope) or by name (`actions=[&read]`). A relationship or a rollup that reaches a record runs them as its `read` would,
 * actor only; none covering, it gives nothing.
 */
export function loadPolicies(entity: Entity): Policy[] {
  return entity.policies.filter((policy) => policyCovers(policy, { kind: "read", name: "read" }));
}

/** The policies whose scope covers the action, in the order the entity file declares them. */
export function policiesCovering(entity: Entity, action: Pick<Action, "kind" | "name">): Policy[] {
  return entity.policies.filter((policy) => policyCovers(policy, action));
}
