import { validateCapabilityManifest, type CapabilityManifest } from "./capabilities.ts";
import type { DataLayer, DataOperations, Query, Row, TableHandle } from "./data-layer.ts";
import { sameValue } from "./compose.ts";
import { FrameworkError } from "./errors.ts";
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
    ["an undefined query field is the same as an absent one", withTasks(async (read) => {
      const everything = await read({});
      await expectIds(read, { filter: undefined, sort: undefined, limit: undefined, offset: undefined }, everything, "all four undefined");
      await expectIds(read, { filter: undefined, sort: ["id"], limit: undefined, offset: undefined }, [...everything].sort(), "only sort given");
      const filter = { parentId: { eq: "p1" } };
      await expectIds(read, { filter, sort: ["createdAt", "id"], limit: 2, offset: undefined }, ["a2", "a3"], "offset undefined");
      await expectIds(read, { filter, sort: ["createdAt", "id"], limit: undefined, offset: 1 }, ["a3", "a4", "a6"], "limit undefined");
    })],
    ["a malformed query is a FrameworkError and reads nothing", withTasks(async (_read, fixture) => {
      for (const [query, message] of [
        [{ filter: { nope: { eq: 1 } } }, "an unknown attribute"],
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
  ]);
}
