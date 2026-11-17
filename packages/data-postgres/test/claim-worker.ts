// Run by claim.test.ts as a second process: binds an empty domain with a bus on the given database and schema,
// starts delivery (which claims and then renews every 50 ms), prints READY with its pid, and runs until killed.
import { AsyncLocalStorage } from "node:async_hooks";
import { bindDomain } from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import { postgresWith } from "../src/layer.ts";

const [url, schema] = process.argv.slice(2) as [string, string];
setDeliveryTiming({ renewMs: 50 });
const layer = postgresWith({ url }, { schema });
const binding = bindDomain({}, layer, { events: { bus: testBus({ pollMs: 50 }), load: async () => ({}) } }, new AsyncLocalStorage());
await binding.startDelivery();
console.log(`READY ${process.pid}`);
setInterval(() => {}, 1000);
