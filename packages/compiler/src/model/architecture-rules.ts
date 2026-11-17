import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, Expression, ModelDocument, SourcePosition } from "@meshfw/model";
import { actionExpressionsByOwner } from "./action-expressions.ts";
import { aggregatesOf } from "./aggregates.ts";
import { entitiesByFile } from "./key-holder.ts";
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

/** One call, in an entity file's function, to a member of another entity value: `Task.close(...)`, `work.Task.close(...)`. */
export interface EntityCall {
  /** The local the chain starts at: an entity the file names (`Task`), or a namespace import's alias (`work`). */
  binding: string;
  /** Through a namespace import, the entity the alias's file declares (`Task` in `work.Task.close`). */
  qualified?: string;
  /** The member called: `close` in `Task.close(...)`. Not checked against the target here. */
  member: string;
  /** Where the callee starts (`Task` in `await Task.close(...)`). */
  position: SourcePosition;
}

/** What a rule's check reads. `buildModel` builds it; the model layer never imports the front end. */
export interface RuleInput {
  document: ModelDocument;
  /** The calls a function makes to entity values (the front end's `entityCallsOf`). */
  entityCallsOf(expression: Expression): readonly EntityCall[];
  /** The FQNs of the declared aggregates that list the entity as root or part; empty for an entity in none. */
  aggregatesOf(entityFqn: string): readonly string[];
}

/** `aggregatesOf` (`model/aggregates.ts`) as the rules read it: the aggregates' FQNs, in the document's order. */
export function aggregateNamesOf(document: ModelDocument): (entityFqn: string) => readonly string[] {
  const memberships = aggregatesOf(document);
  return (fqn) => memberships(fqn).map((membership) => membership.aggregate);
}

const WRITES: ReadonlySet<string> = new Set(["create", "update", "destroy"]);
/** Whether `member` is a write action of `target`: an action of type create, update or destroy, its own or from `auto=`. */
const isWriteAction = (target: Entity, member: string): boolean =>
  target.actions.some((action) => action.name === member && WRITES.has(action.kind)) || (WRITES.has(member) && target.auto.includes(member as Entity["auto"][number]));
const joined = (names: readonly string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The check of `:action-calls-other-aggregate` (R16; ruling D40, OD8 (a) and OD9 (a)): a function of an entity's action or
 * `always` block (`actionExpressionsByOwner`, never a handler body) that calls a write action of another entity, when both
 * entities are in declared aggregates and no aggregate lists both. The callee resolves through the caller's imports to the
 * entity its file declares (a namespace import through `qualified`); a call it cannot resolve, to the entity itself, to a
 * read or to a name that is no write action is not reported, nor one from or to an entity no aggregate file lists. A
 * named check copied into several actions holds one call at one position, so the calls are grouped by position, target and
 * member, and one finding names every owner.
 */
export function actionCallsOtherAggregate(input: RuleInput, report: (finding: Finding) => void): void {
  const byFile = entitiesByFile(input.document);
  for (const caller of input.document.entities) {
    const callerAggregates = input.aggregatesOf(caller.fqn);
    if (!callerAggregates.length) continue;
    const groups = new Map<string, { what: string; owners: string[]; callee: string; target: Entity; position: SourcePosition }>();
    for (const { owner, expressions } of actionExpressionsByOwner(caller))
      for (const { expression, what } of expressions)
        for (const call of input.entityCallsOf(expression)) {
          const imported = caller.imports.find((i) => !i.helper && !i.mesh && i.identifiers.includes(call.binding) && (i.namespace === true) === (call.qualified !== undefined));
          const target = imported && byFile.get(resolve(dirname(caller.file), imported.from));
          if (!target || target === caller || (call.qualified !== undefined && target.name !== call.qualified)) continue;
          if (!isWriteAction(target, call.member)) continue;
          const targetAggregates = input.aggregatesOf(target.fqn);
          if (!targetAggregates.length || targetAggregates.some((name) => callerAggregates.includes(name))) continue;
          const key = `${call.position.offset}\0${target.fqn}\0${call.member}`;
          const group = groups.get(key);
          if (group) {
            if (!group.owners.includes(owner)) group.owners.push(owner);
          } else
            groups.set(key, { what, owners: [owner], callee: [call.binding, ...(call.qualified !== undefined ? [call.qualified] : []), call.member].join("."), target, position: call.position });
        }
    for (const { what, owners, callee, target, position } of groups.values())
      report({
        message: `${what} of ${joined(owners)} of ${caller.fqn} calls \`${callee}\`, a write action of ${target.fqn}, and no aggregate holds both: an effect across aggregates belongs in a service, in plain code over \`transaction\`, or in a \`publish\` and a listener`,
        position,
        fix: "move the call out of the entity's action, or switch the rule off in the architecture file: `disable :action-calls-other-aggregate`",
      });
  }
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
 * `action-calls-other-aggregate` is checked by `actionCallsOtherAggregate` above.
 */
export const ARCHITECTURE_RULES: readonly ArchitectureRule[] = Object.freeze([
  { name: "action-calls-other-aggregate", code: "MESH_ACTION_CALLS_OTHER_AGGREGATE", defaultLevel: "warning", check: actionCallsOtherAggregate },
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
