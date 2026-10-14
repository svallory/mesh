import { FrameworkError, type Issue, type IssueSource } from "./errors.ts";
import { now, type Clock, type Scope } from "./expr.ts";
import type { Seams } from "./seams.ts";

/**
 * What `bind(layer, options)` takes. The clock is what `%.now` reads in a function of an entity file (ADR-0012, M4 D6):
 * read once per transaction (ACT-29), by the action call, read or application `transaction` that opens it. `seams` are
 * the lifecycle seams of every action (ADR-0075).
 */
export interface BindOptions {
  clock?: Clock | undefined;
  seams?: Seams | undefined;
}

/**
 * One `check` of an action, as the generated code declares it (M5, ADR-0053). The functions are the compiled
 * expressions of the entity (`<entity>.expressions.ts`); the scope is `{ self, input, actor, context }` with no
 * `before` (ACT-01, ACT-27): `self` is the record before the input is applied (see `checkScope`).
 */
export interface CheckSpec {
  label: string;
  code: string;
  /** Fixed text, or (ACT-30) a function of the arguments `that` gets; it runs only for a failed check and must return a string. */
  message: string | ((scope: never) => unknown);
  /** The entity the check belongs to, named by the error a `message` function causes. */
  entity?: string;
  /** Where the `check` tag sits in the entity file: embedded as data, so a failure names its line (ADR-0039). */
  source: IssueSource;
  that: (scope: never) => unknown;
  when?: (scope: never) => unknown;
  details?: (scope: never) => unknown;
}

/**
 * The scope the checks get: the action's scope without `before` (ACT-01, ACT-27). There `self` is already the record
 * before the input, so `before` would only repeat it. The build reports a check that names `before` as
 * `MESH_VALIDATE_BEFORE`; one that hands the rest of its scope to a helper (`({ context, ...rest }) => helper(rest)`)
 * passes the build, and finds nothing there rather than a value the rule forbids. The copy reads the action's one
 * instant (`now`), as `rescope` does, so a check and a step of the same action see the same time.
 */
export function checkScope<S extends Scope<object>>(scope: S): Omit<S, "before"> {
  const copy: { before?: unknown; clock: Clock } = { ...scope, clock: () => now(scope) };
  delete copy.before;
  return copy as unknown as Omit<S, "before">;
}

/**
 * Run one check and, if it fails, add its issue to `issues`; never throws for a failed check, so that every failed
 * check of an action is reported together. A check passes when `that` is true. `false` fails it, and so does an
 * unknown result (`null`), because a rule over a missing value must not pass silently (ADR-0012, ruling D1). A `when`
 * that is not true, unknown included, skips the check. `details` and a `message` function are worked out only for a failed
 * check. A `message` function that throws or returns anything but a string is a `FrameworkError` naming the entity, the
 * check and its line (ACT-30): the failure is never swallowed and never replaced by other text.
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
    message: typeof spec.message === "string" ? spec.message : await messageOf(spec, s, spec.message),
    source: spec.source,
    details: details === undefined ? null : details,
  });
}

/** Run a check's `message` function; any failure of it names the check (ACT-30). */
async function messageOf(spec: CheckSpec, scope: never, message: (scope: never) => unknown): Promise<string> {
  const where = `the message of check :${spec.label}${spec.entity ? ` of ${spec.entity}` : ""} (${spec.source.file}:${spec.source.line})`;
  let text: unknown;
  try {
    text = await message(scope);
  } catch (cause) {
    throw new FrameworkError(`${where} threw: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (typeof text !== "string") {
    throw new FrameworkError(`${where} must return a string, and returned ${text === null ? "null" : Array.isArray(text) ? "an array" : typeof text}`);
  }
  return text;
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
