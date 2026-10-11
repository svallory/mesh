import { failJoined } from "./compose.ts";
import type { DataLayer } from "./data-layer.ts";
import { ForbiddenError, FrameworkError, type PolicyCheck } from "./errors.ts";

/**
 * The policy evaluator the generated actions call (M8, ADR-0055, POL-03). Policies combine without order: a policy passes
 * when none of its `forbid-if` is true and, if it has any `authorize-if`, at least one is true; every policy that covers
 * the action must pass, and an action no policy covers is forbidden. An unknown `forbid-if` forbids (POL-04), an unknown
 * `authorize-if` does not authorize, and an unknown `when` fails its policy: every unknown fails closed.
 *
 * A check that reads only `actor`, `context` and `input` runs once, before the transaction opens (`before`); one that reads
 * the record (`self`, a related record, `tx`) runs inside it, on the locked row or a create's new instance (`inside`). The
 * build decides which is which and says so in each spec (`record`).
 */

/** A function of the entity's expressions file: it takes the scope. */
export type PolicyFunction = (scope: never) => unknown;

/** One `authorize-if` or `forbid-if` of a policy, as the generated actions pass it. */
export interface PolicyCheckSpec {
  readonly kind: "authorize-if" | "forbid-if";
  /** The function as written in the entity file, for the breakdown. */
  readonly check: string;
  /** True when the check reads the record (or anything the build cannot analyse): it then runs inside the transaction. */
  readonly record: boolean;
  readonly run: PolicyFunction;
}

/** One policy that covers the action by its `types=`/`actions=` scope. */
export interface PolicySpec {
  readonly name: string;
  /** The policy's `when=`: false means the policy does not cover this call; unknown fails it. */
  readonly when: { readonly check: string; readonly record: boolean; readonly run: PolicyFunction } | null;
  readonly checks: readonly PolicyCheckSpec[];
}

/** The policies of one call: made per call, since it keeps what the checks before the transaction gave. */
export interface Authorizer {
  /**
   * The pre-check, before the transaction opens: runs every check that does not read the record and throws
   * `ForbiddenError` as soon as the answer is known to be no. When no check reads the record, this is the whole decision.
   * Inside a running transaction (a nested call), a denial fails that transaction, as a failed cast does.
   */
  before(layer: DataLayer, scope: object): Promise<void>;
  /** Inside the transaction, before `validate`: runs the checks that read the record and decides. */
  inside(scope: object): Promise<void>;
  /**
   * A read's policies as a filter (ADR-0022): true when every covering policy passes, false when one fails (the read then
   * returns no rows). A read no policy covers is forbidden.
   */
  filter(layer: DataLayer, scope: object): Promise<boolean>;
}

type Spec = PolicySpec["when"] & object;
type Result = boolean | null;

/** `true` and `false` are themselves; anything else (null, undefined, a non-boolean from plain code) is unknown. */
const outcome = (value: unknown): Result => (value === true ? true : value === false ? false : null);

export function authorizer(entity: string, action: string, policies: readonly PolicySpec[]): Authorizer {
  const results = new Map<Spec | PolicyCheckSpec, Result>();
  const run = async (spec: Spec | PolicyCheckSpec, scope: object) => {
    if (!results.has(spec)) results.set(spec, outcome(await spec.run(scope as never)));
  };
  /** Runs the checks `wanted` selects, in the order written; a policy whose `when` is false covers nothing, so its checks are skipped. */
  const evaluate = async (scope: object, wanted: (record: boolean) => boolean) => {
    for (const policy of policies) {
      if (policy.when && wanted(policy.when.record)) await run(policy.when, scope);
      if (policy.when && results.get(policy.when) === false) continue;
      for (const check of policy.checks) if (wanted(check.record)) await run(check, scope);
    }
  };
  const covers = (policy: PolicySpec): "yes" | "no" | "not-yet" =>
    !policy.when ? "yes" : !results.has(policy.when) ? "not-yet" : results.get(policy.when) === false ? "no" : "yes";
  /** True when the policy has failed, false when it has passed, undefined while a check it needs has not run. */
  const fails = (policy: PolicySpec): boolean | undefined => {
    if (policy.when && results.get(policy.when) === null) return true;
    const forbids = policy.checks.filter((check) => check.kind === "forbid-if");
    const authorizes = policy.checks.filter((check) => check.kind === "authorize-if");
    if (forbids.some((check) => results.has(check) && results.get(check) !== false)) return true;
    if (authorizes.length && authorizes.every((check) => results.has(check)) && !authorizes.some((check) => results.get(check) === true)) return true;
    return policy.checks.every((check) => results.has(check)) ? false : undefined;
  };
  const breakdown = (): PolicyCheck[] => {
    const out: PolicyCheck[] = [];
    for (const policy of policies) {
      if (covers(policy) !== "yes") continue;
      const failed = fails(policy) === true;
      const unknownWhen = policy.when !== null && results.get(policy.when) === null;
      if (unknownWhen) out.push({ policy: policy.name, kind: "when", check: policy.when!.check, result: null, decisive: true });
      const ran = policy.checks.filter((check) => results.has(check));
      const forbidding = ran.filter((check) => check.kind === "forbid-if" && results.get(check) !== false);
      for (const check of ran) {
        const result = results.get(check)!;
        const decisive = failed && !unknownWhen && (forbidding.length ? forbidding.includes(check) : check.kind === "authorize-if");
        out.push({ policy: policy.name, kind: check.kind, check: check.check, result, decisive });
      }
    }
    return out;
  };
  const denial = (failed: readonly PolicySpec[]) =>
    new ForbiddenError({ entity, action, policies: failed.map((policy) => policy.name), breakdown: breakdown() });
  /** The final answer, once every check has run: undefined when allowed, else the error. */
  const decide = (): ForbiddenError | undefined => {
    const covering = policies.filter((policy) => covers(policy) === "yes");
    if (covering.length === 0) return denial([]);
    const failed = covering.filter((policy) => fails(policy) === true);
    return failed.length ? denial(failed) : undefined;
  };
  /** A nested call (inside a running transaction) fails that transaction, as a failed cast does; a top-level call rejects. */
  const reject = (layer: DataLayer, error: Error): Promise<never> => {
    if (layer.refuseIfFailed()) return failJoined(layer, error);
    throw error;
  };
  return Object.freeze({
    async before(layer: DataLayer, scope: object): Promise<void> {
      await evaluate(scope, (record) => !record);
      const known = policies.filter((policy) => covers(policy) === "yes" && fails(policy) === true);
      if (known.length) return reject(layer, denial(known));
      // Nothing left for the transaction: this is the whole decision (no covering policy included).
      if (policies.every((policy) => covers(policy) === "no" || (covers(policy) === "yes" && fails(policy) !== undefined))) {
        const error = decide();
        if (error) return reject(layer, error);
      }
    },
    async inside(scope: object): Promise<void> {
      await evaluate(scope, () => true);
      const error = decide();
      if (error) throw error;
    },
    async filter(layer: DataLayer, scope: object): Promise<boolean> {
      const reads = policies.find((policy) => policy.when?.record || policy.checks.some((check) => check.record));
      if (reads)
        return reject(layer, new FrameworkError(`${entity}.${action} cannot run in this version: policy :${reads.name} reads the record, `
          + "and a read policy that reads the record is a filter on the query, which the SQL evaluator folds in M10"));
      await evaluate(scope, () => true);
      const error = decide();
      if (!error) return true;
      if (error.policies.length === 0) return reject(layer, error);
      return false;
    },
  });
}

/** `isSystem(context)`, as entity files call it (ADR-0071). */
export { isSystem } from "./expr.ts";
