// The project's events module, read by connect(): one project handler that records each paid invoice in the read
// model `PaidInvoice`, from the beginning of history.
import { project } from "@meshfw/event-sourcing";
import { InvoicePaid, PaidInvoice } from "#mesh/domain/billing";

export const handlers = {
  project: {
    paidInvoices: project({
      events: [InvoicePaid],
      run: async (event, { context }) => {
        await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context);
      },
    }),
  },
};
