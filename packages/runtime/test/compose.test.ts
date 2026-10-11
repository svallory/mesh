import { describe, expect, test } from "bun:test";
import { cloneValue, composed, composer, FrameworkError, readOnlyRecord, type DataLayer, type DataOperations } from "../src/index.ts";

/**
 * The composer on its own, over a layer that hands every call the operations it is told to. The joining and rollback
 * rules belong to the data layer and are checked by the conformance suite and the SQLite tests; these check what the
 * composer itself does: which context a call carries, the read-only results, and what it refuses.
 */
function layerOf(): { layer: DataLayer; current: { ops: DataOperations } } {
  const current = { ops: {} as DataOperations };
  const layer = {
    transaction: <T>(run: (ops: DataOperations) => Promise<T>) => run(current.ops),
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
