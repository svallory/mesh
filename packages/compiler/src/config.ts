import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat, realpath } from "node:fs/promises";
import type { Diagnostic } from "@mesh/model";
import { buildModel, error, positionAt, type BuildResult } from "./build.ts";
import { absolutePath, canonicalFuturePath, confinedGlob, foreignAbsolute, inside, normalizePath, projectPath, resolveResource, errorCode } from "./paths.ts";

export interface MeshConfig {
  /** Resource folder (recursive .mx discovery), glob or file list, relative to mesh.config.ts. */
  resources: string | string[];
  /** Output folder, relative to mesh.config.ts; no files are emitted here. */
  output: string;
  /** Opaque until M2: accepted and preserved, not required or interpreted in M1. */
  data?: unknown;
  /** Opaque until M6: accepted and preserved without activating extensions in M1. */
  extensions?: unknown;
}
export interface ResolvedConfig {
  root: string;
  configFile: string;
  resourceFiles: string[];
  output: string;
  data?: unknown;
  extensions?: unknown;
}
export interface ConfigResult { config: ResolvedConfig | null; diagnostics: Diagnostic[] }
export function defineConfig(config: MeshConfig): MeshConfig { return config; }
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** mesh.config.ts is trusted executable project code, not a resource declaration.
 * Path containment is nevertheless physical as well as lexical: resource and
 * output symlinks must resolve inside the canonical project root. */
export async function loadConfig(projectRoot: string): Promise<ConfigResult> {
  const diagnostics: Diagnostic[] = [];
  const start = positionAt("", "mesh.config.ts", 0);
  if (foreignAbsolute(projectRoot)) return { config: null, diagnostics: [error("MESH_CONFIG_ROOT", "Project root must be a host-compatible path", start, "Use a project directory on this host")] };
  const root = resolve(normalizePath(projectRoot));
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(root); }
  catch (cause) {
    return { config: null, diagnostics: [error("MESH_CONFIG_ROOT", `Cannot resolve project root (${errorCode(cause) ?? "UNKNOWN"})`, start, "Use an existing project directory")] };
  }
  const configFile = resolve(root, "mesh.config.ts");
  let source: string;
  try { source = await readFile(configFile, "utf8"); }
  catch (cause) {
    return { config: null, diagnostics: [error("MESH_CONFIG_READ", `Cannot read mesh.config.ts (${errorCode(cause) ?? "UNKNOWN"})`, start, "Create mesh.config.ts with resources and output")] };
  }
  // Best-effort key positions: executable config may compute fields dynamically.
  // Regex keys are escaped, never interpreted as user-supplied pattern syntax.
  const at = (field: string) => {
    const match = new RegExp(`(?:^|[\\s,{])(?:["']?)(${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?:["']?)\\s*:`).exec(source);
    return positionAt(source, "mesh.config.ts", match ? match.index + match[0].indexOf(field) : 0);
  };
  const fail = (field: string, message: string, fix = `Fix the ${field} field in mesh.config.ts`) => diagnostics.push(error("MESH_CONFIG", message, at(field), fix));
  let value: unknown;
  try {
    // Bun shares ESM and require.cache; query strings do not invalidate a file.
    delete require.cache[configFile];
    delete require.cache[resolve(canonicalRoot, "mesh.config.ts")];
    value = (await import(pathToFileURL(configFile).href)).default;
  } catch (cause) {
    // Only paths Mesh produces from structured values are made relative. The
    // name/message of an exception from executable config is external text:
    // preserve it verbatim, including paths, rather than rewriting its meaning.
    // Its diagnostic position remains the project-relative config filename.
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : `Thrown value: ${String(cause)}`;
    return { config: null, diagnostics: [error("MESH_CONFIG_LOAD", `Cannot load mesh.config.ts: ${detail}`, start, "Fix the config module and export default defineConfig({...})")] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("default", "mesh.config.ts must default-export a configuration object");
    return { config: null, diagnostics };
  }
  const config = value as Record<string, unknown>;
  const keys = new Set(["resources", "output", "data", "extensions"]);
  for (const key of Object.keys(config)) if (!keys.has(key)) fail(key, `Unknown configuration field "${key}"`, "Remove the unknown field");
  const resources = config.resources;
  if (!nonEmpty(resources) && !(Array.isArray(resources) && resources.length > 0 && resources.every(nonEmpty))) fail("resources", "Configuration field `resources` must be a non-empty relative folder, glob or list of relative file paths");
  if (!nonEmpty(config.output)) fail("output", "Configuration field `output` must be a non-empty relative directory path");
  if (diagnostics.length) return { config: null, diagnostics };

  const outputInput = normalizePath(config.output as string);
  const output = resolve(root, outputInput);
  if (absolutePath(outputInput) || !inside(root, output) || output === root) {
    fail("output", "Configuration field `output` must name a directory inside the project, not the project root");
  } else {
    try {
      const canonicalOutput = await canonicalFuturePath(output);
      if (!inside(canonicalRoot, canonicalOutput) || canonicalOutput === canonicalRoot) fail("output", "Configuration field `output` resolves outside the project");
    } catch (cause) { fail("output", `Cannot resolve generated directory (${errorCode(cause) ?? "UNKNOWN"})`); }
  }
  let files: string[] = [];
  if (typeof resources === "string") {
    const input = normalizePath(resources);
    if (!confinedGlob(input)) fail("resources", "Configuration field `resources` must stay inside the project");
    else {
      try {
        const candidate = resolve(root, input);
        let folder = false;
        try { folder = (await stat(candidate)).isDirectory(); }
        catch (cause) {
          // A glob normally has no literal filesystem entry. Only that absence
          // allows discovery to continue; permission and other I/O errors surface.
          if (errorCode(cause) !== "ENOENT" && errorCode(cause) !== "ENOTDIR") throw cause;
        }
        if (folder && !inside(canonicalRoot, await realpath(candidate))) {
          fail("resources", `Resource path "${projectPath(root, candidate)}" resolves outside the project`);
        } else {
          const cwd = folder ? candidate : root;
          const glob = folder ? "**/*.mx" : input;
          for await (const file of new Bun.Glob(glob).scan({ cwd, onlyFiles: true, followSymlinks: true })) files.push(resolve(cwd, normalizePath(file)));
          if (files.length === 0) fail("resources", "Configuration field `resources` matches no files");
        }
      } catch (cause) { fail("resources", `Cannot expand resource glob (${errorCode(cause) ?? "UNKNOWN"})`); }
    }
  } else {
    for (const item of resources as string[]) {
      const path = absolutePath(item) ? null : resolveResource(root, item);
      if (!path) fail("resources", "Resource file path must resolve inside the project");
      else files.push(path.absolute);
    }
  }
  files = [...new Set(files)].sort();
  for (const file of files) {
    const name = projectPath(root, file);
    try {
      const canonicalFile = await realpath(file);
      if (!inside(canonicalRoot, canonicalFile)) { fail("resources", `Resource path "${name}" resolves outside the project`); continue; }
      if (!(await stat(file)).isFile()) fail("resources", `Resource path "${name}" is not a file`);
    } catch (cause) { fail("resources", `Cannot read resource file "${name}" (${errorCode(cause) ?? "UNKNOWN"})`); }
  }
  // These future-milestone fields are deliberately opaque. Preserve presence,
  // references and even explicit undefined; do not serialize or interpret them.
  const opaque = {
    ...(Object.hasOwn(config, "data") ? { data: config.data } : {}),
    ...(Object.hasOwn(config, "extensions") ? { extensions: config.extensions } : {}),
  };
  return { config: diagnostics.length ? null : { root, configFile, resourceFiles: files, output, ...opaque }, diagnostics };
}

