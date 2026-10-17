/**
 * What the fixture's entity file hands to application code: `made` returns whatever the test sets, so a publish can return
 * what the build cannot see (null, a plain object, a command), and `step` calls back into the test, where the entity's
 * actions and the binding are in reach. The helper imports nothing: this file is in the CLI's own type check.
 */
export const hooks: {
  made: (() => unknown) | undefined;
  step: ((kind: string, id: string) => Promise<unknown>) | undefined;
} = { made: undefined, step: undefined };

/**
 * The value a `publish` returns, set by the test. Typed `never` so the generated tree type-checks: what it returns at run
 * time is what the run-time check of the publish step refuses or accepts.
 */
export function made(): never {
  if (!hooks.made) throw new Error("the test sets hooks.made");
  return hooks.made() as never;
}

/** A step that calls back into the test, inside the action's transaction. */
export async function step(kind: string, id: string): Promise<void> {
  if (!hooks.step) throw new Error("the test sets hooks.step");
  await hooks.step(kind, id);
}
