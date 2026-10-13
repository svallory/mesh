import { privileged } from "./entity.ts";
import { isSystem } from "./expr.ts";

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
}

export const Mesh: MeshFunctions = Object.freeze({ privileged, isSystem });
