import type { Diagnostic, ModelDocument } from "@meshfw/model";
import type { DataAdapter } from "@meshfw/runtime";
import { error } from "./model/index.ts";

/**
 * What the model needs from the configured data adapter, checked against its static
 * capability manifest (ADR-0013): an error for each entity that needs a capability the
 * adapter does not declare, never a run-time surprise. Today those are the `integer-key-fill`
 * an integer primary key needs and the `aggregates` a `count` or `max` rollup calls (M7).
 */
export function capabilityDiagnostics(document: ModelDocument, adapter: DataAdapter): Diagnostic[] {
  const declared: readonly string[] = adapter.capabilities?.capabilities ?? [];
  const diagnostics: Diagnostic[] = [];
  for (const entity of document.entities) {
    const key = entity.attributes.find((attribute) => attribute.primaryKey);
    if (key?.type === "integer" && !declared.includes("integer-key-fill")) {
      diagnostics.push(error("MESH_CAPABILITY",
        `Entity :${entity.name} has the integer primary key :${key.name}, which the data layer fills, and the data adapter "${adapter.name}" does not declare the integer-key-fill capability`,
        key.position, `Use a data adapter that declares integer-key-fill, or make :${key.name} a uuid`));
    }
    for (const field of entity.computed) {
      if ((field.rollup?.fn === "count" || field.rollup?.fn === "max") && !declared.includes("aggregates")) {
        diagnostics.push(error("MESH_CAPABILITY",
          `Entity :${entity.name} has the ${field.rollup.fn} rollup :${field.name}, which calls the data layer's ${field.rollup.fn}, and the data adapter "${adapter.name}" does not declare the aggregates capability`,
          field.position, "Use a data adapter that declares aggregates, or remove the rollup"));
      }
    }
  }
  return diagnostics;
}
