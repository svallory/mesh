import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat, realpath, lstat } from "node:fs/promises";
import type { Diagnostic } from "@meshfw/model";
import { BUS_CAPABILITIES, busProblem, CAPABILITIES, FrameworkError, keepProblem, renamedShapeProblems, validateCapabilityManifest, type DataAdapter, type EventsConfig, type ExtensionDescriptor } from "@meshfw/runtime";
export { defineConfig, type MeshConfig, type ExtensionDescriptor } from "@meshfw/runtime";
import { buildModel } from "./front-end/build.ts";
import { hasMeshExtension, meshExtensionsText, meshGlob } from "./front-end/extensions.ts";
import { isArchitectureFileName } from "./front-end/architecture-file.ts";
import { capabilityDiagnostics, eventsDiagnostics } from "./capabilities.ts";
import { handlersNotGenerated } from "./model/handlers.ts";
import { error, positionAt, type BuildResult } from "./model/index.ts";
import { absolutePath, canonicalFuturePath, confinedGlob, foreignAbsolute, inside, normalizePath, projectPath, resolveEntityFile, errorCode } from "./paths.ts";

export interface ResolvedConfig {
  root: string;
  configFile: string;
  domainRoot: string;
  entityFiles: string[];
  /** The surfaces root, absolute; absent when the config has no `surfaces`. */
  surfacesRoot?: string;
  /** The Mesh files under it, absolute, sorted; `ignore` applies to them as to entity files. Absent with `surfacesRoot`. */
  surfaceFiles?: string[];
  /** Discovered entity files that `ignore` excluded, with the pattern that matched. */
  ignoredFiles?: { file: string; pattern: string }[];
  output: string;
  data: DataAdapter;
  extensions?: readonly ExtensionDescriptor[];
  /** The `events` key as the project wrote it, checked: `bus`, `keep`, `load`, `requires` and `renamed` (M6). Absent when the config has none. */
  events?: EventsConfig;
  /**
   * Where keys of `events` sit in `mesh.config.ts`, for the checks that need the model (`eventsDiagnostics`): present
   * only for a key the config sets. Never part of `model.json`.
   */
  positions?: { readonly renamed?: Diagnostic["position"] };
}
export interface ConfigResult { config: ResolvedConfig | null; diagnostics: Diagnostic[] }
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function isDataAdapter(value: unknown): value is DataAdapter {
  return record(value) && value.kind === "data-adapter" && nonEmpty(value.name) && nonEmpty(value.build) && record(value.options);
}
/** Why the adapter's capability manifest is missing or invalid, or `null` when it is a valid one. */
function manifestProblem(adapter: DataAdapter): string | null {
  if (adapter.capabilities === undefined) return `The data adapter "${adapter.name}" declares no capabilities; its descriptor needs \`capabilities\`, a manifest made by defineCapabilities(...)`;
  try { validateCapabilityManifest(adapter.capabilities); return null; }
  catch (cause) { return `The data adapter "${adapter.name}" declares invalid capabilities: ${cause instanceof FrameworkError ? cause.message : String(cause)}`; }
}

/** The fix every `MESH_CONFIG_LOAD` for `#mesh` gives (spec, Events and commands, "Configuration and the events module"). */
const MESH_IMPORT_FIX = "Import it inside the function that uses it: `const { tables } = await import(\"#mesh\")`. A type-only import (`import type`) is fine.";
/** The message of a config that loads `#mesh` while it loads, naming the specifier. */
const meshImportMessage = (specifier: string) =>
  `mesh.config.ts imports \`${specifier}\` (directly or through a file it imports). \`#mesh\` is the code Mesh generates from this config, so the build cannot load it first.`;
/**
 * The `#mesh` specifier an import error is about, if it is about one. Bun's resolve error carries the full specifier as
 * `specifier` while its text names only the package ("Cannot find package '#mesh'" for `#mesh/domain/billing`), so the
 * property wins and the text is the fallback.
 */
