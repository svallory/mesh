import { describe, expect, test } from "bun:test";
import { CHUNK, FrameworkError, guarded, loadInto, loadRows, rejectComputedQuery, unloadFrom, scope, type DataOperations, type LoadPlan, type PolicySpec, type Row } from "../src/index.ts";

/**
 * An in-memory data layer that understands the filters loading uses (`eq`, `in`, `nil`) and an ascending `sort` with the
 * key (`id`) appended, and records every call.
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
  // This double runs no translated condition: a where or an order it would drop must fail loudly (design 3.4), so a
  // change that passes one has to extend the double instead of passing against unfiltered rows.
  const noCondition = (where: unknown) => { if (where !== undefined) throw new Error("this test double runs no condition"); };
  const tx = {
    select: async (table: unknown, query?: { filter?: never; sort?: readonly string[]; where?: unknown; order?: unknown }) => {
      noCondition(query?.where); noCondition(query?.order);
      calls.push(`select ${(table as { name: string }).name}${query?.sort ? ` sort=${query.sort.join(",")}` : ""}`);
      return sorted(rowsOf(table).filter((row) => matches(row, query?.filter)), query?.sort).map((row) => ({ ...row }));
    },
    count: async (table: unknown, attribute: string, filter?: never, where?: unknown) => { noCondition(where); calls.push(`count ${(table as { name: string }).name}.${attribute}`); return rowsOf(table).filter((row) => matches(row, filter) && row[attribute] != null).length; },
    max: async (table: unknown, attribute: string, filter?: never, where?: unknown) => {
      noCondition(where);
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

    test("sum, avg, min, a path through two relationships and a belongs-to are errors that say when", async () => {
      const { tx, handle } = memory({});
      const row = [{ id: 1, ownerId: 1 }];
      await expect(loadRows(plan(handle), "Node", tx, row, ["sizeSum"])).rejects.toThrow('sum :sizeSum of=&children.size on Node cannot be loaded: only count and max rollups run before Mesh 1.0; sum, avg and min come after it');
      await expect(loadRows(plan(handle), "Node", tx, row, ["deep"])).rejects.toThrow("a rollup over more than one relationship needs a join, which arrives with the SQL evaluator (M10)");
      await expect(loadRows(plan(handle), "Node", tx, row, ["ownerCount"])).rejects.toThrow("a rollup over a belongs-to needs a join");
      await expect(loadRows(plan(handle), "Node", tx, row, ["badRelation"])).rejects.toThrow("Node has no relationship nowhere");
      await expect(loadRows(plan(handle), "Node", tx, row, ["looseCount"])).rejects.toThrow("Badge has no belongs-to back to Node");
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

describe("rejectComputedQuery", () => {
  const names = ["total", "depth"];
  const refused = (what: string, name: string) => `A ${what} by Doc#${name} is not available yet: ${name} is a computed field or rollup, and filtering and sorting by one is evaluated by the SQL evaluator, which arrives in M10`;
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
  // a filter literal leaves out a computed field named like a member of the Object interface only by giving it as
  // undefined, which the generated filter type allows; the data layer has no column for it, so it must not see it.
  test("a computed field given as undefined is left out of the filter it returns, at any depth; a stored column stays", () => {
    const odd = ["toString", "valueOf"];
    const clean = (filter: unknown) => rejectComputedQuery<unknown>("Doc", odd, { filter });
    expect(clean({ toString: undefined, valueOf: undefined, label: { eq: "a" } })).toEqual({ label: { eq: "a" } });
    const cleaned = clean({ or: [{ toString: undefined, label: { eq: "a" } }, { and: [{ valueOf: undefined }, { label: { eq: "b" } }] }] });
    expect(cleaned).toEqual({ or: [{ label: { eq: "a" } }, { and: [{}, { label: { eq: "b" } }] }] });
    expect(Object.keys((cleaned as { or: object[] }).or[0]!)).toEqual(["label"]);
    expect(clean({ toString: undefined })).toEqual({});
    // A stored column given as undefined is the data layer's to leave out (`Filter`).
    const stored = { label: undefined, toString: undefined };
    expect(Object.keys(clean(stored) as object)).toEqual(["label"]);
    // Nothing to take out: the caller's filter itself, never a copy, and never changed.
    const plain = { and: [{ label: { eq: "a" } }], label: undefined };
    expect(clean(plain)).toBe(plain);
    expect(rejectComputedQuery("Doc", odd, {})).toBeUndefined();
    const given = { or: [{ toString: undefined }] };
    clean(given);
    expect(given).toEqual({ or: [{ toString: undefined }] });
    expect(Object.keys(given.or[0]!)).toEqual(["toString"]);
    // A comparison of a computed field is still the SQL evaluator's, beside or under an undefined one.
    expect(() => clean({ toString: undefined, valueOf: { eq: "v" } })).toThrow(refused("filter", "valueOf"));
    expect(() => clean({ or: [{ toString: undefined }, { toString: { eq: "t" } }] })).toThrow(refused("filter", "toString"));
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

  test("a read policy that reads the record is the M10 error", async () => {
    const { tx, handle } = data();
    const base = guarded(handle);
    const reading: PolicySpec = { ...open, checks: [{ ...open.checks[0]!, record: true }] };
    const rows = (await tx.select(handle("nodes"))) as Row[];
    await expect(loadRows({ ...base, Owner: { ...base.Owner!, reads: [reading] } }, "Node", tx, rows, ["owner"], { policies: true })).rejects.toThrow(/M10/);
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
    test("a rollup over it waits for M10, for every caller", async () => {
      const { tx, calls, handle } = data();
      const message = "count :courseRollup of=&courses on Student cannot be loaded yet: a rollup over a has-many through a link entity needs a join, which arrives with the SQL evaluator (M10); only a count or max over one has-many or has-one runs now";
      await expect(loadRows(school(handle), "Student", tx, [{ id: "s1" }], ["courseRollup"])).rejects.toThrow(message);
      const base = school(handle);
      const denied = { ...base, Course: { ...base.Course!, reads: [] } } as LoadPlan;
      await expect(loadRows(denied, "Student", tx, [{ id: "s1" }], ["courseRollup"], { policies: true })).rejects.toThrow(message);
      expect(calls).toEqual([]);
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
