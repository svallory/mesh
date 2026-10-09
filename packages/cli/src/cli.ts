import { parseArgs } from "node:util";
import { join } from "node:path";
import { EmitError, RESERVED_COMMAND_WORDS, buildEmitters, generatedImportDiagnostics, generateFiles, loadAdapterBuild, loadConfig, loadProject, stableJsonStringify, writeGeneratedFiles, type AdapterBuild, type ResolvedConfig } from "@meshfw/compiler";
import type { Diagnostic } from "@meshfw/model";
import { compareText, diagnostic, printDiagnostics } from "./diagnostics.ts";
import { exportGenerators } from "./export.ts";
import { checkGeneratedFiles, projectPath } from "./guard.ts";

const HELP = `Usage: mesh <command> [options]

Run from the project root containing mesh.config.ts.

Commands:
  build               Read entity files and write .mesh/
  build --check       Rebuild in memory; write nothing; fail on any difference
  inspect [entity]    Print the model as JSON with source positions
  export generators   Copy Mesh's generator templates into .mesh-generators/

The data adapter can add its own commands; they are listed below
when mesh.config.ts names one.

Options:
  --help              Show this help
`;

interface Command { kind: "build" | "inspect" | "export" | "help"; check: boolean; entity?: string }
function parseCommand(args: string[]): Command {
  const [first] = args;
  const pending: Record<string, string> = { init: "not scheduled", explain: "M5", migrate: "M9" };
  if (first && Object.hasOwn(pending, first)) {
    throw new Error(`mesh ${first} is not available yet (${pending[first]})`);
  }
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true,
    options: { help: { type: "boolean" }, check: { type: "boolean" } } });
  const [command, entity] = positionals;
  if (command === undefined && values.help && !values.check) return { kind: "help", check: false };
  if (command !== "build" && command !== "inspect" && command !== "export") throw new Error(command ? `Unknown command "${command}"; use mesh --help` : "Missing command; use mesh --help");
  if (command === "export" && entity !== "generators") throw new Error(entity === undefined ? "Missing what to export; use mesh export generators" : `Cannot export "${entity}"; use mesh export generators`);
  if (positionals.length > (command === "build" ? 1 : 2)) throw new Error(`Extra argument for mesh ${command}; use mesh --help`);
  if (values.check && command !== "build") throw new Error("--check is only valid for mesh build");
  if (values.help) return { kind: "help", check: false };
  if (command === "export") return { kind: "export", check: false };
  return { kind: command, check: values.check ?? false, ...(entity === undefined ? {} : { entity }) };
}

