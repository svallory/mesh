import type { DataLayer, DataOperations, Key, Row, TableHandle } from "./data-layer.ts";

/** A fresh isolated layer with an empty, prepared table. Supply a complete sample
 * row, its primary key, and non-key changes that change at least one value.
 * Every factory call must use the same schema and sample values.
 */
export interface DataLayerFixture {
  layer: DataLayer;
  table: TableHandle;
  sampleRow: Row;
  key: Key;
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

function rowEquals(actual: Row | undefined, expected: Row, message: string): void {
  assert(actual !== undefined && Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every((name) => Object.hasOwn(actual, name) && equalValue(actual[name], expected[name])), message);
}

/** Return named, runner-independent asynchronous checks for contract v0.
 * Register each entry with your test runner. Each check owns and closes its fresh
 * layers, including on failure; this module ships no adapter implementation.
 */
export function dataLayerConformance(makeLayer: () => Promise<DataLayerFixture>): Record<string, () => Promise<void>> {
  const withLayer = (run: (fixture: DataLayerFixture) => Promise<void>) => async () => {
    const fixture = await makeLayer();
    try {
      assert(Object.keys(fixture.key).length > 0, "fixture key must not be empty");
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
    "selectAll returns stored rows": withLayer(async ({ layer, table, sampleRow }) => {
      await layer.transaction(async (tx) => { await tx.insert(table, sampleRow); });
      await layer.transaction(async (tx) => {
        const rows = await tx.selectAll(table);
        assert(rows.length === 1, "selectAll must return exactly one row");
        rowEquals(rows[0], sampleRow, "selectAll must preserve TypeScript values");
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
