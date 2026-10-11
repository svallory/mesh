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

/** The named keys of each member of `U`; an action that takes nothing has none (its input type is `{ [key: string]: never }`). */
type KeysOf<U> = U extends unknown ? (string extends keyof U ? never : keyof U) : never;
/** True for a member that takes `K` and requires it. */
type RequiredIn<U, K extends PropertyKey> = U extends unknown
  ? (string extends keyof U ? false : K extends keyof U ? ({} extends Pick<U, K> ? false : true) : false) : never;
/** What `input[K]` holds in each member: its type there, `undefined` where the member does not take it. */
type FieldOf<U, K extends PropertyKey> = U extends unknown ? (string extends keyof U ? undefined : K extends keyof U ? U[K] : undefined) : never;

/**
 * What `input` is in a function that runs for several actions (an `always` block, a policy), given the union of their
 * input types: every field one of them takes, required where every one of them requires it and optional otherwise.
 */
export type SharedInput<U> =
  & { [K in KeysOf<U> as false extends RequiredIn<U, K> ? never : K]: FieldOf<U, K> }
  & { [K in KeysOf<U> as false extends RequiredIn<U, K> ? K : never]?: FieldOf<U, K> };
