// The project's configuration: data-sqlite on app.db beside this file, localBus, and an events module whose one handler
// is registered beside the `handlers` sections' (its `log`, keyed by its bare name).
import { join } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";

export default {
  domain: "domain",
  output: ".mesh",
  data: sqlite({ file: join(import.meta.dir, "app.db") }),
  events: { bus: localBus({ pollInterval: 25 }), load: () => import("./events.ts") },
};
