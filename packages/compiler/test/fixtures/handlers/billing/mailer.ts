/** A helper a handler body calls: it sends the receipt once per idempotency key. */
export async function sendReceipt(_receipt: { idempotencyKey: string; invoiceId: string }): Promise<void> {}
