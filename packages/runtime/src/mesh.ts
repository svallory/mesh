import type { Decision } from "./answer.ts";
import { can, checkPolicies, privileged } from "./entity.ts";
import { isSystem } from "./expr.ts";
import type { ActionContext } from "./index.ts";

export type { Decision } from "./answer.ts";

/**
 * An action function as an entity value has it (`Todo.complete`): the input, then the context. `ActionFunction` alone
 * is any of them. `Mesh.checkPolicies` takes the call's input as `Parameters<A>[0]` of the action `A` it is given, so a
 * member the action does not take is refused as on the call, and a generic read (`load`) is typed with its type
 * parameters at their constraints, as a call with any `load` would be.
 */
export type ActionFunction<I = never> = (input: I, context: ActionContext) => Promise<unknown>;

/**
 * Mesh's own functions (PRJ-22), one frozen object, so that no name an application or an entity file chooses can collide
 * with them: `import { Mesh } from "meshfw"`, then `Mesh.isSystem(context)` and `Mesh.privileged(Task)`. An entity file
 * imports it the same way, and the expressions Mesh generates from the file call the same functions. The instant is not
 * here (SYN-29): an entity file reads the current transaction's as `%.now` and `%.today`, and application code that needs
 * it takes it as a parameter, which the entity file passes (`dueIn(%.today, 30)`).
 */
export interface MeshFunctions {
  /**
   * The reads of an entity with no policy run (TXN-16, TXN-17): `Mesh.privileged(Task).read(input, context?)`. Inside an
   * action it joins the action's transaction and reads the transaction's instant.
   */
  readonly privileged: typeof privileged;
  /**
   * `Mesh.isSystem(context)`: true only when the value is an object whose `system` key is `true` (ADR-0071). Never unknown:
   * a missing context, a missing key or any other value is false, so a policy that admits internal writes with it fails
   * closed.
   */
  readonly isSystem: (context: unknown) => boolean;
  /**
   * `Mesh.checkPolicies(Todo.complete, input, context)` (CMP-21, ADR-0022): resolves to `{ allowed, breakdown }`, the
   * decision the call `Todo.complete(input, context)` would reach, and changes nothing. The action function comes first,
   * then the call's own arguments, typed as the action's (a wrong input is a type error). The runtime recognises the
   * function through a registry of its own, so nothing is added to it; any other function is a `FrameworkError`. It runs
   * the call's checks in the call's order, on the binding the call would use, joining a running transaction of it (and
   * reading its instant) or in a transaction of its own that it rolls back; a denial's `breakdown` is the one the call's
   * `ForbiddenError` would carry. It runs no `validate`, step or seam, and writes nothing: a write action started while
   * the policies are checked, through any binding of the project, is refused before it runs, and the question throws a
   * `FrameworkError`; one that work they left running (a timer) starts after the answer is refused too. Where the call would throw before its policies decide (a failed cast,
   * a missing row), it throws the same error. A read answers whether it is allowed at all.
   */
  readonly checkPolicies: <A extends ActionFunction>(action: A, input: Parameters<A>[0], context: ActionContext) => Promise<Decision>;
  /** `Mesh.can(Todo.complete, input, context)`: resolves to `true` exactly when `Mesh.checkPolicies` for the same arguments resolves with `allowed` `true`. */
  readonly can: <A extends ActionFunction>(action: A, input: Parameters<A>[0], context: ActionContext) => Promise<boolean>;
}

export const Mesh: MeshFunctions = Object.freeze({ privileged, isSystem, checkPolicies, can });
