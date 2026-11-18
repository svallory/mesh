import type { Action, Entity, Step } from "@meshfw/model";
import { alwaysCovers } from "./policies.ts";

/**
 * The input fields Mesh adds to an action because a step asks for one, written nowhere in its `input` section (ADR-0100):
 * `lock &version` adds `expectedVersion`. They are not stored in `Action.input`, which holds what the author wrote; every
 * consumer of an action's input (the input view, the command check, the expression typer, `mesh explain`) appends
 * `derivedInputs` to it.
 */
export type LockStep = Extract<Step, { kind: "lock" }>;

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

/** One input field a step adds: its name, the step, and whether a call must give it (not nullable) or may leave it out (nullable). */
export interface DerivedField {
  name: string;
  source: "lock";
  step: LockStep;
  required: boolean;
  nullable: boolean;
}

/** The derived input fields of an action, in the order its input type lists them after the authored ones: the lock's. */
export function derivedInputs(entity: Pick<Entity, "always">, action: Pick<Action, "kind" | "name" | "do">): DerivedField[] {
  const lock = lockOf(entity, action);
  if (!lock) return [];
  const optional = lock.step.optional === true;
  return [{ name: lock.field, source: "lock", step: lock.step, required: !optional, nullable: optional }];
}
