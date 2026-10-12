import { Mesh, type MeshFunctions } from "meshfw";

/** Application code an entity file calls: it cannot read the running action's instant yet, so this throws (PRJ-22). */
export function appClock(): Date {
  return Mesh.now();
}

/** Application code handed the entity file's `Mesh`: it reads the running action's instant through it. */
export function stampOf(mesh: MeshFunctions, label: string): string {
  return `${label}@${mesh.now().toISOString()}`;
}
