import type { ActionType, Diagnostic, ModelDocument } from "@meshfw/model";
import { actionExpressions } from "./action-expressions.ts";
import { error } from "./diagnostics.ts";

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
    for (const action of entity.actions) {
      if (action.kind !== "read") continue;
      if (action.validate.length || action.do.length)
        diagnostics.push(error("MESH_NOT_IMPLEMENTED",
          `read :${action.name} of :${entity.name} declares ${action.validate.length ? "validate" : "do"}, which a read does not run: it has no record to check or change`,
          action.position, "A read narrows its rows with `filter`; its caller narrows them further with `filter`, `sort`, `limit` and `offset`"));
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
