import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CAPABILITIES, FrameworkError, type DataLayer, type DataOperations } from "@meshfw/runtime";
import { dataLayerConformanceV1, type DataLayerFixtureV1 } from "@meshfw/runtime/testing";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const records = sqliteTable("records", { id: text("id").primaryKey().notNull(), title: text("title").notNull() });
const uuidTable = sqliteTable("uuid_rows", { id: text("id").primaryKey().notNull(), label: text("label").notNull() });
const integerTable = sqliteTable("integer_rows", { seq: integer("seq").primaryKey().notNull(), label: text("label").notNull() });
const taskTable = sqliteTable("tasks", {
  id: text("id").primaryKey().notNull(), parentId: text("parentId"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(), title: text("title").notNull(), rank: integer("rank"),
});
const tables = { records, uuidTable, integerTable, taskTable };

const sampleRow = { id: "00000000-0000-4000-8000-000000000001", title: "First" };
const secondRow = { id: "00000000-0000-4000-8000-000000000002", title: "Second" };

export function fixtureFactory(kind: "memory" | "file", dirs: string[]) {
  return async (): Promise<DataLayerFixtureV1> => {
    const dir = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-contract-")) : undefined;
    if (dir) dirs.push(dir);
    const layer = sqlite({ file: dir ? join(dir, "test.db") : ":memory:" });
    try { await createSchema(layer, tables); }
    catch (error) { await layer.close(); throw error; }
    return {
      layer: { transaction: layer.transaction, refuseIfFailed: layer.refuseIfFailed, close: layer.close } satisfies DataLayer,
      table: records, sampleRow, secondRow, key: { id: sampleRow.id }, secondKey: { id: secondRow.id },
      changes: { title: "Changed" },
      uuidTable, integerTable, taskTable,
    };
  };
}

for (const kind of ["memory", "file"] as const) {
  describe(`contract v1 conformance, ${kind} database`, () => {
    const dirs: string[] = [];
    afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    for (const [name, check] of Object.entries(dataLayerConformanceV1(fixtureFactory(kind, dirs), capabilities))) {
      test(name, check, 60_000);
    }
  });
}

describe("the capability manifest", () => {
  test("is static data on the descriptor and the entry point, readable without opening a connection", () => {
    const layer = sqlite({ file: join(tmpdir(), "mesh-never-created.db") });
    expect(layer.capabilities).toBe(capabilities);
    expect(capabilities).toEqual({ adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] });
    expect(Object.isFrozen(capabilities)).toBe(true);
    for (const name of capabilities.capabilities) expect(CAPABILITIES).toContain(name);
  });
});

