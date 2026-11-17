// Delivery from several processes on data-sqlite, the data layer's side: the multi-process delivery operations
// (`multiProcessConformance` from `@meshfw/runtime/testing`) on a memory and a file database built for a bus that
// declares multi-process, and their refusal on a schema built without it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TableHandle } from "@meshfw/runtime";
import { multiProcessConformance } from "@meshfw/runtime/testing";
import { createSchema, sqlite } from "../src/index.ts";
import { buildSchemas } from "./multi-schema.ts";

let single: Record<string, TableHandle>;
let multi: Record<string, TableHandle>;
let remove: () => Promise<void>;
beforeAll(async () => { ({ single, multi, remove } = await buildSchemas()); });
afterAll(async () => { await remove(); });

test("the multi schema holds the process table after core's other tables, and the single one does not", () => {
  expect(Object.keys(multi)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress", "mesh_delivery_process"]);
  expect(Object.keys(single)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
});

for (const kind of ["memory", "file"] as const) {
  describe(`multi-process data-layer conformance, ${kind} database`, () => {
    const dirs: string[] = [];
    afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    const layerWith = (tables: () => Record<string, TableHandle>) => async () => {
      const scratch = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-multi-")) : undefined;
      if (scratch) dirs.push(scratch);
      const layer = sqlite({ file: scratch ? join(scratch, "app.db") : ":memory:" });
      await createSchema(layer, tables());
      return layer;
    };
    const checks = multiProcessConformance(layerWith(() => multi), { singleLayer: layerWith(() => single) });
    for (const [name, check] of Object.entries(checks)) test(name, check, 30_000);
  });
}
