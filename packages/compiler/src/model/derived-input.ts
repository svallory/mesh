import type { Action, Entity, Step } from "@meshfw/model";
import { alwaysCovers } from "./policies.ts";

/**
 * The input fields Mesh adds to an action because a step asks for one, written nowhere in its `input` section (ADR-0100):
 * `lock &version` adds `expectedVersion`, and `relate &tracks` a list named like its relationship, `tracks`. They are not stored in `Action.input`, which holds what the author wrote; every
 * consumer of an action's input (the input view, the command check, the expression typer, `mesh explain`) appends
 * `derivedInputs` to it.
 */
export type LockStep = Extract<Step, { kind: "lock" }>;
export type RelateStep = Extract<Step, { kind: "relate" }>;

/** `expected` + the member name with its first letter upper-cased: `version` gives `expectedVersion`. */
export const lockField = (member: string): string => `expected${member[0]!.toUpperCase()}${member.slice(1)}`;

/** The `lock` steps written at the top level of a `do` (the builder refuses one under a step `when`). */
export const locksIn = (steps: readonly Step[]): LockStep[] => steps.filter((step): step is LockStep => step.kind === "lock");

/**
 * The lock that reaches `action`: one of the `always` blocks that cover it, then its own `do`; undefined for a create or a
 * read, which no lock reaches (`checkLockRelate` refuses a lock written for one). On a project that builds, at most one is
 * found (the build refuses a second, `MESH_LOCK_STEP`).
 */
export function lockOf(entity: Pick<Entity, "always">, action: Pick<Action, "kind" | "name" | "do">): { step: LockStep; field: string } | undefined {
  if (action.kind !== "update" && action.kind !== "destroy") return undefined;
  const step = [
    ...entity.always.filter((block) => alwaysCovers(block, action)).flatMap((block) => locksIn(block.do)),
    ...locksIn(action.do),
  ][0];
  return step ? { step, field: lockField(step.member.name) } : undefined;
}

/**
 * The `relate` steps of an action's own `do`, in written order: the only place one is read (the builder refuses one under
 * a step `when` or in an `always` block, `checkLockRelate` one in a destroy or a read).
 */
export function relatesOf(action: Pick<Action, "kind" | "do">): RelateStep[] {
  if (action.kind !== "create" && action.kind !== "update") return [];
  return action.do.filter((step): step is RelateStep => step.kind === "relate");
}

/**
 * One input field a step adds: its name, the step, and whether a call must give it (not nullable) or may leave it out
 * (nullable). A relate's list is always optional and never nullable: a call that leaves it out changes no child.
 */
export type DerivedField =
  | { name: string; source: "lock"; step: LockStep; required: boolean; nullable: boolean }
  | { name: string; source: "relate"; step: RelateStep; required: false; nullable: false };

/**
 * The derived input fields of an action, in the order its input type lists them after the authored ones: the lock's,
 * then one per `relate` in written order (a second relate of one relationship is refused, `MESH_RELATE_STEP`, and adds
 * no second field).
 */
export function derivedInputs(entity: Pick<Entity, "always">, action: Pick<Action, "kind" | "name" | "do">): DerivedField[] {
  const fields: DerivedField[] = [];
  const lock = lockOf(entity, action);
  if (lock) {
    const optional = lock.step.optional === true;
    fields.push({ name: lock.field, source: "lock", step: lock.step, required: !optional, nullable: optional });
  }
  for (const step of relatesOf(action))
    if (!fields.some((field) => field.name === step.relationship.name))
      fields.push({ name: step.relationship.name, source: "relate", step, required: false, nullable: false });
  return fields;
}
