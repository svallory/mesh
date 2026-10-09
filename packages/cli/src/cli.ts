import { parseArgs } from "node:util";
import { join } from "node:path";
import { EmitError, generatedImportDiagnostics, generateFiles, loadConfig, loadProject, stableJsonStringify, writeGeneratedFiles } from "@meshfw/compiler";
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

Options:
  --help              Show this help
`;

interface Command { kind: "build" | "inspect" | "export" | "help"; check: boolean; entity?: string }
function parseCommand(args: string[]): Command {
  const [first] = args;
  const pending: Record<string, string> = { init: "not scheduled", explain: "M5", db: "M2", migrate: "M9" };
  if (first && Object.hasOwn(pending, first)) {
    throw new Error(`mesh ${first === "db" ? "db push" : first} is not available yet (${pending[first]})`);
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
  let command: Command;
  try { command = parseCommand(args); }
  catch (cause) {
    io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }
  if (command.kind === "help") { io.stdout(HELP); return 0; }
  if (command.kind === "export") return runExport(root, io);
  const diagnostics: Diagnostic[] = [];
  let errorFile = "mesh.config.ts";
  let json: string | undefined;
  try {
    const loaded = await loadConfig(root);
    diagnostics.push(...loaded.diagnostics);
    if (loaded.config && !diagnostics.some((d) => d.severity === "error")) {
      const config = loaded.config;
      const built = await loadProject(config);
      diagnostics.push(...built.diagnostics);
      if (built.document && !diagnostics.some((d) => d.severity === "error")) {
        if (command.kind === "build" && !command.check) {
          diagnostics.push(...generatedImportDiagnostics(config.root));
          if (diagnostics.some((d) => d.severity === "error")) {
            printDiagnostics(diagnostics, io.stderr);
            return 1;
          }
        }
        const files = await generateFiles({ config, document: built.document });
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
      const result = await exportGenerators(loaded.config.root);
      diagnostics.push(...result.diagnostics);
      written = result.written;
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
