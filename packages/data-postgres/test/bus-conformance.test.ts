// The event-bus conformance suite (`busConformance` from `@meshfw/runtime/testing`) run with `testBus` over
// data-postgres: core's delivery operations, the claim and the generation check, each check on a schema of its own;
// then with testBus declaring multi-process, with its multi-process group, whose workers are second OS processes on
// the same database and schema.
import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { busConformance, testBus } from "@meshfw/runtime/testing";
import { MULTI_CAPABILITIES, WAIT_MS, eventTables } from "./event-tables.ts";
import { spawnWorker } from "./spawn-worker.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
const multi = await eventTables({ multiProcess: true });
afterAll(async () => { await remove(); await multi.remove(); });

describeServer("bus conformance with testBus, Postgres", () => {
  const database = testDatabase(tables);
  const checks = busConformance({
    makeLayer: () => database.freshLayer(),
    frame: () => new AsyncLocalStorage(),
    // dead-letters asked for, so the suite's dead-letters group runs on Postgres's failure operations.
    bus: ({ retryDelays, pollMs }) => testBus({ capabilities: ["ordered-delivery", "replay", "subscribe", "dead-letters"], retryDelays, pollMs }),
  });
  test("every check runs under both keep values, the dead-letters group included", () => {
    const names = Object.keys(checks);
    expect(names.filter((name) => name.startsWith("[keep: until-delivered]")).length).toBe(names.length / 2);
    expect(names.some((name) => name.includes("subscribe:"))).toBe(true);
    expect(names.filter((name) => name.includes("dead letters:")).length).toBeGreaterThan(20);
  });
  for (const [name, check] of Object.entries(checks)) test(name, check, 60_000);
});

describeServer("bus conformance with testBus declaring multi-process, Postgres", () => {
  const database = testDatabase(multi.tables);
  // The group lapses a process row after 300 ms (in production 15 s); a lock wait of the layer's default 5 s would make
  // every process queued behind one miss its renewal. WAIT_MS keeps the production ratio: a lock wait well within a lapse.
  const checks = busConformance({
    makeLayer: () => database.freshLayer({ waitMs: WAIT_MS }),
    frame: () => new AsyncLocalStorage(),
    bus: ({ retryDelays, pollMs }) => testBus({ capabilities: MULTI_CAPABILITIES, retryDelays, pollMs }),
    multiProcess: {
      // The group's "file" is opaque to it: here the database's URL and the check's schema, which the worker opens.
      async makeFileLayer() {
        const layer = await database.freshLayer({ waitMs: WAIT_MS });
        return { file: JSON.stringify({ url: database.url, schema: layer.database!.split("#")[1]!, waitMs: WAIT_MS }), layer };
      },
      spawn: (file, scenario, args = []) => spawnWorker(join(import.meta.dir, "multi-worker.ts"), file, scenario, args),
    },
  });
  test("the multi-process group runs", () => {
    expect(Object.keys(checks).filter((name) => name.startsWith("[multi-process]")).length).toBeGreaterThan(10);
  });
  for (const [name, check] of Object.entries(checks)) test(name, check, 60_000);
});
