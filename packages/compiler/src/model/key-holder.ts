import { dirname, resolve } from "node:path";
import type { Entity, ModelDocument, Relationship } from "@meshfw/model";

/** Every entity of the document by its resolved file, the map `keyHolderOf` takes. */
export function entitiesByFile(document: ModelDocument): Map<string, Entity> {
  return new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
}

/** The entity whose `belongs-to` a has-many or has-one follows: the link entity of a `through=`, the target otherwise. */
export function keyHolderOf(byFile: ReadonlyMap<string, Entity>, owner: Entity, relation: Relationship): Entity | undefined {
  return byFile.get(resolve(dirname(owner.file), (relation.through?.entity ?? relation.entity).from));
}
