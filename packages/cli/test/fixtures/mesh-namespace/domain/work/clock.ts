import { Mesh } from "meshfw";

/** Application code an entity file calls: it cannot read the running action's instant yet, so this throws (PRJ-22). */
export function appClock(): Date {
  return Mesh.now();
}
