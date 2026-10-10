import { describe, expect, test } from "bun:test";
import { CHUNK, FrameworkError, loadRows, rejectComputedQuery, scope, type DataOperations, type LoadPlan, type Row } from "../src/index.ts";

/** An in-memory data layer that understands the two filters loading uses (`eq`, `in`) and records every call. */
function memory(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const handle = (name: string) => ({ name }) as never;
  const rowsOf = (table: unknown) => tables[(table as { name: string }).name] ?? [];
  const matches = (row: Row, filter: Record<string, { eq?: unknown; in?: unknown[] }> | undefined) =>
    Object.entries(filter ?? {}).every(([key, cmp]) => ("eq" in cmp ? row[key] === cmp.eq : cmp.in!.includes(row[key])));
  const tx = {
    select: async (table: unknown, query?: { filter?: never }) => { calls.push(`select ${(table as { name: string }).name}`); return rowsOf(table).filter((row) => matches(row, query?.filter)).map((row) => ({ ...row })); },
    count: async (table: unknown, attribute: string, filter?: never) => { calls.push(`count ${(table as { name: string }).name}.${attribute}`); return rowsOf(table).filter((row) => matches(row, filter) && row[attribute] != null).length; },
    max: async (table: unknown, attribute: string, filter?: never) => {
      calls.push(`max ${(table as { name: string }).name}.${attribute}`);
      const values = rowsOf(table).filter((row) => matches(row, filter)).map((row) => row[attribute]).filter((v): v is number => v != null);
      return values.length ? Math.max(...values) : null;
    },
  } as unknown as DataOperations;
  return { tx, calls, handle };
}

const plan = (handle: (name: string) => never, extra: Partial<LoadPlan> = {}): LoadPlan => ({
  Node: {
    table: handle("nodes"), key: "id",
    relations: {
      parent: { kind: "belongs-to", target: "Node", column: "parentId", nullable: true },
      children: { kind: "has-many", target: "Node", column: "parentId" },
      owner: { kind: "belongs-to", target: "Owner", column: "ownerId", nullable: false },
      badge: { kind: "has-one", target: "Badge", column: "nodeId" },
      loose: { kind: "has-many", target: "Badge", column: null },
    },
    computed: {
      childCount: { kind: "body", needs: ["children"], evaluate: (s: { self: { children: unknown[] } }) => s.self.children.length } as never,
      // Reads its parent's own depth: a chain of rows, a cycle in the data makes it loop.
      depth: { kind: "body", needs: ["parent", "parent.depth"], evaluate: (s: { self: { parent: { depth: number } | null } }) => (s.self.parent ? s.self.parent.depth + 1 : 0) } as never,
      nothing: { kind: "body", needs: [], evaluate: () => undefined } as never,
      maxRank: { kind: "rollup", fn: "max", of: ["children", "rank"] },
      kids: { kind: "rollup", fn: "count", of: ["children"] },
      sizeSum: { kind: "rollup", fn: "sum", of: ["children", "size"] },
      deep: { kind: "rollup", fn: "count", of: ["children", "children"] },
      ownerCount: { kind: "rollup", fn: "count", of: ["owner"] },
      badRelation: { kind: "rollup", fn: "count", of: ["nowhere"] },
      looseCount: { kind: "rollup", fn: "count", of: ["loose"] },
    },
  },
  Owner: { table: handle("owners"), key: "id", relations: {}, computed: {} },
  Badge: { table: handle("badges"), key: "id", relations: {}, computed: {} },
  ...extra,
});

const nodes = (...rows: Row[]) => rows;

