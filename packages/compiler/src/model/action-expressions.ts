import { isCheckGroup, isExpression, type Check, type CheckGroup, type Entity, type Expression, type Step, type ValidateItem } from "@meshfw/model";

/** Where an action's function sits: a part of a check, or a kind of step. */
export type ActionExpressionKind = "that" | "check-when" | "details" | "message" | "validate-when" | "step-when" | "set" | "run" | "publish";

/** The kinds of function that run in `validate`, where no `before` exists (`MESH_VALIDATE_BEFORE`). */
export const VALIDATE_KINDS: ReadonlySet<ActionExpressionKind> = new Set(["that", "check-when", "details", "message", "validate-when"]);

export interface ActionExpression {
  expression: Expression;
  kind: ActionExpressionKind;
  /** What to call it in a message: `check :taskReady (that)`, `set &state`, `run`. */
  what: string;
}

function stepExpressions(steps: readonly Step[], into: ActionExpression[]): void {
  for (const step of steps) {
    if (step.kind === "set") {
      for (const { member, value } of step.assignments)
        if (isExpression(value))
          into.push({ expression: value, kind: "set", what: `set &${member.name}` });
    } else if (step.kind === "when") {
      into.push({ expression: step.condition, kind: "step-when", what: "when" });
      stepExpressions(step.steps, into);
    } else if (step.kind === "run") into.push({ expression: step.fn, kind: "run", what: "run" });
    else if (step.kind === "publish") into.push({ expression: step.fn, kind: "publish", what: "publish" });
  }
}

function checkExpressions(items: readonly ValidateItem[], into: ActionExpression[]): void {
  for (const check of items) {
    if (isCheckGroup(check)) {
      into.push({ expression: check.condition, kind: "validate-when", what: "when in validate" });
      checkExpressions(check.lines, into);
      continue;
    }
    into.push({ expression: check.that, kind: "that", what: `check :${check.label} (that)` });
    if (check.when) into.push({ expression: check.when, kind: "check-when", what: `check :${check.label} (when)` });
    if (check.details) into.push({ expression: check.details, kind: "details", what: `check :${check.label} (details)` });
    if (typeof check.message !== "string") into.push({ expression: check.message, kind: "message", what: `check :${check.label} (message)` });
  }
}

/** Every function in an entity's actions and `always` blocks (`check`, `when`, `set` values, `run`), in written order. */
export function actionExpressions(entity: Entity): ActionExpression[] {
  return actionExpressionsByOwner(entity).flatMap((owner) => owner.expressions);
}

/**
 * The functions of `actionExpressions`, grouped by the action or `always` block that holds them, in declaration order;
 * `owner` is worded as messages word it (`update :finish`, `always`). Action and `always` functions only: a handler body
 * (the `handlers` section) never joins, since it is where the spec sends an effect on another aggregate, and the
 * architecture rule `:action-calls-other-aggregate` reads this list.
 */
export function actionExpressionsByOwner(entity: Entity): { owner: string; expressions: ActionExpression[] }[] {
  const owners: { owner: string; expressions: ActionExpression[] }[] = [];
  for (const action of entity.actions) {
    const expressions: ActionExpression[] = [];
    checkExpressions(action.validate, expressions);
    stepExpressions(action.do, expressions);
    owners.push({ owner: `${action.kind} :${action.name}`, expressions });
  }
  for (const always of entity.always) {
    const expressions: ActionExpression[] = [];
    checkExpressions(always.validate, expressions);
    stepExpressions(always.do, expressions);
    owners.push({ owner: "always", expressions });
  }
  return owners;
}

/** Every check of a `validate` list, depth first: the lines under a `when` with the rest. */
export function checksOf(items: readonly ValidateItem[]): Check[] {
  return items.flatMap((item) => (isCheckGroup(item) ? checksOf(item.lines) : [item]));
}

/** A `when` line in `validate` with no check anywhere under it: legal, and nothing makes it run. */
export function isEmptyGroup(group: CheckGroup): boolean {
  return checksOf(group.lines).length === 0;
}

/**
 * Every function of a `validate` list that can run, depth first: each check's functions and the condition of each
 * `when` line that guards a check. An empty `when` line contributes nothing, so nothing is loaded for it.
 */
export function validateExpressions(items: readonly ValidateItem[]): Expression[] {
  return items.flatMap((item): Expression[] => {
    if (isCheckGroup(item)) return isEmptyGroup(item) ? [] : [item.condition, ...validateExpressions(item.lines)];
    return [item.that, ...(item.when ? [item.when] : []), ...(item.details ? [item.details] : []), ...(typeof item.message === "string" ? [] : [item.message])];
  });
}
