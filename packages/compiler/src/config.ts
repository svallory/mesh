import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat, realpath, lstat } from "node:fs/promises";
import type { Diagnostic } from "@meshfw/model";
import type { DataAdapter, ExtensionDescriptor } from "@meshfw/runtime";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "@meshfw/runtime";
import { buildModel, error, positionAt, type BuildResult } from "./build.ts";
import { absolutePath, canonicalFuturePath, confinedGlob, foreignAbsolute, inside, normalizePath, projectPath, resolveEntityFile, errorCode } from "./paths.ts";

export interface ResolvedConfig {
  root: string;
  configFile: string;
  domainRoot: string;
  entityFiles: string[];
  output: string;
  data: DataAdapter;
  extensions?: readonly ExtensionDescriptor[];
}
export interface ConfigResult { config: ResolvedConfig | null; diagnostics: Diagnostic[] }
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function isDataAdapter(value: unknown): value is DataAdapter {
  return record(value) && value.kind === "data-adapter" && nonEmpty(value.name) && nonEmpty(value.build) && record(value.options);
}

/** mesh.config.ts is trusted executable project code, not an entity declaration.
 * Path containment is nevertheless physical as well as lexical: entity
 * symlinks and output ancestors must resolve inside the canonical project root.
 * The output directory itself must not be a symlink. */
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
    return { config: null, diagnostics: [error("MESH_CONFIG_READ", `Cannot read mesh.config.ts (${errorCode(cause) ?? "UNKNOWN"})`, start, "Create mesh.config.ts with domain, output and data")] };
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
    // Preserve exception text from executable configuration verbatim.
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : `Thrown value: ${String(cause)}`;
    return { config: null, diagnostics: [error("MESH_CONFIG_LOAD", `Cannot load mesh.config.ts: ${detail}`, start, "Fix the config module and export default defineConfig({...})")] };
  }
  if (!record(value)) {
    fail("default", "mesh.config.ts must default-export a configuration object");
    return { config: null, diagnostics };
  }
  const config = value;
  const keys = new Set(["domain", "output", "data", "extensions"]);
  for (const key of Object.keys(config)) if (!keys.has(key)) fail(key, `Unknown configuration field "${key}"`, key === "resources" ? "`resources` was renamed `domain`" : "Remove the unknown field");
  const domain = config.domain;
  if (!nonEmpty(domain) && !(Array.isArray(domain) && domain.length > 0 && domain.every(nonEmpty))) fail("domain", "Configuration field `domain` must be a non-empty relative folder, glob or list of relative file paths");
  if (!nonEmpty(config.output)) fail("output", "Configuration field `output` must be a non-empty relative directory path");
  const data = config.data;
  if (!isDataAdapter(data)) fail("data", "Configuration field `data` must be a data adapter descriptor", 'Import `sqlite` from `@meshfw/data-sqlite` and set data: sqlite({ file: "app.db" })');
  const extensions = config.extensions;
  if (Object.hasOwn(config, "extensions")) {
    if (!Array.isArray(extensions)) fail("extensions", "Configuration field `extensions` must be an array");
    else for (const [index, extension] of extensions.entries()) {
      if (!record(extension) || !nonEmpty(extension.name)) fail("extensions", `Configuration field \`extensions[${index}]\` must be an object with a non-empty name string`);
    }
  }
  if (diagnostics.length) return { config: null, diagnostics };

  const outputInput = normalizePath(config.output as string);
  const output = resolve(root, outputInput);
  if (absolutePath(outputInput) || !inside(root, output) || output === root) {
    fail("output", "Configuration field `output` must name a directory inside the project, not the project root");
  } else {
    try {
      let outputIsLink = false;
      try { outputIsLink = (await lstat(output)).isSymbolicLink(); }
      catch (cause) { if (errorCode(cause) !== "ENOENT") throw cause; }
      if (outputIsLink) {
        diagnostics.push(error("MESH_OUTPUT_SYMLINK",
          "Symlink in the output tree; delete or move it and rebuild using real files and directories",
          positionAt("", projectPath(root, output), 0)));
      } else {
        const canonicalOutput = await canonicalFuturePath(output);
        if (!inside(canonicalRoot, canonicalOutput) || canonicalOutput === canonicalRoot) fail("output", "Configuration field `output` resolves outside the project");
      }
    } catch (cause) { fail("output", `Cannot resolve generated directory (${errorCode(cause) ?? "UNKNOWN"})`); }
  }
  let files: string[] = [];
  let domainRoot = root;
  if (typeof domain === "string") {
    const input = normalizePath(domain);
    if (!confinedGlob(input)) fail("domain", "Configuration field `domain` must stay inside the project");
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
          fail("domain", `Entity file "${projectPath(root, candidate)}" resolves outside the project`);
        } else {
          const cwd = folder ? candidate : root;
          const glob = folder ? "**/*.mesh.mx" : input;
          // A partial segment before a wildcard is not a static directory.
          const wildcard = input.search(/[*?{\[]/);
          const prefix = wildcard < 0 ? input : input.slice(0, wildcard);
          domainRoot = folder ? candidate : resolve(root, prefix.slice(0, prefix.lastIndexOf("/") + 1) || ".");
          for await (const file of new Bun.Glob(glob).scan({ cwd, onlyFiles: true, followSymlinks: true, dot: true })) if (file.endsWith(".mesh.mx")) files.push(resolve(cwd, normalizePath(file)));
          if (files.length === 0) fail("domain", "Configuration field `domain` matches no files");
        }
      } catch (cause) { fail("domain", `Cannot expand entity file glob (${errorCode(cause) ?? "UNKNOWN"})`); }
    }
  } else {
    for (const item of domain as string[]) {
      const path = absolutePath(item) ? null : resolveEntityFile(root, item);
      if (!path) fail("domain", "Entity file path must resolve inside the project");
      else if (!path.file.endsWith(".mesh.mx")) fail("domain", "Entity files must end in .mesh.mx");
      else files.push(path.absolute);
    }
    if (files.length) {
      domainRoot = dirname(files[0]!);
      for (const file of files) while (!inside(domainRoot, file)) domainRoot = dirname(domainRoot);
    }
  }
  files = [...new Set(files)].sort();
  for (const file of files) {
    const name = projectPath(root, file);
    try {
      const canonicalFile = await realpath(file);
      if (!inside(canonicalRoot, canonicalFile)) { fail("domain", `Entity file "${name}" resolves outside the project`); continue; }
      if (!(await stat(file)).isFile()) fail("domain", `Entity file "${name}" is not a file`);
    } catch (cause) { fail("domain", `Cannot read entity file "${name}" (${errorCode(cause) ?? "UNKNOWN"})`); }
  }
  return { config: diagnostics.length ? null : {
    root, configFile, domainRoot, entityFiles: files, output, data: data as DataAdapter,
    ...(Object.hasOwn(config, "extensions") ? { extensions: extensions as readonly ExtensionDescriptor[] } : {}),
  }, diagnostics };
}

