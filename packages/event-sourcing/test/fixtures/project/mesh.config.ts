// The project's configuration: data-sqlite on app.db beside this file, localBus, and `keep: "all"`, so the rows
// published before a project handler first registers are kept for it to replay.
import { join } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";

export default {
  domain: "domain",
  output: ".mesh",
  data: sqlite({ file: join(import.meta.dir, "app.db") }),
  events: { bus: localBus({ pollInterval: 25 }), keep: "all" as const, load: () => import("./events.ts") },
};
