import type { Diagnostic, ModelDocument, Step } from "@meshfw/model";
import { error } from "./diagnostics.ts";

/** True for a `publish`, and for a `when` that holds only `publish` steps (at any depth): a guarded publish. */
const publishesOnly = (step: Step): boolean => step.kind === "publish" || (step.kind === "when" && step.steps.every(publishesOnly));

/**
 * A step that runs before the action's row is written: a `set`, a `load`, a `run` with no `after=`, and a `when`, whose
 * condition is read before the write. A `when` that holds only `publish` steps is left out: its condition is read before
 * the write, but all it guards runs after it, so a `publish` written ahead of it still runs in the order on the page. This
 * is the spec's way of publishing one of several events (Claim `:end`, "What Hyper needs"), one `when=` per outcome.
 */
const runsBeforeWrite = (step: Step): boolean => !publishesOnly(step) && !(step.kind === "run" && step.after === "write");

/** The steps in written order, a `when` before the steps it holds. */
function flatten(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => (step.kind === "when" ? [step, ...flatten(step.steps)] : [step]));
}

/**
 * `MESH_PUBLISH_BEFORE_WRITE` (a warning): a `publish` written ahead of a step that runs before the write. Every `publish`
 * runs after the write, in written order among the `run [after=:write]` steps (`notes/spec/events-and-commands.md`,
 * "Publishing"), so one written among the steps before the write reads as though it ran there, and does not. One written
 * after the last of them, or among the after-write steps, says what it does. (The other three of the spec's four `MESH_PUBLISH`
 * cases are the front end's: a `publish` that is no function or names no event, and one in a `validate`, a `check` or a
 * read. The fourth, an event the action's owner does not list, is vacuous until owner sections exist.)
 */
export function checkPublishSteps(document: ModelDocument, diagnostics: Diagnostic[]): void {
  const check = (steps: readonly Step[], where: string) => {
    const list = flatten(steps);
    list.forEach((step, index) => {
      if (step.kind !== "publish" || !list.slice(index + 1).some(runsBeforeWrite)) return;
      diagnostics.push({ ...error("MESH_PUBLISH_BEFORE_WRITE",
        `A \`publish\` of ${where} is written among the steps before the write, and it runs after the write, in written order among the \`run [after=:write]\` steps: it reads \`self\` as the stored record`,
        step.position, "write it after the steps that run before the write, so the order on the page is the order it runs in"), severity: "warning" });
    });
  };
  for (const entity of document.entities) {
    for (const action of entity.actions) check(action.do, `${entity.fqn}#${action.name}`);
    entity.always.forEach((block, index) => check(block.do, `an always block of ${entity.fqn} (block ${index + 1})`));
  }
}
