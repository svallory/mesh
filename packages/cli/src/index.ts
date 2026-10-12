// From the runtime, not the compiler: a config module imported at run time loads no build code (ADR-0033), and neither
// does application code that imports `Mesh` (PRJ-22).
export { defineConfig, type MeshConfig } from "@meshfw/runtime";
export { Mesh, type MeshFunctions } from "@meshfw/runtime";
