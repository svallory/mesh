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
import type { MethodTable } from "@meshfw/jsonrpc";
import type { ActionContext } from "@meshfw/runtime";
import { transaction } from "#mesh";
import { Collaborator } from "#mesh/domain/identity";
import { runDaemon, startDaemon } from "../../src/daemon/daemon";
import { actorless, methods } from "../../src/rpc/methods";

const [socket, db, delay] = process.argv.slice(2);
if (!socket || !db) throw new Error("usage: bun test/fixtures/test-daemon.ts <socket> <db> [<start-up delay in ms>]");

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
      await transaction(async () => {
        await Collaborator.register({ kind: "agent", name: `${name}-1` }, context);
        console.error(`test.write-twice ${name} wrote ${name}-1`);
        await Bun.sleep(pauseMs);
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
    await Bun.sleep(Number(delay));
  }
  return startDaemon(options);
});
