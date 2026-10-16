import { functionSpec, type Entity, type ExprNode } from "@meshfw/model";

/**
 * What a create's new instance lacks before the input is applied. Mesh builds the instance with a `uuid` or
 * `string` key already filled (lead, ACT-27), the defaults, the stamped timestamps, and null in every nullable member that has no
 * default; `validate` sees it so, and the member inputs are applied after it. What is left are the members the record
 * type says are set but that hold null until something fills them.
 */
export interface NewInstanceGaps {
  /** A primary key Mesh does not fill when it builds the instance (an `integer` key): null until the data layer writes the row. */
  readonly key: string | null;
  /** Required attributes with no default and no `on=` stamp: the input or a `set` step fills them. */
  readonly attributes: readonly string[];
  /** Required `belongs-to` relationships: the input or a `set` step fills the key column, so the related record is not there yet. */
  readonly relationships: readonly { readonly name: string; readonly keyColumn: string }[];
}

/** True for a key Mesh fills when it builds a create's instance: a UUIDv7, the same value the data layer would give at the write. */
export function filledKey(type: string): boolean {
  return type === "uuid" || type === "string";
}

export function newInstanceGaps(entity: Entity): NewInstanceGaps {
  const key = entity.attributes.find((attribute) => attribute.primaryKey);
  return {
    key: key && !filledKey(key.type) ? key.name : null,
    attributes: entity.attributes
      .filter((attribute) => !attribute.primaryKey && !attribute.nullable && attribute.default === undefined && attribute.on === undefined)
      .map((attribute) => attribute.name),
    relationships: entity.relationships
      .filter((relation) => relation.kind === "belongs-to" && !relation.nullable && relation.keyColumn !== undefined)
      .map((relation) => ({ name: relation.name, keyColumn: relation.keyColumn! })),
  };
}

/** Every member of `self` that may be null on a create before the input: the key, the attributes, each relationship and its key column. */
export function newInstanceMembers(gaps: NewInstanceGaps, withRelationships: boolean): string[] {
  return [
    ...(gaps.key ? [gaps.key] : []),
    ...gaps.attributes,
    ...gaps.relationships.flatMap((relation) => (withRelationships ? [relation.keyColumn, relation.name] : [relation.keyColumn])),
  ];
}

/**
 * The computed fields that are null on a create's new instance, the one answer for the generated `<E>NewScope`
 * type and for the build-time checks. The check loads a computed field onto the new instance and evaluates its body over
 * the nulls, so a translated body follows the null rule of each function (`FunctionSpec.nullResult`): `&qty * 2` is null
 * while `qty` is, `&publishedAt === null` is not (`isNull` is never unknown), `&a ?? 0` is not (`??` is null only when
 * every operand can be), and a computed field that reads such a field is null too. `unfilled` is every member null on the
 * new instance (`newInstanceMembers`). `and`, `or` (Kleene) and the quantifiers are conservative: tainted when an
 * operand or the body is, which says "may be null". A plain body is the author's TypeScript: whatever it returns for the
 * nulls is its own result, so it keeps its declared type (the reads it makes through `self.x` are not visible here).
 */
export function newInstanceComputed(entity: Entity, unfilled: ReadonlySet<string>): string[] {
  const tainted = new Set<string>();
  const isNull = (n: ExprNode): boolean => {
    switch (n.kind) {
      case "member": return n.object.kind === "var" && n.object.name === "self" ? unfilled.has(n.name) || tainted.has(n.name) : isNull(n.object);
      case "call": {
        switch (functionSpec(n.fn).nullResult) {
          case "never": return false;
          case "all-operands": return n.args.every(isNull);
          case "branches": return n.args.slice(1).some(isNull);
          case "propagates": return n.args.some(isNull);
        }
        return false;
      }
      case "helper": return n.args.some(isNull);
      case "quantify": return isNull(n.source) || isNull(n.body);
      default: return false;
    }
  };
  // Grow the set until no computed field joins it: one that reads a null computed field is null.
  for (let grew = true; grew;) {
    grew = false;
    for (const computed of entity.computed)
      if (!tainted.has(computed.name) && computed.body?.tree && isNull(computed.body.tree)) { tainted.add(computed.name); grew = true; }
  }
  return entity.computed.map((c) => c.name).filter((name) => tainted.has(name));
}
