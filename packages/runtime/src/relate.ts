import type { Row } from "./data-layer.ts";
import { InvalidInputError, type Issue, type IssueSource } from "./errors.ts";

/** An item of a relate's list that names a current child by its key `K`: the generated keyed item type. */
export type KeyedItem<Item, K extends string> = Exclude<Item, { readonly [P in K]?: undefined }>;
/** An item of a relate's list that holds no key: the generated new item type (`never` when the list takes none). */
export type NewItem<Item, K extends string> = Extract<Item, { readonly [P in K]?: undefined }>;

/**
 * What a generated action hands `relateRows` for one `relate &tracks create=:add update=:rename destroy=:remove` step
 * (ADR-0100, "The relate step"). The functions are closures the generated code builds over the child entity value, the
 * caller's context and the parent's loader, so this module knows nothing about entities or policies.
 */
export interface RelateSpec<Item extends Row, K extends string> {
  /** `music.Album#tracks`, for messages. */
  readonly where: string;
  /** The input field, and the first segment of every issue path. */
  readonly field: string;
  /** The child's key attribute. */
  readonly key: K;
  /** True when the key is a `uuid`: a key is then compared lower-cased (Mesh stores keys lower-case, a caller may send upper-case). */
  readonly uuidKey: boolean;
  /** The `relate` line, for the issues. */
  readonly source: IssueSource;
  /** The current children the caller may read: the generated code loads the has-many with the target's read policies. */
  readonly current: () => Promise<readonly Row[]>;
  /** The `destroy=` action, called with the key alone; absent without `destroy=`. */
  readonly destroy?: (key: Pick<KeyedItem<Item, K>, K>) => Promise<unknown>;
  /** The `update=` action, called with a keyed item; absent without `update=`. */
  readonly update?: (item: KeyedItem<Item, K>) => Promise<unknown>;
  /** The `create=` action, called with a new item (the closure adds the inverse); absent without `create=`. */
  readonly create?: (item: NewItem<Item, K>) => Promise<unknown>;
}

/**
 * Make the children of one record match `items`:
 *
 * - `items` undefined (the caller left the field out) does nothing and reads nothing;
 * - the current children are read once, through `spec.current`;
 * - a keyed item whose key is no current child's is an issue `not_related`, and a key given twice is an issue `duplicate`
 *   at its second item; every such issue is reported together in one `InvalidInputError`, before any call;
 * - then, in this order: `destroy` for each current child the list leaves out (in the order the read returned them),
 *   `update` for each keyed item (in list order), `create` for each new item (in list order). A function that is absent
 *   is not called: without `destroy` a child the list leaves out is kept, without `update` a keyed item keeps its child.
 *
 * An item holding `spec.key` is a `KeyedItem`, any other a `NewItem` (handed to `create` without the key, even an
 * undefined one): the parent's cast has already checked each against
 * its schema, which is what the casts below rest on. A keyed item reaches `update` with the key as stored. A failed call rejects with its own error, unchanged.
 */
export async function relateRows<Item extends Row, const K extends string>(spec: RelateSpec<Item, K>, items: readonly Item[] | undefined): Promise<void> {
  type Keyed = KeyedItem<Item, K>;
  type New = NewItem<Item, K>;
  if (items === undefined) return;
  const normal = (value: unknown): unknown => (spec.uuidKey && typeof value === "string" ? value.toLowerCase() : value);
  const current = await spec.current();
  const byKey = new Map<unknown, Row>();
  for (const row of current) byKey.set(normal(row[spec.key]), row);
  const issues: Issue[] = [];
  const kept = new Set<unknown>();
  const keyed: Keyed[] = [];
  const fresh: New[] = [];
  for (const [index, item] of items.entries()) {
    if (!(spec.key in item) || item[spec.key] === undefined) {
      // `{ id: undefined, name }` is a new item by its type and its schema, and Zod keeps the undefined key: drop it, or
      // the child's strict input refuses it as an unknown key.
      const { [spec.key]: _key, ...rest } = item;
      fresh.push(rest as unknown as New);
      continue;
    }
    const sent = item[spec.key];
    const key = normal(sent);
    const issue = (code: string, message: string): Issue =>
      ({ label: "relate", code, path: [spec.field, index, spec.key], message, source: spec.source, details: { [spec.key]: sent } });
    const row = byKey.get(key);
    if (row === undefined) issues.push(issue("not_related", `${spec.key} ${String(sent)} is not one of the ${spec.field} of this record (${spec.where})`));
    else if (kept.has(key)) issues.push(issue("duplicate", `${spec.key} ${String(sent)} is given twice in ${spec.field}`));
    else {
      kept.add(key);
      keyed.push({ ...item, [spec.key]: row[spec.key] } as unknown as Keyed);
    }
  }
  if (issues.length > 0) throw new InvalidInputError(issues);
  if (spec.destroy)
    for (const row of current) if (!kept.has(normal(row[spec.key]))) await spec.destroy({ [spec.key]: row[spec.key] } as Pick<Keyed, K>);
  if (spec.update) for (const item of keyed) await spec.update(item);
  if (spec.create) for (const item of fresh) await spec.create(item);
}
