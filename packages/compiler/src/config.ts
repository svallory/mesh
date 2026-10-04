import { resolve, isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import type { Diagnostic } from "@mesh/model";
import { buildModel, error, positionAt, projectPath, type BuildResult } from "./build.ts";

export interface MeshConfig {
  /** Glob or explicit list, relative to mesh.config.ts. */
  resources: string | string[];
  /** Output directory, relative to mesh.config.ts; no files are emitted here. */
  generatedDir: string;
}
export interface ResolvedConfig {
  root: string;
  configFile: string;
  resourceFiles: string[];
  generatedDir: string;
}
export interface ConfigResult { config: ResolvedConfig | null; diagnostics: Diagnostic[] }
export function defineConfig(config: MeshConfig): MeshConfig { return config; }

function relativePath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !isAbsolute(value);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** mesh.config.ts is trusted executable project code, not a resource declaration. */
export async function loadConfig(projectRoot: string): Promise<ConfigResult> {
  const root = resolve(projectRoot);
  const configFile = resolve(root, "mesh.config.ts");
  const diagnostics: Diagnostic[] = [];
  let source: string;
  try { source = await readFile(configFile, "utf8"); }
  catch (cause) {
    return { config: null, diagnostics: [error("MESH_CONFIG_READ", `Cannot read mesh.config.ts: ${String(cause)}`, positionAt("", "mesh.config.ts", 0), "Create mesh.config.ts with resources and generatedDir")] };
  }
  // Best-effort key positions; config code may compute fields dynamically, in
  // which case file start is more honest than an invented location.
  const at = (field: string) => {
    const match = new RegExp(`(?:^|[\\s,{])(?:["']?)(${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?:["']?)\\s*:`).exec(source);
    return positionAt(source, "mesh.config.ts", match ? match.index + match[0].indexOf(field) : 0);
  };
  const fail = (field: string, message: string) => diagnostics.push(error("MESH_CONFIG", message, at(field)));
  let value: unknown;
  try {
    // Bun exposes its ESM cache through require.cache; query strings alone do
    // not invalidate a file module. Evict only the config, not its dependencies.
    delete require.cache[configFile];
    value = (await import(pathToFileURL(configFile).href)).default;
  } catch (cause) {
    return { config: null, diagnostics: [error("MESH_CONFIG_LOAD", `Cannot load mesh.config.ts: ${String(cause)}`, positionAt(source, "mesh.config.ts", 0), "Fix the config module and export default defineConfig({...})")] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("default", "mesh.config.ts must default-export a configuration object");
    return { config: null, diagnostics };
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) if (key !== "resources" && key !== "generatedDir") fail(key, `Unknown configuration field \"${key}\"`);
  const resources = config.resources;
  if (!relativePath(resources) && !(Array.isArray(resources) && resources.length > 0 && resources.every(relativePath))) fail("resources", "Configuration field `resources` must be a non-empty relative glob or list of relative file paths");
  if (!relativePath(config.generatedDir)) fail("generatedDir", "Configuration field `generatedDir` must be a non-empty relative directory path");
  if (diagnostics.length) return { config: null, diagnostics };
  const generatedDir = resolve(root, config.generatedDir as string);
  if (!inside(root, generatedDir) || generatedDir === root) fail("generatedDir", "Configuration field `generatedDir` must name a directory inside the project, not the project root");
  let files: string[];
  if (typeof resources === "string") {
    files = [];
    if (!inside(root, resolve(root, resources))) fail("resources", "Configuration field `resources` must stay inside the project");
    else try {
      for await (const file of new Bun.Glob(resources).scan({ cwd: root, onlyFiles: true })) files.push(resolve(root, file));
    } catch (cause) { fail("resources", `Cannot expand resource glob: ${String(cause)}`); }
    if (files.length === 0) fail("resources", "Configuration field `resources` matches no files");
  } else files = (resources as string[]).map((file) => resolve(root, file));
  files = [...new Set(files)].sort();
  for (const file of files) {
    if (!inside(root, file)) { fail("resources", `Resource path \"${projectPath(root, file)}\" is outside the project`); continue; }
    try { if (!(await stat(file)).isFile()) fail("resources", `Resource path \"${projectPath(root, file)}\" is not a file`); }
    catch (cause) { fail("resources", `Cannot read resource file \"${projectPath(root, file)}\": ${String(cause)}`); }
  }
  return { config: diagnostics.length ? null : { root, configFile, resourceFiles: files, generatedDir }, diagnostics };
}

export async function loadProject(config: ResolvedConfig): Promise<BuildResult> {
  const files: { file: string; source: string }[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const file of config.resourceFiles) {
    try { files.push({ file, source: await readFile(file, "utf8") }); }
    catch (cause) { diagnostics.push(error("MESH_RESOURCE_READ", `Cannot read resource file: ${String(cause)}`, positionAt("", projectPath(config.root, file), 0))); }
  }
  const result = buildModel({ root: config.root, files });
  return { document: diagnostics.length ? null : result.document, diagnostics: [...diagnostics, ...result.diagnostics] };
}
