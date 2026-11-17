import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, Exposure, SourcePosition, Surface } from "@meshfw/model";
import { error } from "./index.ts";

/**
 * One `expose` line as the builder read it, before the entities are known: the absolute path of the file its `entity=`
 * resolved to (absent when it resolved to nothing, which is reported already), and where each listed field is written.
 */
export interface PendingExposure {
  exposure: Exposure;
  target?: string;
  fields: { name: string; position: SourcePosition }[];
}
export interface PendingSurface {
  surface: Surface;
  exposures: PendingExposure[];
}

const atoms = (names: readonly string[]) => names.map((name) => `:${name}`).join(", ");
const suggestion = (name: string | undefined) => (name === undefined ? "" : ` Did you mean :${name}?`);

/**
 * What a surface's lines need the built entities for (`notes/architecture/surfaces-design.md`, section 5): the exposed
 * entity's FQN, its actions and its fields. Two expose lines of one name, one entity exposed twice and one action line
 * twice are `MESH_DUPLICATE_MEMBER` (OD4). An action line names one of the entity's own actions, its `auto=` actions
 * included (`MESH_UNKNOWN_ACTION`). `fields=` names an attribute, a `belongs-to` or a computed field (OD3): a `has-many` or
 * a `has-one` is `MESH_OPTION_VALUE` (OD13), since a related record does not leave through a surface, and any other name is
 * `MESH_UNKNOWN_MEMBER`. An exposure whose `entity=` resolved to no built entity is skipped: its import or reference was
 * reported, and a second diagnostic would only repeat it.
 */
export function resolveSurfaces(
  document: { entities: readonly Entity[] },
  rootPath: string,
  pending: readonly PendingSurface[],
  diagnostics: Diagnostic[],
  nearestName: (name: string, candidates: Iterable<string>) => string | undefined,
): void {
  const byFile = new Map(document.entities.map((entity) => [resolve(rootPath, entity.file), entity] as const));
  for (const { surface, exposures } of pending) {
    const names = new Set<string>();
    const exposed = new Map<string, Exposure>();
    for (const { exposure, target, fields } of exposures) {
      if (names.has(exposure.name))
        diagnostics.push(error("MESH_DUPLICATE_MEMBER", `Duplicate expose :${exposure.name} in surface ${surface.name}`, exposure.position));
      names.add(exposure.name);
      const entity = target === undefined ? undefined : byFile.get(target);
      if (!entity) continue;
      exposure.entity = entity.fqn;
      const first = exposed.get(entity.fqn);
      if (first)
        diagnostics.push(error("MESH_DUPLICATE_MEMBER", `${entity.fqn} is already exposed as :${first.name} at line ${first.position.line}: a surface exposes an entity once`, exposure.position));
      else exposed.set(entity.fqn, exposure);
      const actions = [...entity.actions.map((action) => action.name), ...entity.auto];
      const listed = new Set<string>();
      for (const action of exposure.actions) {
        if (!actions.includes(action.name))
          diagnostics.push(error("MESH_UNKNOWN_ACTION", `:${action.name} is not an action of ${entity.fqn}: an \`action\` line names one of the entity's own actions${actions.length ? ` (${atoms(actions)})` : ", and it has none"}.${suggestion(nearestName(action.name, actions))}`, action.position));
        else if (listed.has(action.name))
          diagnostics.push(error("MESH_DUPLICATE_MEMBER", `Duplicate action :${action.name} in expose :${exposure.name}`, action.position));
        listed.add(action.name);
      }
      const belongsTo = entity.relationships.filter((relationship) => relationship.kind === "belongs-to");
      const leaving = [...entity.attributes.map(({ name }) => name), ...belongsTo.map(({ name }) => name), ...entity.computed.map(({ name }) => name)];
      for (const field of fields) {
        if (leaving.includes(field.name)) continue;
        const related = entity.relationships.find((relationship) => relationship.name === field.name);
        if (related) {
          const target = byFile.get(resolve(rootPath, dirname(entity.file), related.entity.from))?.fqn ?? related.entity.identifier;
          diagnostics.push(error("MESH_OPTION_VALUE", `:${field.name} is a ${related.kind} of ${entity.fqn}, and a related record does not leave through a surface: expose ${target} on a line of its own`, field.position));
          continue;
        }
        // A belongs-to's key column (`ownerId`) is named by its relationship, as the entity file names it.
        const keyed = belongsTo.find((relationship) => relationship.keyColumn === field.name)?.name;
        diagnostics.push(error("MESH_UNKNOWN_MEMBER", `:${field.name} is not a field of ${entity.fqn}: \`fields=\` names the entity's attributes, belongs-to relationships and computed fields (${atoms(leaving)}).${suggestion(keyed ?? nearestName(field.name, leaving))}`, field.position));
      }
    }
  }
}
