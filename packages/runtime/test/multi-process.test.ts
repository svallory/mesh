// Delivery from several processes, the parts that need no database: MESH_HANDLER_LOST, the several-processes wording of
// MESH_DELIVERER_TAKEN, testBus ending a handler another process holds for the round without reporting it, and the
// choice of the claim strategy by the bus's manifest over a fake data layer, and the argument checks of adopt and keep.
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DelivererTakenError, FrameworkError, HandlerLostError, MeshError, adoptByName, adoptHandler, bindDomain, keepByValue, type BusCapability, type BusCore, type ClaimHolder, type DataLayer,
} from "@meshfw/runtime";
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

describe("the strategy follows the bus's manifest (rule M1), and multi mode needs the multi-process operations (rule M4)", () => {
  /** A layer whose transactions have the single-mode delivery operations only, each recording its call. */
  function layerWithout(missing: readonly string[] = []) {
    const calls: string[] = [];
    const state = { deletedThrough: 0, highest: 0, generation: 0, claim: null, now: new Date() };
    const tx: Record<string, unknown> = {};
    for (const name of ["readDeliveryState", "writeClaim", "renewClaim", "releaseClaim", "readHandlerProgress", "writeHandlerProgress", "deleteHandlerProgress",
      "readSubscriptionProgress", "writeSubscriptionProgress", "deleteSubscriptionProgress", "firstOutboxRow",
      "lockDeliveryState", "readDeliveryStateUnlocked", "writeKeep", "lockHandlerProgress", "readHandlerLeases", "writeHandlerLease", "moveHandler", "moveSubscription",
      "readProcesses", "writeProcess", "renewProcess", "deleteProcess", "readSubscriptionOwners", "writeSubscriptionOwner"]) {
      if (missing.includes(name)) continue;
      tx[name] = async () => {
        calls.push(name);
        if (name === "readDeliveryState" || name === "readDeliveryStateUnlocked" || name === "lockDeliveryState") return { ...state, keep: null };
        if (name.startsWith("read")) return [];
        return true;
      };
    }
    const layer = {
      database: `fake #${Math.random()}`,
      transaction: async <T>(run: (ops: never) => Promise<T>) => run(tx as never),
      refuseIfFailed: () => false,
      close: async () => {},
    } as unknown as DataLayer;
    return { layer, calls };
  }
  const bind = (layer: DataLayer, capabilities: readonly BusCapability[]) =>
    bindDomain({}, layer, { events: { bus: testBus({ capabilities }), load: async () => ({}) } }, new AsyncLocalStorage() as never);

  test("a bus without multi-process delivers in single mode: no multi-process operation is called", async () => {
    const { layer, calls } = layerWithout();
    // the fake keeps no state, so the round loses its claim at the deletion pass; only the calls matter here
    await bind(layer, ["ordered-delivery"]).deliver().catch(() => undefined);
    expect(calls).toContain("readDeliveryState");
    expect(calls.filter((name) => ["lockDeliveryState", "writeProcess", "readProcesses", "lockHandlerProgress"].includes(name))).toEqual([]);
  });

  test("a bus with multi-process locks mesh_outbox_state, writes the nil claim and its process row", async () => {
    const { layer, calls } = layerWithout();
    await bind(layer, ["ordered-delivery", "multi-process"]).deliver().catch(() => undefined);
    expect(calls.slice(0, 4)).toEqual(["lockDeliveryState", "writeClaim", "readProcesses", "writeProcess"]);
  });

  test("a multi-mode start on a data layer that lacks one of them is a FrameworkError naming it, before anything is written", async () => {
    for (const missing of ["lockDeliveryState", "writeProcess", "writeSubscriptionOwner"]) {
      const { layer, calls } = layerWithout([missing]);
      const error = await bind(layer, ["ordered-delivery", "multi-process"]).deliver().then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe(`The data layer's transactions have no ${missing}: delivering events from several processes needs a data adapter with the multi-process delivery operations (MultiProcessOperations in @meshfw/runtime)`);
      expect(calls).toEqual([]);
    }
    // a layer without the single-mode ones gets their own message first
    const { layer } = layerWithout(["readDeliveryState"]);
    const error = await bind(layer, ["ordered-delivery", "multi-process"]).deliver().then(() => undefined, (thrown: unknown) => thrown);
    expect((error as Error).message).toStartWith("The data layer's transactions have no readDeliveryState: delivering events needs a data adapter with the delivery operations");
  });
});

