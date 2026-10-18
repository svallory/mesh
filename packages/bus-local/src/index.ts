// `@meshfw/bus-local`: `localBus()`, the first event-bus adapter (spec, Events and commands, "`localBus`, the first
// adapter"). It runs in the deliverer's process on any data adapter and reaches the outbox only through core's BusCore.
export { localBus, type LocalBusOptions } from "./local-bus.ts";
