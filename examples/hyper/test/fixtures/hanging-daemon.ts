// The daemon as `main.ts` starts it, with one more method, `test.hang`, which never settles: `test/daemon.test.ts`
// calls it, then sends SIGTERM, to show the process still exits 0 within the spec's 5 seconds (PROTOCOL.md:38).
import type { MethodTable } from "@meshfw/jsonrpc";
import type { ActionContext } from "@meshfw/runtime";
import { exitOnSignal, startDaemon } from "../../src/daemon/daemon";
import { actorless, methods } from "../../src/rpc/methods";

const [socket, db] = process.argv.slice(2);
if (!socket || !db) throw new Error("usage: bun test/fixtures/hanging-daemon.ts <socket> <db>");

const withHang: MethodTable<ActionContext> = {
  ...methods,
  "test.hang": {
    run: () => {
      console.error("test.hang is running");
      return new Promise<never>(() => {});
    },
  },
};

const daemon = await startDaemon({ socket, db, methods: withHang, actorless: new Set([...actorless, "test.hang"]) });
exitOnSignal(daemon);
process.stdout.write("READY\n");
