import { dirname, resolve } from "node:path";
import type { Aggregate, AggregatePart, Diagnostic, Entity, EntityRef, ModelDocument, Relationship, SourcePosition } from "@meshfw/model";
import { entitiesByFile } from "./key-holder.ts";

const lowerCamel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** The entity an aggregate's root or part line names, by its file; undefined for a line that resolved to none (it is reported where written). */
const entityOf = (byFile: ReadonlyMap<string, Entity>, aggregate: Aggregate, ref: EntityRef): Entity | undefined =>
  ref.from ? byFile.get(resolve(dirname(aggregate.file), ref.from)) : undefined;

/**
 * Resolve every aggregate against the model, after all entities and relationships are built (`notes/spec/other-file-kinds.md`,
 * "Aggregate files"). A part line that names the root, or an entity an earlier line names, is an error at the line and is
 * dropped from the parts. Then each part's link to the root: `prop=:name` must name a `belongs-to` of the part that points
 * at the root; without it the part's only `belongs-to` to the root is the link, and `part.prop` is set to it. No link, or
 * two with no `prop=`, is `MESH_AGGREGATE_PART` (rulings D35 OD2, OD3). The wording follows `MESH_INVERSE_*`
 * (`front-end/relationships.ts`). A root or a part that resolved to no entity was reported where it is written and is
 * skipped; a `belongs-to` of the part whose entity is unknown has its own error, and no link error is added on top of it.
 * `nearestName` gives the suggestion for a misspelt `prop=` (the front end's, which `model/` may not import).
 */
export function resolveAggregates(
  document: ModelDocument,
  propPositions: ReadonlyMap<AggregatePart, SourcePosition>,
  diagnostics: Diagnostic[],
  nearestName: (name: string, candidates: readonly string[]) => string | undefined,
): void {
  const byFile = entitiesByFile(document);
  const fail = (code: string, message: string, position: SourcePosition, fix: string | null = null) =>
    diagnostics.push({ severity: "error", code, message, position, fix });
  for (const aggregate of document.aggregates ?? []) {
    const root = entityOf(byFile, aggregate, aggregate.root.entity);
    const seen = new Set<Entity>();
    const parts: AggregatePart[] = [];
    for (const part of aggregate.parts) {
      const entity = entityOf(byFile, aggregate, part.entity);
      if (!entity) {
        parts.push(part);
        continue;
      }
      if (entity === root) {
        fail("MESH_AGGREGATE_PART", `${entity.fqn} is the root of ${aggregate.fqn}, so it is not one of its parts`, part.position, "remove the line");
        continue;
      }
      if (seen.has(entity)) {
        fail("MESH_DUPLICATE_MEMBER", `${entity.fqn} is listed twice in the entities of ${aggregate.fqn}`, part.position, "remove one");
        continue;
      }
      seen.add(entity);
      parts.push(part);
      if (!root) continue;
      const targetOf = (relation: Relationship) => relation.entity.from ? byFile.get(resolve(dirname(entity.file), relation.entity.from)) : undefined;
      const belongsTo = entity.relationships.filter((relation) => relation.kind === "belongs-to");
      const candidates = belongsTo.filter((relation) => targetOf(relation) === root);
      const names = candidates.map((candidate) => candidate.name);
      const list = names.map((name) => `:${name}`).join(", ");
      const known = names.length ? ` The belongs-to from ${entity.fqn} to ${root.fqn}: ${list}.` : "";
      if (part.prop !== undefined) {
        const authored = part.prop;
        const position = propPositions.get(part) ?? part.position;
        const named = entity.relationships.find((relation) => relation.name === authored);
        if (!named || named.kind !== "belongs-to") {
          const suggestion = nearestName(authored, names);
          fail("MESH_AGGREGATE_PART", `prop=:${authored} names no belongs-to of ${entity.fqn}.${suggestion ? ` Did you mean prop=:${suggestion}?` : known}`, position);
          delete part.prop;
        } else if (targetOf(named) !== root) {
          // A belongs-to whose own entity is unknown is reported where it is written.
          if (targetOf(named)) fail("MESH_AGGREGATE_PART", `prop=:${authored} is a belongs-to of ${entity.fqn} that points at ${targetOf(named)!.fqn}, not at ${root.fqn}.${known}`, position);
          delete part.prop;
        }
        continue;
      }
      if (candidates.length === 1) {
        part.prop = candidates[0]!.name;
        continue;
      }
      if (candidates.length === 0) {
        if (belongsTo.some((relation) => !targetOf(relation))) continue;
        const back = lowerCamel(root.name);
        fail("MESH_AGGREGATE_PART", `${entity.fqn} has no belongs-to to ${root.fqn}, the root of ${aggregate.fqn}`, part.position,
          `add \`belongs-to :${back} entity=${root.name}\` to ${entity.fqn}`);
        continue;
      }
      fail("MESH_AGGREGATE_PART", `${entity.fqn} could be tied to ${root.fqn} by any of its ${candidates.length} belongs-to (${list})`, part.position,
        `choose one: prop=:${names[0]}`);
    }
    aggregate.parts = parts;
  }
}

/** One aggregate an entity belongs to: the aggregate's FQN, whether the entity is its root or one of its parts, and the line that says so. */
export interface AggregateMembership { aggregate: string; role: "root" | "part"; position: SourcePosition }

/**
 * For each entity FQN, the aggregates that list it as root or part, with the line that does, in the order the document
 * holds them; an entity in none gets an empty list. A root or part line that resolves to no entity contributes nothing; a
 * part whose link to the root failed still does: the line declares membership, and the failed link is its own error.
 * Read after `resolveAggregates`, which drops a part line that repeats another or names the root.
 */
export function aggregatesOf(document: ModelDocument): (entityFqn: string) => readonly AggregateMembership[] {
  const byFile = entitiesByFile(document);
  const memberships = new Map<string, AggregateMembership[]>();
  const add = (entity: Entity | undefined, membership: AggregateMembership) => {
    if (!entity) return;
    const list = memberships.get(entity.fqn) ?? [];
    list.push(membership);
    memberships.set(entity.fqn, list);
  };
  for (const aggregate of document.aggregates ?? []) {
    add(entityOf(byFile, aggregate, aggregate.root.entity), { aggregate: aggregate.fqn, role: "root", position: aggregate.root.position });
    for (const part of aggregate.parts)
      add(entityOf(byFile, aggregate, part.entity), { aggregate: aggregate.fqn, role: "part", position: part.position });
  }
  return (entityFqn) => memberships.get(entityFqn) ?? [];
}

/** An aggregate as a message names it: `work.TaskAggregate (root work.Task, parts work.Dependency, work.Comment)`. */
export function describeAggregate(document: ModelDocument, aggregate: Aggregate): string {
  const byFile = entitiesByFile(document);
  const root = entityOf(byFile, aggregate, aggregate.root.entity);
  const parts = aggregate.parts.flatMap((part) => entityOf(byFile, aggregate, part.entity)?.fqn ?? []);
  const said = [
    ...(root ? [`root ${root.fqn}`] : []),
    ...(parts.length ? [`${parts.length === 1 ? "part" : "parts"} ${parts.join(", ")}`] : []),
  ];
  return said.length ? `${aggregate.fqn} (${said.join(", ")})` : aggregate.fqn;
}
