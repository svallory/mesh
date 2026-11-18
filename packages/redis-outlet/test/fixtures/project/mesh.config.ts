// The outlet's test project: data-sqlite and localBus. The tests bind their own layers and buses through the generated
// `bind`; this file is what `mesh build` reads.
import { join } from "node:path";
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";

export default {
  domain: "domain",
  surfaces: "surfaces",
  output: ".mesh",
  data: sqlite({ file: join(import.meta.dir, "app.db") }),
  events: { bus: localBus() },
};
