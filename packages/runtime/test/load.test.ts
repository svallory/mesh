import { describe, expect, test } from "bun:test";
import { CHUNK, FrameworkError, guarded, loadInto, loadRows, unloadFrom, scope, type Condition, type ConditionLiteral, type DataOperations, type Hop, type LoadPlan, type PolicySpec, type Row } from "../src/index.ts";
import { and, eq, not, or } from "../src/expr.ts";

/**
 * An in-memory data layer that understands the filters loading uses (`eq`, `in`, `nil`) and an ascending `sort` with the
 * key (`id`) appended, and records every call. Of translated conditions it runs a `where` over the row's own columns
 * (`column`, `value`, `eq`, `ne`, `lt`, `gt`, `and`, `or`, `not`, `isTrue`, `isFalse`) and fails loudly on anything else, an `order` included.
 */
function memory(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const handle = (name: string) => ({ name }) as never;
  const rowsOf = (table: unknown) => tables[(table as { name: string }).name] ?? [];
  const matches = (row: Row, filter: Record<string, { eq?: unknown; in?: unknown[]; nil?: boolean }> | undefined) =>
    Object.entries(filter ?? {}).every(([key, cmp]) =>
      "eq" in cmp ? row[key] === cmp.eq : "nil" in cmp ? (row[key] === null || row[key] === undefined) === cmp.nil : cmp.in!.includes(row[key]));
  const compare = (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1);
  const sorted = (rows: Row[], sort: readonly string[] | undefined) =>
    sort ? [...rows].sort((a, b) => [...sort, "id"].reduce((order, key) => order || compare(a[key], b[key]), 0)) : rows;
  // A where or an order this double cannot run must fail loudly (design 3.4), so a change that passes one has to
  // extend the double instead of passing against unfiltered rows.
  const noCondition = (where: unknown) => { if (where !== undefined) throw new Error("this test double runs no order"); };
  const value = (node: Condition, row: Row): unknown => {
    if (node.kind === "column" && node.depth === 0) return row[node.name] ?? null;
    if (node.kind === "value") return node.value;
    if (node.kind !== "call") throw new Error(`this test double runs no ${node.kind} node`);
    const [a, b] = node.args.map((arg) => () => value(arg, row));
    switch (node.fn) {
      case "eq": return eq(a!(), b!());
      case "ne": return not(eq(a!(), b!()));
      case "lt": case "gt": {
        // Dates compare by instant, as the database compares them.
        const [x, y] = [a!(), b!()].map((v) => (v instanceof Date ? v.getTime() : v));
        if (x === null || y === null) return null;
        return node.fn === "lt" ? (x as number) < (y as number) : (x as number) > (y as number);
      }
      case "not": return not(a!());
      case "isTrue": return a!() === true;
      case "isFalse": return a!() === false;
      case "and": return node.args.reduce<unknown>((acc, arg) => and(acc, () => value(arg, row)), true);
      case "or": return node.args.reduce<unknown>((acc, arg) => or(acc, () => value(arg, row)), false);
      default: throw new Error(`this test double runs no ${node.fn}`);
    }
  };
  const holds = (row: Row, where: unknown) => where === undefined || value(where as Condition, row) === true;
  const describeWhere = (where: unknown) => (where === undefined ? "" : " where");
  const tx = {
    select: async (table: unknown, query?: { filter?: never; sort?: readonly string[]; where?: unknown; order?: unknown }) => {
      noCondition(query?.order);
      calls.push(`select ${(table as { name: string }).name}${query?.sort ? ` sort=${query.sort.join(",")}` : ""}${describeWhere(query?.where)}`);
      return sorted(rowsOf(table).filter((row) => matches(row, query?.filter) && holds(row, query?.where)), query?.sort).map((row) => ({ ...row }));
    },
    count: async (table: unknown, attribute: string, filter?: never, where?: unknown) => {
      calls.push(`count ${(table as { name: string }).name}.${attribute}${describeWhere(where)}`);
      return rowsOf(table).filter((row) => matches(row, filter) && holds(row, where) && row[attribute] != null).length;
    },
    max: async (table: unknown, attribute: string, filter?: never, where?: unknown) => {
      calls.push(`max ${(table as { name: string }).name}.${attribute}${describeWhere(where)}`);
      const values = rowsOf(table).filter((row) => matches(row, filter) && holds(row, where)).map((row) => row[attribute]).filter((v): v is number => v != null);
      return values.length ? Math.max(...values) : null;
    },
    rollup: async ({ fn, table, anchor, anchors, value, hops, key: last, where }: { fn: string; table: unknown; anchor: string; anchors: unknown[]; value: string; hops?: { hop: Hop<unknown>; where?: unknown; linkWhere?: unknown }[]; key?: string; where?: unknown }) => {
      // `where`, `[where]` after a hop's table and `[link where]` after its link name each row condition the call carries.
      const narrowed = (condition: unknown, label: string) => (condition === undefined ? "" : `[${label}]`);
      const route = hops ? ` via ${hops.map(({ hop, where: at, linkWhere }) => `${hop.through ? `${(hop.through.table as { name: string }).name}${narrowed(linkWhere, "where")}>` : ""}${(hop.table as { name: string }).name}${narrowed(at, "where")}`).join(".")}` : "";
      calls.push(`rollup ${fn} ${(table as { name: string }).name}.${value} by ${anchor}${route}${describeWhere(where)} [${anchors.join(",")}]`);
      if (anchors.length > 500) throw new Error("this test double takes at most 500 anchors, as the contract says");
      // A joined route: each hop from the rows the one before reached; the last rows once each, by their key.
      const follow = (from: Row[], { hop, where: at, linkWhere }: { hop: Hop<unknown>; where?: unknown; linkWhere?: unknown }) => from.flatMap((row) => {
        if (!hop.through) return rowsOf(hop.table).filter((far) => far[hop.column] != null && far[hop.column] === row[hop.outer] && holds(far, at));
        const exits = rowsOf(hop.through.table).filter((link) => link[hop.through!.entry] === row[hop.outer] && link[hop.through!.exit] != null && holds(link, linkWhere)).map((link) => link[hop.through!.exit]);
        return rowsOf(hop.table).filter((far) => exits.includes(far[hop.column]) && holds(far, at));
      });
      return anchors.flatMap((key) => {
        const start = rowsOf(table).filter((row) => row[anchor] === key && holds(row, where));
        const reached = hops ? [...new Map(hops.reduce(follow, start).map((row) => [row[last!], row])).values()] : start;
        if (reached.length === 0) return [];
        const values = reached.map((row) => row[value]).filter((v): v is number => v != null);
        const total = values.reduce((a, b) => a + b, 0);
        const result = fn === "count" ? values.length : values.length === 0 ? null
          : fn === "sum" ? total : fn === "avg" ? total / values.length : fn === "min" ? Math.min(...values) : Math.max(...values);
        return [{ anchor: key, value: result }];
      });
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
      rankAvg: { kind: "rollup", fn: "avg", of: ["children", "rank"] },
      rankMin: { kind: "rollup", fn: "min", of: ["children", "rank"] },
      ownerRank: { kind: "rollup", fn: "max", of: ["owner", "rank"] },
      parentRank: { kind: "rollup", fn: "min", of: ["parent", "rank"] },
      badgeSum: { kind: "rollup", fn: "sum", of: ["badge", "points"] },
      deep: { kind: "rollup", fn: "count", of: ["children", "children"] },
      family: { kind: "rollup", fn: "count", of: ["children", "parent"] },
      siblingRank: { kind: "rollup", fn: "sum", of: ["parent", "children", "rank"] },
      bossRank: { kind: "rollup", fn: "max", of: ["owner", "boss", "rank"] },
      ownerSize: { kind: "rollup", fn: "sum", of: ["owner", "nodes", "size"] },
      ownerCount: { kind: "rollup", fn: "count", of: ["owner"] },
      badRelation: { kind: "rollup", fn: "count", of: ["nowhere"] },
      looseCount: { kind: "rollup", fn: "count", of: ["loose"] },
    },
  },
  Owner: {
    table: handle("owners"), key: "id",
    relations: {
      boss: { kind: "belongs-to", target: "Boss", column: "bossId", nullable: false },
      nodes: { kind: "has-many", target: "Node", column: "ownerId" },
    },
    computed: {},
  },
  Boss: { table: handle("bosses"), key: "id", relations: {}, computed: {} },
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
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1, ownerId: null }], ["owner"])).rejects.toThrow("belongs-to :owner of Node has no key in ownerId, and it is not nullable");
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1, ownerId: 2 }], ["owner"])).rejects.toThrow("belongs-to :owner of Node points at Owner 2, which does not exist");
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
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 3 }], ["badge"])).rejects.toThrow("has-one :badge of Node found 2 rows for 3");
  });

  test("a has-many with no key back says what to declare", async () => {
    const { tx, handle } = memory({});
    await expect(loadRows(plan(handle), "Node", tx, [{ id: 1 }], ["loose"])).rejects.toThrow("has-many :loose of Node cannot be loaded: Badge has no belongs-to back to Node. Declare one in Badge, and name it with inverse=:name if there are several");
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

    test("a relationship that cannot be loaded says why", async () => {
      const { tx, handle } = memory({});
      const row = [{ id: 1, ownerId: 1 }];
      await expect(loadRows(plan(handle), "Node", tx, row, ["badRelation"])).rejects.toThrow("Node has no relationship nowhere");
      await expect(loadRows(plan(handle), "Node", tx, row, ["looseCount"])).rejects.toThrow("Badge has no belongs-to back to Node");
    });

    // Everything but a count or max over one has-many or has-one: one `rollup` call per 500 anchors (ruling D33, OD3).
    const tree = () => memory({
      nodes: [
        { id: 1, parentId: null, ownerId: 10, rank: 3, size: 1 }, { id: 2, parentId: 1, ownerId: 10, rank: 8, size: 2 },
        { id: 3, parentId: 1, ownerId: 11, rank: 5, size: null }, { id: 4, parentId: 2, ownerId: 12, rank: null, size: 4 },
      ],
      owners: [{ id: 10, rank: 7 }, { id: 11, rank: null }, { id: 12, rank: 2 }],
      badges: [{ id: 70, nodeId: 1, points: 6 }],
    });
    test("sum, avg and min over a has-many are one rollup call for every row", async () => {
      const { tx, calls, handle } = tree();
      const rows = (await tx.select(handle("nodes"))) as Row[];
      calls.length = 0;
      const loaded = await loadRows(plan(handle), "Node", tx, rows, ["sizeSum", "rankAvg", "rankMin", "badgeSum"]);
      expect(loaded.map((r) => [r.id, r.sizeSum, r.rankAvg, r.rankMin, r.badgeSum])).toEqual([[1, 2, 6.5, 5, 6], [2, 4, null, null, null], [3, null, null, null, null], [4, null, null, null, null]]);
      expect(calls).toEqual([
        "rollup sum nodes.size by parentId [1,2,3,4]", "rollup avg nodes.rank by parentId [1,2,3,4]",
        "rollup min nodes.rank by parentId [1,2,3,4]", "rollup sum badges.points by nodeId [1,2,3,4]",
      ]);
    });
    test("over a belongs-to the anchors are the distinct key values: rows that share a target share one anchor", async () => {
      const { tx, calls, handle } = tree();
      const rows = (await tx.select(handle("nodes"))) as Row[];
      calls.length = 0;
      const loaded = await loadRows(plan(handle), "Node", tx, rows, ["ownerRank", "parentRank"]);
      expect(loaded.map((r) => [r.id, r.ownerRank, r.parentRank])).toEqual([[1, 7, null], [2, 7, 3], [3, null, 3], [4, 2, 8]]);
      // Node 1 has no parent: a nullable belongs-to with a null key reaches nothing, with no anchor.
      expect(calls).toEqual(["rollup max owners.rank by id [10,11,12]", "rollup min nodes.rank by id [1,2]"]);
    });
    test("a long list is asked in chunks of 500 anchors", async () => {
      const many = Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, parentId: null, ownerId: 10 }));
      const { tx, calls, handle } = memory({ nodes: many, owners: [{ id: 10, rank: 1 }] });
      const loaded = await loadRows(plan(handle), "Node", tx, many, ["sizeSum"]);
      expect(loaded.every((r) => r.sizeSum === null)).toBe(true);
      expect(calls.map((c) => c.split(" [")[0])).toEqual(["rollup sum nodes.size by parentId", "rollup sum nodes.size by parentId", "rollup sum nodes.size by parentId"]);
      expect(calls.map((c) => c.split(",").length)).toEqual([500, 500, 1]);
    });
    test("min and count use a relationship the same call loaded; sum and avg always ask the database", async () => {
      const { tx, calls, handle } = tree();
      const rows = (await tx.select(handle("nodes"))) as Row[];
      calls.length = 0;
      const loaded = await loadRows(plan(handle), "Node", tx, rows, ["children", "owner", "rankMin", "ownerRank", "rankAvg"]);
      expect(loaded.map((r) => [r.rankMin, r.ownerRank, r.rankAvg])).toEqual([[5, 7, 6.5], [null, 7, null], [null, null, null], [null, 2, null]]);
      expect(calls.filter((c) => c.startsWith("rollup"))).toEqual(["rollup avg nodes.rank by parentId [1,2,3,4]"]);
    });
    test("a required belongs-to with no key is an error, one whose key points at nothing too; a nullable one gives null", async () => {
      const { tx, calls, handle } = tree();
      await expect(loadRows(plan(handle), "Node", tx, [{ id: 5, parentId: null, ownerId: null }], ["ownerRank"])).rejects.toThrow("belongs-to :owner of Node has no key in ownerId, and it is not nullable");
      await expect(loadRows(plan(handle), "Node", tx, [{ id: 5, parentId: null, ownerId: 99 }], ["ownerRank"]))
        .rejects.toThrow("`max :ownerRank of=&owner.rank` on Node 5 reaches no Owner row: a key on its path points at a row that does not exist");
      calls.length = 0;
      const [dangling] = await loadRows(plan(handle), "Node", tx, [{ id: 5, parentId: 99, ownerId: 10 }], ["parentRank"]);
      expect(dangling!.parentRank).toBeNull();
      expect(calls).toEqual(["rollup min nodes.rank by id [99]"]);
    });
    test("a create's new instance with no key yet gives null and asks nothing", async () => {
      const { tx, calls, handle } = tree();
      const record: Row = { id: null, parentId: null, ownerId: null };
      await loadInto(plan(handle), "Node", tx, record, ["ownerRank", "sizeSum"], { newInstance: true });
      expect([record.ownerRank, record.sizeSum]).toEqual([null, null]);
      expect(calls).toEqual([]);
    });

    // A path through several relationships is one `rollup` call with hops per 500 anchors; each row the path reaches
    // counts once per owner row (ruling D33, OD1).
    describe("over a joined route", () => {
      const joined = () => memory({
        nodes: [
          { id: 1, parentId: null, ownerId: 10, rank: 3, size: 1 }, { id: 2, parentId: 1, ownerId: 10, rank: 8, size: 2 },
          { id: 3, parentId: 1, ownerId: 11, rank: 5, size: null }, { id: 4, parentId: 2, ownerId: 12, rank: null, size: 4 },
        ],
        owners: [{ id: 10, bossId: 20 }, { id: 11, bossId: 21 }, { id: 12, bossId: 99 }, { id: 13, bossId: 20 }],
        bosses: [{ id: 20, rank: 9 }, { id: 21, rank: null }],
      });
      const stored = async (tx: DataOperations, handle: (name: string) => never) => (await tx.select(handle("nodes"))) as Row[];
      test("two has-many hops from the entity's own table, and converging paths counted once", async () => {
        const { tx, calls, handle } = joined();
        const rows = await stored(tx, handle);
        calls.length = 0;
        const loaded = await loadRows(plan(handle), "Node", tx, rows, ["deep", "family"]);
        expect(loaded.map((r) => [r.id, r.deep, r.family])).toEqual([[1, 1, 1], [2, 0, 1], [3, 0, 0], [4, 0, 0]]);
        expect(calls).toEqual(["rollup count nodes.id by id via nodes.nodes [1,2,3,4]", "rollup count nodes.id by id via nodes.nodes [1,2,3,4]"]);
      });
      test("a path that starts at a belongs-to is anchored on its key, from the target's table; a null nullable key asks nothing", async () => {
        const { tx, calls, handle } = joined();
        const rows = await stored(tx, handle);
        calls.length = 0;
        const loaded = await loadRows(plan(handle), "Node", tx, rows, ["siblingRank", "ownerSize"]);
        // Node 1 has no parent; 2 and 3 share parent 1 (ranks 8 and 5); 4's parent 2 has one child, with no rank.
        expect(loaded.map((r) => [r.id, r.siblingRank, r.ownerSize])).toEqual([[1, null, 3], [2, 13, 3], [3, 13, null], [4, null, 4]]);
        expect(calls).toEqual(["rollup sum nodes.rank by id via nodes [1,2]", "rollup sum owners.size by id via nodes [10,11,12]"]);
      });
      test("a relationship already loaded on the row is not used: a joined route always asks", async () => {
        const { tx, calls, handle } = joined();
        const rows = await stored(tx, handle);
        calls.length = 0;
        const loaded = await loadRows(plan(handle), "Node", tx, rows, ["children", "deep"]);
        expect(loaded.map((r) => r.deep)).toEqual([1, 0, 0, 0]);
        expect(calls.filter((call) => call.startsWith("rollup"))).toEqual(["rollup count nodes.id by id via nodes.nodes [1,2,3,4]"]);
      });
      test("over required belongs-to only, a key that points at nothing on the path is an error, as its load is; a null value is null", async () => {
        const { tx, calls, handle } = joined();
        const rows = await stored(tx, handle);
        calls.length = 0;
        const loaded = await loadRows(plan(handle), "Node", tx, rows.slice(0, 3), ["bossRank"]);
        expect(loaded.map((r) => r.bossRank)).toEqual([9, 9, null]);
        expect(calls).toEqual(["rollup max owners.rank by id via bosses [10,11]"]);
        const missing = "reaches no Boss row: a key on its path points at a row that does not exist";
        // Owner 12's boss 99 is missing; owner 14 is missing itself.
        await expect(loadRows(plan(handle), "Node", tx, rows, ["bossRank"])).rejects.toThrow(`\`max :bossRank of=&owner.boss.rank\` on Node 4 ${missing}`);
        await expect(loadRows(plan(handle), "Node", tx, [{ id: 5, parentId: null, ownerId: 14 }], ["bossRank"])).rejects.toThrow(`on Node 5 ${missing}`);
        await expect(loadRows(plan(handle), "Node", tx, [{ id: 5, parentId: null, ownerId: null }], ["bossRank"])).rejects.toThrow("belongs-to :owner of Node has no key in ownerId, and it is not nullable");
        // Through a has-many on the way, a dangling key reaches nothing (ruling D33, OD5).
        expect((await loadRows(plan(handle), "Node", tx, [{ id: 5, parentId: null, ownerId: 14 }], ["ownerSize"]))[0]!.ownerSize).toBeNull();
      });
      test("a create's new instance with no key yet asks nothing; one whose belongs-to key is filled is asked from the target", async () => {
        const { tx, calls, handle } = joined();
        const record: Row = { id: null, parentId: null, ownerId: null };
        await loadInto(plan(handle), "Node", tx, record, ["bossRank", "deep", "siblingRank"], { newInstance: true });
        expect([record.bossRank, record.deep, record.siblingRank]).toEqual([null, 0, null]);
        expect(calls).toEqual([]);
        const filled: Row = { id: null, parentId: null, ownerId: 10 };
        await loadInto(plan(handle), "Node", tx, filled, ["bossRank"], { newInstance: true });
        expect(filled.bossRank).toBe(9);
      });
      test("a caller must be admitted by every entity the path reaches; one denied makes no query", async () => {
        const allow = (yes: boolean): PolicySpec => ({ name: "p", when: null, checks: [{ kind: "authorize-if", check: "() => x", record: false, run: (() => yes) as never }] });
        for (const [owner, node, boss] of [[true, true, true], [false, true, true], [true, false, true], [true, true, false]] as const) {
          const { tx, calls, handle } = joined();
          const base = plan(handle);
          const policed = { ...base, Owner: { ...base.Owner!, reads: [allow(owner)] }, Node: { ...base.Node!, reads: [allow(node)] }, Boss: { ...base.Boss!, reads: [allow(boss)] } } as LoadPlan;
          const rows = [{ id: 1, parentId: null, ownerId: 10 }];
          const loaded = await loadRows(policed, "Node", tx, rows, ["ownerSize", "bossRank"], { policies: true });
          expect([owner, node, boss, loaded[0]!.ownerSize, loaded[0]!.bossRank]).toEqual([owner, node, boss, owner && node ? 3 : null, owner && boss ? 9 : null]);
          expect(calls.length).toBe((owner && node ? 1 : 0) + (owner && boss ? 1 : 0));
        }
      });
    });
  });
});

