import type { DataLayer, DataOperations, Key, Row, TableHandle } from "./data-layer.ts";
import { contractV1Checks, type DataLayerFixtureV1 } from "./conformance-v1.ts";
import type { CapabilityManifest } from "./capabilities.ts";
import { FrameworkError } from "./errors.ts";

export type { DataLayerFixtureV1 } from "./conformance-v1.ts";

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** A fresh isolated layer with an empty, prepared table. Supply two complete rows
 * with distinct primary keys, and non-key changes that change the sample row.
 * Every factory call must use the same schema and values for both rows.
 */
export interface DataLayerFixture {
  layer: DataLayer;
  table: TableHandle;
  sampleRow: Row;
  key: Key;
  /** A second schema-valid row, whose primary key differs from the sample's. */
  secondRow: Row;
  /** The same primary-key attribute names as key, with at least one different value. */
  secondKey: Key;
  changes: Row;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Data-layer conformance: ${message}`);
}

// Contract v0 rows contain scalar TypeScript attribute values, including Dates.
function equalValue(left: unknown, right: unknown): boolean {
  return left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : Object.is(left, right);
}

function sameRow(actual: Row | undefined, expected: Row): boolean {
  return actual !== undefined && Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every((name) => Object.hasOwn(actual, name) && equalValue(actual[name], expected[name]));
}

function rowEquals(actual: Row | undefined, expected: Row, message: string): void {
  assert(sameRow(actual, expected), message);
}

function rowsEqual(actual: Row[], expected: Row[], message: string): void {
  assert(actual.length === expected.length && expected.every((row) => actual.some((other) => sameRow(other, row))), message);
}

/** The contract v1 suite: the base checks plus reads, read for update, aggregates, keys and the manifest. */
export function dataLayerConformanceV1(makeLayer: () => Promise<DataLayerFixtureV1>, manifest: CapabilityManifest): Record<string, () => Promise<void>> {
  return { ...dataLayerConformance(makeLayer), ...contractV1Checks(makeLayer, manifest) };
}

/** Return named, runner-independent asynchronous checks for contract v0.
 * Add each entry to your test runner. Each check owns and closes its fresh
 * layers, including on failure; this module ships no adapter implementation.
 */
export function dataLayerConformance(makeLayer: () => Promise<DataLayerFixture>): Record<string, () => Promise<void>> {
  const withLayer = (run: (fixture: DataLayerFixture) => Promise<void>) => async () => {
    const fixture = await makeLayer();
    try {
      assert(Object.keys(fixture.key).length > 0, "fixture key must not be empty");
      assert(Object.keys(fixture.key).length === Object.keys(fixture.secondKey).length &&
        Object.keys(fixture.key).every((name) => Object.hasOwn(fixture.secondKey, name)), "fixture keys must name the same attributes");
      assert(!sameRow(fixture.key, fixture.secondKey), "fixture rows must have distinct keys");
      for (const [row, key] of [[fixture.sampleRow, fixture.key], [fixture.secondRow, fixture.secondKey]] as const) {
        assert(Object.keys(key).every((name) => Object.hasOwn(row, name) && equalValue(row[name], key[name])), "fixture row must contain its key values");
      }
      assert(Object.keys(fixture.changes).every((name) => !Object.hasOwn(fixture.key, name)), "fixture changes must not change the primary key");
      assert(Object.keys(fixture.changes).some((name) => !equalValue(fixture.changes[name], fixture.sampleRow[name])), "fixture changes must change a value");
      await fixture.layer.transaction(async (tx) => {
        assert((await tx.selectAll(fixture.table)).length === 0, "fixture table must start empty");
      });
      await run(fixture);
    } finally {
      await fixture.layer.close();
    }
  };

  return {
    "concurrent transactions never interleave statements": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      const started = gate();
      const resume = gate();
      const events: string[] = [];
      const first = layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        events.push("first write");
        started.release();
        await resume.promise;
        await tx.selectAll(table);
        events.push("first read");
      });
      await started.promise;
      const second = layer.transaction(async (tx) => {
        await tx.insert(table, secondRow);
        events.push("second write");
        await tx.selectAll(table);
        events.push("second read");
      });
      // Let an incorrectly concurrent callback advance before releasing the first:
      // a macrotask, so every pending microtask (and any driver step) runs first.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      resume.release();
      await Promise.all([first, second]);
      assert(events.join(",") === "first write,first read,second write,second read", "transactions must not interleave statements");
      await layer.transaction(async (tx) => rowsEqual(await tx.selectAll(table), [sampleRow, secondRow], "both queued transactions must commit"));
    }),
    "throw after a write leaves no row": withLayer(async ({ layer, table, sampleRow }) => {
      const error = new Error("throw after write");
      let caught: unknown;
      try { await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); throw error; }); }
      catch (cause) { caught = cause; }
      assert(caught === error, "throw after write must rethrow the same error");
      await layer.transaction(async (tx) => assert((await tx.selectAll(table)).length === 0, "throw after write must leave no row"));
    }),
    "rejected promise after a write leaves no row": withLayer(async ({ layer, table, sampleRow }) => {
      const error = new Error("rejection after write");
      let caught: unknown;
      try { await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); return Promise.reject(error); }); }
      catch (cause) { caught = cause; }
      assert(caught === error, "rejected promise must rethrow the same error");
      await layer.transaction(async (tx) => assert((await tx.selectAll(table)).length === 0, "rejected promise must leave no row"));
    }),
    "queue continues after a failed transaction": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      const error = new Error("queued failure");
      const first = layer.transaction(async (tx) => { await tx.insert(table, sampleRow); throw error; });
      const second = layer.transaction(async (tx) => { await tx.insert(table, secondRow); });
      const [failed, succeeded] = await Promise.allSettled([first, second]);
      assert(failed.status === "rejected" && failed.reason === error, "first queued transaction must fail unchanged");
      assert(succeeded.status === "fulfilled", "failed transaction must not poison the queue");
      await layer.transaction(async (tx) => rowsEqual(await tx.selectAll(table), [secondRow], "only successful queued write must persist"));
    }),
    "close with a transaction in flight rejects and leaves the layer open": withLayer(async ({ layer, table, sampleRow }) => {
      const started = gate();
      const resume = gate();
      const pending = layer.transaction(async (tx) => {
        started.release();
        await resume.promise;
        await tx.insert(table, sampleRow);
      });
      await started.promise;
      let caught: unknown;
      try { await layer.close(); } catch (cause) { caught = cause; }
      finally { resume.release(); await pending; }
      assert(caught instanceof FrameworkError, "close with an in-flight transaction must reject with FrameworkError");
      await layer.transaction(async (tx) => rowsEqual(await tx.selectAll(table), [sampleRow], "rejected close must leave the layer open and transaction able to commit"));
    }),
    "nested transaction joins the running one": withLayer(async ({ layer, table, sampleRow, secondRow, key, secondKey }) => {
      const value = await layer.transaction(async (outer) => {
        await outer.insert(table, sampleRow);
        const inner = await layer.transaction(async (tx) => {
          rowEquals(await tx.selectByKey(table, key), sampleRow, "a joined call must see the outer transaction's uncommitted write");
          await tx.insert(table, secondRow);
          return "inner";
        });
        rowEquals(await outer.selectByKey(table, secondKey), secondRow, "the outer transaction must see the joined call's write");
        return inner;
      });
      assert(value === "inner", "a joined call must return its own result");
      await layer.transaction(async (tx) => rowsEqual(await tx.selectAll(table), [sampleRow, secondRow], "both writes must commit together"));
    }),
    "a throw after a joined call rolls back both": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      const failure = new Error("after the inner call");
      let caught: unknown;
      try {
        await layer.transaction(async (outer) => {
          await outer.insert(table, sampleRow);
          await layer.transaction(async (tx) => { await tx.insert(table, secondRow); });
          throw failure;
        });
      } catch (cause) { caught = cause; }
      assert(caught === failure, "the outer error must be rethrown unchanged");
      await layer.transaction(async (tx) => assert((await tx.selectAll(table)).length === 0, "a throw after a joined call must roll back the outer and the inner write"));
    }),
    "a throw inside a joined call reaches the outer call and rolls back": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      const failure = new Error("inside the inner call");
      let caught: unknown;
      try {
        await layer.transaction(async (outer) => {
          await outer.insert(table, sampleRow);
          await layer.transaction(async (tx) => { await tx.insert(table, secondRow); throw failure; });
        });
      } catch (cause) { caught = cause; }
      assert(caught === failure, "the inner error must reach the caller unchanged");
      await layer.transaction(async (tx) => assert((await tx.selectAll(table)).length === 0, "a throw inside a joined call must roll back everything"));
    }),
    "joins nest more than one level and run in parallel": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      await layer.transaction(async () => {
        await layer.transaction(async () => {
          await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
        });
        await Promise.all([
          layer.transaction(async (tx) => { await tx.insert(table, secondRow); }),
          layer.transaction(async (tx) => { await tx.selectAll(table); }),
        ]);
      });
      await layer.transaction(async (tx) => rowsEqual(await tx.selectAll(table), [sampleRow, secondRow], "nested and parallel joined writes must commit"));
    }),
    "a call after the transaction ended starts a new one": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      let late: Promise<void> | undefined;
      await layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        late = Promise.resolve().then(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await layer.transaction(async (next) => { await next.insert(table, secondRow); }); });
      });
      await late;
      await layer.transaction(async (tx) => rowsEqual(await tx.selectAll(table), [sampleRow, secondRow], "a late call must commit as its own transaction"));
    }),
    "insert returns the stored row": withLayer(async ({ layer, table, sampleRow, key }) => {
      await layer.transaction(async (tx) => {
        const stored = await tx.insert(table, sampleRow);
        rowEquals(stored, sampleRow, "insert must return the complete sample row");
        rowEquals(await tx.selectByKey(table, key), stored, "insert result must match storage");
      });
    }),
    "selectByKey after insert": withLayer(async ({ layer, table, sampleRow, key }) => {
      await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, key), sampleRow, "selectByKey must find committed row");
      });
    }),
    "selectAll returns stored rows": withLayer(async ({ layer, table, sampleRow, secondRow }) => {
      await layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        await tx.insert(table, secondRow);
      });
      await layer.transaction(async (tx) => {
        rowsEqual(await tx.selectAll(table), [sampleRow, secondRow], "selectAll must return both complete rows, in any order");
      });
    }),
    "selectByKey selects only the named row": withLayer(async ({ layer, table, sampleRow, key, secondRow, secondKey }) => {
      await layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        await tx.insert(table, secondRow);
      });
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, secondKey), secondRow, "selectByKey must select the second row by key");
        rowEquals(await tx.selectByKey(table, key), sampleRow, "selectByKey must select the first row by key");
      });
    }),
    "updateByKey changes only the named row": withLayer(async ({ layer, table, sampleRow, secondRow, secondKey, changes }) => {
      await layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        await tx.insert(table, secondRow);
      });
      const expected = { ...secondRow, ...changes };
      await layer.transaction(async (tx) => {
        rowEquals(await tx.updateByKey(table, secondKey, changes), expected, "updateByKey must return the named second row");
      });
      await layer.transaction(async (tx) => {
        rowsEqual(await tx.selectAll(table), [sampleRow, expected], "updateByKey must leave the unrelated row unchanged");
      });
    }),
    "deleteByKey deletes only the named row": withLayer(async ({ layer, table, sampleRow, secondRow, secondKey }) => {
      await layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        await tx.insert(table, secondRow);
      });
      await layer.transaction(async (tx) => {
        assert(await tx.deleteByKey(table, secondKey) === true, "deleteByKey must delete the named second row");
      });
      await layer.transaction(async (tx) => {
        rowsEqual(await tx.selectAll(table), [sampleRow], "deleteByKey must leave the unrelated row unchanged");
      });
    }),
    "missing key leaves unrelated rows unchanged": withLayer(async ({ layer, table, sampleRow, secondKey, changes }) => {
      await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
      await layer.transaction(async (tx) => {
        assert(await tx.selectByKey(table, secondKey) === undefined, "missing select must not return an unrelated row");
        assert(await tx.updateByKey(table, secondKey, changes) === undefined, "missing update must not change an unrelated row");
        assert(await tx.deleteByKey(table, secondKey) === false, "missing delete must not delete an unrelated row");
      });
      await layer.transaction(async (tx) => {
        rowsEqual(await tx.selectAll(table), [sampleRow], "missing key operations must preserve the unrelated row");
      });
    }),
    "updateByKey changes and returns the stored row": withLayer(async ({ layer, table, sampleRow, key, changes }) => {
      await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
      const expected = { ...sampleRow, ...changes };
      await layer.transaction(async (tx) => {
        rowEquals(await tx.updateByKey(table, key, changes), expected, "update must return changed row");
      });
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, key), expected, "update must persist changes");
      });
    }),
    "missing key returns undefined or false": withLayer(async ({ layer, table, key, changes }) => {
      await layer.transaction(async (tx) => {
        assert(await tx.selectByKey(table, key) === undefined, "missing select must return undefined");
        assert(await tx.updateByKey(table, key, changes) === undefined, "missing update must return undefined");
        assert(await tx.deleteByKey(table, key) === false, "missing delete must return false");
        assert((await tx.selectAll(table)).length === 0, "missing operations must not create rows");
      });
    }),
    "deleteByKey removes an existing row": withLayer(async ({ layer, table, sampleRow, key }) => {
      await layer.transaction(async (tx) => {
        await tx.insert(table, sampleRow);
        assert(await tx.deleteByKey(table, key) === true, "existing delete must return true");
      });
      await layer.transaction(async (tx) => {
        assert(await tx.selectByKey(table, key) === undefined, "deleted row must remain absent");
      });
    }),
    "rejected run rolls back every write and rethrows the same error": withLayer(async ({ layer, table, sampleRow, key, changes }) => {
      const error = new Error("rollback sentinel");
      const rejectWrite = async (write: (tx: DataOperations) => Promise<unknown>) => {
        let rejected = false;
        try {
          await layer.transaction(async (tx) => { await write(tx); throw error; });
        } catch (caught) {
          assert(caught === error, "transaction must rethrow the same error");
          rejected = true;
        }
        assert(rejected, "transaction must reject");
      };
      await rejectWrite((tx) => tx.insert(table, sampleRow));
      await layer.transaction(async (tx) => {
        assert((await tx.selectAll(table)).length === 0, "rejected insert must roll back");
        await tx.insert(table, sampleRow);
      });
      await rejectWrite((tx) => tx.updateByKey(table, key, changes));
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, key), sampleRow, "rejected update must roll back");
      });
      await rejectWrite((tx) => tx.deleteByKey(table, key));
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, key), sampleRow, "rejected delete must roll back");
      });
      await rejectWrite(async (tx) => {
        await tx.updateByKey(table, key, changes);
        await tx.deleteByKey(table, key);
        await tx.insert(table, { ...sampleRow, ...changes });
      });
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, key), sampleRow, "all writes in a rejected run must roll back together");
      });
    }),
    "resolved run commits and returns its result": withLayer(async ({ layer, table, sampleRow, key }) => {
      const value = {};
      const result = await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); return value; });
      assert(result === value, "transaction must return callback result unchanged");
      await layer.transaction(async (tx) => {
        rowEquals(await tx.selectByKey(table, key), sampleRow, "resolved run must commit");
      });
    }),
    "a transaction after close reopens the layer": withLayer(async ({ layer }) => {
      await layer.close();
      await layer.close();
      // Storage may not survive a close (an in-memory database does not), so the
      // check runs no table operation: it asks only that the layer opens again.
      const value = {};
      assert(await layer.transaction(async () => value) === value, "a transaction after close must open the layer again and return its result");
    }),
    "two layers do not see each other's rows": withLayer(async (first) => {
      const second = await makeLayer();
      try {
        await first.layer.transaction(async (tx) => { await tx.insert(first.table, first.sampleRow); });
        await second.layer.transaction(async (tx) => {
          assert((await tx.selectAll(second.table)).length === 0, "second layer must not see first's row");
          await tx.insert(second.table, second.sampleRow);
        });
        await first.layer.transaction(async (tx) => { await tx.deleteByKey(first.table, first.key); });
        await second.layer.transaction(async (tx) => {
          rowEquals(await tx.selectByKey(second.table, second.key), second.sampleRow, "first layer must not delete second's row");
        });
      } finally {
        await second.layer.close();
      }
    }),
  };
}
