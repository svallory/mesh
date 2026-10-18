import { defineConfig } from "@meshfw/runtime";
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "hyper.db" }),
  // The event log (spec, Events and commands, "What Hyper needs"): every event is kept, since clients read the history
  // and resume subscriptions from a cursor (PROTOCOL.md §6), and the build checks that the bus and the data adapter
  // give gapless positions, replay and live subscriptions.
  events: {
    bus: localBus(),
    keep: "all",
    requires: ["gapless-positions", "replay", "subscribe"],
    load: () => import("./src/events.ts"),
  },
});
