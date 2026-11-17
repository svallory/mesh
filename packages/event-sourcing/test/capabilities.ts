// The capabilities of the bus the tests use (localBus), merged into @meshfw/runtime as a project's generated `#mesh`
// merges them, so `project()` here takes `from` as a project on localBus does. `no-replay/` checks a bus without them.
import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface EventBusCapabilities {
    "ordered-delivery": true;
    replay: true;
    subscribe: true;
  }
}