describe("adoptByName, adoptHandler and keepByValue: arguments and mode (rules R5, K4, M6)", () => {
  /** A layer whose every operation reads nothing; only the refusals before or at the first read matter here. */
  const empty = (calls: string[] = []) => ({
    database: `fake #${Math.random()}`,
    transaction: async <T>(run: (ops: never) => Promise<T>) => run(new Proxy({}, {
      get: (_target, name) => async () => { calls.push(String(name)); return String(name).endsWith("DeliveryState") ? { deletedThrough: 0, highest: 0, generation: 0, claim: null, now: new Date(), keep: null } : String(name).startsWith("read") ? [] : undefined; },
    }) as never),
    refuseIfFailed: () => false,
    close: async () => {},
  }) as unknown as DataLayer;
  const bind = (layer: DataLayer, capabilities: readonly BusCapability[]) =>
    bindDomain({}, layer, { events: { bus: testBus({ capabilities }), load: async () => ({}) } }, new AsyncLocalStorage() as never);
  const rejection = (run: () => Promise<unknown>) => run().then(() => undefined, (error: unknown) => error as Error);

  test("outside multi mode each refuses before it opens a transaction, saying it applies to a bus that declares multi-process", async () => {
    const calls: string[] = [];
    const layer = empty(calls);
    expect((await rejection(() => adoptByName(layer, "h")))?.message).toBe("mesh events adopt applies to a project whose bus declares multi-process: in single mode a handler's events are the list its one deliverer registered");
    expect((await rejection(() => adoptByName(layer, "h", { multiProcess: false })))?.message).toStartWith("mesh events adopt applies to a project whose bus declares multi-process");
    expect((await rejection(() => keepByValue(layer, "all")))?.message).toBe("mesh events keep applies to a project whose bus declares multi-process: in single mode the deliverer's own keep is the one in force");
    expect((await rejection(() => adoptHandler(bind(layer, ["ordered-delivery"]), "h")))?.message).toStartWith("adoptHandler applies to a project whose bus declares multi-process");
    expect(calls).toEqual([]);
  });

  test("a bad name, drop list or keep is a FrameworkError worded as its neighbours", async () => {
    const layer = empty();
    const multi = bind(layer, ["ordered-delivery", "multi-process"]);
    expect(await rejection(() => adoptByName(layer, "", { multiProcess: true }))).toBeInstanceOf(FrameworkError);
    expect((await rejection(() => adoptByName(layer, "h", { drop: "multi.A" as never, multiProcess: true })))?.message).toBe('mesh events adopt: drop is a list of event names, such as ["billing.InvoiceVoided"], and is a string');
    expect((await rejection(() => adoptByName(layer, "h", { drop: [""], multiProcess: true })))?.message).toStartWith("mesh events adopt: drop is a list of event names");
    expect((await rejection(() => adoptHandler(multi, 3 as never)))?.message).toBe("adoptHandler takes a handler's name, and was given a number");
    expect((await rejection(() => adoptHandler(multi, "h", { drop: [1] as never })))?.message).toStartWith("adoptHandler: drop is a list of event names");
    expect((await rejection(() => keepByValue(layer, "forever" as never, { multiProcess: true })))?.message).toBe('mesh events keep takes "until-delivered" or "all", and was given a string');
  });

  test("adoptHandler on a multi-process binding runs adopt on its layer: a handler no live process registers is refused, named with the caller", async () => {
    const calls: string[] = [];
    const error = await rejection(() => adoptHandler(bind(empty(calls), ["ordered-delivery", "multi-process"]), "notify"));
    expect(error?.message).toBe('adoptHandler: no live process registers the handler "notify", so there is no list to adopt: if it was removed, drop its progress with `mesh events forget notify`');
    expect(calls.slice(0, 2)).toEqual(["lockDeliveryState", "readProcesses"]);
  });
});
