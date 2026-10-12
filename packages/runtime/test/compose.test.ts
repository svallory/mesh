import { describe, expect, test } from "bun:test";
import { pinClock, castInput, checkUnchanged, cloneValue, failJoined, FrameworkError, InvalidInputError, noteWrite, readOnlyRecord, writeCount, type DataLayer, type DataOperations, type StandardSchemaV1, type TableHandle } from "../src/index.ts";

describe("pinClock", () => {
  test("reads its clock once and hands out the same instant as a fresh Date each time", () => {
    let reads = 0;
    const pinned = pinClock(() => new Date(1_000 * ++reads));
    expect(reads).toBe(0);
    const first = pinned();
    first.setTime(0);
    expect(pinned().getTime()).toBe(1_000);
    expect(pinned()).not.toBe(pinned());
    expect(reads).toBe(1);
    expect(pinClock()().getTime()).toBeGreaterThan(0);
  });
});

describe("cloneValue", () => {
  test("copies a read-only view into a plain, mutable value at every depth, dates included", () => {
    const row = { id: 1, at: new Date(5), meta: { tags: ["a"], nested: { n: 1 } } };
    const view = readOnlyRecord(row, "run") as typeof row;
    expect(() => structuredClone(view)).toThrow();
    const copy = cloneValue(view);
    copy.meta.tags.push("b");
    copy.meta.nested.n = 2;
    copy.at.setTime(9);
    expect(copy).toEqual({ id: 1, at: new Date(9), meta: { tags: ["a", "b"], nested: { n: 2 } } });
    expect(row).toEqual({ id: 1, at: new Date(5), meta: { tags: ["a"], nested: { n: 1 } } });
    expect(cloneValue(readOnlyRecord(row, "run").meta)).toEqual({ tags: ["a"], nested: { n: 1 } });
  });

  test("a plain value is copied as structuredClone copies it, cycles and shared members kept", () => {
    const shared = { n: 1 };
    const value: { a: typeof shared; b: typeof shared; self?: unknown } = { a: shared, b: shared };
    value.self = value;
    const copy = cloneValue(value);
    expect(copy.a).not.toBe(shared);
    expect(copy.a).toBe(copy.b);
    expect(copy.self).toBe(copy);
    expect(cloneValue(null)).toBeNull();
    expect(cloneValue("text")).toBe("text");
  });
});

describe("castInput and failJoined", () => {
  const positive: StandardSchemaV1<unknown, number> = {
    "~standard": { version: 1, vendor: "test", validate: (value) => (typeof value === "number" && value > 0 ? { value } : { issues: [{ message: "must be positive", path: [] }] }) },
  };

  test.each([["at top level", false], ["inside a running transaction", true]])("%s, a value that casts comes back without opening or joining a transaction", async (_where, joined) => {
    let opened = 0;
    const layer = { transaction: async () => { opened++; }, refuseIfFailed: () => joined, close: async () => {} } as unknown as DataLayer;
    expect(await castInput(layer, positive, 3)).toBe(3);
    expect(opened).toBe(0);
  });

  test("inside a running transaction, a failed cast passes through the layer's transaction, so the transaction is marked, and rejects with the cast error itself", async () => {
    const seen: unknown[] = [];
    const layer = { transaction: (run: () => Promise<unknown>) => run().catch((cause) => { seen.push(cause); throw cause; }), refuseIfFailed: () => true, close: async () => {} } as unknown as DataLayer;
    const error = await castInput(layer, positive, -1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect(seen).toEqual([error]);
  });

  test("at top level, a failed cast rejects with the cast error and never calls the layer's transaction, so it takes no lock", async () => {
    let opened = 0;
    const layer = { transaction: async () => { opened++; }, refuseIfFailed: () => false, close: async () => {} } as unknown as DataLayer;
    const error = await castInput(layer, positive, -1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect(opened).toBe(0);
  });

  test("when refuseIfFailed refuses, castInput rejects with that refusal before the input is cast", async () => {
    let cast = 0;
    const counted: StandardSchemaV1<unknown, number> = { "~standard": { version: 1, vendor: "test", validate: (value) => { cast++; return { value: value as number }; } } };
    const refusal = new FrameworkError("refused", { cause: new Error("the first failure") });
    const layer = { transaction: async () => { throw new Error("must not open"); }, refuseIfFailed: () => { throw refusal; }, close: async () => {} } as unknown as DataLayer;
    await expect(castInput(layer, counted, 3)).rejects.toBe(refusal);
    expect(cast).toBe(0);
  });

  test("whatever the layer's transaction rejects with, the caller gets the original error", async () => {
    const original = new Error("the original");
    const broken = { transaction: async () => { throw new FrameworkError("the layer is unusable"); }, refuseIfFailed: () => true, close: async () => {} } as unknown as DataLayer;
    await expect(failJoined(broken, original)).rejects.toBe(original);
    const resolving = { transaction: async () => "swallowed", refuseIfFailed: () => true, close: async () => {} } as unknown as DataLayer;
    await expect(failJoined(resolving, original)).rejects.toBe(original);
  });
});

describe("checkUnchanged", () => {
  const table = {} as TableHandle;
  const before = { id: 1, name: "Ada", at: new Date(5), meta: { tags: ["a"] }, bytes: new Uint8Array([1, 2]) };
  const operations = (row: unknown) => {
    let reads = 0;
    const ops = { selectByKey: async () => { reads++; return row; } } as unknown as DataOperations;
    return { ops, reads: () => reads };
  };

  test("with no write since the snapshot, the row is not read again", async () => {
    const { ops, reads } = operations(undefined);
    await checkUnchanged(ops, writeCount(ops), table, { id: 1 }, before, "Account.rename");
    expect(reads()).toBe(0);
  });

  test("after a write, an equal row passes: dates by time, bytes by content, json member by member", async () => {
    const { ops, reads } = operations({ id: 1, name: "Ada", at: new Date(5), meta: { tags: ["a"] }, bytes: new Uint8Array([1, 2]) });
    const since = writeCount(ops);
    noteWrite(ops);
    await checkUnchanged(ops, since, table, { id: 1 }, before, "Account.rename");
    expect(reads()).toBe(1);
  });

  test.each([
    ["a changed name", { ...before, name: "Bo" }, /changed the row this action is updating \(\{"id":1\}\)/],
    ["a later date", { ...before, at: new Date(6) }, /changed/],
    ["a json member", { ...before, meta: { tags: ["a", "b"] } }, /changed/],
    ["other bytes", { ...before, bytes: new Uint8Array([1, 3]) }, /changed/],
    ["a deleted row", undefined, /deleted the row this action is updating/],
  ])("after a write, %s is a FrameworkError that says to move the call after the write", async (_name, row, message) => {
    const { ops } = operations(row);
    const since = writeCount(ops);
    noteWrite(ops);
    const error = await checkUnchanged(ops, since, table, { id: 1 }, before, "Account.rename").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toMatch(/^Account\.rename: a call made before this action's write /);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).toContain("so this action's checks and steps decided on a stale row. Make the call from a step that runs after the write");
    expect((error as Error).message).not.toContain("overwrite");
    expect((error as Error).message).toMatch(/run \[after=:write\]$/);
  });
});
