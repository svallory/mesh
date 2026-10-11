import { expect, test } from "bun:test";
import { FrameworkError, type DataLayer, type DataOperations, type Key, type Row } from "@meshfw/runtime";
import { AsyncLocalStorage } from "node:async_hooks";
import { dataLayerConformance } from "@meshfw/runtime/testing";
import type { DataLayerFixture } from "@meshfw/runtime/testing";

// Only a test double for the suite: never shipped as an adapter.
function fake(mode: "correct" | "no rollback" | "wrong error" | "no commit" | "bad update" | "ignores keys" | "ignores select key" | "ignores update key" | "ignores delete key" | "interleaves" | "closes while busy" | "nests separately" | "copies operations" | "rejects nesting" | "poisoned queue" | "stays closed" = "correct"): DataLayerFixture & { closed: () => boolean } {
  let rows = new Map<unknown, Row>();
  let closed = false;
  const table = {};
  const context = new AsyncLocalStorage<{ active: boolean; tx?: DataOperations }>();
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;
  const execute = async <T>(run: (tx: DataOperations) => Promise<T>, token?: { tx?: DataOperations }): Promise<T> => {
      if (closed && mode === "stays closed") throw new Error("closed");
      closed = false;
      const pending = structuredClone(rows);
      const lookupKey = (key: Key, operation: "select" | "update" | "delete") =>
        mode === "ignores keys" || mode === `ignores ${operation} key` ? pending.keys().next().value : key.id;
      const tx: DataOperations = {
        async insert(_table, row) { pending.set(row.id, structuredClone(row)); return structuredClone(row); },
        async selectByKey(_table, key) { return structuredClone(pending.get(lookupKey(key, "select"))); },
        async updateByKey(_table, key, changes) {
          const id = lookupKey(key, "update");
          const old = pending.get(id);
          if (!old) return undefined;
          const updated = mode === "bad update" ? old : { ...old, ...changes };
          pending.set(id, updated);
          return structuredClone(updated);
        },
        async deleteByKey(_table, key) { return pending.delete(lookupKey(key, "delete")); },
        async select() { return structuredClone([...pending.values()]); },
        async selectByKeyForUpdate(_table, key) { return structuredClone(pending.get(lookupKey(key, "select"))); },
        async max() { throw new Error("not used"); },
        async count() { throw new Error("not used"); },
      };
      if (token) token.tx = tx;
      try {
        const value = await run(tx);
        if (mode !== "no commit") rows = pending;
        return value;
      } catch (error) {
        if (mode === "no rollback") rows = pending;
        if (mode === "wrong error") throw new Error("wrapped", { cause: error });
        throw error;
      }
  };
  const layer: DataLayer = {
    transaction(run) {
      const current = context.getStore();
      if (current?.active) {
        if (mode === "nests separately") return execute(run);
        if (mode === "rejects nesting") throw new FrameworkError("nested transactions are not supported");
        // Joins the transaction, but hands the call a copy of its operations: composition could not tell it from a new one.
        if (mode === "copies operations") return run({ ...current.tx! });
        return run(current.tx!);
      }
      pendingCount++;
      const start = async () => {
        const token: { active: boolean; tx?: DataOperations } = { active: true };
        try { return await context.run(token, () => execute(run, token)); }
        finally { token.active = false; pendingCount--; }
      };
      if (mode === "interleaves") return start();
      const result = tail.then(start, (error) => { pendingCount--; throw error; });
      tail = mode === "poisoned queue" ? result.then(() => undefined) : result.then(() => undefined, () => undefined);
      // Observe, but do not repair, the deliberately poisoned tail. Successors
      // reject promptly and release their count: this broken fake never hangs.
      if (mode === "poisoned queue") void tail.catch(() => undefined);
      return result;
    },
    async close() {
      if (pendingCount && mode !== "closes while busy") throw new FrameworkError("transactions pending");
      closed = true;
    },
  };
  return {
    layer, table, closed: () => closed,
    sampleRow: { id: "00000000-0000-4000-8000-000000000001", title: "First", active: false, at: new Date("2026-01-01T00:00:00Z"), optional: null },
    key: { id: "00000000-0000-4000-8000-000000000001" },
    secondRow: { id: "00000000-0000-4000-8000-000000000002", title: "Second", active: false, at: new Date("2026-03-01T00:00:00Z"), optional: "present" },
    secondKey: { id: "00000000-0000-4000-8000-000000000002" },
    changes: { title: "Changed", active: true, at: new Date("2026-02-01T00:00:00Z") },
  };
}

for (const [name, check] of Object.entries(dataLayerConformance(async () => fake()))) {
  test(`data-layer conformance: ${name}`, check);
}

