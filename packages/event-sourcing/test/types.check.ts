// Type checks of project(), on a bus that declares replay (./capabilities.ts merges localBus's capabilities, as a
// project's generated `#mesh` does). Run by the package's typecheck; `no-replay/from.check.ts` is the other side.
import "./capabilities.ts";
import { project, type FromOption, type ProjectHandler } from "../src/index.ts";

class Paid { readonly invoiceId: string = ""; constructor(_fields: { invoiceId: string }) {} }
class Voided { readonly reason: string = ""; constructor(_fields: { reason: string }) {} }

// The record's payload is inferred from `events`.
const one = project({ events: [Paid], run: (event) => { const id: string = event.payload.invoiceId; void id; } });
const handler: ProjectHandler<Paid> = one;
void handler;
project({ events: [Paid, Voided], run: (event) => { const payload: Paid | Voided = event.payload; void payload; } });
// @ts-expect-error a payload is only what the listed events make
project({ events: [Paid], run: (event) => { void event.payload.reason; } });

// With replay, `from` may be left out or set to either value.
project({ events: [Paid], run: () => undefined });
project({ events: [Paid], from: "beginning", run: () => undefined });
project({ events: [Paid], from: "now", run: () => undefined, renamedFrom: "old" });
// @ts-expect-error from is "beginning" or "now"
project({ events: [Paid], from: "later", run: () => undefined });
// @ts-expect-error a project handler takes no onFailure: it never skips an event
project({ events: [Paid], onFailure: "stop", run: () => undefined });

const optional: FromOption = {};
void optional;