describe("loadRows", () => {
  test("an unknown name lists what the entity has; an unknown entity is a framework error", async () => {
    const { tx, handle } = memory({});
    await expect(loadRows(plan(handle), "Node", tx, [], ["parnt"])).rejects.toThrow(/Node has no relationship or computed field "parnt" to load \(it has parent, children/);
    await expect(loadRows(plan(handle), "Nope", tx, [], [])).rejects.toThrow("The load plan has no entity Nope");
    // Names that exist on Object are not names.
    await expect(loadRows(plan(handle), "Node", tx, [], ["toString"])).rejects.toBeInstanceOf(FrameworkError);
    await expect(loadRows(plan(handle), "constructor", tx, [], [])).rejects.toBeInstanceOf(FrameworkError);
  });

  test("no names loads nothing and returns copies", async () => {
    const { tx, calls, handle } = memory({});
    const input = nodes({ id: 1, parentId: null });
    const result = await loadRows(plan(handle), "Node", tx, input, []);
    expect(result).toEqual(input);
    expect(result[0]).not.toBe(input[0]);
    expect(calls).toEqual([]);
  });

  test("belongs-to: shared targets are one row, a null key on a nullable one is null", async () => {
    const { tx, calls, handle } = memory({ nodes: [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 1 }] });
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const loaded = await loadRows(plan(handle), "Node", tx, rows, ["parent"]);
    expect(loaded.map((r) => (r.parent as Row | null)?.id ?? null)).toEqual([null, 1, 1]);
    expect(loaded[1]!.parent).toBe(loaded[2]!.parent);
    expect(calls.filter((c) => c.startsWith("select")).length).toBe(2); // one to read the rows, one to load
  });

  test("a required belongs-to with no key, or whose row is missing, is an error", async () => {
    const { tx, handle } = memory({ owners: [{ id: 1 }] });
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1, ownerId: null }], ["owner"])).rejects.toThrow("belongs-to :owner of :Node has no key in ownerId, and it is not nullable");
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1, ownerId: 2 }], ["owner"])).rejects.toThrow("belongs-to :owner of :Node points at Owner 2, which does not exist");
  });

  test("has-many: one empty list per row without children, in the order the layer returns", async () => {
    const { tx, handle } = memory({ nodes: [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 1 }, { id: 4, parentId: 3 }] });
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const loaded = await loadRows(plan(handle), "Node", tx, rows, ["children"]);
    expect(loaded.map((r) => (r.children as Row[]).map((c) => c.id))).toEqual([[2, 3], [], [4], []]);
  });

  test("has-one: the row or null; two rows is an error", async () => {
    const { tx, handle } = memory({ badges: [{ id: 1, nodeId: 1 }, { id: 2, nodeId: 3 }, { id: 3, nodeId: 3 }] });
    const ok = await loadRows(plan(handle), "Node", tx, [{ id: 1 }, { id: 2 }], ["badge"]);
    expect(ok.map((r) => (r.badge as Row | null)?.id ?? null)).toEqual([1, null]);
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 3 }], ["badge"])).rejects.toThrow("has-one :badge of :Node found 2 rows for 3");
  });

  test("a has-many with no key back says what to declare", async () => {
    const { tx, handle } = memory({});
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1 }], ["loose"])).rejects.toThrow("has-many :loose of :Node cannot be loaded: :Badge has no belongs-to back to :Node. Declare one in :Badge, and name it with via=:name if there are several");
  });

  test("more keys than a chunk are several queries, and every row is served", async () => {
    const table = Array.from({ length: CHUNK * 2 + 3 }, (_, i) => ({ id: i + 1, parentId: i === 0 ? null : 1 }));
    const { tx, calls, handle } = memory({ nodes: table });
    const loaded = await loadRows(plan(handle), "Node", tx, table.slice(0, CHUNK * 2 + 3), ["children"]);
    expect(calls.filter((c) => c === "select nodes")).toHaveLength(3);
    expect((loaded[0]!.children as Row[]).length).toBe(CHUNK * 2 + 2);
    expect(loaded.slice(1).every((r) => (r.children as Row[]).length === 0)).toBe(true);
    // The same key twice is asked for once.
    const { tx: tx2, calls: calls2 } = memory({ nodes: table });
    await loadRows(plan(handle), "Node", tx2, [table[0]!, table[0]!], ["children"]);
    expect(calls2).toEqual(["select nodes"]);
  });

  test("a body loads what it needs first, once, and an undefined result is null", async () => {
    const { tx, calls, handle } = memory({ nodes: [{ id: 1, parentId: null }, { id: 2, parentId: 1 }] });
    const loaded = await loadRows(plan(handle), "Node", tx, [{ id: 1, parentId: null }], ["childCount", "nothing"]);
    expect(loaded[0]).toMatchObject({ childCount: 1, nothing: null });
    expect("children" in loaded[0]!).toBe(false);
    expect(calls).toEqual(["select nodes"]);
  });

  test("a body that reads a parent's computed field walks up the chain, one query per level", async () => {
    const { tx, calls, handle } = memory({ nodes: [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4, parentId: 3 }] });
    const [leaf] = await loadRows(plan(handle), "Node", tx, [{ id: 4, parentId: 3 }], ["depth"]);
    expect(leaf!.depth).toBe(3);
    // The parent of 4, of 3 and of 2; 1 has no parent, so nothing more is asked.
    expect(calls).toEqual(["select nodes", "select nodes", "select nodes"]);
  });

  test("a body that follows a cycle in the data stops with an error, not a hang", async () => {
    const { tx, handle } = memory({ nodes: [{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }] });
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1, parentId: 2 }], ["depth"])).rejects.toThrow(
      "went more than 32 levels deep: a computed field reads itself through rows that lead back to each other");
  });

  test("the scope a body gets carries the actor, the context and the clock; before is null", async () => {
    const seen: unknown[] = [];
    const { tx, handle } = memory({});
    const spy = plan(handle, {
      Spy: { table: handle("spies"), key: "id", relations: {}, computed: {
        look: { kind: "body", needs: [], evaluate: ((s: Record<string, unknown>) => { seen.push(s); return (s.clock as () => Date)().getTime(); }) as never },
      } },
    });
    const [row] = await loadRows(spy, "Spy", tx, [{ id: 1 }], ["look"], { actor: { id: "a" }, context: { actor: { id: "a" }, k: 1 }, clock: () => new Date(42) });
    expect(row!.look).toBe(42);
    expect(seen[0]).toMatchObject({ self: { id: 1 }, actor: { id: "a" }, context: { k: 1 }, before: null, input: undefined });
    void scope;
  });

  describe("rollups", () => {
    test("count and max call the layer once per row, on the key the has-many follows", async () => {
      const { tx, calls, handle } = memory({ nodes: [{ id: 1, parentId: null, rank: 3 }, { id: 2, parentId: 1, rank: 8 }, { id: 3, parentId: 1, rank: 5 }, { id: 4, parentId: 2, rank: null }] });
      const rows = (await tx.select(handle("nodes"))) as Row[];
      calls.length = 0;
      const loaded = await loadRows(plan(handle), "Node", tx, rows, ["maxRank", "kids"]);
      expect(loaded.map((r) => [r.maxRank, r.kids])).toEqual([[8, 2], [null, 1], [null, 0], [null, 0]]);
      expect(calls.filter((c) => c.startsWith("max")).length).toBe(4);
      expect(calls.filter((c) => c.startsWith("count nodes.id")).length).toBe(4);
    });

    test("sum, avg, min, a path through two relationships and a belongs-to are errors that say when", async () => {
      const { tx, handle } = memory({});
      const row = [{ id: 1, ownerId: 1 }];
      await expect(loadRows(plan(handle), "Node", tx, row, ["sizeSum"])).rejects.toThrow('sum :sizeSum of="children.size" on :Node cannot be loaded: only count and max rollups run before Mesh 1.0; sum, avg and min come after it');
      await expect(loadRows(plan(handle), "Node", tx, row, ["deep"])).rejects.toThrow("a rollup over more than one relationship needs a join, which arrives with the SQL evaluator (M10)");
      await expect(loadRows(plan(handle), "Node", tx, row, ["ownerCount"])).rejects.toThrow("a rollup over a belongs-to needs a join");
      await expect(loadRows(plan(handle), "Node", tx, row, ["badRelation"])).rejects.toThrow(":Node has no relationship nowhere");
      await expect(loadRows(plan(handle), "Node", tx, row, ["looseCount"])).rejects.toThrow(":Badge has no belongs-to back to :Node");
    });
  });
});

