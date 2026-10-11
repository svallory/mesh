import { describe, expect, test } from "bun:test";
import { castInput, checkUnchanged, cloneValue, composed, composer, failJoined, FrameworkError, InvalidInputError, noteWrite, readOnlyRecord, writeCount, type DataLayer, type DataOperations, type StandardSchemaV1, type TableHandle } from "../src/index.ts";

/**
 * The composer on its own, over a layer that hands every call the operations it is told to. The joining and rollback
 * rules belong to the data layer and are checked by the conformance suite and the SQLite tests; these check what the
 * composer itself does: which context a call carries, the read-only results, and what it refuses.
 */
function layerOf(): { layer: DataLayer; current: { ops: DataOperations } } {
  const current = { ops: {} as DataOperations };
  const layer = {
    transaction: <T>(run: (ops: DataOperations) => Promise<T>) => run(current.ops),
    refuseIfFailed: () => true,
    close: async () => {},
  } as unknown as DataLayer;
  return { layer, current };
}

describe("composer", () => {
  test("a call carries the caller's context unless it passes its own; a read gets its input only", async () => {
    const { layer, current } = layerOf();
    const made = composer(layer);
    const seen: unknown[] = [];
    made.provide(
      { openThing: (async (input: unknown, context: unknown) => { seen.push([input, context]); return { id: 1 }; }) as never },
      { readThing: (async (...args: unknown[]) => { seen.push(args); return [{ id: 1 }]; }) as never },
    );
    const { actions, tx } = made.bound(current.ops, { actor: "caller" }) as { actions: Record<string, (input: unknown, context?: unknown) => Promise<unknown>>; tx: Record<string, (input: unknown) => Promise<unknown>> };
    await actions.openThing!({ n: 1 });
    await actions.openThing!({ n: 2 }, { actor: "own" });
    await tx.readThing!({ limit: 1 });
    expect(seen).toEqual([[{ n: 1 }, { actor: "caller" }], [{ n: 2 }, { actor: "own" }], [{ limit: 1 }]]);
    expect(Object.isFrozen(actions)).toBe(true);
    expect(Object.isFrozen(tx)).toBe(true);
  });

  test("with `where`, every record a call returns is a read-only view; without it, the plain value", async () => {
    const { layer, current } = layerOf();
    const made = composer(layer);
    made.provide({ openThing: (async () => ({ id: 1, tags: ["a"] })) as never }, { readThing: (async () => [{ id: 1 }]) as never });
    const inFunction = made.bound(current.ops, undefined, "run of open") as { actions: Record<string, () => Promise<any>>; tx: Record<string, () => Promise<any>> };
    const record = await inFunction.actions.openThing!();
    expect(() => { record.id = 2; }).toThrow(FrameworkError);
    expect(() => { record.tags.push("b"); }).toThrow(FrameworkError);
    expect(() => { (record as any).extra = 1; }).toThrow(/run of open/);
    const rows = await inFunction.tx.readThing!();
    expect(() => { rows[0].id = 2; }).toThrow(FrameworkError);
    // The application's transaction gets what the function returned, unchanged.
    const plain = made.bound(current.ops, undefined) as { actions: Record<string, () => Promise<any>> };
    const own = await plain.actions.openThing!();
    own.id = 2;
    expect(own.id).toBe(2);
  });

  test("a value that is not a record passes through as it is", async () => {
    const { layer, current } = layerOf();
    const made = composer(layer);
    made.provide({ destroyThing: (async () => undefined) as never, countThing: (async () => 3) as never }, {});
    const { actions } = made.bound(current.ops, undefined, "run") as { actions: Record<string, () => Promise<unknown>> };
    expect(await actions.destroyThing!()).toBeUndefined();
    expect(await actions.countThing!()).toBe(3);
  });

  test("a call made once its transaction has ended is refused: it would otherwise open a new one", async () => {
    const { layer, current } = layerOf();
    const made = composer(layer);
    let calls = 0;
    made.provide({ openThing: (async () => { calls++; return null; }) as never }, {});
    const { actions } = made.bound(current.ops, undefined) as { actions: Record<string, () => Promise<unknown>> };
    current.ops = {} as DataOperations; // the layer now runs another transaction
    await expect(actions.openThing!()).rejects.toThrow(/it has ended/);
    await expect(actions.openThing!()).rejects.toBeInstanceOf(FrameworkError);
    expect(calls).toBe(0);
  });

  test("before provide nothing is bound, and provide happens once", () => {
    const { layer, current } = layerOf();
    const made = composer(layer);
    expect(() => made.bound(current.ops, undefined)).toThrow(/not all bound yet/);
    made.provide({}, {});
    expect(() => made.provide({}, {})).toThrow(/provided once/);
  });

  test("transaction resolves with what its function resolves with and hands it plain results", async () => {
    const { layer } = layerOf();
    const made = composer(layer);
    made.provide({ openThing: (async (_input: unknown, context: unknown) => ({ context })) as never }, {});
    const result = await made.transaction(async ({ actions }) => {
      const opened = await (actions as Record<string, (input: unknown) => Promise<any>>).openThing!({});
      opened.mine = true;
      return [opened.context, opened.mine] as const;
    }, { actor: "app" });
    expect(result).toEqual([{ actor: "app" }, true]);
  });
});

describe("composed", () => {
  test("with no composer (an entity bound alone), reading a member of actions or tx throws a FrameworkError that names it", () => {
    const { actions, tx } = composed(undefined, {} as DataOperations, undefined, "run of open");
    expect(() => (actions as Record<string, unknown>).openThing).toThrow(new FrameworkError(
      "run of open reads `actions.openThing`, which only a binding of the whole project has: bind with bind(layer) from #mesh, not with one entity's bind function"));
    expect(() => (tx as Record<string, unknown>).readThing).toThrow(/reads `tx.readThing`/);
    // Inspecting them (a symbol key, as console.log and await do) does not throw.
    expect((actions as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    expect(Object.isFrozen(actions)).toBe(true);
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
