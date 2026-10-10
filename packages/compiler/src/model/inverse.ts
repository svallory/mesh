import { dirname, resolve } from "node:path";
import type { Entity, ModelDocument, Relationship } from "@meshfw/model";

/**
 * Why a relationship a rollup or computed field reads cannot be loaded, when `via` was not found: either
 * the target has no `belongs-to` back, or it has several and none was chosen (the relationship's own
 * `MESH_VIA_REQUIRED` already says so where it is declared; this says it where it is used, listing the candidates).
 */
export function inverseProblem(
  document: ModelDocument,
  owner: Entity,
  relation: Relationship,
): { code: "MESH_NO_INVERSE" | "MESH_VIA_REQUIRED"; because: string; fix: string } {
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  const targetOf = (from: Entity, other: Relationship) => byFile.get(resolve(dirname(from.file), other.entity.from));
  const target = targetOf(owner, relation);
  const names = (target?.relationships ?? [])
    .filter((other) => other.kind === "belongs-to" && targetOf(target!, other) === owner)
    .map((other) => other.name);
  const targetName = target?.name ?? relation.entity.identifier;
  if (names.length > 1) {
    const list = names.map((name) => `:${name}`).join(", ");
    return {
      code: "MESH_VIA_REQUIRED",
      because: `:${targetName} has ${names.length} belongs-to back to :${owner.name} (${list}) and ${relation.kind} :${relation.name} does not say which it follows`,
      fix: `Choose one: \`via=:${names[0]}\``,
    };
  }
  return {
    code: "MESH_NO_INVERSE",
    because: `:${targetName} has no belongs-to back to :${owner.name}`,
    fix: `Declare a belongs-to to :${owner.name} in the other entity's file, and name it with via=:name if there are several`,
  };
}
