import type { Diagnostic, ModelDocument, SourcePosition } from "@meshfw/model";
import { serviceTouchesOneEntity } from "./services.ts";

/**
 * The architecture rules (`notes/spec/other-file-kinds.md`, "The architecture file"; ADR-0084): the checks Mesh runs over
 * the whole built model that a project may re-grade or switch off in its architecture file. Each rule has an atom name, a
 * diagnostic code, a default level and, once the construct it reads is built, a check; a project with no architecture
 * file runs every rule at its default level (R9). Built-in invariants are not here: they are ordinary build errors that
 * no file can name, re-grade or disable (R13). `checkArchitecture` runs the checks at the end of `buildModel`.
 */
export type RuleLevel = "error" | "warning";
export type RuleSetting = RuleLevel | "off";

/** What a rule's check reads. `buildModel` builds it; the model layer never imports the front end. */
export interface RuleInput {
  document: ModelDocument;
}

/** One thing a check found: `checkArchitecture` reports it under the rule's code, at the level the settings give. */
export interface Finding {
  message: string;
  position: SourcePosition;
  fix: string | null;
}

export interface ArchitectureRule {
  /** The atom the architecture file names it by, without the colon: `action-calls-other-aggregate`. */
  name: string;
  /** Its diagnostic code (ruling D40, OD1). */
  code: string;
  defaultLevel: RuleLevel;
  /** Absent while the construct it reads is not built (R17): the rule is known, and checks nothing. */
  check?(input: RuleInput, report: (finding: Finding) => void): void;
}

/**
 * The catalogue, in a fixed order (ruling D40, OD1 (a)). `service-touches-one-entity` is the services unit's warning,
 * under that unit's code (ruling D42), checked by `serviceTouchesOneEntity` (`model/services.ts`).
 */
export const ARCHITECTURE_RULES: readonly ArchitectureRule[] = Object.freeze([
  { name: "action-calls-other-aggregate", code: "MESH_ACTION_CALLS_OTHER_AGGREGATE", defaultLevel: "warning" },
  { name: "service-touches-one-entity", code: "MESH_SERVICE_ONE_ENTITY", defaultLevel: "warning", check: serviceTouchesOneEntity },
] satisfies ArchitectureRule[]);

/** The resolved settings: one entry per catalogue rule (R9, R10). */
export type ArchitectureSettings = ReadonlyMap<string, RuleSetting>;

/** Every rule at its default level: the settings of a project with no architecture file. */
export const DEFAULT_SETTINGS: ArchitectureSettings = new Map(ARCHITECTURE_RULES.map((rule) => [rule.name, rule.defaultLevel]));

/**
 * The presets Mesh ships, by the name `"meshfw/architecture"` exports: a level for each rule a preset names.
 * `MeshRecommended` names every rule at its default level, so including it changes nothing today (ruling D40, OD4 (a)).
 */
export const PRESETS: ReadonlyMap<string, ArchitectureSettings> = new Map([
  ["MeshRecommended", DEFAULT_SETTINGS],
]);

/**
 * Runs every rule whose setting is not `off` and that has a check; each finding becomes a diagnostic under the rule's
 * code at the setting's level, so an `error` setting fails the build. A rule the settings do not name runs at its
 * default level. Grouping findings is each check's job: nothing is de-duplicated here.
 */
export function checkArchitecture(
  settings: ArchitectureSettings,
  input: RuleInput,
  diagnostics: Diagnostic[],
  rules: readonly ArchitectureRule[] = ARCHITECTURE_RULES,
): void {
  for (const rule of rules) {
    const setting = settings.get(rule.name) ?? rule.defaultLevel;
    if (setting === "off" || !rule.check) continue;
    rule.check(input, ({ message, position, fix }) => diagnostics.push({ severity: setting, code: rule.code, message, position, fix }));
  }
}
