import type { Issue, IssueSource } from "./errors.ts";
import type { Clock } from "./expr.ts";

/** What `bind(layer, options)` takes. The clock is what `now()` reads in a function of an entity file (ADR-0012, M4 D6). */
export interface BindOptions {
  clock?: Clock | undefined;
}

/**
 * One `check` of an action, as the generated code declares it (M5, ADR-0053). The functions are the compiled
 * expressions of the entity (`<entity>.expressions.ts`); the scope is `{ self, input, actor, context, before }`.
 */
export interface CheckSpec {
  label: string;
  code: string;
  message: string;
  /** Where the `check` tag sits in the entity file: embedded as data, so a failure names its line (ADR-0039). */
  source: IssueSource;
  that: (scope: never) => unknown;
  when?: (scope: never) => unknown;
  details?: (scope: never) => unknown;
}

/**
 * Run one check and, if it fails, add its issue to `issues`; never throws for a failed check, so that every failed
 * check of an action is reported together. A check passes when `that` is true. `false` fails it, and so does an
 * unknown result (`null`), because a rule over a missing value must not pass silently (ADR-0012, ruling D1). A `when`
 * that is not true, unknown included, skips the check. `details` is worked out only for a failed check.
 */
export async function runCheck(issues: Issue[], scope: object, spec: CheckSpec): Promise<void> {
  const s = scope as never;
  if (spec.when && !(await spec.when(s))) return;
  if (await spec.that(s)) return;
  const details = spec.details ? await spec.details(s) : null;
  issues.push({
    label: spec.label,
    code: spec.code,
    path: [],
    message: spec.message,
    source: spec.source,
    details: details === undefined ? null : details,
  });
}