describe("the suite catches adapters that break the contract", () => {
  // A wrapper that breaks one promise: each case must fail a named check.
  // A wrapper that does not name `refuseIfFailed` keeps the real one.
  async function broken(change: (layer: DataLayer) => Pick<DataLayer, "transaction" | "close"> & Partial<DataLayer>, name: string, message: string) {
    const make = fixtureFactory("memory", []);
    const checks = dataLayerConformanceV1(async () => {
      const fixture = await make();
      return { ...fixture, layer: { refuseIfFailed: fixture.layer.refuseIfFailed, ...change(fixture.layer) } };
    }, capabilities);
    await expect(checks[name]!()).rejects.toThrow(message);
  }

  test("a layer that rejects nested calls", async () => {
    const inside = new AsyncLocalStorage<boolean>();
    await broken((layer) => ({
      close: layer.close,
      transaction: (run) => {
        if (inside.getStore()) throw new FrameworkError("nested transactions are not supported");
        return layer.transaction((tx) => inside.run(true, () => run(tx)));
      },
    }), "nested transaction joins the running one", "nested transactions are not supported");
  });

  test("a select that ignores the limit", async () => {
    await broken((layer) => ({ close: layer.close, transaction: (run) => layer.transaction((tx) => run({ ...tx, select: (table, query) => tx.select(table, { ...query, limit: undefined }) })) }),
      "limit and offset page the result, and an offset past the end is empty", "first page");
  });

  test("a select that ignores sort", async () => {
    await broken((layer) => ({ close: layer.close, transaction: (run) => layer.transaction((tx) => run({ ...tx, select: (table, query) => tx.select(table, { ...query, sort: undefined }) })) }),
      "sort ascending, descending and by several fields, ties in primary-key order", "createdAt, id");
  });

  test("a select that drops the filter", async () => {
    await broken((layer) => ({ close: layer.close, transaction: (run) => layer.transaction((tx) => run({ ...tx, select: (table, query) => tx.select(table, { ...query, filter: undefined }) })) }),
      "filter eq and ne", "filter");
  });

  test("a max that counts instead", async () => {
    await broken((layer) => ({ close: layer.close, transaction: (run) => layer.transaction((tx) => run({ ...tx, max: async (table, attribute, filter) => tx.count(table, attribute, filter) })) }),
      "max and count over one attribute with a plain-data filter", "max of rank");
  });

  test("a key fill that counts on after a rollback", async () => {
    let issued = 0;
    await broken((layer) => ({
      close: layer.close,
      transaction: (run) => layer.transaction((tx) => run({
        ...tx,
        insert: (table, row) => table === integerTable && row.seq === undefined ? tx.insert(table, { ...row, seq: ++issued }) : tx.insert(table, row),
      })),
    }), "an integer primary key is filled with the next integer, with no gap after a rollback", "no gap");
  });

  test("a layer that lets a caught joined failure commit", async () => {
    const outer = new AsyncLocalStorage<DataOperations>();
    await broken((layer) => ({
      close: layer.close,
      // Joins by handing the outer operations to the inner callback, with no failure mark.
      transaction: (run) => outer.getStore() ? run(outer.getStore()!) : layer.transaction((tx) => outer.run(tx, () => run(tx))),
    }), "a joined call that fails rejects the commit even when the outer callback catches it", "must reject the commit");
  });

  // Joins through its own context and marks a failure, so the commit is still refused, but never fails fast.
  function slowToRefuse(refuses: boolean) {
    const joined = new AsyncLocalStorage<{ tx: DataOperations; failed?: { cause: unknown } }>();
    return (layer: DataLayer): DataLayer => ({
      close: layer.close,
      refuseIfFailed: () => {
        const failed = joined.getStore()?.failed;
        if (refuses && failed) throw new FrameworkError("refused", { cause: failed.cause });
      },
      transaction: (run) => {
        const state = joined.getStore();
        if (state) return run(state.tx).catch((cause: unknown) => { state.failed ??= { cause }; throw cause; });
        return layer.transaction((tx) => {
          const own: { tx: DataOperations; failed?: { cause: unknown } } = { tx };
          return joined.run(own, async () => {
            const result = await run(tx);
            if (own.failed) throw new FrameworkError("a joined call failed", { cause: own.failed.cause });
            return result;
          });
        });
      },
    });
  }

  test("a layer whose refuseIfFailed never refuses", async () => {
    await broken(slowToRefuse(false), "a call that joins a failed transaction is refused before it runs, and refuseIfFailed refuses only there",
      "refuseIfFailed inside a failed transaction must throw");
  });

  test("a layer that runs a call joined after a failure", async () => {
    await broken(slowToRefuse(true), "a call that joins a failed transaction is refused before it runs, and refuseIfFailed refuses only there",
      "a call that joins a failed transaction must be refused");
    await broken(slowToRefuse(true), "one failing joined call among parallel ones rolls back all of them",
      "a joined call whose turn comes after a failure must be refused");
  });

  test("a manifest that names a capability outside the union is refused", async () => {
    const checks = dataLayerConformanceV1(fixtureFactory("memory", []), { adapter: "x", capabilities: ["teleport"] as never });
    await expect(checks["the capability manifest is valid and consistent with the fixture"]!()).rejects.toThrow(FrameworkError);
  });
});
