// The event-bus conformance suite (`busConformance` from `@meshfw/runtime/testing`) run with `testBus` over
// data-postgres: core's delivery operations, the claim and the generation check, each check on a schema of its own.
import { afterAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { busConformance, testBus } from "@meshfw/runtime/testing";
import { eventTables } from "./event-tables.ts";
import { describeServer, testDatabase } from "./support.ts";

const { tables, remove } = await eventTables();
afterAll(remove);

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