// a field may be named like a member of Object.prototype, which every row inherits; a row holds a loaded field
// as its own member, so an inherited one is never taken for it.
describe("a relationship and computed fields named like members of Object.prototype", () => {
  // TypeScript reads `row.toString` as Object's member and gives a `constructor:` key of a literal no contextual type, so
  // the test names the fields through a variable and spells the kinds `as const`.
  const field = (row: unknown, name: string) => (row as Row)[name];
  const oddPlan = (handle: (name: string) => never): LoadPlan => ({
    Odd: {
      table: handle("odds"), key: "id",
      relations: {
        constructor: { kind: "belongs-to" as const, target: "Odd", column: "constructorId", nullable: true },
        valueOf: { kind: "has-many" as const, target: "Odd", column: "constructorId" },
      },
      computed: {
        toString: { kind: "body", needs: ["constructor"], evaluate: (s: { self: unknown }) => { const parent = field(s.self, "constructor") as Row | null; return parent ? `to ${parent.id}` : "none"; } } as never,
        hasOwnProperty: { kind: "rollup" as const, fn: "count" as const, of: ["valueOf"] },
        // Each reads what it cannot: a path on through a computed field, and a name the entity does not have.
        through: { kind: "body", needs: ["toString", "toString.id"], evaluate: () => null } as never,
        astray: { kind: "body", needs: ["isPrototypeOf"], evaluate: () => null } as never,
      },
    },
  });

  test("are loaded, not taken for the inherited members", async () => {
    const { tx, handle } = memory({ odds: [{ id: 1, constructorId: null }, { id: 2, constructorId: 1 }] });
    const rows = (await tx.select(handle("odds"))) as Row[];
    const loaded = await loadRows(oddPlan(handle), "Odd", tx, rows, ["constructor", "toString", "valueOf", "hasOwnProperty"]);
    expect(loaded.map((row) => [(field(row, "constructor") as Row | null)?.id ?? null, field(row, "toString"), (field(row, "valueOf") as Row[]).map((r) => r.id), field(row, "hasOwnProperty")]))
      .toEqual([[null, "none", [2], 1], [1, "to 1", [], 0]]);
  });

  test("a rollup over one that the call did not load counts its rows, not the inherited member", async () => {
    const { tx, handle, calls } = memory({ odds: [{ id: 1, constructorId: null }, { id: 2, constructorId: 1 }] });
    const rows = (await tx.select(handle("odds"))) as Row[];
    const loaded = await loadRows(oddPlan(handle), "Odd", tx, rows, ["hasOwnProperty"]);
    // `valueOf` is not on the rows, so the count is asked of the data layer: never worked out from Object's `valueOf`.
    expect(loaded.map((row) => field(row, "hasOwnProperty"))).toEqual([1, 0]);
    expect(calls.filter((call) => call.startsWith("count"))).toEqual(["count odds.id", "count odds.id"]);
  });

  test("a path on through a computed field named like one is refused; a name the entity lacks is unknown", async () => {
    const { tx, handle } = memory({ odds: [{ id: 1, constructorId: null }] });
    const rows = (await tx.select(handle("odds"))) as Row[];
    // `relations.toString` is Object's method, never a relationship: nothing is loaded through the computed field.
    await expect(loadRows(oddPlan(handle), "Odd", tx, rows, ["through"])).rejects.toThrow("Odd#toString is a computed field, and nothing can be loaded through it (toString.id)");
    // `computed.isPrototypeOf` is Object's method, never a computed field.
    await expect(loadRows(oddPlan(handle), "Odd", tx, rows, ["astray"])).rejects.toThrow('Odd has no relationship or computed field "isPrototypeOf" to load');
  });

  test("a guard throws for them when they are not loaded, and leaves every other inherited member alone", () => {
    const { handle } = memory({});
    const guard = guarded(oddPlan(handle), "Odd", { id: 1, constructorId: null }, "action function") as Record<string, unknown>;
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(() => guard[name]).toThrow(`A plain action function read Odd#${name}, which was not loaded`);
      expect(() => name in guard).toThrow(FrameworkError);
    }
    expect(guard.isPrototypeOf).toBe(Object.prototype.isPrototypeOf);
    expect(guard.missing).toBeUndefined();
  });
});

