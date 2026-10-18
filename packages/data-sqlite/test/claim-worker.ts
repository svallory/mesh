// Run by bus-conformance.test.ts as a second process: binds an empty domain with a bus on the file, starts delivery
// (which claims and then renews every 50 ms), prints READY with its pid, and runs until the parent kills it.
import { AsyncLocalStorage } from "node:async_hooks";
import { bindDomain } from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import { sqlite } from "../src/index.ts";

const [file] = process.argv.slice(2) as [string];
setDeliveryTiming({ renewMs: 50 });
const layer = sqlite({ file });
const binding = bindDomain({}, layer, { events: { bus: testBus({ pollMs: 50 }), load: async () => ({}) } }, new AsyncLocalStorage());
await binding.startDelivery();
console.log(`READY ${process.pid}`);
setInterval(() => {}, 1000);
