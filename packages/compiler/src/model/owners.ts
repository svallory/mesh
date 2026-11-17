import type { ModelDocument } from "@meshfw/model";

/**
 * Each event's owners (`notes/spec/events-and-commands.md`, "Owners publish"): the entities whose `events` section lists
 * it, by FQN. An event no owner lists is absent, and any action may publish it.
 */
export type Owners = ReadonlyMap<string, { entities: ReadonlySet<string> }>;

export function ownersOf(document: ModelDocument): Owners {
  const owners = new Map<string, { entities: Set<string> }>();
  for (const entity of document.entities)
    for (const listed of entity.events ?? []) {
      // A listing that resolved to nothing was reported where it is written, and owns nothing.
      if (!listed.fqn) continue;
      const entry = owners.get(listed.fqn) ?? { entities: new Set<string>() };
      entry.entities.add(entity.fqn);
      owners.set(listed.fqn, entry);
    }
  return owners;
}

/** Whether an action of the entity `entityFqn` may publish the event `eventFqn`: it is one of the event's owners, or the event has none. */
export function mayPublish(owners: Owners, entityFqn: string, eventFqn: string): { ok: true } | { ok: false; owners: string[] } {
  const entry = owners.get(eventFqn);
  if (!entry || entry.entities.has(entityFqn)) return { ok: true };
  return { ok: false, owners: [...entry.entities].sort() };
}