// What the message tells the author to do must work in the plain body it is about: Mesh loads what such a body reads as
// `&name` with the chain written right after it, and follows neither `self.name` nor a read through a variable.
describe("the message of a guard for a field that was not loaded", () => {
  const message = (read: () => unknown) => {
    try { read(); } catch (error) { return (error as Error).message; }
    return undefined;
  };
  const told = (what: string, entity: string, name: string) =>
    `A plain ${what} read ${entity}#${name}, which was not loaded: Mesh could not tell from the body that it reads it. Read it as \`&${name}\` in the same body (a related record's as the whole chain, \`&relationship.${name}\`) so Mesh loads what it reads: \`self.${name}\` and a read through a variable are not followed`;

  test("says to read the member as `&name` in the same body, and never to rewrite the body as one expression", () => {
    const { handle } = memory({});
    const own = guarded(plan(handle), "Node", { id: 1, parentId: null, ownerId: 7 }) as { children: unknown; depth: unknown };
    // A relationship, a computed field, and `in` on either: one message.
    expect(message(() => own.children)).toBe(told("computed body", "Node", "children"));
    expect(message(() => own.depth)).toBe(told("computed body", "Node", "depth"));
    expect(message(() => "children" in own)).toBe(told("computed body", "Node", "children"));
    expect(message(() => own.children)).not.toContain("one expression");
  });

  test("names the kind of plain code and, for a related row, the related entity's member", () => {
    const { handle } = memory({});
    const child = guarded(plan(handle), "Node", { id: 2, parentId: 1, ownerId: 7, parent: { id: 1, parentId: null, ownerId: 7 }, owner: { id: 7 } }, "action function") as { parent: { children: unknown; id: unknown }; owner: { badge: unknown } };
    expect(child.parent.id).toBe(1);
    expect(message(() => child.parent.children)).toBe(told("action function", "Node", "children"));
    // Owner has no relationship or computed field, so nothing on it is guarded.
    expect(child.owner.badge).toBeUndefined();
  });

  test("`before` keeps its own message", () => {
    const { handle } = memory({});
    const before = guarded(plan(handle), "Node", { id: 1, parentId: null, ownerId: 7 }, "before") as { children: unknown };
    expect(message(() => before.children)).toStartWith("`before` holds the stored columns of Node only, so Node#children is not on it");
    expect(message(() => before.children)).not.toContain("so Mesh loads what it reads");
  });
});

describe("what a caller loads runs the read policies of the entity it reaches", () => {
  /** A read policy that admits a caller whose actor id is `admin`. */
  const adminOnly: PolicySpec = { name: "admins", when: null, checks: [{ kind: "authorize-if", check: "({ actor }) => actor.id === \"admin\"", record: false,
    run: ((s: { actor: { id?: string } }) => s.actor?.id === "admin") as never }] };
  const open: PolicySpec = { name: "anyone", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: (() => true) as never }] };
  const guarded = (handle: (name: string) => never) => {
    const base = plan(handle);
    return { ...base, Node: { ...base.Node!, reads: [open] }, Owner: { ...base.Owner!, reads: [adminOnly] }, Badge: { ...base.Badge! } } as LoadPlan;
  };
  const data = () => memory({
    nodes: [{ id: 1, parentId: null, ownerId: 10 }, { id: 2, parentId: 1, ownerId: 10, rank: 5 }],
    owners: [{ id: 10 }],
    badges: [{ id: 7, nodeId: 1 }],
  });

  test("not admitted: a belongs-to or has-one is null, a has-many []; what they admit is loaded; tx (no `policies`) sees everything", async () => {
    const { tx, handle } = data();
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const guest = await loadRows(guarded(handle), "Node", tx, rows, ["owner", "children", "badge"], { actor: { id: "guest" }, policies: true });
    // Owner admits only the admin; Badge declares no read policy, so no one; Node admits anyone.
    expect(guest.map((row) => [row.owner, row.badge])).toEqual([[null, null], [null, null]]);
    expect((guest[0]!.children as Row[]).map((row) => row.id)).toEqual([2]);
    const admin = await loadRows(guarded(handle), "Node", tx, rows, ["owner"], { actor: { id: "admin" }, policies: true });
    expect(admin[0]!.owner).toEqual({ id: 10 });
    const unfiltered = await loadRows(guarded(handle), "Node", tx, rows, ["owner", "badge"], { actor: { id: "guest" } });
    expect(unfiltered[0]).toMatchObject({ owner: { id: 10 }, badge: { id: 7, nodeId: 1 } });
  });

  test("a rollup over an entity the caller may not read counts no row; a computed field's body still reads every related row", async () => {
    const { tx, handle } = data();
    const withChildren = guarded(handle);
    const closed = { ...withChildren, Node: { ...withChildren.Node!, reads: [adminOnly] } } as LoadPlan;
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const guest = await loadRows(closed, "Node", tx, rows, ["kids", "maxRank", "childCount", "children"], { actor: { id: "guest" }, policies: true });
    expect(guest[0]).toMatchObject({ kids: 0, maxRank: null, childCount: 1, children: [] });
    // Two rows never share one emptied list.
    expect(guest[0]!.children).not.toBe(guest[1]!.children);
    const admin = await loadRows(closed, "Node", tx, rows, ["kids", "maxRank"], { actor: { id: "admin" }, policies: true });
    expect(admin[0]).toMatchObject({ kids: 1, maxRank: 5 });
  });

  test("the policies are decided before loading: a denied name is not queried, unless a computed body the caller named reads it", async () => {
    const { tx, calls, handle } = data();
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const closed = { ...guarded(handle), Node: { ...guarded(handle).Node!, reads: [adminOnly] } } as LoadPlan;
    calls.length = 0;
    const guest = await loadRows(closed, "Node", tx, rows, ["owner", "badge", "children", "kids", "maxRank"], { actor: { id: "guest" }, policies: true });
    expect(guest[0]).toMatchObject({ owner: null, badge: null, children: [], kids: 0, maxRank: null });
    expect(calls).toEqual([]);
    // `childCount` reads `children` for itself: the children are selected once, for the body, and still taken off.
    const counted = await loadRows(closed, "Node", tx, rows, ["childCount", "children"], { actor: { id: "guest" }, policies: true });
    expect(calls).toEqual(["select nodes"]);
    expect(counted[0]).toMatchObject({ childCount: 1, children: [] });
    // Admitted, each is queried as before.
    calls.length = 0;
    await loadRows(closed, "Node", tx, rows, ["owner", "kids"], { actor: { id: "admin" }, policies: true });
    expect(calls).toEqual(["select owners", "count nodes.id", "count nodes.id"]);
  });

  test("a required belongs-to pointing at a row that is gone gives a denied caller null, not the error an admitted one gets", async () => {
    const { tx, handle } = memory({ nodes: [{ id: 1, parentId: null, ownerId: 99 }], owners: [], badges: [] });
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const guest = await loadRows(guarded(handle), "Node", tx, rows, ["owner"], { actor: { id: "guest" }, policies: true });
    expect(guest[0]!.owner).toBeNull();
    await expect(loadRows(guarded(handle), "Node", tx, rows, ["owner"], { actor: { id: "admin" }, policies: true }))
      .rejects.toThrow("belongs-to :owner of Node points at Owner 99, which does not exist");
    // A load that cannot be served is an error for every caller: a denied one is told so too, with no query.
    const unserved = await loadRows(guarded(handle), "Node", tx, rows, ["looseCount"], { actor: { id: "guest" }, policies: true }).catch((error: unknown) => error);
    expect(unserved).toBeInstanceOf(FrameworkError);
    await expect(loadRows(guarded(handle), "Node", tx, rows, ["loose"], { actor: { id: "guest" }, policies: true })).rejects.toThrow(/has no belongs-to back/);
  });

});

