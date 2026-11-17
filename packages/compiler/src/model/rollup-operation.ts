import { dirname, resolve } from "node:path";
import type { Computed, Entity, ModelDocument } from "@meshfw/model";

/**
 * The route a rollup's path takes: `relationships`, how many it crosses; `through`, whether one of them is a has-many
 * through a link entity; `entities`, every entity it reaches in order (each relationship's target, after the link entity
 * of a `through=`), as far as the model has them. A route is joined when it crosses more than one relationship or a link
 * entity. Undefined for a computed field that is not a rollup, or whose first relationship the model does not have (the
 * build reported it).
 */
export interface RollupRoute {
  readonly relationships: number;
  readonly through: boolean;
  readonly joined: boolean;
  readonly entities: readonly Entity[];
}

export function rollupRoute(document: ModelDocument, entity: Entity, computed: Computed): RollupRoute | undefined {
  if (!computed.rollup) return undefined;
  const byFile = new Map(document.entities.map((candidate) => [resolve(candidate.file), candidate]));
  const entities: Entity[] = [];
  let relationships = 0;
  let through = false;
  let current: Entity | undefined = entity;
  for (const segment of computed.rollup.of.split(".")) {
    const relation = current?.relationships.find((candidate) => candidate.name === segment.trim());
    if (!current || !relation) break;
    relationships++;
    if (relation.through) {
      through = true;
      const link = byFile.get(resolve(dirname(current.file), relation.through.entity.from));
      if (link) entities.push(link);
    }
    current = byFile.get(resolve(dirname(current.file), relation.entity.from));
    if (current) entities.push(current);
  }
  if (relationships === 0) return undefined;
  return { relationships, through, joined: relationships > 1 || through, entities };
}

/**
 * The data-layer operation a rollup calls when it is loaded: `count` or `max` over one has-many or has-one with no link
 * entity keep the per-row `count` and `max` (ruling D33, OD3); every other rollup (`sum`, `avg`, `min`, any rollup over
 * a belongs-to, and any rollup over a joined route) calls the batched `rollup`. Undefined for a computed field that is
 * not a rollup, or whose first relationship the model does not have (the build reported it).
 */
export function rollupOperation(entity: Entity, computed: Computed): "count" | "max" | "rollup" | undefined {
  if (!computed.rollup) return undefined;
  const segments = computed.rollup.of.split(".");
  const first = entity.relationships.find((relation) => relation.name === segments[0]!.trim());
  if (!first) return undefined;
  const { fn } = computed.rollup;
  const oneHop = segments.length === (fn === "count" ? 1 : 2) && !first.through;
  return (fn === "count" || fn === "max") && first.kind !== "belongs-to" && oneHop ? fn : "rollup";
}
