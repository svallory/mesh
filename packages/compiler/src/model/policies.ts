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

/** The scope names a policy function reads the record through: `self` (and a related record from it) and `tx`. */
const RECORD_ROOTS: readonly string[] = ["self", "tx"];

function readsVar(n: ExprNode, names: readonly string[]): boolean {
  switch (n.kind) {
    case "var": return names.includes(n.name);
    case "member": return readsVar(n.object, names);
    case "call": case "helper": return n.args.some((arg) => readsVar(arg, names));
    case "quantify": return readsVar(n.source, names) || readsVar(n.body, names);
    default: return false;
  }
}

/**
 * Does the function read the record (ACT-28, POL-08, lead ruling 1 of M8a)? A function that reads `self`, a related record
 * through it, or `tx` runs inside the transaction, on the locked row or a create's new instance; one that reads only
 * `actor`, `context` and `input` runs once, before the transaction opens. A plain function the build cannot analyse (a
 * parameter that is not destructured, a rest pattern) counts as reading the record.
 */
export function readsRecord(expression: Expression): boolean {
  if (expression.rest) return true;
  if (expression.params.some((name) => RECORD_ROOTS.includes(name))) return true;
  if (expression.tree) return readsVar(expression.tree, RECORD_ROOTS);
  if (expression.plain) return expression.plain.edits.some((edit) => edit.text.startsWith("self")) || expression.plain.roots.some((name) => RECORD_ROOTS.includes(name));
  return true;
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
