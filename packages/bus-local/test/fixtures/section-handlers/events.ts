// The events module: one listen handler, `log`, beside the handlers the entity files' `handlers` sections declare.
import { Mesh } from "meshfw";
import { InvoicePaid } from "#mesh/domain/billing";
import { record } from "./domain/billing/record.ts";

export const handlers = {
  listen: {
    log: Mesh.handler({ events: [InvoicePaid], run: (event) => { record(`module ${event.position} ${event.name}`); } }),
  },
};