test.each([
  ["interleaves", "concurrent transactions never interleave statements", "transactions must not interleave statements"],
  ["closes while busy", "close with a transaction in flight rejects and leaves the layer open", "close with an in-flight transaction must reject with FrameworkError"],
  ["rejects nesting", "nested transaction joins the running one", "nested transactions are not supported"],
  ["nests separately", "nested transaction joins the running one", "a joined call must receive the same operations as the transaction it joins"],
  ["copies operations", "nested transaction joins the running one", "a joined call must receive the same operations as the transaction it joins"],
  ["nests separately", "a throw after a joined call rolls back both", "a throw after a joined call must roll back"],
  ["no rollback", "rejected run rolls back every write and rethrows the same error", "rejected insert must roll back"],
  ["wrong error", "rejected run rolls back every write and rethrows the same error", "transaction must rethrow the same error"],
  ["no commit", "resolved run commits and returns its result", "resolved run must commit"],
  ["stays closed", "a transaction after close reopens the layer", "closed"],
  ["bad update", "updateByKey changes and returns the stored row", "update must return changed row"],
] as const)("conformance detects %s and closes failed layer", async (mode, name, message) => {
  const fixture = fake(mode);
  const checks = dataLayerConformance(async () => fixture);
  await expect(checks[name]!()).rejects.toThrow(message);
  expect(fixture.closed()).toBe(true);
});

test.each([
  ["throw after a write leaves no row", "no rollback", "throw after write must leave no row"],
  ["throw after a write leaves no row", "wrong error", "throw after write must rethrow the same error"],
  ["rejected promise after a write leaves no row", "no rollback", "rejected promise must leave no row"],
  ["rejected promise after a write leaves no row", "wrong error", "rejected promise must rethrow the same error"],
  ["queue continues after a failed transaction", "poisoned queue", "failed transaction must not poison the queue"],
] as const)("conformance negative proof: %s rejects %s", async (name, mode, message) => {
  const fixture = fake(mode);
  await expect(dataLayerConformance(async () => fixture)[name]!()).rejects.toThrow(`Data-layer conformance: ${message}`);
  expect(fixture.closed()).toBe(true);
});

test.each([
  ["ignores select key", "selectByKey selects only the named row", "selectByKey must select the second row by key"],
  ["ignores update key", "updateByKey changes only the named row", "updateByKey must return the named second row"],
  ["ignores delete key", "deleteByKey deletes only the named row", "deleteByKey must leave the unrelated row unchanged"],
  ["ignores select key", "missing key leaves unrelated rows unchanged", "missing select must not return an unrelated row"],
  ["ignores update key", "missing key leaves unrelated rows unchanged", "missing update must not change an unrelated row"],
  ["ignores delete key", "missing key leaves unrelated rows unchanged", "missing delete must not delete an unrelated row"],
] as const)("conformance rejects an adapter that %s in %s", async (mode, name, message) => {
  const fixture = fake(mode);
  await expect(dataLayerConformance(async () => fixture)[name]!()).rejects.toThrow(message);
  expect(fixture.closed()).toBe(true);
});

test("conformance detects the reviewer's all-keys-ignored fake in all four new checks", async () => {
  const checks = dataLayerConformance(async () => fake("ignores keys"));
  for (const name of ["selectByKey selects only the named row", "updateByKey changes only the named row", "deleteByKey deletes only the named row", "missing key leaves unrelated rows unchanged"]) {
    await expect(checks[name]!()).rejects.toThrow("Data-layer conformance:");
  }
});

test("conformance rejects fixture rows with the same key", async () => {
  const fixture = fake();
  fixture.secondKey = fixture.key;
  await expect(dataLayerConformance(async () => fixture)["selectByKey selects only the named row"]!()).rejects.toThrow("fixture rows must have distinct keys");
  expect(fixture.closed()).toBe(true);
});

test("conformance detects shared storage and closes both layers", async () => {
  const fixture = fake();
  let closes = 0;
  const close = fixture.layer.close;
  fixture.layer.close = async () => { closes++; await close(); };
  await expect(dataLayerConformance(async () => fixture)["two layers do not see each other's rows"]!()).rejects.toThrow("second layer must not see first's row");
  expect(closes).toBe(2);
});

test("conformance closes every successfully created fixture", async () => {
  const fixtures: ReturnType<typeof fake>[] = [];
  const checks = dataLayerConformance(async () => {
    const fixture = fake();
    fixtures.push(fixture);
    return fixture;
  });
  for (const check of Object.values(checks)) await check();
  expect(fixtures.length).toBe(Object.keys(checks).length + 1);
  expect(fixtures.every((fixture) => fixture.closed())).toBe(true);
});
