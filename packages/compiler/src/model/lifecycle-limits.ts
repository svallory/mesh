import type { ActionType, Diagnostic, Entity, ModelDocument, Step } from "@meshfw/model";
import { actionExpressions, type ActionExpression } from "./action-expressions.ts";
import { error } from "./diagnostics.ts";

/** True when the function only ever runs in a create: an action that is one, or an `always` block that covers nothing else. */
function createOnly(entity: Entity, owner: ActionExpression["owner"]): boolean {
  if ("action" in owner) return owner.action.kind === "create";
  const { always } = owner;
  const named = always.actions?.map((ref) => entity.actions.find((a) => a.name === ref.name)?.kind ?? (ref.name === "create" ? "create" : undefined));
  const covers = always.types ?? named;
  return covers !== undefined && covers.length > 0 && covers.every((kind) => kind === "create");
}

/**
 * What the action lifecycle (M5) does not run yet is a build error that names the milestone (ADR-0018), never a
 * silent skip: a function that reads `actions` or `tx` (action composition, the second half of M5), and a `validate`
 * or `do` on a read, which has no record to check or change.
 */
export function checkLifecycleLimits(document: ModelDocument, diagnostics: Diagnostic[]): void {
  for (const entity of document.entities) {
    for (const { expression, what } of actionExpressions(entity)) {
      const reads = expression.params.find((param) => param === "actions" || param === "tx")
        ?? (expression.plain?.why === "uses-tx" ? "tx" : undefined);
      if (reads)
        diagnostics.push(error("MESH_NOT_IMPLEMENTED",
          `${what} reads \`${reads}\`, which belongs to action composition: \`actions\` and \`tx\` arrive in the second half of M5`,
          expression.position, "Remove it for now; an action can do its single-entity work with `check`, `set`, `when`, `load` and `run`"));
    }
    // A plain function (a `run`, or a body that is not one expression) is not type-checked by the expression pass, so a create's
    // `before` parameter is caught here: a create has no stored record.
    for (const { expression, what, owner } of actionExpressions(entity)) {
      const reads = expression.params.includes("before") || (expression.rest && /\bbefore\b/.test(expression.source));
      if (!expression.plain || !reads || !createOnly(entity, owner)) continue;
      // The type pass already reported a `before` it found inside this function (a `details` value it could translate).
      const end = expression.position.offset + expression.source.length;
      if (diagnostics.some((d) => d.code === "MESH_BEFORE_IN_CREATE" && d.position.file === expression.position.file && d.position.offset >= expression.position.offset && d.position.offset < end)) continue;
      diagnostics.push(error("MESH_BEFORE_IN_CREATE",
        `${what} reads \`before\`, the stored record, and a create has none, so it is always null`, expression.position,
        "Remove it. Compare with `self` or `input`, or move the rule to an update"));
    }
    for (const action of entity.actions) {
      if (action.kind !== "read") continue;
      if (action.validate.length || action.do.length)
        diagnostics.push(error("MESH_NOT_IMPLEMENTED",
          `read :${action.name} of :${entity.name} declares ${action.validate.length ? "validate" : "do"}, which a read does not run: it has no record to check or change`,
          action.position, "A read narrows its rows with `filter`; its caller narrows them further with `filter`, `sort`, `limit` and `offset`"));
    }
    // A destroy returns nothing and writes nothing: a `set` or `load` in one would be dropped, so it is refused.
    const refuseDestroyStep = (steps: Step[], where: string): void => {
      for (const step of steps) {
        if (step.kind === "set" || step.kind === "load")
          diagnostics.push(error("MESH_DESTROY_STEP",
            `${where} has a \`${step.kind}\` step, and a destroy returns nothing and writes nothing, so it would do nothing`,
            step.position, step.kind === "set" ? "Remove it. A destroy can `check` the record, and `run` work that happens before the delete" : "Remove it. A destroy returns nothing for a loaded record to appear on"));
        else if (step.kind === "when") refuseDestroyStep(step.steps, where);
      }
    };
    for (const action of entity.actions) if (action.kind === "destroy") refuseDestroyStep(action.do, `destroy :${action.name} of :${entity.name}`);
    for (const always of entity.always) {
      const covers = always.types?.includes("destroy") || always.actions?.some((ref) => entity.actions.find((a) => a.name === ref.name)?.kind === "destroy" || (ref.name === "destroy" && entity.auto.includes("destroy")));
      if (covers) refuseDestroyStep(always.do, `an always block of :${entity.name} that covers a destroy`);
    }
    for (const always of entity.always) {
      if (!always.validate.length && !always.do.length) continue;
      const reads = (always.types ?? []).includes("read" satisfies ActionType)
        || always.actions?.some((ref) => entity.actions.find((a) => a.name === ref.name)?.kind === "read" || (ref.name === "read" && entity.auto.includes("read")));
      if (reads)
        diagnostics.push(error("MESH_NOT_IMPLEMENTED",
          `always declares ${always.validate.length ? "validate" : "do"} for a read, which does not run it: a read has no record to check or change`,
          always.position, "Scope the block to :create, :update or :destroy"));
    }
  }
}
