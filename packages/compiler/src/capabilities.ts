import { dirname, resolve } from "node:path";
import type { Diagnostic, ModelDocument } from "@meshfw/model";
import { BUS_CAPABILITIES, renamedProblems, type DataAdapter, type EventsConfig } from "@meshfw/runtime";
import { error } from "./model/index.ts";
import { sectionHandlers } from "./model/handlers.ts";
import { rollupOperation, rollupRoute } from "./model/rollup-operation.ts";
import { policyConditions, sqlPositions } from "./model/sql-required.ts";

/**
 * What the model needs from the configured data adapter, checked against its static
 * capability manifest (ADR-0013): an error for each entity that needs a capability the
 * adapter does not declare, never a run-time surprise. Today those are the `integer-key-fill`
 * an integer primary key needs, the `aggregates` every rollup calls (`count`, `max` or `rollup`; M7, M10), `joins` for a rollup whose path crosses several relationships or a link entity, and for a read's declared filter
 * or sort and a read policy that reads the record, which run as SQL (M10), `conditions`, plus `joins` where the condition
 * crosses a relationship (a correlated subquery: `aggregates` covers the data layer's `max`/`count`, not SQL inside a condition).
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
      const operation = rollupOperation(entity, field);
      if (field.rollup && operation && !declared.includes("aggregates")) {
        diagnostics.push(error("MESH_CAPABILITY",
          `Entity ${entity.fqn} has the ${field.rollup.fn} rollup :${field.name}, which calls the data layer's ${operation}, and the data adapter "${adapter.name}" does not declare the aggregates capability`,
          field.position, "Use a data adapter that declares aggregates, or remove the rollup"));
      }
      // A rollup through several relationships or a link entity runs as a join; over one relationship it reads one table.
      const route = field.rollup ? rollupRoute(document, entity, field) : undefined;
      if (field.rollup && route?.joined && !declared.includes("joins")) {
        const crosses = route.relationships > 1 ? `crosses ${route.relationships} relationships` : "goes through a link entity";
        diagnostics.push(error("MESH_CAPABILITY",
          `Entity ${entity.fqn} has the ${field.rollup.fn} rollup :${field.name}, whose path &${field.rollup.of} ${crosses}, which needs a join, and the data adapter "${adapter.name}" does not declare the joins capability`,
          field.position, "Use a data adapter that declares joins, or compute the value in a computed field's body from the loaded relationships"));
      }
    }
    const places = [
      ...sqlPositions(document, entity),
      ...policyConditions(document, entity).map((place) => ({ ...place, kind: "policy" as const, position: place.expression.position })),
    ];
    for (const place of places) {
      const lowered = place.lower();
      if (!lowered.ok) continue; // the build reported it
      if (!declared.includes("conditions")) {
        diagnostics.push(error("MESH_CAPABILITY",
          `${place.subject} runs as SQL, and the data adapter "${adapter.name}" does not declare the conditions capability, so it would ignore the ${place.kind === "sort" ? "order" : "condition"}`,
          place.position, "Use a data adapter that declares conditions"));
        continue;
      }
      if (!declared.includes("joins"))
        for (const crossing of lowered.lowered.crossings) {
          const name = crossing.path.replace(/^&/, "").split(".")[0];
          // Only a belongs-to holds the related record's key, which a condition compares with no join.
          const relation = crossing.path.startsWith("&") ? entity.relationships.find((r) => r.name === name && r.kind === "belongs-to") : undefined;
          const target = relation && document.entities.find((e) => resolve(e.file) === resolve(dirname(entity.file), relation.entity.from));
          const key = target?.attributes.find((a) => a.primaryKey)?.name;
          diagnostics.push(error("MESH_CAPABILITY",
            `${place.subject} reads ${crossing.path} through a relationship, which runs as a subquery, and the data adapter "${adapter.name}" does not declare the joins capability`,
            crossing.position, key ? `Use a data adapter that declares joins, or compare the related record's key (\`&${name}.${key}\`), which needs no join` : "Use a data adapter that declares joins"));
        }
    }
  }
  return diagnostics;
}

/**
 * The checks of `events` that need the model or both manifests (spec, Events and commands, "Configuration and the
 * events module"): a project that declares an event sets `events.bus`, with no default (`MESH_EVENTS_CONFIG`), and each
 * capability `events.requires` lists is declared by the bus (a bus capability) or by the data adapter (a data
 * capability), else `MESH_CAPABILITY` naming the capability and the adapter; and `events.renamed` maps former FQNs that no
 * event declares to declared events (`renamedProblems`), each problem a `MESH_EVENTS_CONFIG` at the `renamed` key
 * (`positions.renamed`, else `at`); and a handler of a `handlers` section needs a bus that declares `ordered-delivery`, else
 * `MESH_CAPABILITY` at its line. `checkEvents` in `config.ts` has already refused a bus that is not one, a name that
 * is no capability and a `renamed` of the wrong shape.
 */