describe("a batched rollup under the read policies of what it reaches", () => {
  const adminOnly: PolicySpec = { name: "admins", when: null, checks: [{ kind: "authorize-if", check: "({ actor }) => actor.id === \"admin\"", record: false,
    run: ((s: { actor: { id?: string } }) => s.actor?.id === "admin") as never }] };
  const open: PolicySpec = { name: "anyone", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: (() => true) as never }] };
  const byRecord: PolicySpec = { name: "mine", when: null, checks: [{ kind: "authorize-if", check: "({ actor }) => &by === actor.id", record: true,
    run: (() => { throw new Error("folded, never run in memory"); }) as never,
    sql: () => ({ what: "policy :mine authorize-if", entity: "Any", tree: { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "by", class: "string" }, { kind: "param", index: 0, class: "string" }] }, params: (sc: { actor?: { id?: unknown } }) => [sc.actor?.id] }) as never }] };
  const data = () => memory({ nodes: [{ id: 1, parentId: null, ownerId: 10, size: 3 }, { id: 2, parentId: 1, ownerId: 10, size: 4 }], owners: [{ id: 10, rank: 7 }] });
  const policed = (handle: (name: string) => never, owner: PolicySpec, node: PolicySpec = open) => {
    const base = plan(handle);
    return { ...base, Node: { ...base.Node!, reads: [node] }, Owner: { ...base.Owner!, reads: [owner] } } as LoadPlan;
  };
  test("a caller the target denies gets null and nothing is asked; through privileged (no policies) the value", async () => {
    const { tx, calls, handle } = data();
    const rows = [{ id: 2, parentId: 1, ownerId: 10 }];
    expect((await loadRows(policed(handle, adminOnly), "Node", tx, rows, ["ownerRank"], { actor: { id: "guest" }, policies: true }))[0]!.ownerRank).toBeNull();
    expect(calls).toEqual([]);
    expect((await loadRows(policed(handle, adminOnly), "Node", tx, rows, ["ownerRank"], { actor: { id: "admin" }, policies: true }))[0]!.ownerRank).toBe(7);
    expect((await loadRows(policed(handle, adminOnly), "Node", tx, rows, ["ownerRank"]))[0]!.ownerRank).toBe(7);
  });
  test("a target whose read policy reads the record narrows the batched rollup; a privileged load is not narrowed", async () => {
    const { tx, calls, handle } = memory({ nodes: [{ id: 1, parentId: null, ownerId: 10, by: "a" }, { id: 2, parentId: 1, ownerId: 10, by: "b", size: 4 }, { id: 3, parentId: 1, ownerId: 10, by: "a", size: 6 }], owners: [{ id: 10, rank: 7, by: "a" }] });
    const rows = [{ id: 1, parentId: null, ownerId: 10 }];
    expect((await loadRows(policed(handle, byRecord, byRecord), "Node", tx, rows, ["ownerRank", "sizeSum"], { actor: { id: "a" }, policies: true }))[0]).toMatchObject({ ownerRank: 7, sizeSum: 6 });
    expect(calls).toEqual(["rollup max owners.rank by id where [10]", "rollup sum nodes.size by parentId where [1]"]);
    expect((await loadRows(policed(handle, byRecord, byRecord), "Node", tx, rows, ["ownerRank", "sizeSum"], { actor: { id: "b" }, policies: true }))[0]).toMatchObject({ ownerRank: null, sizeSum: 4 });
    // Through privileged no policy runs, so nothing restricts it.
    expect((await loadRows(policed(handle, open, byRecord), "Node", tx, rows, ["sizeSum"]))[0]!.sizeSum).toBe(10);
  });
});

