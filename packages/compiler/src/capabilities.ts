import type { Diagnostic, ModelDocument } from "@meshfw/model";
import { BUS_CAPABILITIES, type DataAdapter, type EventsConfig } from "@meshfw/runtime";
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
        `Entity ${entity.fqn} has the integer primary key :${key.name}, which the data layer fills, and the data adapter "${adapter.name}" does not declare the integer-key-fill capability`,
        key.position, `Use a data adapter that declares integer-key-fill, or make :${key.name} a uuid`));
    }
    for (const field of entity.computed) {
      if ((field.rollup?.fn === "count" || field.rollup?.fn === "max") && !declared.includes("aggregates")) {
        diagnostics.push(error("MESH_CAPABILITY",
          `Entity ${entity.fqn} has the ${field.rollup.fn} rollup :${field.name}, which calls the data layer's ${field.rollup.fn}, and the data adapter "${adapter.name}" does not declare the aggregates capability`,
          field.position, "Use a data adapter that declares aggregates, or remove the rollup"));
      }
    }
  }
  return diagnostics;
}

/**
 * The checks of `events` that need the model or both manifests (spec, Events and commands, "Configuration and the
 * events module"): a project that declares an event sets `events.bus`, with no default (`MESH_EVENTS_CONFIG`), and each
 * capability `events.requires` lists is declared by the bus (a bus capability) or by the data adapter (a data
 * capability), else `MESH_CAPABILITY` naming the capability and the adapter. `checkEvents` in `config.ts` has already
 * refused a bus that is not one and a name that is no capability.
 */
export function eventsDiagnostics(document: ModelDocument, config: { readonly data: DataAdapter; readonly events?: EventsConfig }, at: Diagnostic["position"]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const bus = config.events?.bus;
  const declared = document.events ?? [];
  if (declared.length > 0 && bus === undefined) {
    diagnostics.push(error("MESH_EVENTS_CONFIG",
      `The project declares ${declared.length === 1 ? "the event" : "events, among them"} ${declared[0]!.fqn}, and mesh.config.ts sets no events.bus: an event is delivered by a bus, and there is no default`,
      at, "Set events: { bus: localBus() } in mesh.config.ts (localBus from @meshfw/bus-local)"));
  }
  const busNames: readonly string[] = BUS_CAPABILITIES;
  const data: readonly string[] = config.data.capabilities?.capabilities ?? [];
  for (const name of config.events?.requires ?? []) {
    if (busNames.includes(name)) {
      if (bus === undefined) {
        diagnostics.push(error("MESH_CAPABILITY", `events.requires lists the bus capability ${name}, and mesh.config.ts sets no events.bus to declare it`, at,
          "Set events.bus to a bus that declares it, or remove it from events.requires"));
      } else if (!(bus.manifest.capabilities as readonly string[]).includes(name)) {
        diagnostics.push(error("MESH_CAPABILITY", `events.requires lists ${name}, and the event bus "${bus.manifest.adapter}" does not declare it`, at,
          `Use a bus that declares ${name}, or remove it from events.requires`));
      }
    } else if (!data.includes(name)) {
      diagnostics.push(error("MESH_CAPABILITY", `events.requires lists ${name}, and the data adapter "${config.data.name}" does not declare it`, at,
        `Use a data adapter that declares ${name}, or remove it from events.requires`));
    }
  }
  return diagnostics;
}
