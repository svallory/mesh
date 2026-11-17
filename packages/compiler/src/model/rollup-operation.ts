import { dirname, resolve } from "node:path";
import type { Computed, Entity, ModelDocument } from "@meshfw/model";

/**
 * The data-layer operation a rollup calls when it is loaded: `count` or `max` over one has-many or has-one keep the
 * per-row `count` and `max` (ruling D33, OD3); every other rollup (`sum`, `avg`, `min`, and any rollup over a
 * belongs-to) calls the batched `rollup`. Undefined for a computed field that is not a rollup, or whose first
 * relationship the model does not have (the build reported it).
 */
export function rollupOperation(entity: Entity, computed: Computed): "count" | "max" | "rollup" | undefined {
  if (!computed.rollup) return undefined;
  const first = entity.relationships.find((relation) => relation.name === computed.rollup!.of.split(".")[0]!);
  if (!first) return undefined;
  const { fn } = computed.rollup;
  return (fn === "count" || fn === "max") && first.kind !== "belongs-to" ? fn : "rollup";
}

/** The entity the rollup's single relationship reaches (the only route that builds before M10's joins), or undefined. */
export function rollupTarget(document: ModelDocument, entity: Entity, computed: Computed): Entity | undefined {
  const first = computed.rollup && entity.relationships.find((relation) => relation.name === computed.rollup!.of.split(".")[0]!);
  if (!first) return undefined;
  const file = resolve(dirname(entity.file), first.entity.from);
  return document.entities.find((candidate) => resolve(candidate.file) === file);
}