/** The shell owns argument/stream policy; the compiler owns the build. */
export async function runCli(args: string[], root = process.cwd(), io = {
  stdout: (text: string) => { process.stdout.write(text); },
  stderr: (text: string) => { process.stderr.write(text); },
}): Promise<number> {
  // A first word that is not a core command or flag may be one the data adapter adds.
  const [first] = args;
  if (first !== undefined && !first.startsWith("-") && !RESERVED_COMMAND_WORDS.includes(first)) {
    return runAdapterCommand(args, root, io);
  }
  let command: Command;
  try { command = parseCommand(args); }
  catch (cause) {
    io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }
  if (command.kind === "help") { io.stdout(HELP + await adapterHelp(root)); return 0; }
  if (command.kind === "export") return runExport(root, io);
  const diagnostics: Diagnostic[] = [];
  let errorFile = "mesh.config.ts";
  let json: string | undefined;
  try {
    const loaded = await loadConfig(root);
    diagnostics.push(...loaded.diagnostics);
    if (loaded.config && !diagnostics.some((d) => d.severity === "error")) {
      const config = loaded.config;
      const adapter = await loadAdapterBuild(config);
      diagnostics.push(...adapter.diagnostics);
      const built = await loadProject(config);
      diagnostics.push(...built.diagnostics);
      if (adapter.build && built.document && !diagnostics.some((d) => d.severity === "error")) {
        if (command.kind === "build" && !command.check) {
          diagnostics.push(...generatedImportDiagnostics(config.root, buildEmitters(adapter.build)));
          if (diagnostics.some((d) => d.severity === "error")) {
            printDiagnostics(diagnostics, io.stderr);
            return 1;
          }
        }
        const files = await generateFiles({ config, document: built.document }, adapter.build);
        if (command.kind === "inspect") {
          if (command.entity === undefined) {
            const modelPath = projectPath(root, join(config.output, "model.json"));
            const modelFile = files.find((file) => file.path === modelPath);
            if (!modelFile) throw new Error("The compiler did not produce model.json; report this emitter bug");
            json = modelFile.contents;
          } else {
            const entity = built.document.entities.find((candidate) => candidate.name === command.entity);
            if (entity) json = `${stableJsonStringify(entity)}\n`;
            else diagnostics.push(diagnostic("mesh.config.ts", `Unknown entity "${command.entity}"; known entities: ${built.document.entities.map((entity) => entity.name).sort(compareText).join(", ")}`));
          }
        } else {
          errorFile = projectPath(root, config.output);
          if (!command.check) await writeGeneratedFiles(files, config);
          // A successful build must establish the same readable-byte invariant
          // as --check, not just the absence of stray files.
          diagnostics.push(...await checkGeneratedFiles(files, config));
        }
      }
    }
  } catch (cause) {
    if (cause instanceof EmitError) diagnostics.push(cause.diagnostic);
    else if (cause instanceof Error && "path" in cause && typeof cause.path === "string" && "code" in cause) {
      // Filesystem exception prose embeds absolute paths. Use its structured
      // identity and code, not that prose, for Mesh's own output diagnostics.
      diagnostics.push(diagnostic(projectPath(root, cause.path),
        `Cannot access generated path (${String(cause.code)}); fix the output path or permissions and rebuild`));
    } else diagnostics.push(diagnostic(errorFile,
      `Build failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }
  printDiagnostics(diagnostics, io.stderr);
  if (diagnostics.some((d) => d.severity === "error")) return 1;
  if (json !== undefined) io.stdout(json);
  return 0;
}

async function runExport(root: string, io: { stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
  const diagnostics: Diagnostic[] = [];
  let written: readonly string[] = [];
  try {
    const loaded = await loadConfig(root);
    diagnostics.push(...loaded.diagnostics);
    if (loaded.config && !diagnostics.some((d) => d.severity === "error")) {
      const adapter = await loadAdapterBuild(loaded.config);
      diagnostics.push(...adapter.diagnostics);
      if (adapter.build) {
        const result = await exportGenerators(loaded.config.root, adapter.build.generators);
        diagnostics.push(...result.diagnostics);
        written = result.written;
      }
    }
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : null;
    diagnostics.push(diagnostic(".mesh-generators", code
      ? `Export failed (${code}); fix the permissions of .mesh-generators/ and export again`
      : `Export failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }
  printDiagnostics(diagnostics, io.stderr);
  if (diagnostics.some((d) => d.severity === "error")) return 1;
  if (written.length === 0) io.stdout("nothing to export: .mesh-generators/ already holds Mesh's templates\n");
  for (const path of written) io.stdout(`wrote ${path}\n`);
  return 0;
}

type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

/** The configured adapter's build half, or `null` with the diagnostics that explain why not. */
async function loadAdapter(root: string): Promise<{ config: ResolvedConfig | null; build: AdapterBuild | null; diagnostics: Diagnostic[] }> {
  const loaded = await loadConfig(root);
  if (!loaded.config || loaded.diagnostics.some((d) => d.severity === "error")) return { config: null, build: null, diagnostics: loaded.diagnostics };
  const adapter = await loadAdapterBuild(loaded.config);
  return { config: loaded.config, build: adapter.build, diagnostics: [...loaded.diagnostics, ...adapter.diagnostics] };
}

/** Under `mesh --help`: the configured data adapter's commands. Nothing when there is no valid config. */
async function adapterHelp(root: string): Promise<string> {
  let names: string[] = [];
  let adapter = "";
  try {
    const { config, build } = await loadAdapter(root);
    if (!config || !build) return "";
    names = Object.keys(build.commands ?? {}).sort(compareText);
    adapter = config.data.name;
  } catch { return ""; }
  if (names.length === 0) return "";
  return `\nCommands from the data adapter "${adapter}":\n${names.map((name) => `  ${name}\n`).join("")}`;
}

/**
 * `mesh <words> [args]` for a command the data adapter adds, such as `mesh db push`.
 * The command works from the committed generated tree, so the guard runs first:
 * an out-of-date tree stops it before the adapter is called. The shell holds no
 * adapter-specific code: it matches the longest command name and passes the rest.
 */
async function runAdapterCommand(args: string[], root: string, io: Io): Promise<number> {
  const diagnostics: Diagnostic[] = [];
  try {
    const loaded = await loadAdapter(root);
    if (!loaded.config && loaded.diagnostics.some((d) => d.code === "MESH_CONFIG_READ") && args[0] !== "db") {
      io.stderr(`Unknown command "${args[0]}"; use mesh --help\n`);
      return 2;
    }
    diagnostics.push(...loaded.diagnostics);
    const { config, build } = loaded;
    if (!config || !build || diagnostics.some((d) => d.severity === "error")) { printDiagnostics(diagnostics, io.stderr); return 1; }
    const names = Object.keys(build.commands ?? {}).sort((a, b) => b.split(" ").length - a.split(" ").length || compareText(a, b));
    const name = names.find((candidate) => candidate.split(" ").every((word, index) => args[index] === word));
    if (name === undefined) {
      const known = names.some((candidate) => candidate.split(" ")[0] === args[0]);
      if (!known && args[0] !== "db") { io.stderr(`Unknown command "${args[0]}"; use mesh --help\n`); return 2; }
      const asked = args.slice(0, 2).filter((word) => !word.startsWith("-")).join(" ");
      printDiagnostics([diagnostic("mesh.config.ts", `the data adapter "${config.data.name}" does not provide "${asked}"`)], io.stderr);
      return 1;
    }
    const built = await loadProject(config);
    diagnostics.push(...built.diagnostics);
    if (!built.document || diagnostics.some((d) => d.severity === "error")) { printDiagnostics(diagnostics, io.stderr); return 1; }
    const stale = await checkGeneratedFiles(await generateFiles({ config, document: built.document }, build), config);
    if (stale.length) {
      io.stderr("the generated tree is out of date: run mesh build first\n");
      printDiagnostics(stale, io.stderr);
      return 1;
    }
    return await build.commands![name]!({ projectRoot: config.root, config, args: args.slice(name.split(" ").length), stdout: io.stdout, stderr: io.stderr });
  } catch (cause) {
    if (cause instanceof EmitError) diagnostics.push(cause.diagnostic);
    else diagnostics.push(diagnostic("mesh.config.ts", `${args.slice(0, 2).join(" ")} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    printDiagnostics(diagnostics, io.stderr);
    return 1;
  }
}
