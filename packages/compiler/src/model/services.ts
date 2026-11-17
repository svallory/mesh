import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, Service } from "@meshfw/model";
import { error } from "./diagnostics.ts";
import { checkPolicyHasChecks } from "./lifecycle-limits.ts";
import type { Finding, RuleInput } from "./architecture-rules.ts";

const atoms = (names: readonly string[]) => names.map((name) => `:${name}`).join(", ");

/**
 * What a service's lines need the built entities for (services design, section 5.1 step 4; ruling D42): each `uses`
 * line's entity FQN (`ServiceUse.fqn`), from the file its `entity=` resolved to; each atom of `actions=` names an action
 * of that entity, its `auto=` actions included (`MESH_UNKNOWN_ACTION`); one entity in two `uses` lines of an operation is
 * `MESH_DUPLICATE_MEMBER`; a policy with no check is `MESH_POLICY_NO_CHECKS`, as for an entity. A line whose `entity=`
 * resolved to no built entity is skipped: its import or reference was reported.
 * The one-entity warning is the architecture rule's check, `serviceTouchesOneEntity` below.
 */
export function checkServices(
  document: { entities: readonly Entity[]; services?: readonly Service[] },
  diagnostics: Diagnostic[],
  nearestName: (name: string, candidates: Iterable<string>) => string | undefined,
): void {
  const byFile = new Map(document.entities.map((entity) => [resolve("/", entity.file), entity] as const));
  for (const service of document.services ?? []) {
    for (const operation of service.operations) {
      const reached = new Map<string, Entity>();
      for (const use of operation.uses) {
        const entity = use.entity.from ? byFile.get(resolve("/", dirname(service.file), use.entity.from)) : undefined;
        if (!entity) continue;
        use.fqn = entity.fqn;
        if (reached.has(entity.fqn))
          diagnostics.push(error("MESH_DUPLICATE_MEMBER", `Duplicate uses of ${entity.fqn}: one line per entity; list every action it calls in that line's actions=`, use.position, "merge the two lines into one"));
        else reached.set(entity.fqn, entity);
        const actions = [...entity.actions.map((action) => action.name), ...entity.auto];
        for (const action of use.actions)
          if (!actions.includes(action.name)) {
            const near = nearestName(action.name, actions);
            diagnostics.push(error("MESH_UNKNOWN_ACTION", `:${action.name} is not an action of ${entity.fqn}: a \`uses\` line names actions of the entity it uses${actions.length ? ` (${atoms(actions)})` : ", and it has none"}.${near === undefined ? "" : ` Did you mean :${near}?`}`, action.position));
          }
      }
    }
    for (const policy of service.policies) checkPolicyHasChecks(policy, service.fqn, diagnostics);
  }
}

/**
 * The check of the architecture rule `:service-touches-one-entity` (`model/architecture-rules.ts`; services design R3,
 * OD-10, ruling D42): an operation whose `uses` lines name exactly one entity, `MESH_SERVICE_ONE_ENTITY` at its line, since
 * an operation that touches one entity belongs on that entity, as an action. It reads `ServiceUse.fqn`, which
 * `checkServices` sets; an operation with a line that resolved to no entity is skipped (that line's error is enough).
 */
export function serviceTouchesOneEntity({ document }: RuleInput, report: (finding: Finding) => void): void {
  const byFqn = new Map(document.entities.map((entity) => [entity.fqn, entity] as const));
  for (const service of document.services ?? [])
    for (const operation of service.operations) {
      const reached = new Set(operation.uses.map((use) => use.fqn));
      if (reached.has(undefined) || reached.size !== 1) continue;
      const only = byFqn.get([...reached][0]!);
      if (!only) continue;
      report({
        message: `operation :${operation.name} of ${service.fqn} uses only ${only.fqn}: an operation that touches one entity belongs on that entity, as an action`,
        position: operation.position,
        fix: `move it to ${only.name} as an action, add the other entities it reaches, or switch the rule off in the architecture file: \`disable :service-touches-one-entity\``,
      });
    }
}
