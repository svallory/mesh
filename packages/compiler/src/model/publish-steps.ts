import { includerTagger } from "./includers.ts";
import type { Diagnostic, Entity, Expression, ModelDocument, SourcePosition, Step } from "@meshfw/model";
import { error } from "./diagnostics.ts";
import { mayPublish, ownersOf } from "./owners.ts";
import type { AggregateMembership } from "./aggregates.ts";

/**
 * A `new` a `publish` function returns, resolved to an event by the front end: the declaring file (as the import writes it),
 * the name that file gives the event, the reference as written (`InvoicePaid`, `Paid`, `ev.InvoicePaid`) and where its
 * callee is. Kept beside the expression, never in it, so `model.json` does not change.
 */
export interface PublishTarget { from: string; declared: string; identifier: string; position: SourcePosition }

/** True for a `publish`, and for a `when` that holds only `publish` steps (at any depth): a guarded publish. */
const publishesOnly = (step: Step): boolean => step.kind === "publish" || (step.kind === "when" && step.steps.every(publishesOnly));

/**
 * A step that runs before the action's row is written: a `set`, a `load`, a `run` with no `after=`, and a `when`, whose
 * condition is read before the write. A `when` that holds only `publish` steps is left out: its condition is read before
 * the write, but all it guards runs after it, so a `publish` written ahead of it still runs in the order on the page. This
 * is the spec's way of publishing one of several events (Claim `:end`, "What Hyper needs"), one `when=` per outcome. A
 * `lock` writes nothing of its own before the write (it compares before `validate`, wherever it is written).
 */
const runsBeforeWrite = (step: Step): boolean => !publishesOnly(step) && !(step.kind === "run" && step.after === "write") && step.kind !== "lock" && step.kind !== "relate";

/** The steps in written order, a `when` before the steps it holds. */
function flatten(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => (step.kind === "when" ? [step, ...flatten(step.steps)] : [step]));
}

/**
 * `MESH_PUBLISH_BEFORE_WRITE` (a warning): a `publish` written ahead of a step that runs before the write. Every `publish`
 * runs after the write, in written order among the `run [after=:write]` steps (`notes/spec/events-and-commands.md`,
 * "Publishing"), so one written among the steps before the write reads as though it ran there, and does not. One written
 * after the last of them, or among the after-write steps, says what it does.
 *
 * `MESH_PUBLISH`, the fourth of the spec's cases (the other three are the front end's: a `publish` that is no function or
 * names no event, and one in a `validate`, a `check` or a read): a `publish` of an event that owners list, from an action
 * of an entity that is none of them and neither the root nor a part of an aggregate that is one ("Owners publish"). Only a `new` the build resolved is checked; a function that returns
 * a helper's result is not. When a file of the project did not parse (`complete` false) it is not checked at all: the
 * missing file may list the entity as an owner.
 */
export function checkPublishSteps(
  document: ModelDocument,
  diagnostics: Diagnostic[],
  { targetsOf, fqnOf, membership = () => [], complete }: {
    /** The `new`s a publish function returns, resolved (`publishTargetsOf`). */
    targetsOf: (fn: Expression) => readonly PublishTarget[];
    /** The FQN of the event a target names, from the entity's file; undefined when no event is built for it. */
    fqnOf: (entity: Entity, target: PublishTarget) => string | undefined;
    /** The aggregates an entity is the root or a part of (`aggregatesOf`); none when absent. */
    membership?: (entityFqn: string) => readonly AggregateMembership[];
    complete: boolean;
  },
): void {
  const owners = ownersOf(document);
  const owned = (entity: Entity, steps: readonly Step[]) => {
    if (!complete || owners.size === 0) return;
    for (const step of flatten(steps)) {
      if (step.kind !== "publish") continue;
      for (const target of targetsOf(step.fn)) {
        const fqn = fqnOf(entity, target);
        if (fqn === undefined) continue;
        const allowed = mayPublish(owners, membership, entity.fqn, fqn);
        if (allowed.ok) continue;
        const listers = allowed.owners.join(", ");
        const one = allowed.owners.length === 1;
        diagnostics.push(error("MESH_PUBLISH",
          `\`${target.identifier}\` is ${fqn}, which ${listers} ${one ? "lists in its" : "list in their"} \`events\` section, and ${entity.fqn} is not one of its owners: an action publishes only events its owner lists, or events no owner lists`,
          target.position,
          `list it in the \`events\` section of ${entity.fqn}, or publish it from an action of ${one ? allowed.publishers[0] : `one of ${allowed.publishers.join(", ")}`}`));
      }
    }
  };
  const check = (steps: readonly Step[], where: string) => {
    const list = flatten(steps);
    list.forEach((step, index) => {
      if (step.kind !== "publish" || !list.slice(index + 1).some(runsBeforeWrite)) return;
      diagnostics.push({ ...error("MESH_PUBLISH_BEFORE_WRITE",
        `A \`publish\` of ${where} is written among the steps before the write, and it runs after the write, in written order among the \`run [after=:write]\` steps: it reads \`self\` as the stored record`,
        step.position, "write it after the steps that run before the write, so the order on the page is the order it runs in"), severity: "warning" });
    });
  };
  const tagIncluder = includerTagger(diagnostics);
  for (const entity of document.entities) {
    tagIncluder(entity);
    for (const action of entity.actions) {
      check(action.do, `${entity.fqn}#${action.name}`);
      owned(entity, action.do);
    }
    entity.always.forEach((block, index) => {
      check(block.do, `an always block of ${entity.fqn} (block ${index + 1})`);
      owned(entity, block.do);
    });
  }
  tagIncluder();
}
