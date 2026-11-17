/**
 * The architecture file (`notes/spec/other-file-kinds.md`, "The architecture file"; ADR-0084; design
 * `notes/architecture/architecture-file-design.md`, ruling D40): one per project, directly in the domain root, its root
 * line `architecture :name`, its lines `use preset=Name`, `severity :rule level=:error|:warning` and `disable :rule`. It
 * declares nothing another file can import; `readArchitectureFile` turns it into the levels of the architecture rules
 * (`model/architecture-rules.ts`) and reports every mistake in it that MX does not.
 */
import { basename } from "node:path";
import type { Diagnostic } from "@meshfw/model";
import { error, positionAt } from "../model/index.ts";
import { ARCHITECTURE_RULES, DEFAULT_SETTINGS, PRESETS, type ArchitectureSettings, type RuleSetting } from "../model/architecture-rules.ts";
import { MESH_EXTENSIONS } from "./extensions.ts";
import { nearestName } from "./nearest-name.ts";
import { writtenReference } from "./references.ts";
import { atomOf, attr, attrOffset, nodeOf, tags, type IrImport, type Tag } from "./tree.ts";

/** The package path the architecture file imports Mesh's presets from. */
export const MESHFW_ARCHITECTURE = "meshfw/architecture";
/** Whether `path` is named as the architecture file: `architecture` plus an entry of `MESH_EXTENSIONS`, which alone spells it. */
export const isArchitectureFileName = (path: string): boolean =>
  MESH_EXTENSIONS.some((extension) => basename(path) === `architecture${extension}`);
/** The file name as messages print it: `architecture` plus the first extension. */
export const architectureFileText = `architecture${MESH_EXTENSIONS[0]}`;

const PRESET_NAMES = [...PRESETS.keys()];
const RULE_NAMES = ARCHITECTURE_RULES.map((rule) => rule.name);
const LEVELS: readonly string[] = ["error", "warning"];
const quoted = (names: readonly string[]) =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const IMPORT_EXAMPLE = `\`import { ${PRESET_NAMES[0]} } from "${MESHFW_ARCHITECTURE}"\``;

/**
 * Reads the architecture file's imports and lines into settings: the default level of every rule, then each `use preset=`
 * line in written order, then the file's own `severity` and `disable` lines, whose order does not matter (R10, ruling D40
 * OD4). A line MX already refused (no name, a level that is not `:error` or `:warning`, a `preset=` that is no reference)
 * is skipped with no diagnostic and sets nothing.
 */
export function readArchitectureFile(
  input: { root: Tag; imports: readonly IrImport[]; source: string; file: string },
  diagnostics: Diagnostic[],
): ArchitectureSettings {
  const { root, imports, source, file } = input;
  const at = (offset: number) => positionAt(source, file, offset);
  const fail = (code: string, message: string, offset: number, fix: string | null = null) =>
    diagnostics.push(error(code, message, at(offset), fix));
  // The imports (R7, ruling D40 OD6 (a)): a named value import from "meshfw/architecture" of a preset Mesh ships, and
  // nothing else. Each local name is the file's way to name that preset in a `use` line.
  const scope = new Map<string, string>();
  for (const entry of imports) {
    const offset = entry.span.sourceStart;
    const names = entry.names ?? [];
    if (entry.from !== MESHFW_ARCHITECTURE) {
      fail("MESH_UNKNOWN_IMPORT", `The architecture file imports presets from "${MESHFW_ARCHITECTURE}" alone (${IMPORT_EXAMPLE})`, offset, "remove the import");
      continue;
    }
    if (!names.length || entry.typeOnly || names.some((name) => name.typeOnly || name.kind !== "named")) {
      fail("MESH_IMPORT_FORM", `import a preset by name: "${MESHFW_ARCHITECTURE}" gives the named export${PRESET_NAMES.length === 1 ? "" : "s"} ${quoted(PRESET_NAMES.map((name) => `\`${name}\``))}`, offset, `write ${IMPORT_EXAMPLE}`);
      // Its named bindings of a preset still name it, so a `use` line of one draws no second error asking for the import.
      for (const name of names) if (name.kind === "named" && PRESETS.has(name.imported)) scope.set(name.local, name.imported);
      continue;
    }
    for (const name of names) {
      if (!PRESETS.has(name.imported))
        fail("MESH_UNKNOWN_IMPORT", `"${MESHFW_ARCHITECTURE}" gives ${quoted(PRESET_NAMES.map((preset) => `\`${preset}\``))}, and \`${name.imported}\` is not it`, name.span.sourceStart);
      else scope.set(name.local, name.imported);
    }
  }
  const settings = new Map<string, RuleSetting>(DEFAULT_SETTINGS);
  const lines = tags(root.children);
  // `use preset=` lines, in written order: each preset's levels over what came before.
  const used = new Set<string>();
  for (const line of lines) {
    if (line.name !== "use") continue;
    const option = attr(line, "preset");
    const written = option && writtenReference(nodeOf(option));
    if (!option || !written) continue;
    const text = written.qualifier ? `${written.qualifier.name}.${written.name}` : written.name;
    const preset = written.qualifier ? undefined : scope.get(written.name);
    if (!preset) {
      const near = written.qualifier ? undefined : nearestName(written.name, scope.keys());
      fail("MESH_UNKNOWN_IMPORT",
        `\`${text}\` is not an imported preset: the architecture file includes a preset it imports from "${MESHFW_ARCHITECTURE}"${near ? `. Did you mean \`${near}\`?` : ""}`,
        written.qualifier?.offset ?? written.offset,
        !near && PRESETS.has(written.name) ? `add \`import { ${written.name} } from "${MESHFW_ARCHITECTURE}"\`` : null);
      continue;
    }
    if (used.has(preset)) {
      fail("MESH_DUPLICATE_MEMBER", `Duplicate use of the preset ${preset}: this file already uses it`, line.nameSpan.sourceStart, "remove this line");
      continue;
    }
    used.add(preset);
    for (const [rule, level] of PRESETS.get(preset)!) settings.set(rule, level);
  }
  // The file's own lines: one setting per rule, so their order does not matter (R15).
  const own = new Map<string, { setting: RuleSetting; line: Tag }>();
  for (const line of lines) {
    if (line.name !== "severity" && line.name !== "disable") continue;
    const nameOption = attr(line, "name");
    const name = atomOf(nameOption)?.name;
    const level = line.name === "severity" ? atomOf(attr(line, "level"))?.name : "off";
    if (name === undefined || level === undefined || (line.name === "severity" && !LEVELS.includes(level))) continue;
    if (!RULE_NAMES.includes(name)) {
      // A camelCase name (`:serviceTouchesOneEntity`) is too far from its kebab spelling for `nearestName`: try that
      // spelling first, then the nearest rule to it.
      const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      const near = RULE_NAMES.includes(kebab) ? kebab : nearestName(kebab, RULE_NAMES);
      fail("MESH_UNKNOWN_RULE", `\`:${name}\` is not an architecture rule${near ? `. Did you mean \`:${near}\`?` : ""}`,
        attrOffset(nameOption!), `the rules are ${quoted(RULE_NAMES.map((rule) => `:${rule}`))}`);
      continue;
    }
    const first = own.get(name);
    if (first) {
      fail("MESH_DUPLICATE_MEMBER", `Duplicate setting of \`:${name}\`: line ${at(first.line.nameSpan.sourceStart).line} already sets it`, line.nameSpan.sourceStart, "keep one line for the rule");
      continue;
    }
    own.set(name, { setting: level as RuleSetting, line });
  }
  for (const [rule, { setting }] of own) settings.set(rule, setting);
  return settings;
}
