import type { Check, Entity, Expression, Step } from "@meshfw/model";

/** Where an action's function sits: a part of a check, or a kind of step. */
export type ActionExpressionKind = "that" | "check-when" | "details" | "step-when" | "set" | "run";

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
        if (typeof value === "object" && value !== null && "source" in value && "params" in value)
          into.push({ expression: value as Expression, kind: "set", what: `set &${member.name}` });
    } else if (step.kind === "when") {
      into.push({ expression: step.condition, kind: "step-when", what: "when" });
      stepExpressions(step.steps, into);
    } else if (step.kind === "run") into.push({ expression: step.fn, kind: "run", what: "run" });
  }
}

function checkExpressions(checks: readonly Check[], into: ActionExpression[]): void {
  for (const check of checks) {
    into.push({ expression: check.that, kind: "that", what: `check :${check.label} (that)` });
    if (check.when) into.push({ expression: check.when, kind: "check-when", what: `check :${check.label} (when)` });
    if (check.details) into.push({ expression: check.details, kind: "details", what: `check :${check.label} (details)` });
  }
}

/** Every function in an entity's actions and `always` blocks (`check`, `when`, `set` values, `run`), in written order. */
export function actionExpressions(entity: Entity): ActionExpression[] {
  const found: ActionExpression[] = [];
  for (const action of entity.actions) {
    checkExpressions(action.validate, found);
    stepExpressions(action.do, found);
  }
  for (const always of entity.always) {
    checkExpressions(always.validate, found);
    stepExpressions(always.do, found);
  }
  return found;
}
