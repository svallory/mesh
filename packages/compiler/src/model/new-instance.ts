import type { Entity, ExprNode } from "@meshfw/model";

/**
 * What a create's new instance lacks before the input is applied (ACT-27). Mesh builds the instance with a `uuid` or
 * `string` key already filled, the defaults, the stamped timestamps, and null in every nullable member that has no
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
 * The computed fields that are null on a create's new instance (ACT-27): the ones whose translated body reads a member
 * that is null there (`unfilled`, as `newInstanceMembers` lists them) or another such computed field. The check loads
 * a computed field onto the new instance and evaluates its body over the nulls, and a translated body follows the null
 * rule, so `&qty * 2` is null while `qty` is. A plain body is the author's TypeScript: whatever it returns for the nulls
 * is its own result, so it keeps its declared type (the reads it makes through `self.x` are not visible here either).
 */
export function newInstanceComputed(entity: Entity, unfilled: ReadonlySet<string>): string[] {
  const reads = (n: ExprNode, into: Set<string>): void => {
    if (n.kind === "member") {
      if (n.object.kind === "var" && n.object.name === "self") into.add(n.name);
      reads(n.object, into);
    } else if (n.kind === "call" || n.kind === "helper") n.args.forEach((arg) => reads(arg, into));
    else if (n.kind === "quantify") { reads(n.source, into); reads(n.body, into); }
  };
  const readBy = new Map<string, Set<string>>();
  for (const computed of entity.computed) {
    const names = new Set<string>();
    if (computed.body?.tree) reads(computed.body.tree, names);
    readBy.set(computed.name, names);
  }
  // Grow the set until no computed field reads one more: a computed field that reads another one that is null is null.
  const tainted = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, names] of readBy)
      if (!tainted.has(name) && [...names].some((read) => unfilled.has(read) || tainted.has(read))) { tainted.add(name); grew = true; }
  }
  return entity.computed.map((c) => c.name).filter((name) => tainted.has(name));
}
