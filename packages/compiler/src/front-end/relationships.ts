import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, ModelDocument, Relationship, SourcePosition } from "@meshfw/model";
import { nearestName } from "./nearest-name.ts";

/**
 * Resolve every relationship against the model (M7), after all entities are built: a
 * `belongs-to` learns the type of its target's key, and a `has-many` or `has-one` learns which
 * `belongs-to` of the target it follows (ADR-0070). A target that is not in the model is
 * reported where the relationship is declared; this pass leaves it alone.
 */
export function resolveRelationships(
  document: ModelDocument,
  viaPositions: ReadonlyMap<Relationship, SourcePosition>,
  diagnostics: Diagnostic[],
): void {
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  const targetOf = (from: Entity, relation: Relationship) => byFile.get(resolve(dirname(from.file), relation.entity.from));
  const fail = (code: string, message: string, position: SourcePosition, fix: string | null = null) =>
    diagnostics.push({ severity: "error", code, message, position, fix });

  for (const entity of document.entities) {
    for (const relation of entity.relationships) {
      const target = targetOf(entity, relation);
      if (!target) continue;
      if (relation.kind === "belongs-to") {
        const key = target.attributes.find((attribute) => attribute.primaryKey);
        if (key) relation.keyType = key.type;
        continue;
      }
      // The target's `belongs-to` back to this entity: the keys this relationship could follow.
      const candidates = target.relationships.filter(
        (other) => other.kind === "belongs-to" && targetOf(target, other) === entity,
      );
      const names = candidates.map((candidate) => candidate.name);
      const list = names.map((name) => `:${name}`).join(", ");
      const describe = `${relation.kind} :${relation.name} of :${entity.name}`;
      const authored = relation.via;
      if (authored !== undefined) {
        const position = viaPositions.get(relation) ?? relation.position;
        const named = target.relationships.find((other) => other.name === authored);
        if (!named || named.kind !== "belongs-to") {
          const suggestion = nearestName(authored, names);
          fail(
            "MESH_VIA_UNKNOWN",
            `via=:${authored} names no belongs-to of :${target.name}.${suggestion ? ` Did you mean via=:${suggestion}?` : names.length ? ` The belongs-to from :${target.name} to :${entity.name}: ${list}.` : ""}`,
            position,
          );
          delete relation.via;
        } else if (targetOf(target, named) !== entity) {
          fail(
            "MESH_VIA_ENTITY",
            `via=:${authored} is a belongs-to of :${target.name} that points at :${named.entity.identifier}, not at :${entity.name}.${names.length ? ` The belongs-to from :${target.name} to :${entity.name}: ${list}.` : ""}`,
            position,
          );
          delete relation.via;
        }
        continue;
      }
      // No belongs-to back is not a build error (cross-file inverse checks come after 1.0): loading it fails at run time.
      if (candidates.length === 0) continue;
      if (candidates.length === 1) relation.via = names[0]!;
      else if (relation.kind === "has-many")
        fail(
          "MESH_VIA_REQUIRED",
          `${describe} could follow any of ${candidates.length} belongs-to of :${target.name} back to :${entity.name} (${list})`,
          relation.position,
          `Choose one: \`via=:${names[0]}\``,
        );
      else
        fail(
          "MESH_VIA_REQUIRED",
          `${describe} follows one belongs-to, and :${target.name} has ${candidates.length} back to :${entity.name} (${list}); a has-one takes no via`,
          relation.position,
          `Use \`has-many\` with \`via=:${names[0]}\`, and read the one row you want from the list`,
        );
    }
  }
}
