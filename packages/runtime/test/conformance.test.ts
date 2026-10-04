import { expect, test } from "bun:test";
import type { DataLayer, DataOperations, Row } from "@mesh/runtime";
import { dataLayerConformance } from "@mesh/runtime/testing";
import type { DataLayerFixture } from "@mesh/runtime/testing";

// Only a test double for the suite: never shipped as an adapter.
function fake(mode: "correct" | "no rollback" | "wrong error" | "no commit" | "bad update" = "correct"): DataLayerFixture & { closed: () => boolean } {
  let rows = new Map<unknown, Row>();
  let closed = false;
  const table = {};
  const layer: DataLayer = {
    async transaction(run) {
      if (closed) throw new Error("closed");
      const pending = structuredClone(rows);
      const tx: DataOperations = {
        async insert(_table, row) { pending.set(row.id, structuredClone(row)); return structuredClone(row); },
        async selectByKey(_table, key) { return structuredClone(pending.get(key.id)); },
        async selectAll() { return structuredClone([...pending.values()]); },
        async updateByKey(_table, key, changes) {
          const old = pending.get(key.id);
          if (!old) return undefined;
          const updated = mode === "bad update" ? old : { ...old, ...changes };
          pending.set(key.id, updated);
          return structuredClone(updated);
        },
        async deleteByKey(_table, key) { return pending.delete(key.id); },
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
