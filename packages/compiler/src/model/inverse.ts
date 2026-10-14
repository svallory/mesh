import { dirname, resolve } from "node:path";
import type { Entity, ModelDocument, Relationship } from "@meshfw/model";

/**
 * Why a relationship a rollup or computed field reads cannot be loaded, when `inverse` was not found: the target
 * has several `belongs-to` back and none was chosen (the relationship's own `MESH_INVERSE_REQUIRED` already says so
 * where it is declared; this says it where it is used, listing the candidates). Null when the declaration already
 * carries the one error: a target with no `belongs-to` back is `MESH_NO_INVERSE` at the `has-many` or `has-one` line
 * (DOM-34), and a bad `inverse=` is `MESH_INVERSE_UNKNOWN` or `MESH_INVERSE_ENTITY` there.
 */
export function inverseProblem(
  document: ModelDocument,
  owner: Entity,
  relation: Relationship,
): { code: "MESH_INVERSE_REQUIRED"; because: string; fix: string } | null {
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  const targetOf = (from: Entity, other: Relationship) => byFile.get(resolve(dirname(from.file), other.entity.from));
  const target = targetOf(owner, relation);
  const names = (target?.relationships ?? [])
    .filter((other) => other.kind === "belongs-to" && targetOf(target!, other) === owner)
    .map((other) => other.name);
  if (names.length <= 1) return null;
  const list = names.map((name) => `:${name}`).join(", ");
  return {
    code: "MESH_INVERSE_REQUIRED",
    because: `${target!.fqn} has ${names.length} belongs-to back to ${owner.fqn} (${list}) and ${relation.kind} :${relation.name} does not say which it follows`,
    fix: `Choose one: \`inverse=:${names[0]}\``,
  };
}