export async function loadProject(config: ResolvedConfig): Promise<BuildResult> {
  const files: { file: string; source: string }[] = [];
  const diagnostics: Diagnostic[] = [];
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(config.root); }
  catch (cause) {
    return { document: null, diagnostics: [error("MESH_CONFIG_ROOT", `Cannot resolve project root (${errorCode(cause) ?? "UNKNOWN"})`, positionAt("", "mesh.config.ts", 0), "Use an existing project directory")] };
  }
  for (const file of config.resourceFiles) {
    const path = resolveResource(config.root, file);
    if (!path) {
      diagnostics.push(error("MESH_RESOURCE_PATH", "Resource file path must resolve inside the project", positionAt("", "mesh.config.ts", 0), "Use a resource path inside the project"));
      continue;
    }
    try {
      if (!inside(canonicalRoot, await realpath(path.absolute))) {
        diagnostics.push(error("MESH_RESOURCE_PATH", `Resource path "${path.file}" resolves outside the project`, positionAt("", path.file, 0), "Use a resource path inside the project"));
        continue;
      }
      files.push({ file: path.absolute, source: await readFile(path.absolute, "utf8") });
    } catch (cause) { diagnostics.push(error("MESH_RESOURCE_READ", `Cannot read resource file "${path.file}" (${errorCode(cause) ?? "UNKNOWN"})`, positionAt("", path.file, 0), "Restore the resource file or fix the resources list")); }
  }
  const result = buildModel({ root: config.root, files });
  return { document: diagnostics.length ? null : result.document, diagnostics: [...diagnostics, ...result.diagnostics] };
}
