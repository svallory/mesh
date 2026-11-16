import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, ModelDocument, Relationship, SourcePosition, Through } from "@meshfw/model";
import { entitiesByFile, keyHolderOf } from "../model/key-holder.ts";
import { nearestName } from "./nearest-name.ts";

const lowerCamel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Resolve every relationship against the model (M7), after all entities are built: a
 * `belongs-to` learns the type of its target's key, and a `has-many` or `has-one` learns which
 * `belongs-to` of its key holder (the target, or the link entity of a `through=`) it follows (ADR-0070: `inverse=`, else the only candidate, else the one named after
 * the entity). A target that is not in the model is
 * reported where the relationship is declared; this pass leaves it alone.
 */
export function resolveRelationships(
  document: ModelDocument,
  inversePositions: ReadonlyMap<Relationship, SourcePosition>,
  throughPositions: ReadonlyMap<Relationship, SourcePosition>,
  diagnostics: Diagnostic[],
): void {
  const byFile = entitiesByFile(document);
  const targetOf = (from: Entity, relation: Relationship) => byFile.get(resolve(dirname(from.file), relation.entity.from));
  const fail = (code: string, message: string, position: SourcePosition, fix: string | null = null) =>
    diagnostics.push({ severity: "error", code, message, position, fix });

  /**
   * The `belongs-to` of `holder` (the key holder) that a has-many or has-one of `entity` follows, by the ladder of ADR-0070:
   * the authored `inverse=`, else the only candidate, else the one named after the entity. Reports what goes wrong, sets
   * `relation.inverse` when it chooses, and returns the chosen name or `undefined`.
   */
  const entryOf = (entity: Entity, relation: Relationship, holder: Entity): string | undefined => {
    // The holder's `belongs-to` back to this entity: the keys this relationship could follow.
    const candidates = holder.relationships.filter(
      (other) => other.kind === "belongs-to" && targetOf(holder, other) === entity,
    );
    const names = candidates.map((candidate) => candidate.name);
    const list = names.map((name) => `:${name}`).join(", ");
    const describe = `${relation.kind} :${relation.name} of ${entity.fqn}`;
    // With `through=`, the holder is the link entity, and the messages say so.
    const through = relation.through !== undefined;
    const holderName = through ? `the link entity ${holder.fqn}` : holder.fqn;
    const authored = relation.inverse;
    if (authored !== undefined) {
      const position = inversePositions.get(relation) ?? relation.position;
      const named = holder.relationships.find((other) => other.name === authored);
      if (!named || named.kind !== "belongs-to") {
        const suggestion = nearestName(authored, names);
        fail(
          "MESH_INVERSE_UNKNOWN",
          `inverse=:${authored} names no belongs-to of ${holderName}.${suggestion ? ` Did you mean inverse=:${suggestion}?` : names.length ? ` The belongs-to from ${holder.fqn} to ${entity.fqn}: ${list}.` : ""}`,
          position,
        );
        delete relation.inverse;
        return undefined;
      }
      if (targetOf(holder, named) !== entity) {
        fail(
          "MESH_INVERSE_ENTITY",
          `inverse=:${authored} is a belongs-to of ${holderName} that points at ${targetOf(holder, named)?.fqn ?? named.entity.identifier}, not at ${entity.fqn}.${names.length ? ` The belongs-to from ${holder.fqn} to ${entity.fqn}: ${list}.` : ""}`,
          position,
        );
        delete relation.inverse;
        return undefined;
      }
      return authored;
    }
    // No belongs-to back: the has-many or has-one is what the other entity's key column hangs on, so the build fails
    // (ADR-0018). This pass runs after every entity is built, so the holder's relationships are all known.
    if (candidates.length === 0) {
      // A belongs-to of the holder whose entity is unknown may have been meant to point here; its own error is reported.
      if (holder.relationships.some((other) => other.kind === "belongs-to" && !targetOf(holder, other))) return undefined;
      const back = lowerCamel(entity.name);
      fail(
        "MESH_NO_INVERSE",
        through
          ? `${describe} goes through ${holder.fqn}, which has no belongs-to to ${entity.fqn}: add \`belongs-to :${back} entity=${entity.name}\` to ${holder.fqn}`
          : `${describe} needs a belongs-to back, and ${holder.fqn} has none to ${entity.fqn}: add \`belongs-to :${back} entity=${entity.name}\` to ${holder.fqn}`,
        relation.position,
        `Add \`belongs-to :${back} entity=${entity.name}\` to ${holder.fqn}`,
      );
      return undefined;
    }
    // The ladder: one candidate is the one; of several, the one named after this entity (Collaborator's
    // `memberships` follows Membership's `collaborator`); otherwise the author must say.
    const namedAfterEntity = names.find((name) => name === lowerCamel(entity.name));
    if (candidates.length === 1) relation.inverse = names[0]!;
    else if (namedAfterEntity !== undefined) relation.inverse = namedAfterEntity;
    else if (relation.kind === "has-many")
      fail(
        "MESH_INVERSE_REQUIRED",
        through
          ? `${describe} could enter ${holder.fqn} by any of its ${candidates.length} belongs-to to ${entity.fqn} (${list})`
          : `${describe} could follow any of ${candidates.length} belongs-to of ${holder.fqn} back to ${entity.fqn} (${list})`,
        relation.position,
        `Choose one: \`inverse=:${names[0]}\``,
      );
    else
      fail(
        "MESH_INVERSE_REQUIRED",
        `${describe} follows one belongs-to, and ${holder.fqn} has ${candidates.length} back to ${entity.fqn} (${list}); a has-one takes no inverse`,
        relation.position,
        `Use \`has-many\` with \`inverse=:${names[0]}\`, and read the one row you want from the list`,
      );
    return relation.inverse;
  };

  /**
   * The exit of a `has-many ... through=`: the link's only `belongs-to` to the far entity, the entry aside (D14(1)). None or
   * several is an error at the `through=` value; no option names the exit. Resolved whatever the entry's outcome, except
   * where the entry's error already stands for the same cause.
   */
  const exitOf = (entity: Entity, relation: Relationship, through: Through, link: Entity, far: Entity, entry: string | undefined) => {
    // Owner and far entity are one: the unchosen entry would be among the candidates, and its own error stands.
    if (entry === undefined && far === entity) return;
    const candidates = link.relationships.filter(
      (other) => other.kind === "belongs-to" && targetOf(link, other) === far && other.name !== entry,
    );
    if (candidates.length === 1) {
      through.exit = candidates[0]!.name;
      return;
    }
    // A belongs-to of the link whose entity is unknown may have been meant as the exit; its own error is reported.
    if (candidates.length === 0 && link.relationships.some((other) => other.kind === "belongs-to" && !targetOf(link, other))) return;
    const describe = `${relation.kind} :${relation.name} of ${entity.fqn}`;
    const besides = far === entity && entry !== undefined ? ` other than :${entry}` : "";
    const position = throughPositions.get(relation) ?? relation.position;
    if (candidates.length === 0) {
      const taken = new Set([...link.attributes, ...link.relationships, ...link.computed].map((member) => member.name));
      let name = lowerCamel(far.name);
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}${n}`)) n++;
        name = `${name}${n}`;
      }
      const line = `\`belongs-to :${name} entity=${far.name}\``;
      fail(
        "MESH_NO_INVERSE",
        `${describe} goes through ${link.fqn}, which has no belongs-to to ${far.fqn}${besides}: add ${line} to ${link.fqn}`,
        position,
        `Add ${line} to ${link.fqn}`,
      );
      return;
    }
    fail(
      "MESH_INVERSE_REQUIRED",
      `${describe} leaves ${link.fqn} by its one belongs-to to ${far.fqn}${besides}, and ${link.fqn} has ${candidates.length} (${candidates.map((c) => `:${c.name}`).join(", ")}); the exit must be the only one`,
      position,
      `Keep one belongs-to from ${link.fqn} to ${far.fqn}, or give the second its own link entity`,
    );
  };

  for (const entity of document.entities) {
    for (const relation of entity.relationships) {
      const target = targetOf(entity, relation);
      if (!target) continue;
      if (relation.kind === "belongs-to") {
        const key = target.attributes.find((attribute) => attribute.primaryKey);
        if (key) relation.keyType = key.type;
        continue;
      }
      // A `through=` that did not resolve has its own error (`MESH_UNKNOWN_ENTITY`), and so does an `entity=` (above).
      if (relation.through && relation.through.entity.from === "") continue;
      const holder = keyHolderOf(byFile, entity, relation);
      if (!holder) continue;
      if (relation.through && (holder === entity || holder === target)) {
        // The link is a third entity (D26): a link that is the owner or the far entity can be allowed later, not withdrawn.
        fail(
          "MESH_ENTITY_REFERENCE",
          `${relation.kind} :${relation.name} of ${entity.fqn} goes through ${holder === entity ? `${entity.fqn} itself` : `${target.fqn}, the entity it lists`}; the link entity must be a third entity, neither ${entity.fqn} nor the one it lists`,
          throughPositions.get(relation) ?? relation.position,
          "Declare a link entity with a belongs-to to each side and name it in through=",
        );
        continue;
      }
      const entry = entryOf(entity, relation, holder);
      if (relation.through) exitOf(entity, relation, relation.through, holder, target, entry);
    }
  }

  // A has-one is at most one row for the key it follows, so a has-many of the same entity cannot follow that key too
  // (ADR-0045). Two has-one over one key are accepted. A relationship whose key was not found has its own error above
  // and shares nothing.
  for (const entity of document.entities) {
    // A through whose exit was not found has its own error and shares nothing either.
    const followers = entity.relationships.filter(
      (relation) => relation.kind !== "belongs-to" && relation.inverse !== undefined && (!relation.through || relation.through.exit !== undefined),
    );
    for (const one of followers) {
      if (one.kind !== "has-one") continue;
      const target = keyHolderOf(byFile, entity, one);
      if (!target) continue;
      const sharing = followers.filter(
        (other) => other.kind === "has-many" && other.inverse === one.inverse && keyHolderOf(byFile, entity, other) === target,
      );
      const many = sharing.map((other) => `has-many :${other.name}`);
      if (many.length === 0) continue;
      const alone = many.length === 1;
      // A has-many through the has-one's target enters it by the same key; its list holds far records, not the target's rows.
      if (alone && sharing[0]!.through) {
        fail(
          "MESH_HAS_ONE_SHARED_KEY",
          `has-one :${one.name} of ${entity.fqn} follows belongs-to :${one.inverse} of ${target.fqn}, and ${many[0]} enters ${target.fqn} by it too: a has-one is at most one row for that key, so the two cannot share it`,
          one.position,
          `Replace the has-one with \`has-many :${one.name}s entity=${one.entity.identifier}\` and take the one row from its list, or give ${many[0]} its own belongs-to on ${target.fqn} with \`inverse=\``,
        );
        continue;
      }
      fail(
        "MESH_HAS_ONE_SHARED_KEY",
        `has-one :${one.name} of ${entity.fqn} follows belongs-to :${one.inverse} of ${target.fqn}, and ${alone ? many[0] : `${many.slice(0, -1).join(", ")} and ${many.at(-1)}`} ${alone ? "follows" : "follow"} it too: a has-one is at most one row for that key, so ${alone ? "the two" : "they"} cannot share it`,
        one.position,
        "Keep the has-many and take the one row from its list, or give the has-many its own belongs-to with `inverse=`",
      );
    }
  }
}
