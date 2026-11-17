import { validateCapabilityManifest, type CapabilityManifest } from "./capabilities.ts";
import type { Condition } from "./condition.ts";
import type { DataLayer, DataOperations, Key, Query, RollupFn, RollupQuery, Row, TableHandle, WriteGuard } from "./data-layer.ts";
import { sameValue } from "./compose.ts";
import { FrameworkError, PolicyGuardDenial } from "./errors.ts";
import type { DataLayerFixture } from "./testing.ts";

/**
 * What the contract v1 checks need beyond the base fixture. Every call of the factory
 * must return a fresh, isolated layer with these tables prepared and empty:
 *
 * - `uuidTable`: `id` text primary key, `label` text not null.
 * - `taskTable`: `id` text primary key, `parentId` text nullable, `createdAt` date not null
 *   (millisecond precision), `title` text not null, `rank` integer nullable. This is the
 *   shape of Hyper's `list_tasks` read.
 * - `integerTable`: `seq` integer primary key, `label` text not null. Required when the
 *   manifest declares `integer-key-fill`; with it undeclared, give it anyway to prove the
 *   adapter refuses to fill.
 */
export interface DataLayerFixtureV1 extends DataLayerFixture {
  uuidTable: TableHandle;
  taskTable: TableHandle;
  integerTable?: TableHandle;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Data-layer conformance: ${message}`);
}

const day = (n: number) => new Date(`2026-01-0${n}T00:00:00.000Z`);
// a2 and a3 tie on createdAt; a1 and a5 tie on createdAt; a4 and a5 tie on rank.
const TASKS: Row[] = [
  { id: "a1", parentId: null, createdAt: day(1), title: "Alpha", rank: 3 },
  { id: "a2", parentId: "p1", createdAt: day(2), title: "Bravo", rank: 1 },
  { id: "a3", parentId: "p1", createdAt: day(2), title: "Charlie", rank: null },
  { id: "a4", parentId: "p1", createdAt: day(3), title: "Delta", rank: 5 },
  { id: "a5", parentId: "p2", createdAt: day(1), title: "Echo", rank: 5 },
  { id: "a6", parentId: "p1", createdAt: day(4), title: "Foxtrot", rank: 2 },
];

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What `probe` returns, or the error it throws, so a check can inspect either. */
function answer(probe: () => unknown): unknown {
  try { return probe(); } catch (cause) { return cause; }
}

/** A value for an assertion message: an error by class and message, anything else as JSON. */
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.constructor.name}: ${value.message}${value.cause instanceof Error ? ` (cause: ${value.cause.message})` : ""}`;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** Run `run` in one transaction, and settle with its error, if any, so a check can inspect it. */
async function failure(layer: DataLayer, run: (tx: DataOperations) => Promise<unknown>): Promise<unknown> {
  try { await layer.transaction(run); } catch (cause) { return cause; }
  return undefined;
}

export function contractV1Checks(makeLayer: () => Promise<DataLayerFixtureV1>, manifest: CapabilityManifest): Record<string, () => Promise<void>> {
  const declared = (name: string) => (manifest.capabilities as readonly string[]).includes(name);
  const withFixture = (run: (fixture: DataLayerFixtureV1) => Promise<void>) => async () => {
    const fixture = await makeLayer();
    try { await run(fixture); } finally { await fixture.layer.close(); }
  };
  const withTasks = (run: (read: (query?: Query) => Promise<string[]>, fixture: DataLayerFixtureV1) => Promise<void>) => withFixture(async (fixture) => {
    await fixture.layer.transaction(async (tx) => { for (const task of TASKS) await tx.insert(fixture.taskTable, task); });
    const read = (query?: Query) => fixture.layer.transaction(async (tx) => (await tx.select(fixture.taskTable, query)).map((row) => String(row.id)));
    await run(read, fixture);
  });
  const expectIds = async (read: (query?: Query) => Promise<string[]>, query: Query | undefined, expected: string[], message: string) => {
    const actual = await read(query);
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${expected.join(",")} but got ${actual.join(",")}`);
  };
  const rejected = async (fixture: DataLayerFixtureV1, query: unknown, message: string) => {
    const error = await failure(fixture.layer, (tx) => tx.select(fixture.taskTable, query as Query));
    assert(error instanceof FrameworkError, `${message} must reject with FrameworkError`);
  };
  const filterCheck = (name: string, cases: readonly (readonly [Query["filter"], string[]])[]) =>
    [name, withTasks(async (read) => {
      for (const [filter, expected] of cases) await expectIds(read, { filter }, expected, `filter ${JSON.stringify(filter)}`);
    })] as const;

  return Object.fromEntries([
    ["the capability manifest is valid and consistent with the fixture", withFixture(async (fixture) => {
      validateCapabilityManifest(manifest);
      assert(!declared("integer-key-fill") || fixture.integerTable !== undefined, "an adapter that declares integer-key-fill needs the fixture's integerTable");
      const guarded = await fixture.layer.transaction(async (tx) => typeof tx.deleteByKeyGuarded === "function");
      assert(guarded === declared("policy-guards"), `deleteByKeyGuarded must be present exactly when policy-guards is declared: declared ${String(declared("policy-guards"))}, present ${String(guarded)}`);
    })],
    ["select without a query returns every row in primary-key order", withTasks(async (read) => {
      await expectIds(read, undefined, ["a1", "a2", "a3", "a4", "a5", "a6"], "no query");
      await expectIds(read, {}, ["a1", "a2", "a3", "a4", "a5", "a6"], "empty query");
      await expectIds(read, { filter: {} }, ["a1", "a2", "a3", "a4", "a5", "a6"], "empty filter");
    })],
    ["select returns attribute values as TypeScript values", withTasks(async (_read, { layer, taskTable }) => {
      const [row] = await layer.transaction((tx) => tx.select(taskTable, { filter: { id: { eq: "a2" } } }));
      assert(row !== undefined && row.parentId === "p1" && row.rank === 1 && row.title === "Bravo", "select must return the stored scalars");
      assert(row.createdAt instanceof Date && row.createdAt.getTime() === day(2).getTime(), "select must return dates as Date");
      const [nulls] = await layer.transaction((tx) => tx.select(taskTable, { filter: { id: { eq: "a3" } } }));
      assert(nulls !== undefined && nulls.rank === null, "select must return a missing value as null");
    })],
    filterCheck("filter eq and ne", [
      [{ parentId: { eq: "p1" } }, ["a2", "a3", "a4", "a6"]],
      [{ parentId: { ne: "p1" } }, ["a5"]], // a null parentId matches neither eq nor ne, as in SQL
      [{ parentId: { eq: "none" } }, []],
      [{ createdAt: { eq: day(1) } }, ["a1", "a5"]],
      [{ title: { eq: "Delta" } }, ["a4"]],
    ]),
    filterCheck("filter lt lte gt gte, on dates and numbers", [
      [{ createdAt: { lt: day(2) } }, ["a1", "a5"]],
      [{ createdAt: { lte: day(2) } }, ["a1", "a2", "a3", "a5"]],
      [{ createdAt: { gt: day(2) } }, ["a4", "a6"]],
      [{ createdAt: { gte: day(2) } }, ["a2", "a3", "a4", "a6"]],
      [{ rank: { gt: 1, lt: 5 } }, ["a1", "a6"]],
      [{ rank: { gte: 5 } }, ["a4", "a5"]],
      [{ rank: { lte: 0 } }, []],
    ]),
    filterCheck("filter in, including an empty list", [
      [{ rank: { in: [1, 2] } }, ["a2", "a6"]],
      [{ title: { in: ["Alpha", "Echo", "missing"] } }, ["a1", "a5"]],
      [{ rank: { in: [] } }, []],
    ]),
    filterCheck("filter nil, and eq or ne null", [
      [{ rank: { nil: true } }, ["a3"]],
      [{ rank: { nil: false } }, ["a1", "a2", "a4", "a5", "a6"]],
      [{ parentId: { eq: null } }, ["a1"]],
      [{ parentId: { ne: null } }, ["a2", "a3", "a4", "a5", "a6"]],
    ]),
    filterCheck("filter and, or and nesting", [
      [{ and: [{ parentId: { eq: "p1" } }, { rank: { nil: true } }] }, ["a3"]],
      [{ parentId: { eq: "p1" }, rank: { nil: true } }, ["a3"]],
      [{ or: [{ parentId: { eq: "p2" } }, { and: [{ parentId: { eq: "p1" } }, { rank: { gte: 5 } }] }] }, ["a4", "a5"]],
      [{ or: [{ parentId: { ne: "p1" } }, { parentId: { nil: true } }] }, ["a1", "a5"]],
      [{ and: [{ or: [{ rank: { eq: 1 } }, { rank: { eq: 2 } }] }] }, ["a2", "a6"]],
      [{ and: [] }, ["a1", "a2", "a3", "a4", "a5", "a6"]],
      [{ or: [] }, []],
      [{ and: [{ or: [] }] }, []],
      [{ or: [{ and: [] }, { rank: { eq: 99 } }] }, ["a1", "a2", "a3", "a4", "a5", "a6"]],
    ]),
    ["sort ascending, descending and by several fields, ties in primary-key order", withTasks(async (read) => {
      await expectIds(read, { sort: ["createdAt", "id"] }, ["a1", "a5", "a2", "a3", "a4", "a6"], "createdAt, id");
      await expectIds(read, { sort: ["createdAt"] }, ["a1", "a5", "a2", "a3", "a4", "a6"], "tie on createdAt falls back to the key");
      await expectIds(read, { sort: ["-createdAt"] }, ["a6", "a4", "a2", "a3", "a1", "a5"], "descending keeps ties in key order");
      await expectIds(read, { sort: ["-createdAt", "-id"] }, ["a6", "a4", "a3", "a2", "a5", "a1"], "descending id after descending createdAt");
      await expectIds(read, { sort: ["-title"] }, ["a6", "a5", "a4", "a3", "a2", "a1"], "-title");
      await expectIds(read, { filter: { rank: { nil: false } }, sort: ["rank"] }, ["a2", "a6", "a1", "a4", "a5"], "rank");
      await expectIds(read, { filter: { rank: { nil: false } }, sort: ["-rank"] }, ["a4", "a5", "a1", "a6", "a2"], "-rank");
      await expectIds(read, { sort: [] }, ["a1", "a2", "a3", "a4", "a5", "a6"], "an empty sort");
    })],
    ["nulls sort first ascending and last descending, and text sorts and compares bytewise, as on SQLite", withFixture(async (fixture) => {
      // Upper case, an underscore, lower case and a non-ASCII letter: byte order differs from every locale's collation.
      const rows = [
        { id: "b1", parentId: null, createdAt: day(1), title: "apple", rank: 2 },
        { id: "b2", parentId: null, createdAt: day(1), title: "Banana", rank: null },
        { id: "b3", parentId: null, createdAt: day(1), title: "_x", rank: 1 },
        { id: "b4", parentId: null, createdAt: day(1), title: "\u00e9", rank: null },
      ];
      await fixture.layer.transaction(async (tx) => { for (const row of rows) await tx.insert(fixture.taskTable, row); });
      const read = (query?: Query) => fixture.layer.transaction(async (tx) => (await tx.select(fixture.taskTable, query)).map((row) => String(row.id)));
      await expectIds(read, { sort: ["rank"] }, ["b2", "b4", "b3", "b1"], "rank ascending puts nulls first, ties in key order");
      await expectIds(read, { sort: ["-rank"] }, ["b1", "b3", "b2", "b4"], "rank descending puts nulls last, ties in key order");
      await expectIds(read, { sort: ["title"] }, ["b2", "b3", "b1", "b4"], "title ascending in byte order");
      await expectIds(read, { sort: ["-title"] }, ["b4", "b1", "b3", "b2"], "title descending in byte order");
      await expectIds(read, { filter: { title: { lt: "b" } } }, ["b1", "b2", "b3"], "lt compares bytewise");
      await expectIds(read, { filter: { title: { gte: "_" } } }, ["b1", "b3", "b4"], "gte compares bytewise");
      await expectIds(read, { filter: { title: { eq: "banana" } } }, [], "eq is exact, letter case included");
    })],
    ["limit and offset page the result, and an offset past the end is empty", withTasks(async (read) => {
      const query = { sort: ["createdAt", "id"] };
      await expectIds(read, { ...query, limit: 2 }, ["a1", "a5"], "first page");
      await expectIds(read, { ...query, limit: 2, offset: 2 }, ["a2", "a3"], "second page");
      await expectIds(read, { ...query, limit: 2, offset: 4 }, ["a4", "a6"], "last page");
      await expectIds(read, { ...query, limit: 2, offset: 5 }, ["a6"], "partial last page");
      await expectIds(read, { ...query, limit: 2, offset: 6 }, [], "offset at the end");
      await expectIds(read, { ...query, limit: 2, offset: 600 }, [], "offset past the end");
      await expectIds(read, { ...query, limit: 0 }, [], "limit 0");
      await expectIds(read, { ...query, limit: 100 }, ["a1", "a5", "a2", "a3", "a4", "a6"], "limit above the count");
      await expectIds(read, { ...query, offset: 4 }, ["a4", "a6"], "offset without limit");
      await expectIds(read, { offset: 0 }, ["a1", "a2", "a3", "a4", "a5", "a6"], "offset 0");
    })],
    ["a filter, sort and limit return the page Hyper's list_tasks returns", withTasks(async (read) => {
      const filter = { parentId: { eq: "p1" } };
      await expectIds(read, { filter, sort: ["createdAt", "id"], limit: 10 }, ["a2", "a3", "a4", "a6"], "list_tasks");
      await expectIds(read, { filter, sort: ["-createdAt", "id"], limit: 2 }, ["a6", "a4"], "newest two");
      await expectIds(read, { filter, sort: ["createdAt", "id"], limit: 2, offset: 1 }, ["a3", "a4"], "second and third");
      await expectIds(read, { filter: { and: [filter, { createdAt: { gte: day(3) } }] }, sort: ["id"] }, ["a4", "a6"], "since a date");
    })],
    ["in, nil and sort in one query return the link rows a has-many through a link entity loads", withTasks(async (read) => {
      // The loader's shape: the link rows of several owners, those with an exit key, in the exit key's order, ties by key.
      await expectIds(read, { filter: { parentId: { in: ["p1", "p2"] }, rank: { nil: false } }, sort: ["rank"] }, ["a2", "a6", "a4", "a5"], "in, nil: false, sort");
    })],
    ["an undefined query field is the same as an absent one", withTasks(async (read) => {
      const everything = await read({});
      await expectIds(read, { filter: undefined, sort: undefined, limit: undefined, offset: undefined }, everything, "all four undefined");
      await expectIds(read, { filter: undefined, sort: ["id"], limit: undefined, offset: undefined }, [...everything].sort(), "only sort given");
      await expectIds(read, { filter: { rank: undefined }, sort: ["id"] }, [...everything].sort(), "an attribute whose comparison is undefined");
      await expectIds(read, { filter: { or: [{ parentId: { eq: "p1" }, rank: undefined }] }, sort: ["id"] }, ["a2", "a3", "a4", "a6"], "an undefined comparison under or");
      const filter = { parentId: { eq: "p1" } };
      await expectIds(read, { filter, sort: ["createdAt", "id"], limit: 2, offset: undefined }, ["a2", "a3"], "offset undefined");
      await expectIds(read, { filter, sort: ["createdAt", "id"], limit: undefined, offset: 1 }, ["a3", "a4", "a6"], "limit undefined");
    })],
    ["a malformed query is a FrameworkError and reads nothing", withTasks(async (_read, fixture) => {
      for (const [query, message] of [
        [{ filter: { nope: { eq: 1 } } }, "an unknown attribute"],
        [{ filter: { nope: undefined } }, "an unknown attribute whose comparison is undefined"],
        [{ filter: { rank: { like: 1 } } }, "an unknown operator"],
        [{ filter: { rank: 1 } }, "a bare value"],
        [{ filter: { rank: {} } }, "an empty comparison"],
        [{ filter: { rank: { eq: undefined } } }, "an undefined operand"],
        [{ filter: { rank: { lt: null } } }, "lt null"],
        [{ filter: { rank: { in: [1, null] } } }, "null inside in"],
        [{ filter: { rank: { in: 1 } } }, "a non-list in"],
        [{ filter: { rank: { nil: "yes" } } }, "a non-boolean nil"],
        [{ filter: { rank: { eq: Number.NaN } } }, "NaN"],
        [{ filter: { rank: { eq: {} } } }, "an object operand"],
        [{ filter: { and: {} } }, "and without a list"],
        [{ filter: { or: [{ nope: { eq: 1 } }] } }, "an unknown attribute under or"],
        [{ filter: [] }, "a list filter"],
        [{ sort: ["nope"] }, "an unknown sort field"],
        [{ sort: ["-"] }, "a sort field without a name"],
        [{ sort: "id" }, "a sort that is not a list"],
        [{ limit: -1 }, "a negative limit"],
        [{ limit: 1.5 }, "a fractional limit"],
        [{ limit: "1" }, "a text limit"],
        [{ offset: -1 }, "a negative offset"],
      ] as const) await rejected(fixture, query, message);
      const error = await failure(fixture.layer, (tx) => tx.select(fixture.taskTable, { filter: { "id'; drop table x; --": { eq: 1 } } as never }));
      assert(error instanceof FrameworkError, "an attribute name that is not a column must be refused, never sent to the database");
      const hostile = "a1' OR '1'='1";
      assert((await fixture.layer.transaction((tx) => tx.select(fixture.taskTable, { filter: { id: { eq: hostile } } }))).length === 0, "values are parameters, never SQL text");
    })],
    ["a rejected read leaves the transaction usable", withTasks(async (_read, { layer, taskTable }) => {
      const count = await layer.transaction(async (tx) => {
        try { await tx.select(taskTable, { sort: ["nope"] }); } catch { /* expected */ }
        return (await tx.select(taskTable)).length;
      });
      assert(count === 6, "a read that fails validation must not poison the transaction");
    })],
    ["reads see the writes of their own transaction and not those of a rolled-back one", withTasks(async (read, { layer, taskTable }) => {
      await layer.transaction(async (tx) => {
        await tx.insert(taskTable, { id: "a7", parentId: "p1", createdAt: day(5), title: "Golf", rank: 9 });
        const rows = await tx.select(taskTable, { filter: { parentId: { eq: "p1" } }, sort: ["-createdAt"], limit: 1 });
        assert(rows[0]?.id === "a7", "a select must see the transaction's own insert");
      });
      await expectIds(read, { sort: ["-createdAt"], limit: 1 }, ["a7"], "committed insert");
      await failure(layer, async (tx) => { await tx.deleteByKey(taskTable, { id: "a7" }); await tx.insert(taskTable, { id: "a8", parentId: null, createdAt: day(6), title: "Hotel", rank: 1 }); throw new Error("roll back"); });
      await expectIds(read, { sort: ["-createdAt"], limit: 1 }, ["a7"], "after a rolled-back delete and insert");
    })],
    ["read for update returns the stored row, undefined when absent, and sees the transaction's writes", withTasks(async (_read, { layer, taskTable }) => {
      await layer.transaction(async (tx) => {
        const row = await tx.selectByKeyForUpdate(taskTable, { id: "a2" });
        assert(row?.title === "Bravo" && row.createdAt instanceof Date, "read for update must return the complete stored row");
        assert(await tx.selectByKeyForUpdate(taskTable, { id: "missing" }) === undefined, "read for update of an absent row must return undefined");
        await tx.updateByKey(taskTable, { id: "a2" }, { title: "Changed" });
        assert((await tx.selectByKeyForUpdate(taskTable, { id: "a2" }))?.title === "Changed", "read for update must see the transaction's own update");
        await tx.deleteByKey(taskTable, { id: "a2" });
        assert(await tx.selectByKeyForUpdate(taskTable, { id: "a2" }) === undefined, "read for update must see the transaction's own delete");
      });
      const error = await failure(layer, (tx) => tx.selectByKeyForUpdate(taskTable, {}));
      assert(error instanceof FrameworkError, "read for update with an empty key must be a FrameworkError");
    })],
    ["read for update runs under the write lock, so a concurrent writer waits for it", withTasks(async (_read, { layer, taskTable }) => {
      const events: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const first = layer.transaction(async (tx) => {
        const row = await tx.selectByKeyForUpdate(taskTable, { id: "a1" });
        events.push("first read");
        await held;
        await tx.updateByKey(taskTable, { id: "a1" }, { rank: Number(row?.rank) + 1 });
        events.push("first wrote");
      });
      const second = layer.transaction(async (tx) => {
        events.push("second started");
        const row = await tx.selectByKeyForUpdate(taskTable, { id: "a1" });
        await tx.updateByKey(taskTable, { id: "a1" }, { rank: Number(row?.rank) + 1 });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert(!events.includes("second started"), "a second writer must not start while the first holds the lock");
      release();
      await Promise.all([first, second]);
      const final = await layer.transaction((tx) => tx.selectByKey(taskTable, { id: "a1" }));
      assert(final?.rank === 5, "two read-modify-write transactions must not lose an update");
    })],
    ["max and count over one attribute with a plain-data filter", withTasks(async (_read, { layer, taskTable }) => {
      const run = <T>(use: (tx: DataOperations) => Promise<T>) => layer.transaction(use);
      if (!declared("aggregates")) {
        const error = await failure(layer, (tx) => tx.max(taskTable, "rank"));
        assert(error instanceof FrameworkError, "an adapter without aggregates must refuse max with FrameworkError");
        return;
      }
      assert(await run((tx) => tx.max(taskTable, "rank")) === 5, "max of rank");
      assert(await run((tx) => tx.max(taskTable, "rank", { parentId: { eq: "p1" } })) === 5, "max of rank under a filter");
      assert(await run((tx) => tx.max(taskTable, "rank", { parentId: { eq: "p1" }, createdAt: { lt: day(3) } })) === 1, "max of rank under two conditions");
      assert(await run((tx) => tx.max(taskTable, "rank", { parentId: { eq: "p3" } })) === null, "max over no rows is null");
      assert(await run((tx) => tx.max(taskTable, "rank", { rank: { nil: true } })) === null, "max over only nulls is null");
      assert(await run((tx) => tx.max(taskTable, "rank", { or: [] })) === null, "max under a filter that matches nothing is null");
      const newest = await run((tx) => tx.max(taskTable, "createdAt"));
      assert(newest instanceof Date && newest.getTime() === day(4).getTime(), "max of a date is a Date");
      assert(await run((tx) => tx.max(taskTable, "title")) === "Foxtrot", "max of text");
      assert(await run((tx) => tx.count(taskTable, "title")) === 6, "count of a never-null attribute");
      assert(await run((tx) => tx.count(taskTable, "rank")) === 5, "count skips nulls");
      assert(await run((tx) => tx.count(taskTable, "rank", { parentId: { eq: "p1" } })) === 3, "count under a filter");
      assert(await run((tx) => tx.count(taskTable, "rank", { parentId: { eq: "p3" } })) === 0, "count over no rows is 0");
      assert(await run((tx) => tx.count(taskTable, "id", {})) === 6, "count under an empty filter");
      for (const attribute of ["nope", "constructor"]) {
        assert(await failure(layer, (tx) => tx.max(taskTable, attribute)) instanceof FrameworkError, `max of ${attribute} must be a FrameworkError`);
        assert(await failure(layer, (tx) => tx.count(taskTable, attribute)) instanceof FrameworkError, `count of ${attribute} must be a FrameworkError`);
      }
      assert(await failure(layer, (tx) => tx.max(taskTable, "rank", { nope: { eq: 1 } })) instanceof FrameworkError, "an aggregate filter on an unknown attribute must be a FrameworkError");
      const inside = await run(async (tx) => {
        await tx.insert(taskTable, { id: "a9", parentId: "p1", createdAt: day(7), title: "India", rank: 42 });
        return tx.max(taskTable, "rank");
      });
      assert(inside === 42, "an aggregate must see the transaction's own insert");
      assert(await run((tx) => tx.max(taskTable, "rank")) === 42, "the insert committed");
    })],
    ["rollup groups one table by its anchor column, one row per anchor that reaches a row", withTasks(async (_read, { layer, taskTable }) => {
      const run = <T>(use: (tx: DataOperations) => Promise<T>) => layer.transaction(use);
      const query = (fn: RollupFn, value: string, anchors: readonly string[] = ["p1", "p2", "p3", "p4"]): RollupQuery => ({ fn, table: taskTable, anchor: "parentId", anchors, value });
      if (!declared("aggregates")) {
        assert(await failure(layer, (tx) => tx.rollup(query("count", "id"))) instanceof FrameworkError, "an adapter without aggregates must refuse rollup with FrameworkError");
        return;
      }
      // p4 reaches one row whose rank is null; p3 reaches none.
      await run((tx) => tx.insert(taskTable, { id: "a7", parentId: "p4", createdAt: day(5), title: "Golf", rank: null }));
      const byAnchor = async (fn: RollupFn, value: string, anchors?: readonly string[]) => {
        const rows = await run((tx) => tx.rollup(query(fn, value, anchors)));
        const out: Record<string, unknown> = {};
        for (const row of rows) {
          assert(!Object.hasOwn(out, String(row.anchor)), `${fn} of ${value} must give each anchor once, and gave ${String(row.anchor)} twice`);
          out[String(row.anchor)] = row.value;
        }
        return out;
      };
      const same = (actual: Record<string, unknown>, expected: Record<string, unknown>, message: string) =>
        assert(JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(Object.keys(expected).sort())
          && Object.entries(expected).every(([key, value]) => typeof value === "number" && typeof actual[key] === "number" ? Math.abs((actual[key] as number) - value) < 1e-9 : actual[key] === value),
        `${message}: expected ${describe(expected)} but got ${describe(actual)}`);
      same(await byAnchor("count", "rank"), { p1: 3, p2: 1, p4: 0 }, "count skips nulls, and an anchor that reaches no row is left out");
      same(await byAnchor("count", "id"), { p1: 4, p2: 1, p4: 1 }, "count of the key counts every row");
      same(await byAnchor("sum", "rank"), { p1: 8, p2: 5, p4: null }, "sum, null over only nulls");
      same(await byAnchor("avg", "rank"), { p1: 8 / 3, p2: 5, p4: null }, "avg of integers is fractional, null over only nulls");
      same(await byAnchor("min", "rank"), { p1: 1, p2: 5, p4: null }, "min, null over only nulls");
      same(await byAnchor("max", "rank"), { p1: 5, p2: 5, p4: null }, "max, null over only nulls");
      for (const fn of ["count", "sum", "avg"] as const)
        for (const value of Object.values(await byAnchor(fn, "rank"))) assert(value === null || typeof value === "number", `${fn} must be a number, not ${describe(value)}`);
      const earliest = await byAnchor("min", "createdAt", ["p1"]);
      assert(earliest.p1 instanceof Date && earliest.p1.getTime() === day(2).getTime(), `min of a date must be a Date, not ${describe(earliest.p1)}`);
      const latest = await byAnchor("max", "createdAt", ["p1"]);
      assert(latest.p1 instanceof Date && latest.p1.getTime() === day(4).getTime(), `max of a date must be a Date, not ${describe(latest.p1)}`);
      same(await byAnchor("count", "id", ["p3"]), {}, "a rollup whose anchors reach no row returns no row");
      assert((await run((tx) => tx.rollup(query("sum", "rank", [])))).length === 0, "a rollup with no anchor returns no row");
      for (const name of ["nope", "constructor"]) {
        assert(await failure(layer, (tx) => tx.rollup(query("max", name))) instanceof FrameworkError, `a rollup of the column ${name} must be a FrameworkError`);
        assert(await failure(layer, (tx) => tx.rollup({ ...query("count", "id"), anchor: name })) instanceof FrameworkError, `a rollup anchored on the column ${name} must be a FrameworkError`);
      }
      const many = Array.from({ length: 501 }, (_, index) => `x${index}`);
      assert(await failure(layer, (tx) => tx.rollup(query("count", "id", many))) instanceof FrameworkError, "a rollup of more than 500 anchors must be a FrameworkError");
      same(await byAnchor("count", "id", many.slice(0, 500)), {}, "a rollup takes 500 anchors");
      const inside = await run(async (tx) => {
        await tx.insert(taskTable, { id: "a9", parentId: "p3", createdAt: day(7), title: "India", rank: 42 });
        return tx.rollup(query("sum", "rank", ["p3"]));
      });
      assert(inside.length === 1 && inside[0]!.anchor === "p3" && inside[0]!.value === 42, `a rollup must see the transaction's own insert, and gave ${describe(inside)}`);
    })],
    ["rollup with hops follows a joined route and counts each row it reaches once per anchor", withTasks(async (_read, { layer, taskTable }) => {
      const run = <T>(use: (tx: DataOperations) => Promise<T>) => layer.transaction(use);
      // A task's parent (belongs-to): `id` of the parent row equals the task's `parentId`. Its children (has-many): the
      // rows whose `parentId` is the task's `id`.
      const parent = { hop: { table: taskTable, column: "id", outer: "parentId", key: "id" } };
      const children = { hop: { table: taskTable, column: "parentId", outer: "id", key: "id" } };
      const query = (fn: RollupFn, value: string, hops: RollupQuery["hops"], anchors: readonly string[]): RollupQuery =>
        ({ fn, table: taskTable, anchor: "id", anchors, value, hops, key: "id" });
      if (!declared("aggregates") || !declared("joins")) {
        if (declared("aggregates"))
          assert(await failure(layer, (tx) => tx.rollup(query("count", "id", [parent], ["a2"]))) instanceof FrameworkError, "an adapter without joins must refuse a rollup with hops with FrameworkError");
        return;
      }
      // p1 (rank 10) is a root; p2 (rank 20) is a child of p1. a2, a3, a4, a6 and p2 are p1's children; a5 is p2's.
      await run(async (tx) => {
        await tx.insert(taskTable, { id: "p1", parentId: null, createdAt: day(6), title: "Papa", rank: 10 });
        await tx.insert(taskTable, { id: "p2", parentId: "p1", createdAt: day(7), title: "Quebec", rank: 20 });
      });
      const byAnchor = async (rollup: RollupQuery) => {
        const out: Record<string, unknown> = {};
        for (const row of await run((tx) => tx.rollup(rollup))) {
          assert(!Object.hasOwn(out, String(row.anchor)), `a rollup with hops must give each anchor once, and gave ${String(row.anchor)} twice`);
          out[String(row.anchor)] = row.value;
        }
        return out;
      };
      const same = (actual: Record<string, unknown>, expected: Record<string, unknown>, message: string) =>
        assert(describe(Object.fromEntries(Object.entries(actual).sort())) === describe(Object.fromEntries(Object.entries(expected).sort())), `${message}: expected ${describe(expected)} but got ${describe(actual)}`);
      // One hop from the owner table: each task's parent. a1 has no parent (a null key adds nothing), a5's is p2.
      same(await byAnchor(query("max", "rank", [parent], ["a1", "a2", "a5", "p2"])), { a2: 10, a5: 20, p2: 10 }, "a hop that matches nothing leaves the anchor out");
      // Children, then their parent: p1's five children all reach p1, which counts once (R12).
      same(await byAnchor(query("count", "id", [children, parent], ["p1"])), { p1: 1 }, "a row reached by several paths counts once");
      same(await byAnchor(query("sum", "rank", [children, parent], ["p1"])), { p1: 10 }, "a row reached by several paths is summed once");
      // Children of children: p1 reaches a5 through p2; p2 reaches nothing two hops down.
      same(await byAnchor(query("sum", "rank", [children, children], ["p1", "p2"])), { p1: 5 }, "two has-many hops");
      // a3's parent's children: p1's five children, a3 itself among them; ranks 1, null, 5, 2 and 20.
      same(await byAnchor(query("count", "rank", [parent, children], ["a3"])), { a3: 4 }, "count skips nulls over a joined route");
      same(await byAnchor(query("avg", "rank", [parent, children], ["a3"])), { a3: 7 }, "avg over a joined route");
      const earliest = await byAnchor(query("min", "createdAt", [parent, children], ["a3"]));
      assert(earliest.a3 instanceof Date && earliest.a3.getTime() === day(2).getTime(), `min of a date over a joined route must be a Date, not ${describe(earliest.a3)}`);
      assert((await run((tx) => tx.rollup(query("sum", "rank", [parent], [])))).length === 0, "a rollup with hops and no anchor returns no row");
      for (const name of ["nope", "constructor"]) {
        assert(await failure(layer, (tx) => tx.rollup(query("count", "id", [{ hop: { ...parent.hop, column: name } }], ["a2"]))) instanceof FrameworkError, `a hop on the column ${name} must be a FrameworkError`);
        assert(await failure(layer, (tx) => tx.rollup(query("count", "id", [{ hop: { ...parent.hop, outer: name } }], ["a2"]))) instanceof FrameworkError, `a hop from the column ${name} must be a FrameworkError`);
        assert(await failure(layer, (tx) => tx.rollup({ ...query("count", "id", [parent], ["a2"]), key: name })) instanceof FrameworkError, `a rollup keyed on the column ${name} must be a FrameworkError`);
      }
      assert(await failure(layer, (tx) => tx.rollup(query("count", "id", [], ["a2"]))) instanceof FrameworkError, "a rollup with an empty list of hops must be a FrameworkError");
      // Two different rows with one value both count (R12: each reached row once, not each distinct value). a7 gives p1
      // a sixth child whose rank, 5, is a4's: a3's parent's children now rank 1, null, 5, 2, 20 and 5.
      await run((tx) => tx.insert(taskTable, { id: "a7", parentId: "p1", createdAt: day(8), title: "Golf", rank: 5 }));
      same(await byAnchor(query("count", "rank", [parent, children], ["a3"])), { a3: 5 }, "two rows with one value count twice over a joined route");
      same(await byAnchor(query("sum", "rank", [parent, children], ["a3"])), { a3: 33 }, "two rows with one value are both summed over a joined route");
      same(await byAnchor(query("avg", "rank", [parent, children], ["a3"])), { a3: 33 / 5 }, "two rows with one value both weigh in an average over a joined route");
    })],
    ["reads on an empty table return nothing and aggregates are null or 0", withFixture(async ({ layer, uuidTable }) => {
      await layer.transaction(async (tx) => {
        assert((await tx.select(uuidTable)).length === 0, "select on an empty table must return no rows");
        assert((await tx.select(uuidTable, { filter: { label: { eq: "x" } }, sort: ["-label"], limit: 5, offset: 2 })).length === 0, "a full query on an empty table must return no rows");
        assert(await tx.selectByKey(uuidTable, { id: "none" }) === undefined, "selectByKey on an empty table must return undefined");
        assert(await tx.selectByKeyForUpdate(uuidTable, { id: "none" }) === undefined, "read for update on an empty table must return undefined");
        if (declared("aggregates")) {
          assert(await tx.max(uuidTable, "label") === null, "max on an empty table must be null");
          assert(await tx.count(uuidTable, "label") === 0, "count on an empty table must be 0");
          assert(await tx.max(uuidTable, "id", { label: { eq: "x" } }) === null, "filtered max on an empty table must be null");
        }
      });
    })],
    ["a joined call that fails rejects the commit even when the outer callback catches it", withFixture(async ({ layer, uuidTable }) => {
      const inner = new Error("inner failed");
      let caught: unknown;
      try {
        await layer.transaction(async (tx) => {
          await tx.insert(uuidTable, { label: "outer" });
          try { await layer.transaction(async (joined) => { await joined.insert(uuidTable, { label: "inner" }); throw inner; }); }
          catch { /* the outer callback swallows the failure */ }
        });
      } catch (cause) { caught = cause; }
      assert(caught instanceof FrameworkError, "a caught joined failure must reject the commit with a FrameworkError");
      assert((caught as Error).cause === inner, "the rejection must carry the inner error as its cause");
      assert((await layer.transaction((tx) => tx.select(uuidTable))).length === 0, "nothing of a poisoned transaction may commit, the outer write included");
      // The failure marks that transaction only: the next one commits normally.
      await layer.transaction((tx) => tx.insert(uuidTable, { label: "fine" }));
      assert((await layer.transaction((tx) => tx.select(uuidTable))).length === 1, "a later transaction must commit");
    })],
    ["a statement the database refuses and the callback catches never lets the transaction resolve as if it wrote nothing", withFixture(async ({ layer, uuidTable }) => {
      // SQLite leaves the transaction usable and commits the rest; a server dialect aborts it and must then reject.
      const first = "00000000-0000-4000-8000-0000000000a1";
      const second = "00000000-0000-4000-8000-0000000000a2";
      let refused: unknown;
      const outcome = await failure(layer, async (tx) => {
        await tx.insert(uuidTable, { id: first, label: "first" });
        try { await tx.insert(uuidTable, { id: first, label: "duplicate key" }); } catch (cause) { refused = cause; }
        await tx.insert(uuidTable, { id: second, label: "second" }).catch(() => undefined);
      });
      assert(refused !== undefined, "inserting a duplicate primary key must reject");
      const stored = (await layer.transaction((tx) => tx.select(uuidTable))).map((row) => String(row.id)).sort();
      if (outcome === undefined) {
        assert(JSON.stringify(stored) === JSON.stringify([first, second]), `a transaction that resolved must have committed everything outside the refused statement, got ${stored.join(",") || "nothing"}`);
      } else {
        assert(outcome instanceof Error, `a transaction that rejected must reject with an error, got ${describe(outcome)}`);
        assert(stored.length === 0, `a transaction that rejected must have committed nothing, got ${stored.join(",")}`);
      }
    })],
    ["a joined callback that throws synchronously rejects the commit too", withFixture(async ({ layer, uuidTable }) => {
      let caught: unknown;
      try {
        await layer.transaction(async (tx) => {
          await tx.insert(uuidTable, { label: "outer" });
          try {
            // Not async: it throws before it can return a promise.
            await layer.transaction(((): Promise<void> => { throw new Error("sync"); }) as never);
          } catch { /* swallowed */ }
        });
      } catch (cause) { caught = cause; }
      assert(caught instanceof FrameworkError, "a synchronous throw in a joined callback must reject the commit");
      assert((await layer.transaction((tx) => tx.select(uuidTable))).length === 0, "nothing of that transaction may commit");
    })],
    ["one failing joined call among parallel ones rolls back all of them", withFixture(async ({ layer, uuidTable }) => {
      const failed = new Error("b failed");
      let ranAfter = 0;
      let results: PromiseSettledResult<void>[] = [];
      const outcome = await failure(layer, async () => {
        // Joined calls run one at a time, in call order (base suite): a runs, b fails, c's turn comes after the failure.
        results = await Promise.allSettled([
          layer.transaction(async (tx) => { await tx.insert(uuidTable, { label: "a" }); }),
          layer.transaction(async (tx) => { await tx.insert(uuidTable, { label: "b" }); throw failed; }),
          layer.transaction(async (tx) => { ranAfter++; await tx.insert(uuidTable, { label: "c" }); }),
        ]);
      });
      const [a, b, c] = results;
      assert(a?.status === "fulfilled", "a joined call made before the failure must run");
      assert(b?.status === "rejected" && b.reason === failed, "the failing joined call must reject with its own error");
      assert(c?.status === "rejected" && c.reason instanceof FrameworkError && c.reason.cause === failed,
        "a joined call whose turn comes after a failure must be refused with a FrameworkError whose cause is that failure");
      assert(ranAfter === 0, "a joined call whose turn comes after a failure must not run");
      assert(outcome instanceof FrameworkError, "the outer call must reject after a parallel joined call failed");
      assert((await layer.transaction((tx) => tx.select(uuidTable))).length === 0, "no parallel joined write may commit");
    })],
    ["refuseIfFailed says whether a call made here joins a running transaction", withFixture(async ({ layer, uuidTable }) => {
      assert(answer(() => layer.refuseIfFailed()) === false, "refuseIfFailed must return false at top level");
      let inside: unknown, joined: unknown, nested: unknown, elsewhere: unknown;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      let late!: Promise<unknown>;
      let ended!: () => void;
      const afterCommit = new Promise<void>((resolve) => { ended = resolve; });
      const work = layer.transaction(async (tx) => {
        inside = answer(() => layer.refuseIfFailed());
        await layer.transaction(async () => {
          joined = answer(() => layer.refuseIfFailed());
          await layer.transaction(async () => { nested = answer(() => layer.refuseIfFailed()); });
        });
        await tx.insert(uuidTable, { label: "kept" });
        // Started here, but answered only after the transaction committed: a call made then starts its own.
        late = afterCommit.then(() => answer(() => layer.refuseIfFailed()));
        started();
        await gate;
      });
      await running;
      // The test's own async context is not inside that transaction, even while it is open.
      elsewhere = answer(() => layer.refuseIfFailed());
      open();
      await work;
      ended();
      assert(inside === true, "refuseIfFailed must return true inside a transaction's callback");
      assert(joined === true, "refuseIfFailed must return true inside a joined call");
      assert(nested === true, "refuseIfFailed must return true inside a call joined from a joined call");
      assert(elsewhere === false, "refuseIfFailed must return false from another async context while a transaction is open");
      assert(await late === false, "refuseIfFailed must return false from a continuation of the callback that runs after the transaction committed");
      assert(answer(() => layer.refuseIfFailed()) === false, "refuseIfFailed must return false once the transaction settled");
      assert((await layer.transaction((tx) => tx.select(uuidTable))).length === 1, "asking refuseIfFailed must not change what commits");
    })],
    ["a call that joins a failed transaction is refused before it runs, and refuseIfFailed refuses only there", withFixture(async ({ layer, uuidTable }) => {
      const first = new Error("first");
      assert(answer(() => layer.refuseIfFailed()) === false, "refuseIfFailed must return false outside a transaction");
      let healthy: unknown, probed: unknown, refused: unknown, again: unknown, queuedAnswer: unknown;
      let ran = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let marked!: () => void;
      const failed = new Promise<void>((resolve) => { marked = resolve; });
      const outcomeOf = failure(layer, async (tx) => {
        healthy = answer(() => layer.refuseIfFailed());
        await tx.insert(uuidTable, { label: "outer" });
        await layer.transaction(async () => { throw first; }).catch(() => undefined);
        probed = answer(() => layer.refuseIfFailed());
        refused = await layer.transaction(async (joined) => { ran++; await joined.insert(uuidTable, { label: "after" }); }).then(() => "ran", (cause: unknown) => cause);
        // A refusal does not clear the mark: the call after it is refused too.
        again = await layer.transaction(async () => { ran++; }).then(() => "ran", (cause: unknown) => cause);
        // Held open, failed, while the test asks from its own context.
        marked();
        await gate;
      });
      await failed;
      // The failure belongs to that transaction: another request's call is neither refused nor told it would join.
      const elsewhere = answer(() => layer.refuseIfFailed());
      // A top-level transaction queued while the failed one is still open runs and commits after it.
      const queued = layer.transaction(async (tx) => {
        queuedAnswer = answer(() => layer.refuseIfFailed());
        await tx.insert(uuidTable, { label: "queued" });
      }).then(() => "committed", (cause: unknown) => cause);
      open();
      const outcome = await outcomeOf;
      const queuedOutcome = await queued;
      assert(healthy === true, "refuseIfFailed must return true inside a transaction that has not failed");
      assert(probed instanceof FrameworkError && probed.cause === first, "refuseIfFailed inside a failed transaction must throw a FrameworkError whose cause is the first failure");
      assert(refused instanceof FrameworkError && refused.cause === first, "a call that joins a failed transaction must be refused with a FrameworkError whose cause is the first failure");
      assert(again instanceof FrameworkError && again.cause === first, "every later call that joins a failed transaction must be refused");
      assert(ran === 0, "a call that joins a failed transaction must not run");
      assert(elsewhere === false, `refuseIfFailed from another async context while a failed transaction is still open must return false, not refuse; got ${describe(elsewhere)}`);
      assert(outcome instanceof FrameworkError && outcome.cause === first, "the outer call must still reject with the first failure as its cause");
      assert(queuedOutcome === "committed", `a top-level transaction queued while a failed one is open must commit once it settles; got ${describe(queuedOutcome)}`);
      assert(queuedAnswer === true, "refuseIfFailed inside the queued transaction must return true, not carry the earlier failure");
      const stored = (await layer.transaction((tx) => tx.select(uuidTable))).map((row) => row.label);
      assert(stored.length === 1 && stored[0] === "queued", `nothing of a failed transaction may commit, and the queued one must: got ${JSON.stringify(stored)}`);
      assert(answer(() => layer.refuseIfFailed()) === false, "refuseIfFailed must return false once the failed transaction settled");
    })],
    ["selectByKey and selectByKeyForUpdate return the same row by value", withTasks(async (_read, { layer, taskTable }) => {
      // An update reads its row with selectByKeyForUpdate and, after a nested write, compares it with a selectByKey of
      // the same row: two reads that decode a value differently would refuse every composing update.
      await layer.transaction(async (tx) => {
        for (const task of TASKS) {
          const key = { id: task.id as string };
          const plain = await tx.selectByKey(taskTable, key);
          const locked = await tx.selectByKeyForUpdate(taskTable, key);
          assert(plain !== undefined && sameValue(plain, locked), `selectByKey and selectByKeyForUpdate of ${key.id} must be equal by value: ${describe(plain)} and ${describe(locked)}`);
          assert(sameValue(plain, task), `selectByKey of ${key.id} must return the row as inserted: ${describe(plain)}`);
        }
      });
    })],
    ["parallel inserts with integer fill get distinct consecutive keys", withFixture(async ({ layer, integerTable }) => {
      if (!declared("integer-key-fill")) return;
      assert(integerTable !== undefined, "integer-key-fill needs the fixture's integerTable");
      const direct = await layer.transaction((tx) => Promise.all(Array.from({ length: 25 }, (_, index) => tx.insert(integerTable, { label: `p${index}` }))));
      assert(direct.map((row) => row.seq).sort((a, b) => Number(a) - Number(b)).join() === Array.from({ length: 25 }, (_, index) => index + 1).join(), "parallel inserts must get keys 1 to 25");
      const joined = await layer.transaction(() => Promise.all(Array.from({ length: 10 }, (_, index) =>
        layer.transaction((tx) => tx.insert(integerTable, { label: `j${index}` })))));
      assert(joined.map((row) => row.seq).sort((a, b) => Number(a) - Number(b)).join() === Array.from({ length: 10 }, (_, index) => index + 26).join(), "parallel joined calls must continue the same sequence");
      const stored = (await layer.transaction((tx) => tx.select(integerTable))).map((row) => row.seq);
      assert(stored.length === 35 && stored.every((seq, index) => seq === index + 1), "every key must be stored once");
    })],
    ["a text primary key left out is a UUIDv7 and ids sort in creation order", withFixture(async ({ layer, uuidTable }) => {
      const before = Date.now();
      const made: string[] = [];
      await layer.transaction(async (tx) => {
        for (let index = 0; index < 200; index++) {
          const row = await tx.insert(uuidTable, { label: `n${index}` });
          assert(typeof row.id === "string" && V7.test(row.id), `insert must return a UUIDv7 id, got ${String(row.id)}`);
          made.push(row.id);
        }
      });
      const after = Date.now();
      for (let index = 1; index < made.length; index++) assert(made[index - 1]! < made[index]!, "ids made one after another must sort in creation order, even inside one millisecond");
      const stamp = parseInt(made[0]!.replaceAll("-", "").slice(0, 12), 16);
      assert(stamp >= before - 1 && stamp <= after + 1, "the id must carry the creation time");
      const stored = await layer.transaction((tx) => tx.select(uuidTable));
      assert(stored.map((row) => row.id).join() === made.join(), "reading in key order must return rows in creation order");
      assert(stored.map((row) => row.label).join() === made.map((_, index) => `n${index}`).join(), "each id must belong to its own row");
      // Two creates in separate transactions keep the order too.
      const first = await layer.transaction((tx) => tx.insert(uuidTable, { label: "x" }));
      const second = await layer.transaction((tx) => tx.insert(uuidTable, { label: "y" }));
      assert(String(first.id) < String(second.id), "ids from separate transactions must sort in creation order");
    })],
    ["a key the caller supplies is stored as given", withFixture(async ({ layer, uuidTable }) => {
      const row = await layer.transaction((tx) => tx.insert(uuidTable, { id: "my-own-id", label: "mine" }));
      assert(row.id === "my-own-id", "a supplied text key must be kept");
      const error = await failure(layer, (tx) => tx.insert(uuidTable, { id: "my-own-id", label: "again" }));
      assert(error instanceof FrameworkError, "a duplicate key must be a FrameworkError");
    })],
    ["an integer primary key is filled with the next integer, with no gap after a rollback", withFixture(async ({ layer, integerTable }) => {
      if (!declared("integer-key-fill")) {
        if (integerTable === undefined) return;
        const error = await failure(layer, (tx) => tx.insert(integerTable, { label: "x" }));
        assert(error instanceof FrameworkError, "an adapter without integer-key-fill must refuse an integer key left out");
        return;
      }
      assert(integerTable !== undefined, "integer-key-fill needs the fixture's integerTable");
      const kept: number[] = [];
      for (let index = 1; index <= 1000; index++) {
        const write = (tx: DataOperations) => tx.insert(integerTable, { label: `n${index}` });
        if (index % 10 === 0) {
          const error = await failure(layer, async (tx) => { await write(tx); throw new Error("rolled back"); });
          assert((error as Error).message === "rolled back", "the rollback error must propagate");
        } else {
          const row = await layer.transaction(write);
          kept.push(row.seq as number);
        }
      }
      const stored = (await layer.transaction((tx) => tx.select(integerTable))).map((row) => row.seq);
      assert(stored.length === 900, `900 rows must be stored, got ${stored.length}`);
      assert(stored.every((seq, index) => seq === index + 1), "keys must be 1 to the count, with no gap");
      assert(kept.every((seq, index) => seq === index + 1), "each insert must return the key it was given");
    })],
    ["integer keys count on from the highest stored key, and inside one transaction", withFixture(async ({ layer, integerTable }) => {
      if (!declared("integer-key-fill")) return;
      assert(integerTable !== undefined, "integer-key-fill needs the fixture's integerTable");
      const keys = await layer.transaction(async (tx) => {
        const one = await tx.insert(integerTable, { label: "a" });
        const two = await tx.insert(integerTable, { label: "b" });
        const own = await tx.insert(integerTable, { seq: 100, label: "own" });
        const next = await tx.insert(integerTable, { label: "c" });
        return [one.seq, two.seq, own.seq, next.seq];
      });
      assert(keys.join() === "1,2,100,101", `keys must continue from the highest, got ${keys.join()}`);
      await layer.transaction((tx) => tx.deleteByKey(integerTable, { seq: 101 }));
      const reused = await layer.transaction((tx) => tx.insert(integerTable, { label: "d" }));
      assert(reused.seq === 101, "the next key is the highest stored plus one, so a deleted highest key is reused");
      const joined = await layer.transaction(async (tx) => {
        const outer = await tx.insert(integerTable, { label: "outer" });
        const inner = await layer.transaction((nested) => nested.insert(integerTable, { label: "inner" }));
        return [outer.seq, inner.seq];
      });
      assert(joined.join() === "102,103", "a joined call must continue the same sequence");
    })],
    ...policyGuardChecks(withTasks, declared),
  ]);
}