describe("a read policy that reads the record admits a caller's load row by row", () => {
  /** A check that reads the record: `&<column> === actor.id`, folded into the query of the rows it reaches. */
  const mine = (column: string, name = "mine"): PolicySpec => {
    const literal: ConditionLiteral<{ actor?: { id?: unknown } }> = {
      what: `policy :${name} authorize-if`, entity: "Any",
      tree: { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: column, class: "string" }, { kind: "param", index: 0, class: "string" }] },
      params: (s) => [s.actor?.id],
    };
    return { name, when: null, checks: [{ kind: "authorize-if", check: `({ actor }) => &${column} === actor.id`, record: true,
      run: (() => { throw new Error("a record check is folded, never run in memory"); }) as never, sql: () => literal as never }] };
  };
  const open: PolicySpec = { name: "anyone", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: (() => true) as never }] };
  const owned = (handle: (name: string) => never) => {
    const base = plan(handle);
    return { ...base, Node: { ...base.Node!, reads: [mine("by")] }, Owner: { ...base.Owner!, reads: [mine("by")] }, Badge: { ...base.Badge!, reads: [mine("by")] } } as LoadPlan;
  };
  const data = () => memory({
    nodes: [{ id: 1, parentId: null, ownerId: 10, by: "a" }, { id: 2, parentId: 1, ownerId: 11, by: "a", rank: 5 }, { id: 3, parentId: 1, ownerId: 10, by: "b", rank: 9 }],
    owners: [{ id: 10, by: "a" }, { id: 11, by: "b" }],
    badges: [{ id: 7, nodeId: 1, by: "b" }, { id: 8, nodeId: 2, by: "a" }],
  });

  test("a has-many lists the admitted rows, a belongs-to or has-one not admitted is null, a rollup counts admitted rows", async () => {
    const { tx, calls, handle } = data();
    const rows = (await tx.select(handle("nodes"))) as Row[];
    calls.length = 0;
    const a = await loadRows(owned(handle), "Node", tx, rows, ["children", "owner", "badge", "kids", "maxRank"], { actor: { id: "a" }, policies: true });
    expect(a.map((row) => [(row.children as Row[]).map((c) => c.id), (row.owner as Row | null)?.id ?? null, (row.badge as Row | null)?.id ?? null, row.kids, row.maxRank]))
      .toEqual([[[2], 10, null, 1, 5], [[], null, 8, 0, null], [[], 10, null, 0, null]]);
    // Each query carries the condition; the rollups are queried, not worked out from the loaded children.
    expect(calls.filter((call) => call.startsWith("count") || call.startsWith("max"))).toEqual([
      "count nodes.id where", "count nodes.id where", "count nodes.id where", "max nodes.rank where", "max nodes.rank where", "max nodes.rank where"]);
    // Owner 11 exists (it is excluded, so null, never the dangling-key error), looked up once more by key.
    expect(calls).toContain("select owners where");
    expect(calls.filter((call) => call === "select owners")).toHaveLength(1);
    // With no actor the condition is unknown on every row: nothing is admitted, and nothing is an error.
    const nobody = await loadRows(owned(handle), "Node", tx, rows, ["children", "owner", "kids"], { policies: true });
    expect(nobody.map((row) => [row.children, row.owner, row.kids])).toEqual([[[], null, 0], [[], null, 0], [[], null, 0]]);
    // A privileged load (no `policies`) still sees every row.
    const all = await loadRows(owned(handle), "Node", tx, rows, ["children", "owner"]);
    expect((all[0]!.children as Row[]).map((c) => c.id)).toEqual([2, 3]);
  });

  test("a belongs-to key that names no row is still the error, for an admitted and an excluded caller alike", async () => {
    const { tx, handle } = memory({ nodes: [{ id: 1, parentId: null, ownerId: 99, by: "a" }], owners: [], badges: [] });
    const rows = (await tx.select(handle("nodes"))) as Row[];
    for (const actor of [{ id: "a" }, { id: "z" }])
      await expect(loadRows(owned(handle), "Node", tx, rows, ["owner"], { actor, policies: true }))
        .rejects.toThrow("belongs-to :owner of Node points at Owner 99, which does not exist");
  });

  test("a relationship a computed body the caller named reads is loaded whole for the body, and narrowed for the caller", async () => {
    const { tx, handle } = data();
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const a = await loadRows(owned(handle), "Node", tx, rows, ["childCount", "children", "kids"], { actor: { id: "a" }, policies: true });
    // The body counts every child (it is the entity's own rule); the caller's list and rollup hold only the admitted one.
    expect(a[0]).toMatchObject({ childCount: 2, kids: 1 });
    expect((a[0]!.children as Row[]).map((c) => c.id)).toEqual([2]);
    // Narrowed in order, and the rows are the loaded ones.
    const b = await loadRows(owned(handle), "Node", tx, rows, ["children", "childCount"], { actor: { id: "b" }, policies: true });
    expect((b[0]!.children as Row[]).map((c) => c.id)).toEqual([3]);
    expect(b[0]!.childCount).toBe(2);
  });

  test("a belongs-to or has-one a computed body reads is loaded for the body, and null for the caller where it is not admitted", async () => {
    const { tx, handle } = data();
    const base = owned(handle);
    const id = (value: unknown) => (value as Row | null)?.id ?? null;
    const withBodies = { ...base, Node: { ...base.Node!, computed: { ...base.Node!.computed,
      ownerId: { kind: "body", needs: ["owner"], evaluate: (s: { self: { owner: Row | null } }) => id(s.self.owner) } as never,
      badgeId: { kind: "body", needs: ["badge"], evaluate: (s: { self: { badge: Row | null } }) => id(s.self.badge) } as never,
    } } } as LoadPlan;
    const rows = (await tx.select(handle("nodes"))) as Row[];
    const a = await loadRows(withBodies, "Node", tx, rows, ["owner", "ownerId", "badge", "badgeId"], { actor: { id: "a" }, policies: true });
    // Owner 11 and badge 7 are `by: "b"`: the bodies see them, the caller does not.
    expect(a.map((row) => [id(row.owner), row.ownerId, id(row.badge), row.badgeId])).toEqual([[10, 10, null, 7], [null, 11, 8, 8], [10, 10, null, null]]);
  });

  test("a policy that reads the record beside one that denies the caller outright queries nothing", async () => {
    const { tx, calls, handle } = data();
    const base = owned(handle);
    const closed = { ...base, Owner: { ...base.Owner!, reads: [mine("by"), { name: "never", when: null, checks: [{ kind: "authorize-if", check: "() => false", record: false, run: (() => false) as never }] }] } } as LoadPlan;
    const rows = (await tx.select(handle("nodes"))) as Row[];
    calls.length = 0;
    const a = await loadRows(closed, "Node", tx, rows, ["owner"], { actor: { id: "a" }, policies: true });
    expect(a.map((row) => row.owner)).toEqual([null, null, null]);
    expect(calls).toEqual([]);
    // And one that admits everyone needs no condition.
    const free = { ...base, Owner: { ...base.Owner!, reads: [open] } } as LoadPlan;
    calls.length = 0;
    await loadRows(free, "Node", tx, rows, ["owner"], { actor: { id: "a" }, policies: true });
    expect(calls).toEqual(["select owners"]);
  });

  test("a condition goes only to a layer that declares conditions: another is refused before any query", async () => {
    const { tx, calls, handle } = data();
    const rows = (await tx.select(handle("nodes"))) as Row[];
    calls.length = 0;
    for (const layer of [{}, { capabilities: { adapter: "plain", capabilities: [] } }])
      await expect(loadRows(owned(handle), "Node", tx, rows, ["owner"], { actor: { id: "a" }, policies: true, layer }))
        .rejects.toThrow(/does not declare the conditions capability/);
    expect(calls).toEqual([]);
    // A layer that declares it is handed the condition; a policy with no condition needs none.
    const sql = { capabilities: { adapter: "sql", capabilities: ["conditions"] } };
    const a = await loadRows(owned(handle), "Node", tx, rows, ["owner"], { actor: { id: "a" }, policies: true, layer: sql });
    expect(a.map((row) => (row.owner as Row | null)?.id ?? null)).toEqual([10, null, 10]);
    const base = owned(handle);
    const free = { ...base, Owner: { ...base.Owner!, reads: [open] } } as LoadPlan;
    await loadRows(free, "Node", tx, rows, ["owner"], { actor: { id: "a" }, policies: true, layer: {} });
  });

  test("a batched rollup over a joined route carries each entity's condition: the start, every hop", async () => {
    const { tx, calls, handle } = memory({
      nodes: [{ id: 1, parentId: null, ownerId: 10, by: "a", size: 1 }, { id: 2, parentId: 1, ownerId: 11, by: "a", rank: 5, size: 4 }, { id: 3, parentId: 1, ownerId: 10, by: "b", rank: 9, size: 6 }],
      owners: [{ id: 10, by: "a" }, { id: 11, by: "b" }],
    });
    const rows = (await tx.select(handle("nodes"))) as Row[];
    calls.length = 0;
    const a = await loadRows(owned(handle), "Node", tx, rows, ["siblingRank", "ownerSize", "deep"], { actor: { id: "a" }, policies: true });
    // siblingRank starts at the parent (a belongs-to) and goes to its children; ownerSize at the owner and goes to its nodes.
    expect(a.map((row) => [row.siblingRank, row.ownerSize, row.deep])).toEqual([[null, 1, 0], [5, null, 0], [5, 1, 0]]);
    expect(calls).toEqual([
      "rollup sum nodes.rank by id via nodes[where] where [1]",
      "rollup sum owners.size by id via nodes[where] where [10,11]",
      "rollup count nodes.id by id via nodes[where].nodes[where] [1,2,3]",
    ]);
    // Node 1 is a's: for b the route's start is not admitted, so the siblings are never reached; owner 11 is b's, and its
    // only node is a's.
    const b = await loadRows(owned(handle), "Node", tx, rows, ["siblingRank", "ownerSize"], { actor: { id: "b" }, policies: true });
    expect(b.map((row) => [row.siblingRank, row.ownerSize])).toEqual([[null, null], [null, null], [null, null]]);
  });

  test("a rollup admitted row by row never counts the related rows a computed body loaded for itself", async () => {
    const { tx, calls, handle } = memory({ nodes: [{ id: 1, parentId: null, ownerId: 10, by: "a" }, { id: 2, parentId: 1, ownerId: 10, by: "a", rank: 5 }, { id: 3, parentId: 1, ownerId: 10, by: "b", rank: 9 }], owners: [{ id: 10, by: "a" }] });
    const rows = [{ id: 1, parentId: null, ownerId: 10 }];
    // childCount loads every child for its body; the caller's min and count are queried with the condition instead.
    const b = await loadRows(owned(handle), "Node", tx, rows, ["childCount", "rankMin", "kids"], { actor: { id: "b" }, policies: true });
    expect(b[0]).toMatchObject({ childCount: 2, rankMin: 9, kids: 1 });
    expect(calls).toContain("rollup min nodes.rank by parentId where [1]");
    // With no row condition the loaded children answer the min, with no query of its own.
    const base = owned(handle);
    const free = { ...base, Node: { ...base.Node!, reads: [open] } } as LoadPlan;
    calls.length = 0;
    expect((await loadRows(free, "Node", tx, rows, ["childCount", "rankMin"], { actor: { id: "b" }, policies: true }))[0]).toMatchObject({ childCount: 2, rankMin: 5 });
    expect(calls.filter((call) => call.startsWith("rollup"))).toEqual([]);
  });

  test("on a route of required belongs-to a row the condition excludes is null, and a key that names no row is still the error", async () => {
    const { tx, calls, handle } = memory({ nodes: [], owners: [{ id: 10, by: "b", rank: 7 }] });
    const rows = [{ id: 1, parentId: null, ownerId: 10 }, { id: 2, parentId: null, ownerId: 99 }];
    await expect(loadRows(owned(handle), "Node", tx, rows, ["ownerRank"], { actor: { id: "a" }, policies: true }))
      .rejects.toThrow("`max :ownerRank of=&owner.rank` on Node 2 reaches no Owner row: a key on its path points at a row that does not exist");
    // The excluded anchors are asked once more with no condition, to tell an excluded row from a dangling key.
    expect(calls).toEqual(["rollup max owners.rank by id where [10,99]", "rollup max owners.rank by id [10,99]"]);
    expect((await loadRows(owned(handle), "Node", tx, rows.slice(0, 1), ["ownerRank"], { actor: { id: "a" }, policies: true }))[0]!.ownerRank).toBeNull();
    expect((await loadRows(owned(handle), "Node", tx, rows.slice(0, 1), ["ownerRank"], { actor: { id: "b" }, policies: true }))[0]!.ownerRank).toBe(7);
    // A count over an excluded required belongs-to is 0, as over no row at all, never null.
    expect((await loadRows(owned(handle), "Node", tx, rows.slice(0, 1), ["ownerRank", "ownerCount"], { actor: { id: "a" }, policies: true }))[0])
      .toMatchObject({ ownerRank: null, ownerCount: 0 });
  });

  test("on a joined route of required belongs-to a row the condition hides partway is null, and a dangling key on a hop is still the error", async () => {
    const { tx, calls, handle } = memory({
      nodes: [],
      owners: [{ id: 10, by: "a", bossId: 100 }, { id: 11, by: "b", bossId: 101 }, { id: 12, by: "a", bossId: 999 }, { id: 13, by: "a", bossId: 102 }],
      bosses: [{ id: 100, by: "a", rank: 3 }, { id: 101, by: "a", rank: 4 }, { id: 102, by: "b", rank: 5 }],
    });
    const base = owned(handle);
    const policed = { ...base, Boss: { ...base.Boss!, reads: [mine("by")] } } as LoadPlan;
    // Node 1 reaches its owner and boss; node 2's owner is b's; node 3's owner is a's, its boss b's: both hidden, so null.
    const rows = [{ id: 1, parentId: null, ownerId: 10 }, { id: 2, parentId: null, ownerId: 11 }, { id: 3, parentId: null, ownerId: 13 }];
    const a = await loadRows(policed, "Node", tx, rows, ["bossRank"], { actor: { id: "a" }, policies: true });
    expect(a.map((row) => row.bossRank)).toEqual([3, null, null]);
    // The excluded anchors are asked once more with no condition at the start nor on any hop.
    expect(calls).toEqual(["rollup max owners.rank by id via bosses[where] where [10,11,13]", "rollup max owners.rank by id via bosses [11,13]"]);
    // Owner 12 is a's, and its boss 999 does not exist: the error, as a privileged load gives it.
    await expect(loadRows(policed, "Node", tx, [{ id: 4, parentId: null, ownerId: 12 }], ["bossRank"], { actor: { id: "a" }, policies: true }))
      .rejects.toThrow("`max :bossRank of=&owner.boss.rank` on Node 4 reaches no Boss row: a key on its path points at a row that does not exist");
  });

  test("a check that reads the record with no condition to fold is a framework error", async () => {
    const { tx, handle } = data();
    const base = plan(handle);
    const bare: PolicySpec = { name: "bare", when: null, checks: [{ kind: "authorize-if", check: "() => &by", record: true, run: (() => true) as never }] };
    const rows = (await tx.select(handle("nodes"))) as Row[];
    await expect(loadRows({ ...base, Owner: { ...base.Owner!, reads: [bare] } }, "Node", tx, rows, ["owner"], { actor: { id: "a" }, policies: true }))
      .rejects.toThrow(/policy :bare reads the record, and its check carries no condition to fold into the query/);
  });
});