function meshSpecifierIn(cause: unknown, detail: string): string | undefined {
  const specifier = typeof cause === "object" && cause !== null ? (cause as { specifier?: unknown }).specifier : undefined;
  if (typeof specifier === "string" && /^#mesh(?:\/|$)/.test(specifier)) return specifier;
  return /['"`](#mesh(?:\/[^'"`\s]*)?)['"`]/.exec(detail)?.[1];
}
/**
 * The `#mesh` specifier of a generated module, from its path below the output folder: `index.ts` is `#mesh`,
 * `domain/billing/index.ts` is `#mesh/domain/billing`, and any other file is `#mesh/<path>` without its extension.
 */
function meshSpecifierOf(relativePath: string): string {
  const path = relativePath.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/(?:^|\/)index$/, "");
  return path === "" ? "#mesh" : `#mesh/${path}`;
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
  // The modules loaded before the config: whatever the import adds is what the config loaded (`require.cache` lists the
  // ES modules `import()` loads on Bun; `test/config-load.test.ts` pins it). A module already loaded in this process
  // before the build is not seen again, which keeps a test or a watcher that imported `#mesh` itself from a false report.
  const loadedBefore = new Set(Object.keys(require.cache));
  try {
    // Bun shares ESM and require.cache; query strings do not invalidate a file.
    delete require.cache[configFile];
    delete require.cache[resolve(canonicalRoot, "mesh.config.ts")];
    value = (await import(pathToFileURL(configFile).href)).default;
  } catch (cause) {
    // Preserve exception text from executable configuration verbatim.
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : `Thrown value: ${String(cause)}`;
    // A `#mesh` that does not resolve (no output folder yet, or a module the entity files have only just added) is the
    // config loading the code the build is about to generate: said so, never "Cannot find package", which reads as a
    // missing dependency.
    const specifier = meshSpecifierIn(cause, detail);
    if (specifier) return { config: null, diagnostics: [error("MESH_CONFIG_LOAD", meshImportMessage(specifier), start, MESH_IMPORT_FIX)] };
    return { config: null, diagnostics: [error("MESH_CONFIG_LOAD", `Cannot load mesh.config.ts: ${detail}`, start, "Fix the error in mesh.config.ts, or in the file it imports that threw it")] };
  }
  const loadedNow = Object.keys(require.cache).filter((key) => !loadedBefore.has(key));
  if (!record(value)) {
    fail("default", "mesh.config.ts must default-export a configuration object");
    return { config: null, diagnostics };
  }
  const config = value;
  const keys = new Set(["domain", "surfaces", "output", "data", "extensions", "ignore", "seams", "events"]);
  for (const key of Object.keys(config)) if (!keys.has(key)) fail(key, `Unknown configuration field "${key}"`, key === "resources" ? "`resources` was renamed `domain`" : "Remove the unknown field");
  const domain = config.domain;
  if (!nonEmpty(domain) && !(Array.isArray(domain) && domain.length > 0 && domain.every(nonEmpty))) fail("domain", "Configuration field `domain` must be a non-empty relative folder, glob or list of relative file paths");
  // Absent or `undefined` (as `surfaces: process.env.SURFACES` may give) means no surfaces, as for `ignore`.
  const hasSurfaces = config.surfaces !== undefined;
  if (hasSurfaces) {
    if (!nonEmpty(config.surfaces)) fail("surfaces", "Configuration field `surfaces` must be a non-empty relative folder");
    else if (!confinedGlob(normalizePath(config.surfaces)) || /[*?{\[]/.test(config.surfaces)) fail("surfaces", "Configuration field `surfaces` must be a relative folder inside the project");
  }
  if (!nonEmpty(config.output)) fail("output", "Configuration field `output` must be a non-empty relative directory path");
  const ignoreInput = config.ignore;
  const ignore: string[] = ignoreInput === undefined ? [] : Array.isArray(ignoreInput) ? ignoreInput as string[] : [ignoreInput as string];
  if (ignoreInput !== undefined) {
    if (!ignore.every(nonEmpty)) fail("ignore", "Configuration field `ignore` must be a glob or a list of globs, relative to the project root");
    else if (!ignore.every((glob) => confinedGlob(normalizePath(glob)))) fail("ignore", "Configuration field `ignore` must stay inside the project");
  }
  const data = config.data;
  if (!isDataAdapter(data)) fail("data", "Configuration field `data` must be a data adapter descriptor", 'Import `sqlite` from `@meshfw/data-sqlite` and set data: sqlite({ file: "app.db" })');
  else {
    const problem = manifestProblem(data);
    if (problem) fail("data", problem, "Use a data adapter that publishes a capability manifest (defineCapabilities from @meshfw/runtime)");
  }
  const extensions = config.extensions;
  if (Object.hasOwn(config, "extensions")) {
    if (!Array.isArray(extensions)) fail("extensions", "Configuration field `extensions` must be an array");
    else for (const [index, extension] of extensions.entries()) {
      if (!record(extension) || !nonEmpty(extension.name)) fail("extensions", `Configuration field \`extensions[${index}]\` must be an object with a non-empty name string`);
    }
  }
  if (Object.hasOwn(config, "seams")) {
    const seams = config.seams;
    const names = ["beforeTransaction", "afterWrite", "afterCommit"];
    if (!record(seams)) fail("seams", "Configuration field `seams` must be an object of seam functions", "Set seams: { beforeTransaction, afterWrite, afterCommit }, each optional");
    else for (const [name, seam] of Object.entries(seams)) {
      if (!names.includes(name)) fail("seams", `Unknown seam "${name}" in configuration field \`seams\`; the seams are ${names.join(", ")}`, "Rename the seam or remove it");
      else if (typeof seam !== "function") fail("seams", `Seam \`${name}\` in configuration field \`seams\` must be a function`);
    }
  }
  if (Object.hasOwn(config, "events")) checkEvents(config.events, at, diagnostics);
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
        else {
          // A config that loaded `#mesh` while it loaded, from a stale output folder: refused, as an unresolved one is.
          const generated = loadedNow.find((key) => inside(output, key) || inside(canonicalOutput, key));
          if (generated !== undefined) {
            const relativePath = relative(inside(output, generated) ? output : canonicalOutput, generated);
            diagnostics.push(error("MESH_CONFIG_LOAD", meshImportMessage(meshSpecifierOf(relativePath)), start, MESH_IMPORT_FIX));
          }
        }
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
          const glob = folder ? meshGlob : input;
          // A partial segment before a wildcard is not a static directory.
          const wildcard = input.search(/[*?{\[]/);
          const prefix = wildcard < 0 ? input : input.slice(0, wildcard);
          domainRoot = folder ? candidate : resolve(root, prefix.slice(0, prefix.lastIndexOf("/") + 1) || ".");
          for await (const file of new Bun.Glob(glob).scan({ cwd, onlyFiles: true, followSymlinks: true, dot: true })) if (hasMeshExtension(file)) files.push(resolve(cwd, normalizePath(file)));
          if (files.length === 0) fail("domain", "Configuration field `domain` matches no files");
        }
      } catch (cause) { fail("domain", `Cannot expand entity file glob (${errorCode(cause) ?? "UNKNOWN"})`); }
    }
  } else {
    for (const item of domain as string[]) {
      const path = absolutePath(item) ? null : resolveEntityFile(root, item);
      if (!path) fail("domain", "Entity file path must resolve inside the project");
      else if (!hasMeshExtension(path.file)) fail("domain", `Entity files must end in ${meshExtensionsText}`);
      else files.push(path.absolute);
    }
  }
  files = [...new Set(files)].sort();
  // The surfaces folder: a folder only, inside the project, scanned as a `domain` folder is. It may hold no file yet.
  let surfacesRoot: string | undefined;
  let surfaceFiles: string[] = [];
  if (hasSurfaces && !diagnostics.length) {
    const candidate = resolve(root, normalizePath(config.surfaces as string));
    try {
      let folder = false;
      try { folder = (await stat(candidate)).isDirectory(); }
      catch (cause) { if (errorCode(cause) !== "ENOENT" && errorCode(cause) !== "ENOTDIR") throw cause; }
      if (!folder) fail("surfaces", `Configuration field \`surfaces\` names no folder: ${projectPath(root, candidate)}`);
      else if (!inside(canonicalRoot, await realpath(candidate))) fail("surfaces", "Configuration field `surfaces` resolves outside the project");
      else {
        surfacesRoot = candidate;
        for await (const file of new Bun.Glob(meshGlob).scan({ cwd: candidate, onlyFiles: true, followSymlinks: true, dot: true })) if (hasMeshExtension(file)) surfaceFiles.push(resolve(candidate, normalizePath(file)));
        surfaceFiles = [...new Set(surfaceFiles)].sort();
        // By file, not by root: a file `domain` reads that lies under the surfaces folder is read by both.
        const shared = files.find((file) => inside(candidate, file));
        if (shared !== undefined)
          fail("surfaces", `Configuration field \`surfaces\` overlaps \`domain\`: ${projectPath(root, shared)} is read by both`, "Move the surfaces folder out of what `domain` reads, or narrow `domain`");
      }
    } catch (cause) { fail("surfaces", `Cannot read the surfaces folder (${errorCode(cause) ?? "UNKNOWN"})`); }
  }
  const ignoredFiles: { file: string; pattern: string }[] = [];
  if (ignore.length && !diagnostics.length) {
    const patterns = ignore.map((glob) => { const pattern = normalizePath(glob).replace(/^\.\//, ""); return { glob, matcher: new Bun.Glob(pattern) }; });
    const used = new Set<string>();
    const before = files.length;
    const kept = (file: string) => {
      const name = projectPath(root, file);
      const hits = patterns.filter((p) => p.matcher.match(name));
      for (const hit of hits) used.add(hit.glob);
      if (hits[0]) ignoredFiles.push({ file, pattern: hits[0].glob });
      return hits.length === 0;
    };
    // A pattern is used when it matches an entity file or a surface file; a matched surface file is left out as an entity file is.
    files = files.filter(kept);
    surfaceFiles = surfaceFiles.filter(kept);
    for (const p of patterns) if (!used.has(p.glob))
      diagnostics.push({ ...error("MESH_IGNORE_UNUSED", `\`ignore\` pattern ${JSON.stringify(p.glob)} matches no entity file; check it for a typo (patterns match files, such as "src/legacy/**")`, at("ignore"), "Fix or remove the pattern in mesh.config.ts"), severity: "warning" });
    if (before > 0 && files.length === 0) fail("ignore", "Configuration field `ignore` excludes every entity file");
  }
  if (Array.isArray(domain) && files.length) {
    // The common parent of the listed files, the architecture file left out (unless it is all the list names): the file
    // must sit in the domain root, so it never moves the root it is checked against.
    const rooting = files.some((file) => !isArchitectureFileName(file)) ? files.filter((file) => !isArchitectureFileName(file)) : files;
    domainRoot = dirname(rooting[0]!);
    for (const file of rooting) while (!inside(domainRoot, file)) domainRoot = dirname(domainRoot);
  }
  for (const [field, noun, list] of [["domain", "Entity", files], ["surfaces", "Surface", surfaceFiles]] as const)
    for (const file of list) {
      const name = projectPath(root, file);
      try {
        const canonicalFile = await realpath(file);
        if (!inside(canonicalRoot, canonicalFile)) { fail(field, `${noun} file "${name}" resolves outside the project`); continue; }
        if (!(await stat(file)).isFile()) fail(field, `${noun} file "${name}" is not a file`);
      } catch (cause) { fail(field, `Cannot read ${noun.toLowerCase()} file "${name}" (${errorCode(cause) ?? "UNKNOWN"})`); }
    }
  const renamedAt = record(config.events) && Object.hasOwn(config.events, "renamed") ? at("renamed") : undefined;
  return { config: diagnostics.some((d) => d.severity === "error") ? null : {
    root, configFile, domainRoot, entityFiles: files, ignoredFiles, output, data: data as DataAdapter,
    ...(surfacesRoot !== undefined ? { surfacesRoot, surfaceFiles } : {}),
    ...(Object.hasOwn(config, "extensions") ? { extensions: extensions as readonly ExtensionDescriptor[] } : {}),
    ...(Object.hasOwn(config, "events") ? { events: config.events as EventsConfig } : {}),
    ...(renamedAt ? { positions: { renamed: renamedAt } } : {}),
  }, diagnostics };
}

/**
 * The checks of the `events` key (spec, Events and commands, "Configuration and the events module"), each a
 * `MESH_EVENTS_CONFIG`: an object whose `keep` is one of its values or a period of whole days (`keepProblem`, which refuses a period on a bus that delivers from several processes), whose `load` is a function, whose `bus` is an event
 * bus, whose `requires` lists capabilities, and whose `renamed` is an object of non-empty former FQNs to non-empty event
 * names (`renamedShapeProblems`; `eventsDiagnostics` checks it against the declared events).
 */
function checkEvents(events: unknown, at: (field: string) => Diagnostic["position"], diagnostics: Diagnostic[]): void {
  const fail = (field: string, message: string, fix: string) => diagnostics.push(error("MESH_EVENTS_CONFIG", message, at(field), fix));
  if (!record(events)) {
    fail("events", "Configuration field `events` must be an object", "Set events: { bus, load, keep, requires, renamed }; bus is needed once an event is declared");
    return;
  }
  for (const [key, value] of Object.entries(events)) {
    if (key === "keep") {
      const problem = keepProblem(value, events.bus);
      if (problem) fail("keep", problem.message, problem.fix);
    } else if (key === "load") {
      if (typeof value !== "function")
        fail("load", "`events.load` must be a function that imports the events module", "Set load: () => import(\"./src/events.ts\")");
    } else if (key === "bus") {
      const problem = busProblem(value);
      if (problem) fail("bus", `\`events.bus\` is not a valid event bus: ${problem}`, "Set bus: localBus() (from @meshfw/bus-local), or another event-bus adapter's descriptor");
    } else if (key === "renamed") {
      for (const problem of renamedShapeProblems(value)) fail("renamed", problem.message, problem.fix);
    } else if (key === "requires") {
      const known: readonly string[] = [...BUS_CAPABILITIES, ...CAPABILITIES];
      if (!Array.isArray(value)) {
        fail("requires", "`events.requires` must be an array of capability names", `Set requires: ["replay", "subscribe"], naming any of ${known.join(", ")}`);
        continue;
      }
      const seen = new Set<unknown>();
      for (const name of value) {
        if (typeof name !== "string" || !known.includes(name))
          fail("requires", `\`events.requires\` lists ${JSON.stringify(name) ?? String(name)}, which is no capability: the bus's are ${BUS_CAPABILITIES.join(", ")}, and the data adapter's ${CAPABILITIES.join(", ")}`, "Remove it, or correct the name");
        else if (seen.has(name)) fail("requires", `\`events.requires\` lists "${name}" twice`, "Remove the second one");
        seen.add(name);
      }
    } else {
      fail(key, `Unknown field "${key}" in configuration field \`events\`; its fields are bus, load, keep, requires and renamed`, "Remove the unknown field");
    }
  }
}

export async function loadProject(config: ResolvedConfig): Promise<BuildResult> {
  const files: { file: string; source: string }[] = [];
  const diagnostics: Diagnostic[] = [];
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(config.root); }
  catch (cause) {
    return { document: null, diagnostics: [error("MESH_CONFIG_ROOT", `Cannot resolve project root (${errorCode(cause) ?? "UNKNOWN"})`, positionAt("", "mesh.config.ts", 0), "Use an existing project directory")] };
  }
  // A surface file is read exactly as an entity file is; only the wording names what it is.
  const read = async (list: readonly string[], into: { file: string; source: string }[], noun: "Entity" | "Surface", restore: string) => {
    for (const file of list) {
      const path = resolveEntityFile(config.root, file);
      if (!path) {
        diagnostics.push(error("MESH_ENTITY_PATH", `${noun} file path must resolve inside the project`, positionAt("", "mesh.config.ts", 0), `Use a${noun === "Entity" ? "n entity" : " surface"} file path inside the project`));
        continue;
      }
      try {
        if (!inside(canonicalRoot, await realpath(path.absolute))) {
          diagnostics.push(error("MESH_ENTITY_PATH", `${noun} file "${path.file}" resolves outside the project`, positionAt("", path.file, 0), `Use a${noun === "Entity" ? "n entity" : " surface"} file path inside the project`));
          continue;
        }
        into.push({ file: path.absolute, source: await readFile(path.absolute, "utf8") });
      } catch (cause) { diagnostics.push(error("MESH_ENTITY_READ", `Cannot read ${noun.toLowerCase()} file "${path.file}" (${errorCode(cause) ?? "UNKNOWN"})`, positionAt("", path.file, 0), restore)); }
    }
  };
  await read(config.entityFiles, files, "Entity", "Restore the entity file or fix the domain list");
  const surfaceFiles: { file: string; source: string }[] = [];
  if (config.surfacesRoot !== undefined) await read(config.surfaceFiles ?? [], surfaceFiles, "Surface", "Restore the surface file or fix the surfaces folder");
  const result = buildModel({
    root: config.root, domainRoot: config.domainRoot, files,
    ...(config.surfacesRoot !== undefined ? { surfaces: { root: config.surfacesRoot, files: surfaceFiles } } : {}),
    ignored: (config.ignoredFiles ?? []).map(({ file, pattern }) => ({ file: projectPath(config.root, file), pattern })),
  });
  if (result.document) result.document.data = { name: config.data.name };
  const capabilities = result.document
    ? [...capabilityDiagnostics(result.document, config.data), ...eventsDiagnostics(result.document, config, positionAt("", projectPath(config.root, config.configFile), 0), config.positions), ...handlersNotGenerated(result.document)]
    : [];
  return { document: diagnostics.length || capabilities.length ? null : result.document, diagnostics: [...diagnostics, ...result.diagnostics, ...capabilities] };
}
