/** Every call of `hit`, in order: the test reads and clears it. */
export const calls: string[] = [];

/**
 * A helper behind a guard. It records its tag, throws when `throws` is set (the guard should have kept it from running)
 * and returns `value` otherwise.
 */
export function hit<T>(tag: string, throws: boolean, value: T): T {
  calls.push(tag);
  if (throws) throw new Error(`the helper ${tag} must not run`);
  return value;
}

/** A guard that is itself a helper call. */
export function isBig(n: number | null | undefined): boolean {
  calls.push("isBig");
  return (n ?? 0) > 100;
}
