// Run by bus-conformance.test.ts as a worker of the multi-process group: `runMultiProcessWorker` from
// `@meshfw/runtime/testing` with testBus declaring multi-process on the database and schema the group names (the
// fixture's "file": the URL, the schema and the layer's lock wait), then READY with its pid; SIGTERM stops delivery and exits.
import { AsyncLocalStorage } from "node:async_hooks";
import { runMultiProcessWorker, testBus } from "@meshfw/runtime/testing";
import { postgresWith } from "../src/layer.ts";
import { MULTI_CAPABILITIES } from "./event-tables.ts";

const [target, scenario, ...args] = process.argv.slice(2) as [string, string, ...string[]];
const { url, schema, waitMs } = JSON.parse(target) as { url: string; schema: string; waitMs: number };
const worker = await runMultiProcessWorker(scenario, args, {
  bus: testBus({ capabilities: MULTI_CAPABILITIES, retryDelays: [0, 0], pollMs: 20 }), layer: postgresWith({ url }, { schema, waitMs }), frame: new AsyncLocalStorage(),
});
console.log(`READY ${process.pid}`);
process.on("SIGTERM", () => {
  void worker.stop().then(() => { console.log("STOPPED"); process.exit(0); });
});
setInterval(() => {}, 1000);
