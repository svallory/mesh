// Type checks of project() on a bus without replay: nothing merges EventBusCapabilities here, so `from` is required
// and can only be "now", and the default that would fail at start is a type error too. Its own program
// (`tsconfig.json` beside it), so the package's ./capabilities.ts does not reach it.
import { project } from "../../src/index.ts";

class Paid { readonly invoiceId: string = ""; constructor(_fields: { invoiceId: string }) {} }

project({ events: [Paid], from: "now", run: () => undefined });
// @ts-expect-error from the beginning needs the bus's replay
project({ events: [Paid], from: "beginning", run: () => undefined });
// @ts-expect-error leaving from out means "beginning", which needs the bus's replay
project({ events: [Paid], run: () => undefined });
