import { privileged } from "./entity.ts";
import { FrameworkError } from "./errors.ts";
import { isSystem, now as instantOf, today as dayOf, type Scope } from "./expr.ts";

/**
 * Mesh's own functions (PRJ-22), one frozen object, so that no name an application or an entity file chooses can collide
 * with them: `import { Mesh } from "meshfw"`, then `Mesh.now()`, `Mesh.today()`, `Mesh.isSystem(context)` and
 * `Mesh.privileged(Task)`. An entity file imports it the same way; the expressions Mesh generates from the file call the
 * same functions, with `now` and `today` reading the instant of the action or load that runs the expression.
 */
export interface MeshFunctions {
  /**
   * The reads of an entity with no policy run (TXN-16, TXN-17): `Mesh.privileged(Task).read(input, context?)`. Inside an
   * action it joins the action's transaction and reads the action's instant.
   */
  readonly privileged: typeof privileged;
  /**
   * The instant of the running action: one instant per action call or load, the same each time it is read. In an entity
   * file's expressions it is the instant of the action or load that runs them. Application code cannot read it yet: the
   * running action lives in the project's async frame, which the run-time library does not hold, so it throws there.
   */
  readonly now: () => Date;
  /** `Mesh.now()` at 00:00 UTC; throws where `Mesh.now()` does. */
  readonly today: () => Date;
  /**
   * `Mesh.isSystem(context)`: true only when the value is an object whose `system` key is `true` (ADR-0071). Never unknown:
   * a missing context, a missing key or any other value is false, so a policy that admits internal writes with it fails
   * closed.
   */
  readonly isSystem: (context: unknown) => boolean;
}

function outsideAnExpression(name: string): never {
  throw new FrameworkError(`Mesh.${name}() was called outside an entity file's expression: application code cannot find the running action's instant yet. In a function of the entity file (a step or a check), pass Mesh.${name}() or the file's Mesh to the helper; elsewhere, take the time from the application's own clock`);
}

export const Mesh: MeshFunctions = Object.freeze({
  privileged,
  now: () => outsideAnExpression("now"),
  today: () => outsideAnExpression("today"),
  isSystem,
});

/**
 * `Mesh` as one evaluation sees it: `now` and `today` read the scope's instant (the running action's, or the load's). The
 * generated expressions bind it under the name the entity file imports `Mesh` as, for a function that reads it.
 */
export function meshIn(s: Scope): MeshFunctions {
  return Object.freeze({ ...Mesh, now: () => instantOf(s), today: () => dayOf(s) });
}
