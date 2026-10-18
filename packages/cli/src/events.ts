import { forgetByName, type DataLayer } from "@meshfw/runtime";
import type { Diagnostic } from "@meshfw/model";
import { loadConfig } from "@meshfw/compiler";
import { diagnostic, printDiagnostics } from "./diagnostics.ts";

type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

function isDataLayer(value: unknown): value is DataLayer {
  return typeof value === "object" && value !== null && typeof (value as { transaction?: unknown }).transaction === "function";
}

/**
 * `mesh events forget <name>` (spec, Events and commands, "Retention"): drops the progress row of a handler that was
 * removed or renamed, or the row of a subscription whose client is not coming back, from the database the project's
 * `mesh.config.ts` configures. It runs outside the deliverer's process, so it reads the live claim: a handler the live
 * deliverer registered and a subscription open under it are refused (`forgetByName` in `@meshfw/runtime`).
 */
export async function runEvents(args: readonly string[], root: string, io: Io): Promise<number> {
  const [, verb, name, ...rest] = args;
  if (verb !== "forget") {
    io.stderr(verb === undefined ? "Missing events command; use mesh events forget <name>\n" : `Unknown events command "${verb}"; use mesh events forget <name>\n`);
    return 2;
  }
  if (name === undefined || name.startsWith("-")) { io.stderr("Missing name for mesh events forget; use mesh events forget <name>\n"); return 2; }
  if (rest.length > 0) { io.stderr("Extra argument for mesh events forget; use mesh events forget <name>\n"); return 2; }
  const diagnostics: Diagnostic[] = [];
  let layer: DataLayer | undefined;
  try {
    const loaded = await loadConfig(root);
    diagnostics.push(...loaded.diagnostics);
    if (!loaded.config || diagnostics.some((d) => d.severity === "error")) { printDiagnostics(diagnostics, io.stderr); return 1; }
    const data: unknown = loaded.config.data;
    if (!isDataLayer(data)) {
      printDiagnostics([diagnostic("mesh.config.ts", `the data adapter "${loaded.config.data.name}" is not a data layer this command can open`)], io.stderr);
      return 1;
    }
    layer = data;
    const forgotten = await forgetByName(layer, name);
    io.stdout(`forgot the ${forgotten.kind} ${forgotten.name}, which was at position ${forgotten.position}\n`);
    return 0;
  } catch (cause) {
    printDiagnostics([...diagnostics, diagnostic("mesh.config.ts", `events forget failed: ${cause instanceof Error ? cause.message : String(cause)}`)], io.stderr);
    return 1;
  } finally {
    await layer?.close();
  }
}
