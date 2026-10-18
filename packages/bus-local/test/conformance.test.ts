// The event-bus conformance suite (`busConformance` from `@meshfw/runtime/testing`, spec, Events and commands,
// "Conformance") run against localBus over data-sqlite, under both keep values, on a memory and a file database. The
// suite's retry schedule and polling interval map onto localBus's `retryDelays` and `pollInterval`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TableHandle } from "@meshfw/runtime";
import { busConformance } from "@meshfw/runtime/testing";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { localBus } from "../src/index.ts";
import { buildSchema } from "./schema.ts";

let tables: Record<string, TableHandle>;
let remove: () => Promise<void>;
beforeAll(async () => { ({ tables, remove } = await buildSchema()); });
afterAll(async () => { await remove(); });

for (const kind of ["memory", "file"] as const) {
  describe(`bus conformance with localBus, ${kind} database`, () => {
    const dirs: string[] = [];
    afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    const checks = busConformance({
      async makeLayer() {
        const scratch = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-bus-local-")) : undefined;
        if (scratch) dirs.push(scratch);
        const layer = sqlite({ file: scratch ? join(scratch, "app.db") : ":memory:" });
        await createSchema(layer, tables);
        return layer;
      },
      frame: () => new AsyncLocalStorage(),
      bus: ({ retryDelays, pollMs }) => localBus({ retryDelays, pollInterval: pollMs }),
    });
    test("every check runs under both keep values, the subscribe group included", () => {
      const names = Object.keys(checks);
      expect(names.filter((name) => name.startsWith("[keep: until-delivered]")).length).toBe(names.length / 2);
      expect(names.some((name) => name.includes("subscribe:"))).toBe(true);
      expect(names.some((name) => name.includes("replay:"))).toBe(true);
    });
    for (const [name, check] of Object.entries(checks)) test(name, check, 30_000);
  });
}
