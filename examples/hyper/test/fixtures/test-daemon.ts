// The daemon as `main.ts` starts it (`runDaemon`), with two more methods that `test/daemon.test.ts` calls before it
// sends a signal:
//
// - `test.hang` never settles, to show the process still exits 0 within the spec's 5 seconds (PROTOCOL.md:38);
// - `test.write-twice` registers `<name>-1`, waits `pauseMs`, then registers `<name>-2`, all in one transaction, to
//   show a call that is inside its transaction when the signal arrives commits whole before the database closes.
//
//   bun test/fixtures/test-daemon.ts <socket> <db> [<start-up delay in ms>]
//
// With a delay, it logs `starting` once `runDaemon` has put its signal handlers in place, then waits that long before
// `startDaemon`, so a test can send a signal while the daemon is still starting.
//
// `MESH_TEST_DELIVERY_TIMING`, when set, is JSON for `setDeliveryTiming` (`{"lapseMs":1500,"renewMs":300}`), so a test
// can have a claim lapse, or a subscription overflow, in a fraction of the defaults. `MESH_TEST_GRACE_MS`, when set, is
// how long the daemon waits for its calls in flight before it exits anyway, in place of the real 4 s — the hang test
// uses it so its point, the grace exit itself, is reached without waiting the whole grace period.
import { localBus } from "@meshfw/bus-local";
import type { MethodTable } from "@meshfw/jsonrpc";
import type { ActionContext } from "@meshfw/runtime";
import { setDeliveryTiming, type DeliveryTiming } from "@meshfw/runtime/testing";
import { transaction } from "#mesh";
import { Collaborator } from "#mesh/domain/identity";
import config from "../../mesh.config";
import { runDaemon, startDaemon } from "../../src/daemon/daemon";
import { engineRule } from "../../src/rpc/context";
import { actorless, methods } from "../../src/rpc/methods";

const [socket, db, delay] = process.argv.slice(2);
if (!socket || !db) throw new Error("usage: bun test/fixtures/test-daemon.ts <socket> <db> [<start-up delay in ms>]");

const timing = process.env.MESH_TEST_DELIVERY_TIMING;
if (timing !== undefined) {
  setDeliveryTiming(JSON.parse(timing) as Partial<DeliveryTiming>);
  config.events = { ...config.events!, bus: localBus({ pollInterval: 20 }) };
}
const graceMs = process.env.MESH_TEST_GRACE_MS !== undefined ? Number(process.env.MESH_TEST_GRACE_MS) : undefined;
if (graceMs !== undefined && (!Number.isInteger(graceMs) || graceMs <= 0)) throw new Error("MESH_TEST_GRACE_MS must be a positive integer of milliseconds");

// Resolves on the turn after `SIGTERM` or `SIGINT` has run `exitOnSignal`'s handler, so a pause whose only job is to
// hold a transaction or start-up open until the signal arrives ends as soon as the signal is handled.
const signalled = new Promise<void>((resolve) => {
  const wake = () => setImmediate(resolve);
  process.once("SIGTERM", wake);
  process.once("SIGINT", wake);
});

const withTestMethods: MethodTable<ActionContext> = {
  ...methods,
  "test.hang": {
    run: () => {
      console.error("test.hang is running");
      return new Promise<never>(() => {});
    },
  },
  "test.write-twice": {
    run: async (params, context) => {
      const { name, pauseMs } = params as { readonly name: string; readonly pauseMs: number };
      // The engine's context runs no command, so its writes publish under a rule of their own (`causeOf` in src/events.ts).
      context = engineRule("test.write-twice", context);
      await transaction(async () => {
        await Collaborator.register({ kind: "agent", name: `${name}-1` }, context);
        console.error(`test.write-twice ${name} wrote ${name}-1`);
        await Promise.race([signalled, Bun.sleep(pauseMs)]);
        await Collaborator.register({ kind: "agent", name: `${name}-2` }, context);
      });
      console.error(`test.write-twice ${name} committed`);
      return { ok: true };
    },
  },
};

const options = { socket, db, methods: withTestMethods, actorless: new Set([...actorless, "test.hang", "test.write-twice"]) };
await runDaemon(async () => {
  if (delay !== undefined) {
    // `runDaemon` installs the handlers when `start` first awaits, which is here, so `starting` comes after them.
    await Bun.sleep(0);
    console.error("starting");
    await Promise.race([signalled, Bun.sleep(Number(delay))]);
  }
  return startDaemon(options);
}, graceMs);
