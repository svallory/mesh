/**
 * What the fixture's entity files hand to application code: a function of an entity file calls these helpers, and the test
 * reads what they kept. A helper that asks is the way a computed field or a read policy hides `Mesh.can` from the build
 * (it is not written in the entity file), which the run time refuses while the field or the policy is evaluated. The
 * helper imports nothing: the test sets what it asks with (`asker`), since this file is in the CLI's own type check.
 */

/** What the steps saw, in order. */
export const seen: unknown[] = [];
export function remember(value: unknown): void {
  seen.push(value);
}

/** Asks `Mesh.can(Receipt.record, ...)` for the invoice, as the context of the call but the system. Set by the test. */
export const asker: { current: ((context: { system?: boolean }, invoiceId: string) => Promise<boolean>) | undefined } = { current: undefined };
const ask = (context: { system?: boolean }, invoiceId: string): Promise<boolean> => {
  if (!asker.current) throw new Error("the test sets asker.current");
  return asker.current(context, invoiceId);
};

/** The promises of the questions a helper asked while a computed field or a policy was evaluated; each is expected to reject. */
export const hidden: Promise<boolean>[] = [];
/** Asks and keeps the promise. Returns a plain value, as a computed field or a read policy needs. */
export function askQuietly(context: { system?: boolean }): boolean {
  const asked = ask(context, "00000000-0000-4000-8000-000000000000");
  asked.catch(() => undefined);
  hidden.push(asked);
  return true;
}

/** The same question, awaited and answered: from a write policy (a helper hides the call from the build), where it runs. */
export async function askLoudly(context: { system?: boolean }, invoiceId: string): Promise<boolean> {
  return ask(context, invoiceId);
}
