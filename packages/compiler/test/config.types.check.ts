import { defineConfig, type MeshConfig, type ResolvedConfig } from "../src/index.ts";
import type { DataAdapter } from "@meshfw/runtime";

const data: DataAdapter = { kind: "data-adapter", name: "sqlite", options: { file: ":memory:" } };
const extensions = [{ name: "audit", future: true }] as const;
const config: MeshConfig = { domain: "src/domain", output: ".mesh", data, extensions };
defineConfig(config);
const resolved: ResolvedConfig = { root: "/project", domainRoot: "/project/src/domain", configFile: "/project/mesh.config.ts", entityFiles: [], output: "/project/.mesh", data, extensions };
void resolved;

// @ts-expect-error data is required
defineConfig({ domain: "src/domain", output: ".mesh" });
// @ts-expect-error data must be a descriptor
defineConfig({ ...config, data: null });
// @ts-expect-error extension elements require names
defineConfig({ ...config, extensions: [{}] });
// @ts-expect-error extensions must be an array, not a scalar string
defineConfig({ ...config, extensions: "opaque" });
// @ts-expect-error extensions must be an array, not null
defineConfig({ ...config, extensions: null });
// @ts-expect-error the resolved configuration retains the same array boundary
const invalidResolved: ResolvedConfig = { ...resolved, extensions: false };
void invalidResolved;
