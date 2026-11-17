// The outbox on data-postgres: the emitted tables, the three operations through the outbox conformance suite, with
// `sibling` so its never-skip check runs with three connections, and what is Postgres's own: positions from a
// sequence, which a rolled-back append leaves a gap in.
import { afterAll, expect, test } from "bun:test";
import { FrameworkError } from "@meshfw/runtime";
import { outboxConformance, outboxRow, retentionConformance } from "@meshfw/runtime/testing";
import { capabilities } from "../src/index.ts";
import { type PostgresLayer } from "../src/layer.ts";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, schema, remove } = await eventTables();
afterAll(remove);

test("a project that declares an event gets core's tables after its entities', the position an identity column", () => {
  expect(Object.keys(tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures"]);
  expect(schema).toMatch(/position: bigint\("position", \{ mode: "number" \}\)\s*\.notNull\(\)\s*\.primaryKey\(\)\s*\.generatedAlwaysAsIdentity\(\)/);
  expect(schema).toMatch(/failure: bigint\("failure", \{ mode: "number" \}\)\s*\.notNull\(\)\s*\.primaryKey\(\)\s*\.generatedAlwaysAsIdentity\(\)/);
  expect(schema.match(/generatedAlwaysAsIdentity/g)).toHaveLength(2);
});

describeServer("outbox conformance, Postgres", () => {
  const database = testDatabase(tables);
  const checks = outboxConformance(() => database.freshLayer(), capabilities, {
    sibling: async (layer) => database.sibling(layer as PostgresLayer),
  });
  test("the never-skip check beside an open transaction runs", () => {
    expect(Object.keys(checks).some((name) => name.includes("never skips"))).toBe(true);
    expect(Object.keys(checks).some((name) => name.startsWith("gapless-positions"))).toBe(false);
  });
  for (const [name, check] of Object.entries(checks)) test(name, check, 60_000);
  for (const [name, check] of Object.entries(retentionConformance(() => database.freshLayer()))) test(`retention: ${name}`, check, 60_000);

  test("a rolled-back append leaves a gap in the positions, and highest keeps it", async () => {
    const layer = await database.freshLayer();
    await layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
    await expect(layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); throw new Error("roll back"); })).rejects.toThrow("roll back");
    await layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(3)); });
    const page = await layer.readOutbox(0, 10);
    expect(page.rows.map((row) => row.position)).toEqual([1, 3]);
    expect(page).toMatchObject({ highest: 3, settled: 3, deletedThrough: 0 });
  }, 60_000);

  test("an outbox statement on a database without the outbox tables says how to create them", async () => {
    const layer = await database.freshLayer();
    await database.admin.unsafe(`DROP TABLE "${layer.database!.split("#")[1]}".mesh_outbox`);
    const refused = await layer.readOutbox(0, 10).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(FrameworkError);
    expect((refused as Error).message).toContain("mesh db push");
    const appended = await layer.transaction(async (tx) => tx.appendEvent!(outboxRow(1))).then(() => undefined, (error: unknown) => error);
    expect(appended).toBeInstanceOf(FrameworkError);
    expect((appended as Error).message).toContain("mesh db push");
  }, 60_000);
});
