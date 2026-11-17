// The project's events module, read by connect(): one handler of the test kind `model` that records each paid invoice
// in the read model `PaidInvoice`.
import { InvoicePaid, PaidInvoice } from "#mesh/domain/billing";
import { model } from "./kind.ts";

export const handlers = {
  model: {
    paidInvoices: model({
      events: [InvoicePaid],
      run: async (event, { context }) => {
        await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context);
      },
    }),
  },
};
