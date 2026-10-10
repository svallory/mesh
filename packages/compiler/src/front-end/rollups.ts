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
import { inverseProblem } from "../model/inverse.ts";

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
    const before = diagnostics.length;
    let current = entity;
    let nullable = false;
    for (let index = 0; index < segments.length; index++) {
      const ref = segments[index]!;
      const relation = current.relationships.find((r) => r.name === ref.name);
      const attribute = current.attributes.find((a) => a.name === ref.name);
      const last = index === segments.length - 1;
      if (!relation && !attribute) {
        if (current.computed.some((field) => field.name === ref.name)) {
          fail("MESH_ROLLUP_PATH", "rollups read attributes through relationships, not computed fields", ref.position);
          break;
        }
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
          numeric || attribute.type === "date" || attribute.type === "datetime" || attribute.type === "timestamp";
        if (fn === "sum" || fn === "avg" ? !numeric : !ordered) {
          fail(
            "MESH_ROLLUP_TYPE",
            `${fn} needs ${fn === "sum" || fn === "avg" ? "a number" : "a number, date, datetime or timestamp"}, &${ref.name} is :${attribute.type}`,
            ref.position,
          );
          break;
        }
        computed.type = fn === "avg" ? "decimal" : attribute.type;
        computed.nullable = nullable || attribute.nullable;
      }
    }
    // What the path means is checked; whether the loader can serve it is known now too, so say so at the build (ADR-0018).
    if (diagnostics.length !== before) continue;
    const { fn } = computed.rollup;
    if (fn !== "count" && fn !== "max") {
      fail("MESH_NOT_IMPLEMENTED", `${fn} rollups are not implemented yet: only count and max run before Mesh 1.0; sum, avg and min come after it`, computed.position);
      continue;
    }
    const first = entity.relationships.find((r) => r.name === segments[0]!.name);
    if (!first) continue;
    if (first.kind === "belongs-to" || segments.length > 2 || (fn === "count" && segments.length > 1)) {
      fail("MESH_NOT_IMPLEMENTED", `${fn} :${computed.name} goes through ${first.kind === "belongs-to" ? "a belongs-to" : "more than one relationship"}, which needs a join; joins arrive with the SQL evaluator (M10). Only a ${fn} over one has-many or has-one runs before then`, computed.position);
      continue;
    }
    if (first.via === undefined) {
      const problem = inverseProblem(document, entity, first);
      diagnostics.push({ severity: "error", code: problem.code, message: `${fn} :${computed.name} reads ${first.kind} :${first.name}, which cannot be loaded: ${problem.because}`, position: computed.position, fix: problem.fix });
    }
  }
}
