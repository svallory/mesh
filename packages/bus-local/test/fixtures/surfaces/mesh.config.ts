// A project with one surface whose `publishes` section lists two events: data-sqlite on app.db beside this file, and
// localBus, so `subscribe` from `#mesh` reads the events the surface sends out.
import { join } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";

export default {
  domain: "domain",
  surfaces: "surfaces",
  output: ".mesh",
  data: sqlite({ file: join(import.meta.dir, "app.db") }),
  events: { bus: localBus({ pollInterval: 25 }), load: () => import("./events.ts") },
};