export function eventsDiagnostics(
  document: ModelDocument, config: { readonly data: DataAdapter; readonly events?: EventsConfig }, at: Diagnostic["position"],
  positions?: { readonly renamed?: Diagnostic["position"] },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const renamed = config.events?.renamed;
  if (renamed !== undefined)
    for (const problem of renamedProblems(renamed, (document.events ?? []).map((event) => event.fqn)))
      diagnostics.push(error("MESH_EVENTS_CONFIG", problem.message, positions?.renamed ?? at, problem.fix));
  const bus = config.events?.bus;
  const declared = document.events ?? [];
  if (declared.length > 0 && bus === undefined) {
    diagnostics.push(error("MESH_EVENTS_CONFIG",
      `The project declares ${declared.length === 1 ? "the event" : "events, among them"} ${declared[0]!.fqn}, and mesh.config.ts sets no events.bus: an event is delivered by a bus, and there is no default`,
      at, "Set events: { bus: localBus() } in mesh.config.ts (localBus from @meshfw/bus-local)"));
  }
  // Every handler needs the bus's ordered-delivery: its progress is kept by position only. The start checks it for every
  // handler; a handler of a `handlers` section is in the model, so the build reports it first, at the line (ruling D44, Q12).
  if (bus !== undefined && !(bus.manifest.capabilities as readonly string[]).includes("ordered-delivery"))
    for (const handler of sectionHandlers(document))
      diagnostics.push(error("MESH_CAPABILITY",
        `Handler ${handler.key} needs the bus's ordered-delivery, since a handler's progress is kept by position only, and the event bus "${bus.manifest.adapter}" does not declare it`,
        handler.position, "Use a bus that declares ordered-delivery, such as localBus()"));
  const busNames: readonly string[] = BUS_CAPABILITIES;
  const data: readonly string[] = config.data.capabilities?.capabilities ?? [];
  for (const name of config.events?.requires ?? []) {
    if (busNames.includes(name)) {
      if (bus === undefined) {
        diagnostics.push(error("MESH_CAPABILITY", `events.requires lists the bus capability ${name}, and mesh.config.ts sets no events.bus to declare it`, at,
          "Set events.bus to a bus that declares it, or remove it from events.requires"));
      } else if (!(bus.manifest.capabilities as readonly string[]).includes(name)) {
        diagnostics.push(error("MESH_CAPABILITY", `events.requires lists ${name}, and the event bus "${bus.manifest.adapter}" does not declare it`, at,
          // The local bus declares multi-process when it is made for several processes: the fix names its option.
          name === "multi-process" && bus.manifest.adapter === "local"
            ? "Use localBus({ processes: \"many\" }), or remove it from events.requires"
            : `Use a bus that declares ${name}, or remove it from events.requires`));
      }
    } else if (!data.includes(name)) {
      diagnostics.push(error("MESH_CAPABILITY", `events.requires lists ${name}, and the data adapter "${config.data.name}" does not declare it`, at,
        `Use a data adapter that declares ${name}, or remove it from events.requires`));
    }
  }
  return diagnostics;
}
