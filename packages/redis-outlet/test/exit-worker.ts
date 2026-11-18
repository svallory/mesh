// The second process of the outlet's exit test: binds a fresh database of the built project (argv[2]) with localBus,
// opens an outlet to argv[3] on the stream argv[4], publishes one InvoicePaid, runs one `deliver()` round, waits until
// the entry is in the stream, closes the outlet and the layer, and prints how many entries it saw. It must then exit
// on its own: a timer or a client the outlet left open would keep it running.
import { join } from "node:path";
import { RedisClient } from "bun";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { localBus } from "@meshfw/bus-local";
import { redisOutlet } from "../src/index.ts";

const [root, url, stream] = process.argv.slice(2) as [string, string, string];
const { bind, tables } = await import(join(root, ".mesh/index.ts"));
const { Invoice } = await import(join(root, ".mesh/domain/billing/index.ts"));
const layer = sqlite({ file: ":memory:" });
await createSchema(layer, tables);
const binding = bind(layer, { events: { bus: localBus() } });
const outlet = await redisOutlet(binding, { url, stream, events: ["billing.InvoicePaid"], maxLength: 10 });
const invoice = await binding.run(() => Invoice.open({}));
await binding.run(() => Invoice.pay({ id: invoice.id }));
await binding.deliver();
const reader = new RedisClient(url, { autoReconnect: false, enableOfflineQueue: false });
await reader.connect();
let sent = 0;
for (let tries = 0; tries < 200 && sent === 0; tries++) {
  sent = ((await reader.send("XRANGE", [stream, "-", "+"])) as unknown[]).length;
  if (sent === 0) await Bun.sleep(10);
}
await reader.send("DEL", [stream]);
reader.close();
await outlet.close();
await layer.close();
console.log(`sent ${sent}`);
