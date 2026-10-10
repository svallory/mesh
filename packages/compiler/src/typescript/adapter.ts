import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Diagnostic } from "@meshfw/model";
import type { ResolvedConfig } from "../config.ts";
import { GENERATORS, type Generator } from "./emit.ts";

/**
 * The default export of a data adapter's build half, the module that
 * `DataAdapter.build` names (`"@meshfw/data-sqlite/build"`). The compiler imports
 * it at build time only; the deployed program never does (ADR-0033).
 *
 * UNSTABLE UNTIL M6, like `Generator`: the extension host then registers both.
 */
export interface AdapterBuild {
  /** Generators run after the core ones, under the same path-ownership check. */
  readonly generators: readonly Generator[];
  /** Commands keyed by the words after `mesh`, for example `"db push"`. */
  readonly commands?: Readonly<Record<string, AdapterCommand>>;
}

/** One adapter command; resolves to the process exit code. */
export type AdapterCommand = (context: AdapterCommandContext) => Promise<number>;

/** What the `mesh` command gives an adapter command. */
export interface AdapterCommandContext {
  /** The project root, where `mesh.config.ts` is. */
  readonly projectRoot: string;
  /** The loaded configuration, whose `data` is this adapter. */
  readonly config: ResolvedConfig;
  /** The arguments after the command words, for example `["--force"]`. */
  readonly args: readonly string[];
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface AdapterBuildResult {
  readonly build: AdapterBuild | null;
  readonly diagnostics: Diagnostic[];
}

/**
 * First words the `mesh` command keeps for itself, built in or scheduled
 * (`init`, `explain`, `migrate`). An adapter command starting with one would be
 * registered but never reached, so the loader refuses it. The CLI routes by this list.
 */
export const RESERVED_COMMAND_WORDS: readonly string[] = Object.freeze(["build", "inspect", "export", "init", "explain", "migrate", "help"]);

const CONFIG_POSITION = { file: "mesh.config.ts", line: 1, column: 0, offset: 0 } as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The package an unresolvable specifier belongs to, for the `bun add` hint. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Why `value` is not an `AdapterBuild`, or `null` when it is one. */
function shapeProblem(value: unknown): string | null {
  if (!record(value)) return "has no default export of an AdapterBuild object";
  if (!Array.isArray(value.generators)) return "default export has no `generators` array";
  const core = new Set(GENERATORS.map((generator) => generator.template));
  const templates = new Set<string>();
  for (const [index, generator] of value.generators.entries()) {
    const at = `generators[${index}]`;
    if (!record(generator)) return `${at} is not a generator object`;
    if (!nonEmpty(generator.name)) return `${at} has no \`name\` string`;
    if (!nonEmpty(generator.template) || /[/\\]/.test(generator.template)) return `${at} ("${generator.name}") needs \`template\`, a file name without a folder`;
    if (typeof generator.views !== "function") return `${at} ("${generator.name}") has no \`views\` function`;
    if (!nonEmpty(generator.templateDir) || !isAbsolute(generator.templateDir)) return `${at} ("${generator.name}") needs \`templateDir\`, the absolute folder of its template`;
    if (core.has(generator.template) || templates.has(generator.template)) return `${at} ("${generator.name}") reuses the template name "${generator.template}"; each template has one .mesh-generators/ file`;
    templates.add(generator.template);
  }
  if (value.commands !== undefined) {
    if (!record(value.commands)) return "`commands` is not an object";
    for (const [name, command] of Object.entries(value.commands)) {
      if (!/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(name)) return `command "${name}" is not lowercase words separated by single spaces`;
      if (typeof command !== "function") return `command "${name}" is not a function`;
      const first = name.split(" ")[0]!;
      if (RESERVED_COMMAND_WORDS.includes(first)) return `command "${name}" starts with "${first}", which the mesh command reserves`;
    }
  }
  return null;
}

/**
 * Load the build half of the configured data adapter: resolve `config.data.build`
 * from the project root (`Bun.resolveSync`) and import it. Not resolvable, or not
 * exporting an `AdapterBuild` by default, is `MESH_ADAPTER_BUILD` at `mesh.config.ts`.
 * The one place the compiler loads adapter code.
 */
export async function loadAdapterBuild(config: ResolvedConfig): Promise<AdapterBuildResult> {
  const specifier = config.data.build;
  const fail = (message: string, fix: string | null): AdapterBuildResult =>
    ({ build: null, diagnostics: [{ severity: "error", code: "MESH_ADAPTER_BUILD", message, position: { ...CONFIG_POSITION }, fix }] });
  let resolved: string;
  try { resolved = Bun.resolveSync(specifier, config.root); }
  catch {
    const pkg = packageName(specifier);
    return fail(`the data adapter's build entry "${specifier}" cannot be resolved from this project: either ${pkg} is not installed, or the installed version does not export "${specifier}". Run: bun add ${pkg}`,
      `Install the package of the data adapter that mesh.config.ts names, in a version that has this build entry`);
  }
  let module: Record<string, unknown>;
  try { module = await import(pathToFileURL(resolved).href); }
  catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    return fail(`the data adapter's build entry "${specifier}" cannot be loaded: ${detail.split("\n")[0]}`, "Reinstall the data adapter's package");
  }
  const problem = shapeProblem(module.default);
  if (problem) return fail(`the data adapter's build entry "${specifier}" ${problem}`, "Use a data adapter whose build entry default-exports { generators, commands }");
  return { build: module.default as AdapterBuild, diagnostics: [] };
}