describe("rejectComputedQuery", () => {
  const names = ["total", "depth"];
  const refused = (what: string, name: string) => `A ${what} by Doc.${name} is not available yet: ${name} is a computed field or rollup, and filtering and sorting by one is evaluated by the SQL evaluator, which arrives in M10`;
  test("a filter or sort that names a computed field fails, naming M10", () => {
    expect(() => rejectComputedQuery("Doc", names, { filter: { total: { gt: 1 } } })).toThrow(refused("filter", "total"));
    expect(() => rejectComputedQuery("Doc", names, { sort: ["title", "-depth"] })).toThrow(refused("sort", "depth"));
    expect(() => rejectComputedQuery("Doc", names, { filter: { and: [{ title: { eq: "a" } }, { or: [{ total: { eq: 1 } }] }] } })).toThrow(refused("filter", "total"));
    expect(() => rejectComputedQuery("Doc", names, { filter: { total: { eq: 1 } } })).toThrow(FrameworkError);
  });
  test("an attribute, no query, or a name that only resembles one passes", () => {
    expect(() => rejectComputedQuery("Doc", names, {})).not.toThrow();
    expect(() => rejectComputedQuery("Doc", names, { filter: { title: { eq: "total" } }, sort: ["title", "-title"] })).not.toThrow();
    expect(() => rejectComputedQuery("Doc", names, { filter: { totals: { eq: 1 } }, sort: ["-totals"] })).not.toThrow();
    expect(() => rejectComputedQuery("Doc", names, { filter: { and: [] }, sort: [] })).not.toThrow();
    expect(() => rejectComputedQuery("Doc", [], { filter: { total: { eq: 1 } } })).not.toThrow();
  });
});
