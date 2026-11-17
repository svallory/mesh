// Delivery from several processes on data-postgres, the data layer's side: the multi-process delivery operations
// (`multiProcessConformance` from `@meshfw/runtime/testing`) on a schema built for a bus that declares multi-process,
// their refusal on a schema built without it, and the row locks they take against a second connection.
import { afterAll, expect, test } from "bun:test";
import type { PostgresLayer } from "../src/layer.ts";
import { multiProcessConformance } from "@meshfw/runtime/testing";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const single = await eventTables();
const multi = await eventTables({ multiProcess: true });
afterAll(async () => { await single.remove(); await multi.remove(); });

test("the multi schema holds the process table after core's other tables, and the single one does not", () => {
  expect(Object.keys(multi.tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures", "mesh_delivery_process"]);
  expect(Object.keys(single.tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_outbox_failures"]);
});

describeServer("multi-process data-layer conformance, Postgres", () => {
  const multiDatabase = testDatabase(multi.tables);
  const singleDatabase = testDatabase(single.tables);
  const checks = multiProcessConformance(() => multiDatabase.freshLayer(), {
    singleLayer: () => singleDatabase.freshLayer(),
    sibling: async (layer) => multiDatabase.sibling(layer as PostgresLayer),
  });
  test("the row-lock checks run", () => {
    expect(Object.keys(checks).filter((name) => name.startsWith("[two connections]")).length).toBeGreaterThan(0);
  });
  for (const [name, check] of Object.entries(checks)) test(name, check, 60_000);
});