describe("a rollup with a filter", () => {
  /** `filter=(child) => child.state === :open`, as the build lowers it: a column of the last table compared with a value. */
  const stateIs = (state: string): ConditionLiteral<never> => ({
    what: "the filter of count :openKids of Node", entity: "Node",
    tree: { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "state", class: "string" }, { kind: "value", value: state, class: "string" }] },
    params: () => [],
  });
  /** `filter=(child) => child.dueOn < %.now`: the instant is a parameter, computed with the load's clock. */
  const overdue: ConditionLiteral<never> = {
    what: "the filter of count :lateKids of Node", entity: "Node",
    tree: { kind: "call", fn: "lt", args: [{ kind: "column", depth: 0, name: "dueOn", class: "date" }, { kind: "param", index: 0, class: "date" }] },
    params: ((s: { clock: () => Date }) => [s.clock()]) as never,
  };
  /** A filter that folds to a constant: `filter=(child) => 1 === 2`. */
  const never: ConditionLiteral<never> = {
    what: "the filter of max :noRank of Node", entity: "Node",
    tree: { kind: "call", fn: "eq", args: [{ kind: "value", value: 1, class: "integer" }, { kind: "value", value: 2, class: "integer" }] },
    params: () => [],
  };
  const filtered = (handle: (name: string) => never, extra: Partial<LoadPlan> = {}): LoadPlan => {
    const base = plan(handle);
    return {
      ...base,
      Node: { ...base.Node!, computed: {
        ...base.Node!.computed,
        openKids: { kind: "rollup", fn: "count", of: ["children"], filter: () => stateIs("open") },
        openRank: { kind: "rollup", fn: "max", of: ["children", "rank"], filter: () => stateIs("open") },
        openSize: { kind: "rollup", fn: "sum", of: ["children", "size"], filter: () => stateIs("open") },
        openGrandkids: { kind: "rollup", fn: "count", of: ["children", "children"], filter: () => stateIs("open") },
        openOwnerRank: { kind: "rollup", fn: "max", of: ["owner", "rank"], filter: () => stateIs("open") },
        lateKids: { kind: "rollup", fn: "count", of: ["children"], filter: () => overdue },
        noRank: { kind: "rollup", fn: "max", of: ["owner", "rank"], filter: () => never },
      } },
      ...extra,
    };
  };
  const data = () => memory({
    nodes: [
      { id: 1, parentId: null, ownerId: 10, rank: 3, size: 1, state: "open", dueOn: new Date("2026-01-01") },
      { id: 2, parentId: 1, ownerId: 10, rank: 8, size: 2, state: "open", dueOn: new Date("2026-03-01") },
      { id: 3, parentId: 1, ownerId: 11, rank: 5, size: 7, state: "closed", dueOn: new Date("2026-01-15") },
      { id: 4, parentId: 2, ownerId: 12, rank: null, size: 4, state: "open", dueOn: null },
      { id: 5, parentId: 2, ownerId: 12, rank: 6, size: 1, state: null, dueOn: new Date("2026-01-20") },
    ],
    owners: [{ id: 10, rank: 7, state: "open" }, { id: 11, rank: 4, state: "closed" }, { id: 12, rank: 2, state: "open" }],
  });
  const stored = async (tx: DataOperations, handle: (name: string) => never) => (await tx.select(handle("nodes"))) as Row[];

  test("a filtered count or max over one has-many is one batched rollup with the filter as where, never a per-row call", async () => {
    const { tx, calls, handle } = data();
    const rows = await stored(tx, handle);
    calls.length = 0;
    const loaded = await loadRows(filtered(handle), "Node", tx, rows, ["openKids", "openRank", "kids"]);
    // Node 1's children 2 (open) and 3 (closed); node 2's children 4 (open, no rank) and 5 (unknown state: left out).
    expect(loaded.map((r) => [r.id, r.openKids, r.openRank, r.kids])).toEqual([[1, 1, 8, 2], [2, 1, null, 2], [3, 0, null, 0], [4, 0, null, 0], [5, 0, null, 0]]);
    expect(calls.filter((c) => c.startsWith("rollup"))).toEqual([
      "rollup count nodes.id by parentId where [1,2,3,4,5]", "rollup max nodes.rank by parentId where [1,2,3,4,5]"]);
    // The unfiltered count keeps its per-row call (ruling D33, OD3).
    expect(calls.filter((c) => c.startsWith("count nodes.id"))).toHaveLength(5);
  });

  test("a filtered sum asks with the filter; over a two-hop path the filter is on the last hop only", async () => {
    const { tx, calls, handle } = data();
    const rows = await stored(tx, handle);
    calls.length = 0;
    const loaded = await loadRows(filtered(handle), "Node", tx, rows, ["openSize", "openGrandkids"]);
    // Node 1: open child 2 has size 2; its grandchildren 4 (open) and 5 (unknown) give one. The middle hop is not filtered:
    // the closed child 3 has no children, and a closed middle row would still lead on.
    expect(loaded.map((r) => [r.id, r.openSize, r.openGrandkids])).toEqual([[1, 2, 1], [2, 4, 0], [3, null, 0], [4, null, 0], [5, null, 0]]);
    expect(calls).toEqual(["rollup sum nodes.size by parentId where [1,2,3,4,5]", "rollup count nodes.id by id via nodes.nodes[where] [1,2,3,4,5]"]);
  });

  test("a filtered rollup never works its value out from rows the same call loaded", async () => {
    const { tx, calls, handle } = data();
    const rows = await stored(tx, handle);
    calls.length = 0;
    const loaded = await loadRows(filtered(handle), "Node", tx, rows, ["children", "owner", "openKids", "openOwnerRank", "rankMin"]);
    expect(loaded.map((r) => [r.id, r.openKids, r.openOwnerRank])).toEqual([[1, 1, 7], [2, 1, 7], [3, 0, null], [4, 0, 2], [5, 0, 2]]);
    // The unfiltered min uses the loaded children; both filtered rollups ask (closed owner 11 once more, to tell it from a dangling key).
    expect(calls.filter((c) => c.startsWith("rollup"))).toEqual([
      "rollup count nodes.id by parentId where [1,2,3,4,5]", "rollup max owners.rank by id where [10,11,12]", "rollup max owners.rank by id [11]"]);
  });

  test("%.now in a filter is the load's instant, from the injected clock", async () => {
    const { tx, handle } = data();
    const rows = await stored(tx, handle);
    const at = (iso: string) => loadRows(filtered(handle), "Node", tx, rows.slice(0, 2), ["lateKids"], { clock: () => new Date(iso) });
    expect((await at("2026-02-01")).map((r) => r.lateKids)).toEqual([1, 1]);
    expect((await at("2026-04-01")).map((r) => r.lateKids)).toEqual([2, 1]);
    expect((await at("2025-01-01")).map((r) => r.lateKids)).toEqual([0, 0]);
  });

  test("over required belongs-to only, a row the filter leaves out is null and a key that names no row is still the error", async () => {
    const { tx, calls, handle } = data();
    calls.length = 0;
    const kept = await loadRows(filtered(handle), "Node", tx, [{ id: 1, parentId: null, ownerId: 10 }, { id: 3, parentId: null, ownerId: 11 }], ["openOwnerRank"]);
    expect(kept.map((r) => r.openOwnerRank)).toEqual([7, null]);
    // Owner 11 is closed: asked once more with no filter, it exists, so it is excluded, not dangling.
    expect(calls).toEqual(["rollup max owners.rank by id where [10,11]", "rollup max owners.rank by id [11]"]);
    await expect(loadRows(filtered(handle), "Node", tx, [{ id: 9, parentId: null, ownerId: 99 }], ["openOwnerRank"]))
      .rejects.toThrow("`max :openOwnerRank of=&owner.rank` on Node 9 reaches no Owner row: a key on its path points at a row that does not exist");
  });

  test("a filter that folds to false asks nothing but whether the keys name rows", async () => {
    const { tx, calls, handle } = data();
    calls.length = 0;
    const loaded = await loadRows(filtered(handle), "Node", tx, [{ id: 1, parentId: null, ownerId: 10 }], ["noRank"]);
    expect(loaded[0]!.noRank).toBeNull();
    expect(calls).toEqual(["rollup max owners.rank by id [10]"]);
    await expect(loadRows(filtered(handle), "Node", tx, [{ id: 9, parentId: null, ownerId: 99 }], ["noRank"])).rejects.toThrow("reaches no Owner row");
  });

  test("a filter and a read policy's row condition on the same table both apply", async () => {
    const { tx, calls, handle } = data();
    const byRank: PolicySpec = { name: "ranked", when: null, checks: [{ kind: "authorize-if", check: "() => &rank > 4", record: true, run: (() => { throw new Error("folded"); }) as never,
      sql: () => ({ what: "policy :ranked authorize-if", entity: "Node", params: () => [],
        tree: { kind: "call", fn: "gt", args: [{ kind: "column", depth: 0, name: "rank", class: "integer" }, { kind: "value", value: 4, class: "integer" }] } }) as never }] };
    const base = filtered(handle);
    const policed = { ...base, Node: { ...base.Node!, reads: [byRank] } } as LoadPlan;
    const rows = await stored(tx, handle);
    calls.length = 0;
    // Node 1's children: 2 (open, rank 8) and 3 (closed, rank 5): one row passes both; node 2's: 4 (open, no rank) and 5 (rank 6, unknown state): none.
    const loaded = await loadRows(policed, "Node", tx, rows.slice(0, 2), ["openKids"], { policies: true });
    expect(loaded.map((r) => r.openKids)).toEqual([1, 0]);
    expect(calls.filter((c) => c.startsWith("rollup"))).toEqual(["rollup count nodes.id by parentId where [1,2]"]);
  });

  test("a filter goes only to a layer that declares conditions", async () => {
    const { tx, handle } = data();
    const rows = await stored(tx, handle);
    await expect(loadRows(filtered(handle), "Node", tx, rows, ["openKids"], { layer: { capabilities: { adapter: "plain", capabilities: ["aggregates"] } } }))
      .rejects.toThrow("does not declare the conditions capability");
    const loaded = await loadRows(filtered(handle), "Node", tx, rows.slice(0, 1), ["openKids"], { layer: { capabilities: { adapter: "sql", capabilities: ["aggregates", "conditions"] } } });
    expect(loaded[0]!.openKids).toBe(1);
  });
});

