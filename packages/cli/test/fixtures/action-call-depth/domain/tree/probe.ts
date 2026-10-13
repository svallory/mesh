/**
 * What the fixture's entity files hand to application code: a function of an entity file calls these helpers, which
 * call back into the test (`hooks.call`), where the entity's actions and the binding are in reach. A helper hides an
 * action call from the build, so it runs where the build would refuse a direct call (a write policy). The helper imports
 * nothing: this file is in the CLI's own type check.
 */

/** What a helper calls an action with: set by the test, which knows the entity value and the binding. */
export const hooks: { call: ((kind: string, id: string | undefined) => Promise<unknown>) | undefined } = { call: undefined };
/** How many times `twiceCatching` ran, and how many times `ping` did. The test reads and resets them. */
export const counts = { twice: 0, ping: 0 };

export async function recurse(kind: string, id?: string): Promise<void> {
  if (!hooks.call) throw new Error("the test sets hooks.call");
  await hooks.call(kind, id);
}
export async function recurseOk(kind: string): Promise<boolean> {
  await recurse(kind);
  return true;
}
export async function recurseName(kind: string): Promise<string> {
  await recurse(kind);
  return "named";
}

/** A fail-closed helper: it calls the action twice and catches whatever the call throws. */
export async function twiceCatching(id: string): Promise<void> {
  counts.twice++;
  for (let call = 0; call < 2; call++) {
    try {
      await recurse("twice", id);
    } catch {
      // swallowed: the cap's error sticks to the root call all the same
    }
  }
}

export function ping(): void {
  counts.ping++;
}
