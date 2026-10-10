import { dirname, posix } from "node:path";
import type { Entity } from "@meshfw/model";
import { emitError } from "../emit-error.ts";
import type { EmitInput } from "../emit.ts";
import { orderedEntities } from "../emitters/order.ts";
import { camelCase, entityPath, propertyName, typeName } from "./inputs.ts";
import { relationTarget } from "./types.ts";

/**
 * What `load.ts.jig` renders: `<output>/load.ts`, one per build when some entity has a relationship or
 * a computed field (M7). It holds the load plan, plain data about every entity that `loadRows` in
 * `@meshfw/runtime` follows, and one typed function per such entity (`loadTaskFields`) that the `load` step of
 * an action (M5) and a caller inside a transaction call. Every string is final; the template prints,
 * loops and branches on these fields and computes nothing. A project's own `load.ts.jig` depends on this shape.
 */
export interface LoadView {
  /** The adapter's schema file as a quoted string literal, e.g. `"./schema"`. */
  readonly schemaFromLiteral: string;
  /** Imports of each entity's expressions file, for the entities with a computed field that has a body. */
  readonly expressionImports: readonly { readonly local: string; readonly fromLiteral: string }[];
  /** Type imports, one per entity that has something to load: the record type, its loadable map and its `With` type. */
  readonly typeImports: readonly { readonly names: string; readonly fromLiteral: string }[];
  /** Every entity, in the fixed entity order: the plan has one entry per entity, because a relationship may point at any of them. */
  readonly entities: readonly LoadEntity[];
}

export interface LoadEntity {
  /** The entity's name as a quoted string literal: the key of its plan entry and the target other entries name. */
  readonly nameLiteral: string;
  /** The entity's table handle in the schema file, e.g. `tables.task`. */
  readonly table: string;
  /** The primary key's attribute name as a quoted string literal. */
  readonly keyLiteral: string;
  /** One entry per relationship, in authored order. */
  readonly relations: readonly { readonly key: string; readonly plan: string }[];
  /** One entry per computed field, in authored order. */
  readonly computed: readonly { readonly key: string; readonly plan: string }[];
  /** The entity's loader, or `null` when it has no relationship and no computed field. */
  readonly loader: LoadFunction | null;
}

/** `export async function <name><const N extends keyof <loadable>>(tx, rows: readonly <record>[], names: readonly N[], options?): Promise<<with><N>[]>` */
export interface LoadFunction {
  readonly name: string;
  readonly record: string;
  readonly loadable: string;
  readonly with: string;
  /** The entity's name as a quoted string literal. */
  readonly entityLiteral: string;
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
  const typeImports: { names: string; fromLiteral: string }[] = [];
  const locals = new Map<string, string>();
  const entities = ordered.map((entity): LoadEntity => {
    const record = typeName(entity.name, entity.position);
    const key = entity.attributes.find((attribute) => attribute.primaryKey);
    if (!key) throw emitError("MESH_EMIT_KEY", `Entity :${entity.name} has no primary key`, entity.position);
    const relations = entity.relationships.map((relation) => {
      const target = relationTarget(document, entity, relation);
      const targetKey = target.attributes.find((attribute) => attribute.primaryKey);
      if (!targetKey) throw emitError("MESH_EMIT_KEY", `Entity :${target.name} has no primary key`, target.position);
      const parts = [`kind: ${JSON.stringify(relation.kind)}`, `target: ${JSON.stringify(target.name)}`];
      if (relation.kind === "belongs-to") parts.push(`column: ${JSON.stringify(relation.keyColumn)}`, `nullable: ${relation.nullable}`);
      else {
        const back = relation.via === undefined ? undefined : target.relationships.find((other) => other.name === relation.via);
        parts.push(`column: ${back?.keyColumn === undefined ? "null" : JSON.stringify(back.keyColumn)}`);
      }
      return { key: propertyName(relation.name), plan: `{ ${parts.join(", ")} }` };
    });
    const computed = entity.computed.map((field) => {
      if (field.rollup)
        return { key: propertyName(field.name), plan: `{ kind: "rollup", fn: ${JSON.stringify(field.rollup.fn)}, of: ${JSON.stringify(field.rollup.of.split("."))} }` };
      const needs = JSON.stringify(field.needs ?? []);
      let local = locals.get(entity.file);
      if (!local) {
        local = `${camelCase(entity.name)}Expressions`;
        locals.set(entity.file, local);
        expressionImports.push({ local, fromLiteral: fromLiteral(generatedPath, `${posix.dirname(generatedPath)}/${entityPath(entity)}.expressions`) });
      }
      return { key: propertyName(field.name), plan: `{ kind: "body", needs: ${needs},${field.body!.plain ? " plain: true," : ""} evaluate: ${local}[${JSON.stringify(`computed.${field.name}`)}] }` };
    });
    let loader: LoadFunction | null = null;
    if (hasLoader(entity)) {
      loader = { name: loaderName(entity), record, loadable: `${record}Loadable`, with: `${record}With`, entityLiteral: JSON.stringify(entity.name) };
      typeImports.push({ names: `${record}, ${record}Loadable, ${record}With`, fromLiteral: fromLiteral(generatedPath, `${posix.dirname(generatedPath)}/${entityPath(entity)}.types`) });
    }
    return {
      nameLiteral: JSON.stringify(entity.name),
      table: `tables.${camelCase(entity.name)}`,
      keyLiteral: JSON.stringify(key.name),
      relations, computed, loader,
    };
  });
  return { schemaFromLiteral: JSON.stringify("./schema"), expressionImports, typeImports, entities };
}