// ---- policy-guards: a delete that checks the policies in its own statement (ADR-0046, option B) ----------------------

type WithTasks = (run: (read: (query?: Query) => Promise<string[]>, fixture: DataLayerFixtureV1) => Promise<void>) => () => Promise<void>;

const col = (name: string, cls: "string" | "integer" | "date" = "string"): Condition => ({ kind: "column", depth: 0, name, class: cls });
const val = (value: string | number | Date | null, cls: "string" | "integer" | "date" = "string"): Condition => ({ kind: "value", value, class: cls });
const eqc = (a: Condition, b: Condition): Condition => ({ kind: "call", fn: "eq", args: [a, b] });
/** One policy of `authorize` checks (any one true), or `null` when none decides; `forbid` checks must all be false. */
const pol = (authorize: readonly number[] | null, forbid: readonly number[] = []) => ({ authorize, forbid });

/**
 * The checks run only for an adapter that declares `policy-guards`; the manifest check above asserts that
 * `deleteByKeyGuarded` is present exactly then. Conditions are bound trees, as the authorizer hands them over.
 */
function policyGuardChecks(withTasks: WithTasks, declared: (name: string) => boolean): (readonly [string, () => Promise<void>])[] {
  const guardedCheck = (name: string, run: Parameters<WithTasks>[0]) =>
    [`policy-guards: ${name}`, withTasks(async (read, fixture) => { if (declared("policy-guards")) await run(read, fixture); })] as const;
  /** The outcome of one guarded delete in its own transaction: true/false as returned, or the error. */
  const attempt = async (layer: DataLayer, table: TableHandle, key: Key, guard: WriteGuard): Promise<unknown> => {
    try { return await layer.transaction((tx) => tx.deleteByKeyGuarded!(table, key, guard)); } catch (error) { return error; }
  };
  const denied = (outcome: unknown, results: readonly (boolean | null)[], message: string) => {
    assert(outcome instanceof PolicyGuardDenial, `${message}: expected PolicyGuardDenial, got ${describe(outcome)}`);
    assert(describe(outcome.results) === describe(results), `${message}: expected results ${describe(results)}, got ${describe(outcome.results)}`);
  };
  const ALL = ["a1", "a2", "a3", "a4", "a5", "a6"];
  return [
    guardedCheck("a guard that admits deletes the row; one that denies deletes nothing and reports every check's result", async (read, { layer, taskTable }) => {
      const title = (t: string) => eqc(col("title"), val(t));
      // a2 is Bravo in p1.
      const outcome = await attempt(layer, taskTable, { id: "a2" }, { checks: [title("Nope"), eqc(col("parentId"), val("p1"))], policies: [pol([0], [1])] });
      denied(outcome, [false, true], "an authorize check false and a forbid check true");
      await expectSame(read, ALL, "a denied delete deletes nothing");
      const admitted = await attempt(layer, taskTable, { id: "a2" }, { checks: [title("Bravo"), eqc(col("parentId"), val("p9"))], policies: [pol([0], [1])] });
      assert(admitted === true, `an admitted guarded delete returns true, got ${describe(admitted)}`);
      await expectSame(read, ["a1", "a3", "a4", "a5", "a6"], "an admitted delete deletes the row");
    }),
    guardedCheck("a missing key returns false and raises nothing, even with a guard that would deny", async (read, { layer, taskTable }) => {
      const outcome = await attempt(layer, taskTable, { id: "missing" }, { checks: [false], policies: [pol([0])] });
      assert(outcome === false, `a guarded delete of a missing key returns false, got ${describe(outcome)}`);
      await expectSame(read, ALL, "nothing is deleted");
    }),
    guardedCheck("an unknown check fails closed: an unknown authorize-if does not authorize and an unknown forbid-if forbids", async (read, { layer, taskTable }) => {
      // a3's rank and a1's parentId are null, so a comparison with them is unknown.
      const rank = eqc(col("rank", "integer"), val(3, "integer"));
      denied(await attempt(layer, taskTable, { id: "a3" }, { checks: [rank], policies: [pol([0])] }), [null], "an unknown authorize-if");
      denied(await attempt(layer, taskTable, { id: "a3" }, { checks: [rank], policies: [pol(null, [0])] }), [null], "an unknown forbid-if");
      denied(await attempt(layer, taskTable, { id: "a1" }, { checks: [eqc(col("parentId"), val(null))], policies: [pol([0])] }), [null], "a comparison with null");
      await expectSame(read, ALL, "nothing is deleted");
    }),
    guardedCheck("a check false on every row but the keyed one does not deny the keyed delete", async (read, { layer, taskTable }) => {
      // The check is false on every row but a5: a delete of a5 must not raise for them. This shows the outcome only; it
      // cannot show that the guard is never evaluated on another row, because an adapter that looks the row up by its
      // key never reaches the others whatever its statement says. The key inside the guard's CASE (R6) is pinned by the
      // printed-SQL test of deleteByKeyGuarded in data-drizzle's test/operations.test.ts.
      const outcome = await attempt(layer, taskTable, { id: "a5" }, { checks: [eqc(col("id"), val("a5"))], policies: [pol([0])] });
      assert(outcome === true, `a guard true on the keyed row admits it whatever it gives on others, got ${describe(outcome)}`);
      await expectSame(read, ["a1", "a2", "a3", "a4", "a6"], "only the keyed row is deleted");
    }),
    guardedCheck("within a policy the authorize checks combine with OR and the forbid checks with NOR; across policies, AND", async (read, { layer, taskTable }) => {
      const cases: [string, WriteGuard, boolean][] = [
        ["one of two authorize checks true", { checks: [false, true], policies: [pol([0, 1])] }, true],
        ["no authorize check true", { checks: [false, null], policies: [pol([0, 1])] }, false],
        ["an empty authorize list authorizes nothing", { checks: [true], policies: [pol([])] }, false],
        ["authorize null: only the forbid checks decide", { checks: [false, false], policies: [pol(null, [0, 1])] }, true],
        ["one forbid check true among false ones", { checks: [false, true], policies: [pol(null, [0, 1])] }, false],
        ["a forbid check true beats an authorize check true", { checks: [true, true], policies: [pol([0], [1])] }, false],
        ["two policies that both pass", { checks: [true, false], policies: [pol([0]), pol(null, [1])] }, true],
        ["two policies, the second fails", { checks: [true, true], policies: [pol([0]), pol(null, [1])] }, false],
        ["a check no policy indexes still decides nothing", { checks: [false, true], policies: [pol(null), pol([1])] }, true],
        ["no policy at all admits", { checks: [false], policies: [] }, true],
      ];
      for (const [name, guard, admits] of cases) {
        const outcome = await attempt(layer, taskTable, { id: "a4" }, guard);
        if (admits) {
          assert(outcome === true, `${name}: expected the delete, got ${describe(outcome)}`);
          await layer.transaction((tx) => tx.insert(taskTable, TASKS[3]!));
        } else denied(outcome, guard.checks as readonly (boolean | null)[], name);
      }
      await expectSame(read, ALL, "every denied case deleted nothing");
    }),
    guardedCheck("parameters of each class compare as stored: a date, an integer and text", async (read, { layer, taskTable }) => {
      const before: Condition = { kind: "call", fn: "lt", args: [col("createdAt", "date"), val(day(3), "date")] };
      const rank: Condition = { kind: "call", fn: "gte", args: [col("rank", "integer"), val(5, "integer")] };
      // a4: created on day 3, rank 5, title Delta.
      denied(await attempt(layer, taskTable, { id: "a4" }, { checks: [before, rank, eqc(col("title"), val("Delta"))], policies: [pol([0], [1, 2])] }), [false, true, true], "a4");
      assert(await attempt(layer, taskTable, { id: "a2" }, { checks: [before, rank], policies: [pol([0], [1])] }) === true, "a2 is created before day 3 with rank 1, so it is admitted");
      await expectSame(read, ["a1", "a3", "a4", "a5", "a6"], "only a2 is deleted");
    }),
    guardedCheck("a check that crosses a relationship reads the related row, the table's own included", async (read, { layer, taskTable }) => {
      if (!declared("joins")) return;
      // A task's parent, a row of the same table: `one` over the belongs-to.
      await layer.transaction((tx) => tx.insert(taskTable, { id: "p1", parentId: null, createdAt: day(6), title: "Papa", rank: 10 }));
      const parentTitle = (title: string): Condition =>
        eqc({ kind: "one", hop: { table: taskTable, column: "id", outer: "parentId", key: "id" }, value: { kind: "column", depth: 1, name: "title", class: "string" } }, val(title));
      denied(await attempt(layer, taskTable, { id: "a2" }, { checks: [parentTitle("Quebec")], policies: [pol([0])] }), [false], "a parent with another title");
      // a5's parent p2 has no row, so the related value is null and the check unknown.
      denied(await attempt(layer, taskTable, { id: "a5" }, { checks: [parentTitle("Papa")], policies: [pol([0])] }), [null], "no related row");
      assert(await attempt(layer, taskTable, { id: "a2" }, { checks: [parentTitle("Papa")], policies: [pol([0])] }) === true, "a parent with that title admits");
      await expectSame(read, ["a1", "a3", "a4", "a5", "a6", "p1"], "only a2 is deleted");
    }),
    guardedCheck("a denial inside a transaction that then rolls back leaves the table unchanged", async (read, { layer, taskTable }) => {
      let reported: unknown;
      const outcome = await failure(layer, async (tx) => {
        await tx.deleteByKey(taskTable, { id: "a1" });
        try { await tx.deleteByKeyGuarded!(taskTable, { id: "a2" }, { checks: [false], policies: [pol([0])] }); } catch (error) { reported = error; }
        throw new Error("roll back");
      });
      denied(reported, [false], "inside a transaction");
      assert(outcome instanceof Error, "the transaction rejects");
      await expectSame(read, ALL, "the rolled-back transaction changed nothing");
    }),
    guardedCheck("an integer key is cast to text in the marker", async (_read, { layer, integerTable }) => {
      if (integerTable === undefined) return;
      await layer.transaction((tx) => tx.insert(integerTable, { seq: 7, label: "seven" }));
      denied(await attempt(layer, integerTable, { seq: 7 }, { checks: [eqc(col("label"), val("eight"))], policies: [pol([0])] }), [false], "an integer key");
      assert(await attempt(layer, integerTable, { seq: 7 }, { checks: [eqc(col("label"), val("seven"))], policies: [pol([0])] }) === true, "the integer-keyed row is deleted when admitted");
    }),
    guardedCheck("a guard that points at a check it does not have is a FrameworkError and deletes nothing", async (read, { layer, taskTable }) => {
      for (const guard of [{ checks: [true], policies: [pol([1])] }, { checks: [true], policies: [pol(null, [-1])] }, { checks: "x", policies: [] }, { checks: [], policies: [{ forbid: "x", authorize: null }] }])
        assert(await attempt(layer, taskTable, { id: "a1" }, guard as never) instanceof FrameworkError, `the guard ${describe(guard)} must be refused`);
      await expectSame(read, ALL, "nothing is deleted");
    }),
  ];
}

async function expectSame(read: (query?: Query) => Promise<string[]>, expected: readonly string[], message: string): Promise<void> {
  const actual = await read();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${expected.join(",")} but got ${actual.join(",")}`);
}
