import { dirname, resolve } from "node:path";
import type {
  Computed,
  Diagnostic,
  Entity,
  MemberRef,
  ModelDocument,
  SourcePosition,
} from "@meshfw/model";
import { nearestName } from "./nearest-name.ts";

export function unknownMember(
  entity: Entity,
  ref: MemberRef,
  candidates: Set<string>,
): Diagnostic {
  const suggestion = nearestName(ref.name, candidates);
  return {
    severity: "error",
    code: "MESH_UNKNOWN_MEMBER",
    message: `&${ref.name} is not a member of :${entity.name}.${suggestion ? ` Did you mean &${suggestion}?` : ""}`,
    position: ref.position,
    fix: null,
  };
}
export interface PendingRollup {
  entity: Entity;
  computed: Computed;
  segments: MemberRef[];
}
/** Resolve only static relationship paths. No function body is interpreted. */
export function resolveRollups(
  document: ModelDocument,
  pending: PendingRollup[],
  diagnostics: Diagnostic[],
): void {
  const entities = new Map(
    document.entities.map((entity) => [resolve(entity.file), entity]),
  );
  const fail = (code: string, message: string, position: SourcePosition) =>
    diagnostics.push({ severity: "error", code, message, position, fix: null });
  for (const { entity, computed, segments } of pending) {
    if (!computed.rollup) continue;
    let current = entity;
    let nullable = false;
    for (let index = 0; index < segments.length; index++) {
      const ref = segments[index]!;
      const relation = current.relationships.find((r) => r.name === ref.name);
      const attribute = current.attributes.find((a) => a.name === ref.name);
      const last = index === segments.length - 1;
      if (!relation && !attribute) {
        diagnostics.push(
          unknownMember(
            current,
            ref,
            new Set(
              [...current.attributes, ...current.relationships].map(
                (m) => m.name,
              ),
            ),
          ),
        );
        break;
      }
      if (relation) {
        nullable ||= relation.kind !== "belongs-to" || relation.nullable;
        if (last) {
          if (computed.rollup.fn !== "count")
            fail(
              "MESH_ROLLUP_PATH",
              `&${ref.name} is a relationship, not an attribute`,
              ref.position,
            );
          else {
            computed.type = "integer";
            computed.nullable = false;
          }
          break;
        }
        const target = entities.get(
          resolve(dirname(current.file), relation.entity.from),
        );
        if (!target) {
          fail(
            "MESH_UNKNOWN_ENTITY",
            `Imported entity ${relation.entity.identifier} is not in the model`,
            ref.position,
          );
          break;
        }
        current = target;
      } else if (attribute) {
        if (!last || computed.rollup.fn === "count") {
          fail(
            "MESH_ROLLUP_PATH",
            `&${ref.name} is an attribute, not a relationship`,
            ref.position,
          );
          break;
        }
        if (index === 0) {
          fail("MESH_ROLLUP_PATH", `\`${ref.name}\` is an attribute of :${entity.name}, not a relationship; \`of\` is a path through relationships`, ref.position);
          break;
        }
        const fn = computed.rollup.fn;
        const numeric =
          attribute.type === "integer" || attribute.type === "decimal";
        const ordered =
          numeric || attribute.type === "date" || attribute.type === "datetime";
        if (fn === "sum" || fn === "avg" ? !numeric : !ordered) {
          fail(
            "MESH_ROLLUP_TYPE",
            `${fn} needs ${fn === "sum" || fn === "avg" ? "a number" : "a number, date or datetime"}, &${ref.name} is :${attribute.type}`,
            ref.position,
          );
          break;
        }
        computed.type = fn === "avg" ? "decimal" : attribute.type;
        computed.nullable = nullable || attribute.nullable;
      }
    }
  }
}
