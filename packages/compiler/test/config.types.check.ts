import { defineConfig, type MeshConfig, type ResolvedConfig } from "../src/index.ts";

// Compile-only coverage of the outer container contract. Individual elements
// and data deliberately have no M1 semantic type constraint.
const extensions = [Symbol("opaque"), { future: true }, undefined] as const;
const config: MeshConfig = { resources: "resources", output: "generated", data: null, extensions };
defineConfig(config);
const resolved: ResolvedConfig = { root: "/project", configFile: "/project/mesh.config.ts", resourceFiles: [], output: "/project/generated", extensions };
void resolved;

// @ts-expect-error extensions must be an array, not a scalar string
defineConfig({ resources: "resources", output: "generated", extensions: "opaque" });
// @ts-expect-error extensions must be an array, not null
defineConfig({ resources: "resources", output: "generated", extensions: null });
// @ts-expect-error the resolved configuration retains the same array boundary
const invalidResolved: ResolvedConfig = { ...resolved, extensions: false };
void invalidResolved;
