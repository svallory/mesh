/** Helpers the handler bodies call: a receipt sent once per idempotency key, and a type a body names. */
export const sent: string[] = [];
export async function sendReceipt(receipt: { idempotencyKey: string; invoiceId: string }): Promise<void> {
  sent.push(`${receipt.idempotencyKey} ${receipt.invoiceId}`);
}
export type Note = { readonly text: string };
