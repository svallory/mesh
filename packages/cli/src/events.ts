import { adoptByName, forgetByName, keepByValue, type DataLayer } from "@meshfw/runtime";
import type { Diagnostic } from "@meshfw/model";
import { loadConfig } from "@meshfw/compiler";
import { diagnostic, printDiagnostics } from "./diagnostics.ts";

type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

function isDataLayer(value: unknown): value is DataLayer {
  return typeof value === "object" && value !== null && typeof (value as { transaction?: unknown }).transaction === "function";
}

const FORGET = "mesh events forget <name>";
const ADOPT = "mesh events adopt <handler> [--drop <event>]...";
const KEEP = "mesh events keep <until-delivered|all>";
const VERBS = `${FORGET}, ${ADOPT} or ${KEEP}`;

/** What a verb does once the project's data layer is open: what it prints, and its exit code. */
type Action = (layer: DataLayer, multiProcess: boolean, io: Io) => Promise<number>;

/**
 * `mesh events <verb>` (spec, Events and commands, "Retention" and "Delivery from several processes"), run outside the
 * delivering processes against the database the project's `mesh.config.ts` configures:
 *
 * - `forget <name>` drops the progress row of a handler that was removed or renamed, or the row of a subscription whose
 *   client is not coming back. It reads the live claim: a handler the live deliverer registered and a subscription open
 *   under it are refused (`forgetByName` in `@meshfw/runtime`). When the configured bus declares `multi-process`, it
 *   reads the live process rows instead: a handler one registers and a subscription open under one are refused.
 * - `adopt <handler> [--drop <event>]...` shrinks a handler's registered union (`adoptByName`): it keeps every event a
 *   live process lists and drops only the events named; it exits 1 when nothing changes.
 * - `keep <until-delivered|all>` sets the `keep` recorded in `mesh_outbox_state` (`keepByValue`).
 *
 * `adopt` and `keep` apply only to a project whose bus declares `multi-process`. The mode comes from the configuration,
 * never from the schema (a failed probe would abort a Postgres transaction).
 */
export async function runEvents(args: readonly string[], root: string, io: Io): Promise<number> {
  const [, verb, ...rest] = args;
  const usage = (text: string) => { io.stderr(`${text}\n`); return 2; };
  if (verb === undefined) return usage(`Missing events command; use ${VERBS}`);
  if (verb === "forget") {
    const [name, ...extra] = rest;
    if (name === undefined || name.startsWith("-")) return usage(`Missing name for mesh events forget; use ${FORGET}`);
    if (extra.length > 0) return usage(`Extra argument for mesh events forget; use ${FORGET}`);
    return withLayer(root, io, "forget", async (layer, multiProcess) => {
      const forgotten = await forgetByName(layer, name, { multiProcess });
      io.stdout(`forgot the ${forgotten.kind} ${forgotten.name}, which was at position ${forgotten.position}\n`);
      return 0;
    });
  }
  if (verb === "adopt") {
    const [name, ...options] = rest;
    if (name === undefined || name.startsWith("-")) return usage(`Missing name for mesh events adopt; use ${ADOPT}`);
    const drop: string[] = [];
    for (let index = 0; index < options.length; index += 2) {
      const option = options[index]!;
      if (option !== "--drop") return usage(`Unknown argument "${option}" for mesh events adopt; use ${ADOPT}`);
      const event = options[index + 1];
      if (event === undefined || event.startsWith("-")) return usage(`Missing event after --drop; use ${ADOPT}`);
      drop.push(event);
    }
    return withLayer(root, io, "adopt", async (layer, multiProcess) => {
      if (!multiProcess) {
        printDiagnostics([diagnostic("mesh.config.ts", "mesh events adopt applies to a project whose bus declares multi-process, such as localBus({ processes: \"many\" })")], io.stderr);
        return 1;
      }
      const adopted = await adoptByName(layer, name, { drop, multiProcess });
      for (const event of adopted.dropped) io.stdout(`dropped ${event}\n`);
      for (const { event, listedBy } of adopted.kept)
        io.stdout(listedBy === null ? `kept ${event}: listed by no live process; name it with --drop to drop it\n` : `kept ${event}: listed by ${listedBy}\n`);
      if (!adopted.changed) { io.stdout("Nothing changed\n"); return 1; }
      io.stdout(`adopted the handler ${adopted.handler}: its registered union is now ${adopted.union.join(", ") || "empty"}\n`);
      return 0;
    });
  }
  if (verb === "keep") {
    const [keep, ...extra] = rest;
    if (keep === undefined) return usage(`Missing value for mesh events keep; use ${KEEP}`);
    if (keep !== "until-delivered" && keep !== "all") return usage(`Unknown keep "${keep}" for mesh events keep; use ${KEEP}`);
    if (extra.length > 0) return usage(`Extra argument for mesh events keep; use ${KEEP}`);
    return withLayer(root, io, "keep", async (layer, multiProcess) => {
      if (!multiProcess) {
        printDiagnostics([diagnostic("mesh.config.ts", "mesh events keep applies to a project whose bus declares multi-process, such as localBus({ processes: \"many\" })")], io.stderr);
        return 1;
      }
      const change = await keepByValue(layer, keep, { multiProcess });
      io.stdout(change.before === change.after
        ? `the recorded keep is already "${change.after}"\n`
        : `the recorded keep was ${change.before === null ? "not set" : `"${change.before}"`}, now "${change.after}"\n`);
      return 0;
    });
  }
  return usage(`Unknown events command "${verb}"; use ${VERBS}`);
}

/** Load the configuration, open its data layer, run `action` with the mode the configured bus declares, close the layer. */
async function withLayer(root: string, io: Io, verb: string, action: Action): Promise<number> {
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
    // The mode comes from the configuration, never from the schema (a failed probe would abort a Postgres transaction).
    const multiProcess = loaded.config.events?.bus?.manifest.capabilities.includes("multi-process") === true;
    return await action(layer, multiProcess, io);
  } catch (cause) {
    printDiagnostics([...diagnostics, diagnostic("mesh.config.ts", `events ${verb} failed: ${cause instanceof Error ? cause.message : String(cause)}`)], io.stderr);
    return 1;
  } finally {
    await layer?.close();
  }
}
