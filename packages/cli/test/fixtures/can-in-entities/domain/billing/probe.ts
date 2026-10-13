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

/** What a helper asks: the receipt's policies with `Mesh.can` or `Mesh.checkPolicies`, or the receipt itself (an entity's action), or a ledger's `settle`. Set by the test. */
export type Kind = "can" | "checkPolicies" | "action" | "settle" | "grind";
export const asker: { current: ((kind: Kind, context: { system?: boolean }, id: string) => Promise<unknown>) | undefined } = { current: undefined };
const ask = (kind: Kind, context: { system?: boolean }, id: string): Promise<unknown> => {
  if (!asker.current) throw new Error("the test sets asker.current");
  return asker.current(kind, context, id);
};

/**
 * Asks and drops the promise, answering a plain value, as a computed field or a read policy needs. While one is evaluated
 * the call is refused by throwing, so it throws out of the field or the policy; the rejection of a promise nobody awaits
 * would end the process, so a promise that does come back is caught.
 */
export function askQuietly(kind: Kind, context: { system?: boolean }): boolean {
  ask(kind, context, "00000000-0000-4000-8000-000000000000").catch(() => undefined);
  return true;
}

/** The same question, awaited and answered: from a write policy (a helper hides the call from the build), where it runs. */
export async function askLoudly(kind: Kind, context: { system?: boolean }, id: string): Promise<boolean> {
  return (await ask(kind, context, id)) === true;
}

/** A ledger's policy asks whether its parent may be settled, up to the root, which has none: a recursion that ends. */
export async function askAboutParent(context: { system?: boolean }, parentId: string | null): Promise<boolean> {
  return parentId === null || await askLoudly("settle", context, parentId);
}

/** A fail-closed helper: it asks the ledger's own `grind` and answers false when the question throws, whatever it throws. */
export async function askCatching(context: { system?: boolean }, id: string): Promise<boolean> {
  try {
    return await askLoudly("grind", context, id);
  } catch {
    return false;
  }
}
