// The project's configuration: data-sqlite on app.db beside this file, and localBus, wrapped so that the tests can
// count the instances core makes (`counts.created`).
import { join } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";
import type { EventBus } from "@meshfw/runtime";

export const counts = { created: 0 };
const bus = localBus({ pollInterval: 25 });
const counted: EventBus = {
  manifest: bus.manifest,
  create(core, options) {
    counts.created++;
    return bus.create(core, options);
  },
};

export default {
  domain: "domain",
  output: ".mesh",
  data: sqlite({ file: join(import.meta.dir, "app.db") }),
  events: { bus: counted, load: () => import("./events.ts") },
};