export async function loadProject(config: ResolvedConfig): Promise<BuildResult> {
  const files: { file: string; source: string }[] = [];
  const diagnostics: Diagnostic[] = [];
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(config.root); }
  catch (cause) {
    return { document: null, diagnostics: [error("MESH_CONFIG_ROOT", `Cannot resolve project root (${errorCode(cause) ?? "UNKNOWN"})`, positionAt("", "mesh.config.ts", 0), "Use an existing project directory")] };
  }
  for (const file of config.entityFiles) {
    const path = resolveEntityFile(config.root, file);
    if (!path) {
      diagnostics.push(error("MESH_ENTITY_PATH", "Entity file path must resolve inside the project", positionAt("", "mesh.config.ts", 0), "Use an entity file path inside the project"));
      continue;
    }
    try {
      if (!inside(canonicalRoot, await realpath(path.absolute))) {
        diagnostics.push(error("MESH_ENTITY_PATH", `Entity file "${path.file}" resolves outside the project`, positionAt("", path.file, 0), "Use an entity file path inside the project"));
        continue;
      }
      files.push({ file: path.absolute, source: await readFile(path.absolute, "utf8") });
    } catch (cause) { diagnostics.push(error("MESH_ENTITY_READ", `Cannot read entity file "${path.file}" (${errorCode(cause) ?? "UNKNOWN"})`, positionAt("", path.file, 0), "Restore the entity file or fix the domain list")); }
  }
  const result = buildModel({ root: config.root, domainRoot: config.domainRoot, files });
  if (result.document) result.document.data = { name: config.data.name };
  return { document: diagnostics.length ? null : result.document, diagnostics: [...diagnostics, ...result.diagnostics] };
}
