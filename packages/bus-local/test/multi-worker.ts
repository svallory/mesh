// Run by conformance.test.ts as a worker of the multi-process group: `runMultiProcessWorker` from
// `@meshfw/runtime/testing` with localBus({ processes: "many" }) on the file, then READY with its pid; SIGTERM stops
// delivery and exits.
import { AsyncLocalStorage } from "node:async_hooks";
import { runMultiProcessWorker } from "@meshfw/runtime/testing";
import { sqlite } from "@meshfw/data-sqlite";
import { localBus } from "../src/index.ts";

const [file, scenario, ...args] = process.argv.slice(2) as [string, string, ...string[]];
const worker = await runMultiProcessWorker(scenario, args, {
  bus: localBus({ processes: "many", retryDelays: [0, 0], pollInterval: 20 }), layer: sqlite({ file }), frame: new AsyncLocalStorage(),
});
console.log(`READY ${process.pid}`);
process.on("SIGTERM", () => {
  void worker.stop().then(() => { console.log("STOPPED"); process.exit(0); });
});
setInterval(() => {}, 1000);
