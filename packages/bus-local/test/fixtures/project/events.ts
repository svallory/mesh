// The project's events module: `refundOnPay` (process) refunds each paid invoice, and `log` (listen) records every
// event it is handed in `seen`, which the tests read. `control.failPay` makes `refundOnPay` fail after its refund.
import { Mesh } from "meshfw";
import { Invoice, InvoicePaid, RefundIssued } from "#mesh/domain/billing";

export const seen: string[] = [];
export const control = { failPay: false };

export const handlers = {
  process: {
    refundOnPay: Mesh.handler({
      events: [InvoicePaid],
      run: async (event, { context }) => {
        await Invoice.refund({ id: event.payload.invoiceId }, context);
        if (control.failPay) throw new Error("the refund is refused");
      },
    }),
  },
  listen: {
    log: Mesh.handler({
      events: [InvoicePaid, RefundIssued],
      run: (event) => {
        seen.push(`${event.position} ${event.name}`);
      },
    }),
  },
};
