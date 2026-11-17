import type { ModelDocument } from "@meshfw/model";
import { describeAggregate, type AggregateMembership } from "./aggregates.ts";

/**
 * Each event's owners (`notes/spec/events-and-commands.md`, "Owners publish"): the entities whose `events` section lists
 * it, by FQN, and the aggregates whose `events` section does, by FQN to the aggregate as a message names it (with its root
 * and parts). An event no owner lists is absent, and any action may publish it.
 */
export type Owners = ReadonlyMap<string, { entities: ReadonlySet<string>; aggregates: ReadonlyMap<string, string> }>;

export function ownersOf(document: ModelDocument): Owners {
  const owners = new Map<string, { entities: Set<string>; aggregates: Map<string, string> }>();
  const entryOf = (fqn: string) => {
    const entry = owners.get(fqn) ?? { entities: new Set<string>(), aggregates: new Map<string, string>() };
    owners.set(fqn, entry);
    return entry;
  };
  for (const entity of document.entities)
    for (const listed of entity.events ?? []) {
      // A listing that resolved to nothing was reported where it is written, and owns nothing.
      if (!listed.fqn) continue;
      entryOf(listed.fqn).entities.add(entity.fqn);
    }
  for (const aggregate of document.aggregates ?? [])
    for (const listed of aggregate.events ?? []) {
      if (!listed.fqn) continue;
      entryOf(listed.fqn).aggregates.set(aggregate.fqn, describeAggregate(document, aggregate));
    }
  return owners;
}

/**
 * Whether an action of the entity `entityFqn` may publish the event `eventFqn`: the entity is one of the event's owners,
 * or the root or a part of an aggregate that owns it (`membership`, `aggregatesOf`), or the event has no owner. `owners`
 * lists every owner otherwise, entities by FQN and aggregates as a message names them.
 */
export function mayPublish(
  owners: Owners,
  membership: (entityFqn: string) => readonly AggregateMembership[],
  entityFqn: string,
  eventFqn: string,
): { ok: true } | { ok: false; owners: string[] } {
  const entry = owners.get(eventFqn);
  if (!entry || entry.entities.has(entityFqn)) return { ok: true };
  if (membership(entityFqn).some(({ aggregate }) => entry.aggregates.has(aggregate))) return { ok: true };
  return { ok: false, owners: [...entry.entities, ...entry.aggregates.values()].sort() };
}
