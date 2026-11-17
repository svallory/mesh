/**
 * The architecture rules (`notes/spec/other-file-kinds.md`, "The architecture file"; ADR-0084): the checks Mesh runs over
 * the whole built model that a project may re-grade or switch off in its architecture file. Each rule has an atom name, a
 * diagnostic code and a default level; a project with no architecture file runs every rule at its default level (R9).
 * Built-in invariants are not here: they are ordinary build errors that no file can name, re-grade or disable (R13).
 *
 * This holds the catalogue and the settings only: no rule has a check yet (the cross-aggregate check, and the service
 * check once services exist, add one to their entry).
 */
export type RuleLevel = "error" | "warning";
export type RuleSetting = RuleLevel | "off";

export interface ArchitectureRule {
  /** The atom the architecture file names it by, without the colon: `action-calls-other-aggregate`. */
  name: string;
  /** Its diagnostic code (ruling D40, OD1). */
  code: string;
  defaultLevel: RuleLevel;
}

/**
 * The catalogue, in a fixed order (ruling D40, OD1 (a)). `service-touches-one-entity` is the services unit's warning,
 * under that unit's code (ruling D42); it is known, so a file may set it, and checks nothing until services exist.
 */
export const ARCHITECTURE_RULES: readonly ArchitectureRule[] = Object.freeze([
  { name: "action-calls-other-aggregate", code: "MESH_ACTION_CALLS_OTHER_AGGREGATE", defaultLevel: "warning" },
  { name: "service-touches-one-entity", code: "MESH_SERVICE_ONE_ENTITY", defaultLevel: "warning" },
] as const);

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
