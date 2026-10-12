import { dirname, posix } from "node:path";
import type { Entity } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { entityLocal, entityPath, propertyName, typeName } from "./inputs.ts";
import { tableAccess } from "./actions.ts";
import { loadPolicies } from "../../model/policies.ts";
import { expressionIds, policySpecs } from "./expressions.ts";
import { relationTarget } from "./types.ts";

/**
 * What `load.ts.jig` renders: `<output>/load.ts`, one per build when some entity has a relationship or
 * a computed field (M7). It holds the load plan, plain data about every entity that `loadRows` in
 * `@meshfw/runtime` follows. Each entity's typed load function (`loadTaskFields`) is in its actions file, which reads
 * the plan from here; this file imports no actions file, so the plan is there before any entity value. Every string is
 * final; the template prints, loops and branches on these fields and computes nothing. A project's own `load.ts.jig`
 * depends on this shape.
 */
export interface LoadView {
  /** The adapter's schema file as a quoted string literal, e.g. `"./schema"`. */
  readonly schemaFromLiteral: string;
  /**
   * Imports of each entity's expressions file, for the entities with a computed field that has a body or a read policy
   * a load runs. The local is `entityLocal(entity, "expressions")`, e.g. `$work$Task$expressions`.
   */
  readonly expressionImports: readonly { readonly local: string; readonly fromLiteral: string }[];
  /** Every entity, in the fixed entity order: the plan has one entry per entity, because a relationship may point at any of them. */
  readonly entities: readonly LoadEntity[];
}

export interface LoadEntity {
  /** The entity's FQN (e.g. `blog.Post`) as a quoted string literal: the key of its plan entry and the target other entries name. */
  readonly nameLiteral: string;
  /** The entity's table handle in the schema file, e.g. `tables.tasks`. */
  readonly table: string;
  /** The primary key's attribute name as a quoted string literal. */
  readonly keyLiteral: string;
  /** One entry per relationship, in authored order. */
  readonly relations: readonly { readonly key: string; readonly plan: string }[];
  /** One entry per computed field, in authored order. */
  readonly computed: readonly { readonly key: string; readonly plan: string }[];
  /**
   * The policies a caller's load of the entity runs (POL-17), as the array literal `authorizer` takes, or `null` when none
   * covers its `read`: a caller then loads none of its records.
   */
  readonly reads: string | null;
}

const fromLiteral = (from: string, to: string) => {
  let path = posix.relative(dirname(from), to);
  if (!path.startsWith(".")) path = `./${path}`;
  return JSON.stringify(path);
};

/**
 * The name of the load function of an entity: `loadTaskFields`. An action function is `<action><Entity>`, and
 * `loadTask` is what an action named `load` would be, so the name ends in `Fields`.
 */
export const loaderName = (entity: Entity) => `load${typeName(entity.name, entity.position)}Fields`;
export const hasLoader = (entity: Entity) => entity.relationships.length + entity.computed.length > 0;

export function loadView(input: EmitInput, generatedPath: string): LoadView {
  const { document } = input;
  const ordered = orderedEntities(document);
  const expressionImports: { local: string; fromLiteral: string }[] = [];
  const locals = new Map<string, string>();
  const entities = ordered.map((entity): LoadEntity => {
    const key = entity.attributes.find((attribute) => attribute.primaryKey);
    if (!key) throw emitError("MESH_EMIT_KEY", `Entity ${entity.fqn} has no primary key`, entity.position);
    const relations = entity.relationships.map((relation) => {
      const target = relationTarget(document, entity, relation);
      const targetKey = target.attributes.find((attribute) => attribute.primaryKey);
      if (!targetKey) throw emitError("MESH_EMIT_KEY", `Entity ${target.fqn} has no primary key`, target.position);
      const parts = [`kind: ${JSON.stringify(relation.kind)}`, `target: ${JSON.stringify(target.fqn)}`];
      if (relation.kind === "belongs-to") parts.push(`column: ${JSON.stringify(relation.keyColumn)}`, `nullable: ${relation.nullable}`);
      else {
        const back = relation.inverse === undefined ? undefined : target.relationships.find((other) => other.name === relation.inverse);
        parts.push(`column: ${back?.keyColumn === undefined ? "null" : JSON.stringify(back.keyColumn)}`);
      }
      return { key: propertyName(relation.name), plan: `{ ${parts.join(", ")} }` };
    });
    const expressionsOf = () => {
      let local = locals.get(entity.file);
      if (!local) {
        // This one file holds every entity's local, so a local never uses the bare entity name (CMP-05): it is `$`, the
        // entity's path from the root barrel with `$` for `.` (each folder as its namespace name, PRJ-21), then `$expressions`:
        // `work.Task` gives `$work$Task$expressions`, a root `List` gives `$List$expressions` (`entityLocal`).
        local = entityLocal(entity, "expressions");
        locals.set(entity.file, local);
        expressionImports.push({ local, fromLiteral: fromLiteral(generatedPath, `${posix.dirname(generatedPath)}/${entityPath(entity)}.expressions`) });
      }
      return local;
    };
    // Read from the expressions file when called, never when this file loads: an expressions file imports the actions
    // files of the entities its functions call, which import this file, so the two can be in one import cycle.
    const lazily = (id: string) => `($s: never) => ${expressionsOf()}[${JSON.stringify(id)}]($s)`;
    const computed = entity.computed.map((field) => {
      if (field.rollup)
        return { key: propertyName(field.name), plan: `{ kind: "rollup", fn: ${JSON.stringify(field.rollup.fn)}, of: ${JSON.stringify(field.rollup.of.split("."))} }` };
      const needs = JSON.stringify(field.needs ?? []);
      return { key: propertyName(field.name), plan: `{ kind: "body", needs: ${needs},${field.body!.plain ? " plain: true," : ""} evaluate: ${lazily(`computed.${field.name}`)} }` };
    });
    const policies = loadPolicies(entity);
    const ids = policies.length ? expressionIds(entity) : undefined;
    const reads = policies.length ? policySpecs(policies, (expression) => lazily(ids!.get(expression)!), "read") : null;
    return {
      nameLiteral: JSON.stringify(entity.fqn),
      table: tableAccess(entity),
      keyLiteral: JSON.stringify(key.name),
      relations, computed, reads,
    };
  });
  return { schemaFromLiteral: JSON.stringify("./schema"), expressionImports, entities };
}
