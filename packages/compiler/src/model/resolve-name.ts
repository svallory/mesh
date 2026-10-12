import type { Entity, ModelDocument } from "@meshfw/model";

/** What `resolveName` found: one entity, or why it refused to pick (`message` is ready to print). */
export type NameResolution =
  | { readonly kind: "found"; readonly entity: Entity }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[]; readonly message: string }
  | { readonly kind: "unknown"; readonly known: readonly string[]; readonly message: string };

/** "a, b or c" (PRJ-16's sentence form for candidates). */
function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolves an input name to one entity (PRJ-16). Input may be shortened to the fewest trailing qualifiers that pick one
 * declaration: `project.Task` for `work.project.Task`, and `Task` alone while only one exists. An exact match on the
 * FQN wins; otherwise the input matches segment-wise from the end, case-sensitively. One match wins; two or more is
 * an error that lists every candidate's FQN, and Mesh never picks one; none lists the known FQNs.
 *
 * Agent tools and configuration strings use the same rule. It reads `fqn` off the model and never builds one.
 */
export function resolveName(document: Pick<ModelDocument, "entities">, input: string): NameResolution {
  const exact = document.entities.find((entity) => entity.fqn === input);
  if (exact) return { kind: "found", entity: exact };
  const wanted = input.split(".");
  const matches = input === ""
    ? []
    : document.entities.filter((entity) => {
        const segments = entity.fqn.split(".");
        return wanted.length <= segments.length && wanted.every((segment, index) => segment === segments[segments.length - wanted.length + index]);
      });
  if (matches.length === 1) return { kind: "found", entity: matches[0]! };
  if (matches.length > 1) {
    const candidates = matches.map((entity) => entity.fqn).sort(byCodeUnit);
    return { kind: "ambiguous", candidates, message: `Entity name "${input}" is ambiguous. Did you mean ${orList(candidates)}?` };
  }
  const known = document.entities.map((entity) => entity.fqn).sort(byCodeUnit);
  return { kind: "unknown", known, message: `Unknown entity "${input}"; known entities: ${known.join(", ")}` };
}
