// From the runtime, not the compiler: a config module imported at run time loads no build code (ADR-0033).
export { defineConfig, type MeshConfig } from "@meshfw/runtime";