describe("a has-many through a link entity", () => {
  /** `Student` lists `Course` through `Enrollment` (entry `studentId`, exit `courseId`); `Task` lists `Task` through `Dependency`. */
  const school = (handle: (name: string) => never, exit: string | null = "courseId", extra: Partial<LoadPlan> = {}): LoadPlan => ({
    Student: {
      table: handle("students"), key: "id",
      relations: {
        courses: { kind: "has-many", target: "Course", column: "studentId", through: { target: "Enrollment", exit } },
        enrollments: { kind: "has-many", target: "Enrollment", column: "studentId" },
      },
      computed: {
        courseCount: { kind: "body", needs: ["courses"], evaluate: (s: { self: { courses: unknown[] } }) => s.self.courses.length } as never,
        courseRollup: { kind: "rollup", fn: "count", of: ["courses"] },
      },
    },
    Course: { table: handle("courses"), key: "id", relations: {}, computed: {} },
    Enrollment: {
      table: handle("enrollments"), key: "id",
      relations: {
        student: { kind: "belongs-to", target: "Student", column: "studentId", nullable: false },
        course: { kind: "belongs-to", target: "Course", column: "courseId", nullable: true },
      },
      computed: {},
    },
    Task: {
      table: handle("tasks"), key: "id",
      relations: {
        blockers: { kind: "has-many", target: "Task", column: "dependentId", through: { target: "Dependency", exit: "prerequisiteId" } },
        blocking: { kind: "has-many", target: "Task", column: "prerequisiteId", through: { target: "Dependency", exit: "dependentId" } },
      },
      computed: {},
    },
    Dependency: { table: handle("dependencies"), key: "id", relations: {}, computed: {} },
    ...extra,
  });
  const ids = (list: unknown) => (list as Row[]).map((row) => row.id);
  const enrolments = (...pairs: [string, string | null][]) => pairs.map(([studentId, courseId], index) => ({ id: `e${index + 1}`, studentId, courseId }));
  const data = () => memory({
    students: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    courses: [{ id: "c11" }, { id: "c12" }, { id: "c13" }, { id: "c14" }],
    // Out of order, c13 twice and one with no course for s1; s2 shares c12; s3 has none.
    enrollments: enrolments(["s1", "c13"], ["s1", "c11"], ["s1", "c13"], ["s1", null], ["s1", "c12"], ["s2", "c12"]),
  });

  test("each far record once, in key order, with no null exit; an owner with no link row gets []; two queries", async () => {
    const { tx, calls, handle } = data();
    const loaded = await loadRows(school(handle), "Student", tx, [{ id: "s1" }, { id: "s2" }, { id: "s3" }], ["courses"]);
    expect(loaded.map((row) => ids(row.courses))).toEqual([["c11", "c12", "c13"], ["c12"], []]);
    expect(calls).toEqual(["select enrollments sort=courseId", "select courses"]);
    // A far row shared by two owners is selected once and is the same object in both lists.
    expect((loaded[0]!.courses as Row[])[1]).toBe((loaded[1]!.courses as Row[])[0]!);
  });

  test("no owner rows makes no query; link rows with only null exits make one query, not two", async () => {
    const { tx, calls, handle } = memory({ enrollments: enrolments(["s1", null]), courses: [{ id: "c11" }] });
    expect(await loadRows(school(handle), "Student", tx, [], ["courses"])).toEqual([]);
    expect(calls).toEqual([]);
    const loaded = await loadRows(school(handle), "Student", tx, [{ id: "s1" }, { id: "s2" }], ["courses"]);
    expect(loaded.map((row) => row.courses)).toEqual([[], []]);
    expect(calls).toEqual(["select enrollments sort=courseId"]);
  });

  test("more owner keys and more exit keys than a chunk are several queries, and every list is whole and in order", async () => {
    const students = Array.from({ length: CHUNK + 200 }, (_, i) => ({ id: i + 1 }));
    const courses = Array.from({ length: CHUNK + 100 }, (_, i) => ({ id: i + 1 }));
    // Student 1 takes every course, written in reverse; every other student one course.
    const links = [
      ...courses.map((course, i) => ({ id: i + 1, studentId: 1, courseId: courses.length - course.id + 1 })),
      ...students.slice(1).map((student, i) => ({ id: courses.length + i + 1, studentId: student.id, courseId: (student.id % 7) + 1 })),
    ];
    const { tx, calls, handle } = memory({ students, courses, enrollments: links });
    const loaded = await loadRows(school(handle), "Student", tx, students, ["courses"]);
    expect(ids(loaded[0]!.courses)).toEqual(courses.map((course) => course.id));
    expect(loaded.slice(1).every((row, i) => ids(row.courses).join() === String((students[i + 1]!.id % 7) + 1))).toBe(true);
    expect(calls.filter((call) => call.startsWith("select enrollments"))).toHaveLength(2);
    expect(calls.filter((call) => call === "select courses")).toHaveLength(2);
  });

  test("a self-reference over one table in both directions; a row linked to itself; numeric keys in numeric order", async () => {
    const tasks = [2, 7, 10, 100].map((id) => ({ id }));
    const dependencies = [[100, 10], [100, 2], [10, 7], [10, 2], [2, 2], [7, 100]].map(([dependentId, prerequisiteId], i) => ({ id: i + 1, dependentId, prerequisiteId }));
    const { tx, handle } = memory({ tasks, dependencies });
    const loaded = await loadRows(school(handle), "Task", tx, tasks, ["blockers", "blocking"]);
    expect(loaded.map((row) => [row.id, ids(row.blockers), ids(row.blocking)])).toEqual([
      [2, [2], [2, 10, 100]],
      [7, [100], [10]],
      [10, [2, 7], [100]],
      [100, [2, 10], [7]],
    ]);
  });

  test("an exit key that names no far row is an error naming the row, through loadRows and through loadInto", async () => {
    const { tx, handle } = memory({ courses: [{ id: "c11" }], enrollments: enrolments(["s1", "c11"], ["s1", "c9"]) });
    const message = "has-many :courses of Student goes through a row of Enrollment that points at Course \"c9\", which does not exist";
    await expect(loadRows(school(handle), "Student", tx, [{ id: "s1" }], ["courses"])).rejects.toThrow(message);
    await expect(loadInto(school(handle), "Student", tx, { id: "s1" }, ["courses"])).rejects.toThrow(message);
  });

  describe("read policies", () => {
    const allow = (yes: boolean): PolicySpec => ({ name: "p", when: null, checks: [{ kind: "authorize-if", check: "() => x", record: false, run: (() => yes) as never }] });
    const guardedBy = (handle: (name: string) => never, link: boolean, far: boolean, exit: string | null = "courseId") => {
      const base = school(handle, exit);
      return { ...base, Enrollment: { ...base.Enrollment!, reads: [allow(link)] }, Course: { ...base.Course!, reads: [allow(far)] } } as LoadPlan;
    };
    test("a caller's load needs the link's and the far entity's read policies both; a denied name makes no query", async () => {
      for (const [link, far] of [[true, true], [true, false], [false, true], [false, false]] as const) {
        const { tx, calls, handle } = data();
        const loaded = await loadRows(guardedBy(handle, link, far), "Student", tx, [{ id: "s1" }, { id: "s2" }], ["courses", "enrollments"], { policies: true });
        expect([link, far, loaded.map((row) => ids(row.courses))]).toEqual([link, far, link && far ? [["c11", "c12", "c13"], ["c12"]] : [[], []]]);
        // The plain has-many to the link runs the link's policies alone.
        expect(ids(loaded[0]!.enrollments).length).toBe(link ? 5 : 0);
        if (!(link && far)) expect(calls.some((call) => call.includes("courses"))).toBe(false);
        // Two rows never share one emptied list.
        if (!(link && far)) expect(loaded[0]!.courses).not.toBe(loaded[1]!.courses);
      }
    });
    test("with no policies everything loads, and a computed body named by a denied caller still reads every row", async () => {
      const { tx, handle } = data();
      const closed = guardedBy(handle, false, false);
      const open = await loadRows(closed, "Student", tx, [{ id: "s1" }], ["courses"]);
      expect(ids(open[0]!.courses)).toEqual(["c11", "c12", "c13"]);
      const counted = await loadRows(closed, "Student", tx, [{ id: "s1" }], ["courseCount", "courses"], { policies: true });
      expect(counted[0]).toMatchObject({ courseCount: 3, courses: [] });
    });
    test("a through a computed body reads is narrowed for the caller by the link entity's condition on each link row", async () => {
      const { tx, handle } = data();
      const base = guardedBy(handle, true, true);
      // `&id !== "e2"`: s1's only enrollment in c11 is excluded; c13 stays, through e1 and e3.
      const literal: ConditionLiteral<unknown> = {
        what: "policy :notE2 authorize-if", entity: "Enrollment",
        tree: { kind: "call", fn: "not", args: [{ kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "id", class: "string" }, { kind: "param", index: 0, class: "string" }] }] },
        params: () => ["e2"],
      };
      const notE2: PolicySpec = { name: "notE2", when: null, checks: [{ kind: "authorize-if", check: "() => &id !== \"e2\"", record: true,
        run: (() => { throw new Error("a record check is folded, never run in memory"); }) as never, sql: () => literal as never }] };
      const linked = { ...base, Enrollment: { ...base.Enrollment!, reads: [notE2] } } as LoadPlan;
      const loaded = await loadRows(linked, "Student", tx, [{ id: "s1" }, { id: "s2" }], ["courseCount", "courses"], { policies: true });
      expect(loaded.map((row) => [row.courseCount, ids(row.courses)])).toEqual([[3, ["c12", "c13"]], [1, ["c12"]]]);
      // Without the body, the same condition is loaded with the query.
      const plain = await loadRows(linked, "Student", tx, [{ id: "s1" }, { id: "s2" }], ["courses"], { policies: true });
      expect(plain.map((row) => ids(row.courses))).toEqual([["c12", "c13"], ["c12"]]);
    });
    test("an exit that was not resolved is an error for a denied caller, with no query", async () => {
      const { tx, calls, handle } = data();
      await expect(loadRows(guardedBy(handle, false, true, null), "Student", tx, [{ id: "s1" }], ["courses"], { policies: true }))
        .rejects.toThrow("has-many :courses of Student cannot be loaded: Enrollment, the link entity, has not exactly one belongs-to to Course to leave by");
      expect(calls).toEqual([]);
    });
  });

  describe("the errors a load that cannot be served gives", () => {
    const noExit = "has-many :courses of Student cannot be loaded: Enrollment, the link entity, has not exactly one belongs-to to Course to leave by";
    test("no exit: with no policies, through a computed body, and through loadInto", async () => {
      const { tx, calls, handle } = data();
      const plan = school(handle, null);
      await expect(loadRows(plan, "Student", tx, [{ id: "s1" }], ["courses"])).rejects.toThrow(noExit);
      await expect(loadRows(plan, "Student", tx, [{ id: "s1" }], ["courseCount"])).rejects.toThrow(noExit);
      await expect(loadInto(plan, "Student", tx, { id: "s1" }, ["courses"])).rejects.toThrow(noExit);
      expect(calls).toEqual([]);
    });
    test("no entry names the link entity", async () => {
      const { tx, handle } = data();
      const base = school(handle);
      const entryless = { ...base, Student: { ...base.Student!, relations: { courses: { kind: "has-many", target: "Course", column: null, through: { target: "Enrollment", exit: "courseId" } } } } } as LoadPlan;
      await expect(loadRows(entryless, "Student", tx, [{ id: "s1" }], ["courses"]))
        .rejects.toThrow("has-many :courses of Student cannot be loaded: Enrollment has no belongs-to back to Student. Declare one in Enrollment, and name it with inverse=:name if there are several");
    });
    test("a rollup over it with no exit says why, for every caller", async () => {
      const { tx, calls, handle } = data();
      const message = "count :courseRollup of=&courses on Student cannot be loaded: Enrollment, the link entity, has not exactly one belongs-to to Course to leave by";
      await expect(loadRows(school(handle, null), "Student", tx, [{ id: "s1" }], ["courseRollup"])).rejects.toThrow(message);
      const base = school(handle, null);
      const denied = { ...base, Course: { ...base.Course!, reads: [] } } as LoadPlan;
      await expect(loadRows(denied, "Student", tx, [{ id: "s1" }], ["courseRollup"], { policies: true })).rejects.toThrow(message);
      expect(calls).toEqual([]);
    });
  });

  describe("a rollup over it", () => {
    test("counts each far record once, skips a link with no exit, and is one rollup call with a through hop", async () => {
      const { tx, calls, handle } = data();
      const loaded = await loadRows(school(handle), "Student", tx, [{ id: "s1" }, { id: "s2" }, { id: "s3" }], ["courseRollup"]);
      expect(loaded.map((row) => row.courseRollup)).toEqual([3, 1, 0]);
      expect(calls).toEqual(["rollup count students.id by id via enrollments>courses [s1,s2,s3]"]);
    });
    test("a caller the link entity or the far entity denies gets 0, with no query", async () => {
      const allow = (yes: boolean): PolicySpec => ({ name: "p", when: null, checks: [{ kind: "authorize-if", check: "() => x", record: false, run: (() => yes) as never }] });
      for (const [link, far] of [[true, true], [true, false], [false, true]] as const) {
        const { tx, calls, handle } = data();
        const base = school(handle);
        const policed = { ...base, Enrollment: { ...base.Enrollment!, reads: [allow(link)] }, Course: { ...base.Course!, reads: [allow(far)] } } as LoadPlan;
        const loaded = await loadRows(policed, "Student", tx, [{ id: "s1" }], ["courseRollup"], { policies: true });
        expect([link, far, loaded[0]!.courseRollup, calls.length]).toEqual([link, far, link && far ? 3 : 0, link && far ? 1 : 0]);
      }
    });
    test("a link whose read policy reads the record narrows the link rows the rollup follows", async () => {
      const { tx, calls, handle } = data();
      const base = school(handle);
      const literal: ConditionLiteral<unknown> = { what: "policy :mine authorize-if", entity: "Enrollment", tree: { kind: "value", value: true, class: "boolean" }, params: () => [] };
      const record: PolicySpec = { name: "mine", when: null, checks: [{ kind: "authorize-if", check: "() => &id", record: true,
        run: (() => { throw new Error("folded, never run"); }) as never, sql: () => ({ ...literal, tree: { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "id", class: "string" }, { kind: "value", value: "e1", class: "string" }] } }) as never }] };
      const open: PolicySpec = { name: "p", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: (() => true) as never }] };
      const policed = { ...base, Enrollment: { ...base.Enrollment!, reads: [record] }, Course: { ...base.Course!, reads: [open] } } as LoadPlan;
      // Only e1 (s1 to c13) is admitted: the other enrollments of s1 lead nowhere for this caller.
      const loaded = await loadRows(policed, "Student", tx, [{ id: "s1" }], ["courseRollup"], { policies: true });
      expect(loaded[0]!.courseRollup).toBe(1);
      expect(calls).toEqual(["rollup count students.id by id via enrollments[where]>courses [s1]"]);
      expect((await loadRows(policed, "Student", tx, [{ id: "s1" }], ["courseRollup"]))[0]!.courseRollup).toBe(3);
    });
    test("a far entity whose read policy reads the record narrows the far rows, behind an open link", async () => {
      const { tx, calls, handle } = data();
      const base = school(handle);
      const literal: ConditionLiteral<unknown> = { what: "policy :credited authorize-if", entity: "Course",
        tree: { kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "id", class: "string" }, { kind: "value", value: "c11", class: "string" }] }, params: () => [] };
      const record: PolicySpec = { name: "credited", when: null, checks: [{ kind: "authorize-if", check: "() => &id", record: true,
        run: (() => { throw new Error("folded, never run"); }) as never, sql: () => literal as never }] };
      const open: PolicySpec = { name: "p", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: (() => true) as never }] };
      const policed = { ...base, Enrollment: { ...base.Enrollment!, reads: [open] }, Course: { ...base.Course!, reads: [record] } } as LoadPlan;
      const loaded = await loadRows(policed, "Student", tx, [{ id: "s1" }, { id: "s2" }], ["courseRollup"], { policies: true });
      expect(loaded.map((row) => row.courseRollup)).toEqual([1, 0]);
      expect(calls).toEqual(["rollup count students.id by id via enrollments>courses[where] [s1,s2]"]);
    });
    test("a filter reads the far entity: it goes on the far hop's where, never on the link's", async () => {
      const { tx, calls, handle } = data();
      const base = school(handle);
      // `filter=(c) => c.id !== "c13"`, lowered against Course, the entity the path reaches last.
      const notC13: ConditionLiteral<never> = { what: "the filter of count :openCourses of Student", entity: "Course",
        tree: { kind: "call", fn: "ne", args: [{ kind: "column", depth: 0, name: "id", class: "string" }, { kind: "value", value: "c13", class: "string" }] }, params: () => [] };
      const plan = { ...base, Student: { ...base.Student!, computed: { ...base.Student!.computed, openCourses: { kind: "rollup", fn: "count", of: ["courses"], filter: () => notC13 } } } } as LoadPlan;
      const loaded = await loadRows(plan, "Student", tx, [{ id: "s1" }, { id: "s2" }, { id: "s3" }], ["openCourses"]);
      expect(loaded.map((row) => row.openCourses)).toEqual([2, 1, 0]);
      expect(calls).toEqual(["rollup count students.id by id via enrollments>courses[where] [s1,s2,s3]"]);
    });
  });

  describe("loadInto", () => {
    test("a create's new record has no key: the list is [] and no query runs", async () => {
      const { tx, calls, handle } = data();
      const record: Row = { id: null };
      await loadInto(school(handle), "Student", tx, record, ["courses"], { newInstance: true });
      expect(record.courses).toEqual([]);
      expect(calls).toEqual([]);
    });
    test("a path where it follows a has-many and a belongs-to; a far row shared by two owners is selected once", async () => {
      const { tx, calls, handle } = data();
      const record: Row = { id: "s2" };
      // s2's enrollment leads back to s2, whose courses are loaded once on that one student row.
      await loadInto(school(handle), "Student", tx, record, ["enrollments.student.courses"]);
      const student = (record.enrollments as Row[])[0]!.student as Row;
      expect(ids(student.courses)).toEqual(["c12"]);
      expect(calls).toEqual(["select enrollments", "select students", "select enrollments sort=courseId", "select courses"]);
      const both: Row = { id: "s1" };
      calls.length = 0;
      await loadInto(school(handle), "Student", tx, both, ["enrollments.student.courses"]);
      expect(calls.filter((call) => call === "select courses")).toHaveLength(1);
    });
    test("unloadFrom drops the list and the next loadInto loads it again", async () => {
      const { tx, calls, handle } = data();
      const record: Row = { id: "s2" };
      await loadInto(school(handle), "Student", tx, record, ["courses"]);
      await loadInto(school(handle), "Student", tx, record, ["courses"]);
      expect(calls).toHaveLength(2);
      unloadFrom(school(handle), "Student", record);
      expect(Object.hasOwn(record, "courses")).toBe(false);
      await loadInto(school(handle), "Student", tx, record, ["courses"]);
      expect(ids(record.courses)).toEqual(["c12"]);
      expect(calls).toHaveLength(4);
    });
  });

  test("a guard wraps the listed rows as rows of the far entity", () => {
    const { handle } = memory({});
    const row = guarded(school(handle), "Student", { id: "s1", courses: [{ id: "c11" }] }) as { courses: { id: string }[] };
    expect(row.courses[0]!.id).toBe("c11");
  });
});
