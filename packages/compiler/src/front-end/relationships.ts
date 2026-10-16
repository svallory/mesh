import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, ModelDocument, Relationship, SourcePosition } from "@meshfw/model";
import { nearestName } from "./nearest-name.ts";

const lowerCamel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Resolve every relationship against the model (M7), after all entities are built: a
 * `belongs-to` learns the type of its target's key, and a `has-many` or `has-one` learns which
 * `belongs-to` of the target it follows (ADR-0070: `inverse=`, else the only candidate, else the one named after
 * the entity). A target that is not in the model is
 * reported where the relationship is declared; this pass leaves it alone.
 */
export function resolveRelationships(
  document: ModelDocument,
  inversePositions: ReadonlyMap<Relationship, SourcePosition>,
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
      const describe = `${relation.kind} :${relation.name} of ${entity.fqn}`;
      const authored = relation.inverse;
      if (authored !== undefined) {
        const position = inversePositions.get(relation) ?? relation.position;
        const named = target.relationships.find((other) => other.name === authored);
        if (!named || named.kind !== "belongs-to") {
          const suggestion = nearestName(authored, names);
          fail(
            "MESH_INVERSE_UNKNOWN",
            `inverse=:${authored} names no belongs-to of ${target.fqn}.${suggestion ? ` Did you mean inverse=:${suggestion}?` : names.length ? ` The belongs-to from ${target.fqn} to ${entity.fqn}: ${list}.` : ""}`,
            position,
          );
          delete relation.inverse;
        } else if (targetOf(target, named) !== entity) {
          fail(
            "MESH_INVERSE_ENTITY",
            `inverse=:${authored} is a belongs-to of ${target.fqn} that points at ${targetOf(target, named)?.fqn ?? named.entity.identifier}, not at ${entity.fqn}.${names.length ? ` The belongs-to from ${target.fqn} to ${entity.fqn}: ${list}.` : ""}`,
            position,
          );
          delete relation.inverse;
        }
        continue;
      }
      // No belongs-to back: the has-many or has-one is what the other entity's key column hangs on, so the build fails
      // (ADR-0018). This pass runs after every entity is built, so the target's relationships are all known.
      if (candidates.length === 0) {
        // A belongs-to of the target whose entity is unknown may have been meant to point here; its own error is reported.
        if (target.relationships.some((other) => other.kind === "belongs-to" && !targetOf(target, other))) continue;
        const back = lowerCamel(entity.name);
        fail(
          "MESH_NO_INVERSE",
          `${describe} needs a belongs-to back, and ${target.fqn} has none to ${entity.fqn}: add \`belongs-to :${back} entity=${entity.name}\` to ${target.fqn}`,
          relation.position,
          `Add \`belongs-to :${back} entity=${entity.name}\` to ${target.fqn}`,
        );
        continue;
      }
      // The ladder: one candidate is the one; of several, the one named after this entity (Collaborator's
      // `memberships` follows Membership's `collaborator`); otherwise the author must say.
      const namedAfterEntity = names.find((name) => name === lowerCamel(entity.name));
      if (candidates.length === 1) relation.inverse = names[0]!;
      else if (namedAfterEntity !== undefined) relation.inverse = namedAfterEntity;
      else if (relation.kind === "has-many")
        fail(
          "MESH_INVERSE_REQUIRED",
          `${describe} could follow any of ${candidates.length} belongs-to of ${target.fqn} back to ${entity.fqn} (${list})`,
          relation.position,
          `Choose one: \`inverse=:${names[0]}\``,
        );
      else
        fail(
          "MESH_INVERSE_REQUIRED",
          `${describe} follows one belongs-to, and ${target.fqn} has ${candidates.length} back to ${entity.fqn} (${list}); a has-one takes no inverse`,
          relation.position,
          `Use \`has-many\` with \`inverse=:${names[0]}\`, and read the one row you want from the list`,
        );
    }
  }
}
