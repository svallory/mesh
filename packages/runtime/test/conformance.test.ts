import { expect, test } from "bun:test";
import type { DataLayer, DataOperations, Key, Row } from "@mesh/runtime";
import { dataLayerConformance } from "@mesh/runtime/testing";
import type { DataLayerFixture } from "@mesh/runtime/testing";

// Only a test double for the suite: never shipped as an adapter.
function fake(mode: "correct" | "no rollback" | "wrong error" | "no commit" | "bad update" | "ignores keys" | "ignores select key" | "ignores update key" | "ignores delete key" = "correct"): DataLayerFixture & { closed: () => boolean } {
  let rows = new Map<unknown, Row>();
  let closed = false;
  const table = {};
  const layer: DataLayer = {
    async transaction(run) {
      if (closed) throw new Error("closed");
      const pending = structuredClone(rows);
      const lookupKey = (key: Key, operation: "select" | "update" | "delete") =>
        mode === "ignores keys" || mode === `ignores ${operation} key` ? pending.keys().next().value : key.id;
      const tx: DataOperations = {
        async insert(_table, row) { pending.set(row.id, structuredClone(row)); return structuredClone(row); },
        async selectByKey(_table, key) { return structuredClone(pending.get(lookupKey(key, "select"))); },
        async selectAll() { return structuredClone([...pending.values()]); },
        async updateByKey(_table, key, changes) {
          const id = lookupKey(key, "update");
          const old = pending.get(id);
          if (!old) return undefined;
          const updated = mode === "bad update" ? old : { ...old, ...changes };
          pending.set(id, updated);
          return structuredClone(updated);
        },
        async deleteByKey(_table, key) { return pending.delete(lookupKey(key, "delete")); },
      };
      try {
        const value = await run(tx);
        if (mode !== "no commit") rows = pending;
        return value;
      } catch (error) {
        if (mode === "no rollback") rows = pending;
        if (mode === "wrong error") throw new Error("wrapped", { cause: error });
        throw error;
      }
    },
    async close() { closed = true; },
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
  ["no rollback", "rejected run rolls back every write and rethrows the same error", "rejected insert must roll back"],
  ["wrong error", "rejected run rolls back every write and rethrows the same error", "transaction must rethrow the same error"],
  ["no commit", "resolved run commits and returns its result", "resolved run must commit"],
  ["bad update", "updateByKey changes and returns the stored row", "update must return changed row"],
] as const)("conformance detects %s and closes failed layer", async (mode, name, message) => {
  const fixture = fake(mode);
  const checks = dataLayerConformance(async () => fixture);
  await expect(checks[name]!()).rejects.toThrow(message);
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
