// Delivery from several processes, the parts that need no database: MESH_HANDLER_LOST, the several-processes wording of
// MESH_DELIVERER_TAKEN, and testBus ending a handler another process holds for the round without reporting it.
import { describe, expect, test } from "bun:test";
import { DelivererTakenError, HandlerLostError, MeshError, type BusCore, type ClaimHolder } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";

describe("HandlerLostError", () => {
  test("carries the handler, the reason and the row's position, is not retryable, and its message is the detail", () => {
    const taken = new HandlerLostError("notify", "taken", 812, "the handler \"notify\" was taken over");
    expect(taken).toBeInstanceOf(MeshError);
    expect([taken.code, taken.handler, taken.reason, taken.position, taken.retryable, taken.message, taken.name])
      .toEqual(["MESH_HANDLER_LOST", "notify", "taken", 812, false, "the handler \"notify\" was taken over", "HandlerLostError"]);
    const cause = new Error("x");
    const pending = new HandlerLostError("notify", "pending", 3, "pending", { cause });
    expect([pending.reason, pending.cause]).toEqual(["pending", cause]);
  });
});

describe("MESH_DELIVERER_TAKEN for the nil claim", () => {
  const holder = (changes: Partial<ClaimHolder>): ClaimHolder => ({
    database: "app.db", pid: 77, host: "api-3", startedAt: new Date(Date.UTC(2026, 0, 1, 12, 4, 18)), renewedAgoMs: 2000,
    lapsesAt: new Date(Date.UTC(2026, 0, 1, 12, 4, 31)), thisProcess: false, multiProcess: false, ...changes,
  });

  test("a claim of several processes says so, and its fix names the bus to configure", () => {
    const error = new DelivererTakenError(holder({ pid: null, host: null, startedAt: null, multiProcess: true }));
    expect(error.message).toBe("Another process delivers this database's events: app.db is delivered from several processes (multi-process; renewed 2 s ago). One process delivers per database unless the bus declares multi-process.\n"
      + "  fix: Configure the same bus as those processes, such as localBus({ processes: \"many\" }), or stop them first.");
    expect(error.holder.multiProcess).toBe(true);
    expect(error.retryable).toBe(true);
  });

  test("a single process's claim keeps its wording, and so does one of this process", () => {
    expect(new DelivererTakenError(holder({})).message).toStartWith("Another process delivers this database's events: app.db is claimed by pid 77 on host api-3 (started 12:04:18, renewed 2 s ago). One process delivers per database.\n  fix: Stop that process first");
    expect(new DelivererTakenError(holder({ thisProcess: true })).message).toStartWith("Another binding or round of this process delivers");
  });
});

describe("testBus and a handler this process no longer holds", () => {
  test("MESH_HANDLER_LOST from position or retry ends that handler for the round, unreported; the others and the deletion pass go on", async () => {
    const fed: string[] = [];
    let passes = 0;
    const lost = (name: string) => new HandlerLostError(name, "taken", 0, `${name} was taken over`);
    const core = {
      handlers: [{ name: "a" }, { name: "b" }, { name: "c" }],
      position: async (handler: { name: string }) => { if (handler.name === "a") throw lost("a"); return 0; },
      rows: async (after: number) => ({ rows: after === 0 ? [{ position: 1, name: "x.E" }] : [], deletedThrough: 0, highest: 1, settled: 1 }),
      lists: () => true,
      retry: async (handler: { name: string }) => { fed.push(handler.name); if (handler.name === "b") throw lost("b"); return null; },
      subscriptions: () => [],
      deletionPass: async () => { passes++; },
      onClaimLost: () => () => undefined,
      onPublished: () => () => undefined,
    } as unknown as BusCore;
    const errors: unknown[] = [];
    const instance = testBus({ onError: (error) => { errors.push(error); } }).create(core, { keep: "until-delivered" });
    await instance.deliver();
    expect(fed).toEqual(["b", "c"]);
    expect(passes).toBe(1);
    expect(errors).toEqual([]);
  });

  test("testBus declares multi-process when its capabilities list it, and not by default", () => {
    expect(testBus().manifest.capabilities).toEqual(["ordered-delivery", "replay", "subscribe"]);
    expect(testBus({ capabilities: ["ordered-delivery", "multi-process"] }).manifest.capabilities).toEqual(["ordered-delivery", "multi-process"]);
  });
});
