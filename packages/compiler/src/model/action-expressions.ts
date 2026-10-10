import type { Action, Always, Check, Entity, Expression, Step } from "@meshfw/model";

/** Where an action's function sits: a part of a check, or a kind of step. */
export type ActionExpressionKind = "that" | "check-when" | "details" | "step-when" | "set" | "run";

export interface ActionExpression {
  expression: Expression;
  kind: ActionExpressionKind;
  /** What to call it in a message: `check :taskReady (that)`, `set &state`, `run`. */
  what: string;
  /** The action the function belongs to, or the `always` block that adds it to every action in its scope. */
  owner: { action: Action } | { always: Always };
}

function stepExpressions(steps: readonly Step[], owner: ActionExpression["owner"], into: ActionExpression[]): void {
  for (const step of steps) {
    if (step.kind === "set") {
      for (const { member, value } of step.assignments)
        if (typeof value === "object" && value !== null && "source" in value && "params" in value)
          into.push({ expression: value as Expression, kind: "set", what: `set &${member.name}`, owner });
    } else if (step.kind === "when") {
      into.push({ expression: step.condition, kind: "step-when", what: "when", owner });
      stepExpressions(step.steps, owner, into);
    } else if (step.kind === "run") into.push({ expression: step.fn, kind: "run", what: "run", owner });
  }
}

function checkExpressions(checks: readonly Check[], owner: ActionExpression["owner"], into: ActionExpression[]): void {
  for (const check of checks) {
    into.push({ expression: check.that, kind: "that", what: `check :${check.label} (that)`, owner });
    if (check.when) into.push({ expression: check.when, kind: "check-when", what: `check :${check.label} (when)`, owner });
    if (check.details) into.push({ expression: check.details, kind: "details", what: `check :${check.label} (details)`, owner });
  }
}

/** Every function in an entity's actions and `always` blocks (`check`, `when`, `set` values, `run`), in written order. */
export function actionExpressions(entity: Entity): ActionExpression[] {
  const found: ActionExpression[] = [];
  for (const action of entity.actions) {
    checkExpressions(action.validate, { action }, found);
    stepExpressions(action.do, { action }, found);
  }
  for (const always of entity.always) {
    checkExpressions(always.validate, { always }, found);
    stepExpressions(always.do, { always }, found);
  }
  return found;
}
