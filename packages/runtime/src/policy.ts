import { Answer, answers } from "./answer.ts";
import { failJoined } from "./compose.ts";
import { bindCondition, type Bound, type Condition, type ConditionLiteral, type Mark, type TableOf, type Where } from "./condition.ts";
import type { DataLayer, WriteGuard } from "./data-layer.ts";
import type { ActionFrame } from "./entity.ts";
import { ForbiddenError, FrameworkError, PolicyGuardDenial, guardCountMismatch, type PolicyCheck } from "./errors.ts";

/**
 * The policy evaluator the generated actions call (M8, ADR-0055). Policies combine without order: a policy passes
 * when none of its `forbid-if` is true and, if it has any `authorize-if`, at least one is true; every policy that covers
 * the action must pass, and an action no policy covers is forbidden. An unknown `forbid-if` forbids, an unknown
 * `authorize-if` does not authorize, and an unknown `when` fails its policy: every unknown fails closed.
 *
 * A check that reads only `actor`, `context` and `input` runs once, before the transaction opens (`before`); one that reads
 * the record (`self`, a related record), calls `privileged` or calls an imported function runs inside it, on the locked row or a create's new instance (`inside`). The
 * build decides which is which and says so in each spec (`record`).
 *
 * The build refuses a policy with no check; one that reaches the evaluator anyway fails, so that a policy object
 * not built by the compiler cannot open what it covers. Whether a policy covers the action is decided by its scope
 * (`types=`/`actions=`), at build time: `policies` holds the covering ones, and when it is empty no policy covers the
 * action. A covering policy whose `when=` is false does not apply to the call; when none applies, a write is forbidden
 * and a read gives no rows (S1 of the PR #79 review).
 *
 * A read policy is a filter on the query (ADR-0022): `filter` decides it for the whole read when no check reads the
 * record, and `rows` folds the checks that do into a condition on each row (M10): each such check carries `sql`, its
 * condition literal, which is bound with the caller's scope and combined with what the other checks gave by the same
 * rules, applied row by row. `admits` and `admitsRows` do the same for a caller's load of the entity.
 *
 * A destroy that runs as one statement (ADR-0046, option B) hands the checks that read the record to the data layer:
 * `guard` binds them on the pre-check's scope into a `WriteGuard`, and `statement` turns the adapter's
 * `PolicyGuardDenial` into the `ForbiddenError` `inside` would have thrown, from the same results.
 *
 * `Mesh.checkPolicies` runs the call itself on a layer that answers (`answer.ts`): `before`, `filter` and `rows` see it,
 * and once the policies have decided they throw an `Answer` with the decision, which `inside` then does too, instead of
 * resolving, rejecting with `ForbiddenError` or failing a running transaction. The checks run exactly as for the call.
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
  /**
   * On a check that reads the record, of a policy that covers a read or a load: its condition literal, which `rows` and
   * `admitsRows` bind and fold into the query; on one of a destroy that runs as one statement, the literal `guard` binds. A thunk, since the load plan that holds it is built at module load and the
   * expressions file that holds the literal may be in an import cycle with it.
   */
  readonly sql?: (() => ConditionLiteral<never>) | undefined;
}

/** One policy that covers the action by its `types=`/`actions=` scope. */
export interface PolicySpec {
  readonly name: string;
  /** The policy's `when=`: false means the policy does not cover this call; unknown fails it. */
  readonly when: { readonly check: string; readonly record: boolean; readonly run: PolicyFunction; readonly sql?: (() => ConditionLiteral<never>) | undefined } | null;
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
   * A read's policies as a filter (ADR-0022): true when every covering policy passes, false when one fails or none applies
   * (the read then returns no rows). A read no policy covers is forbidden. For policies none of whose checks reads the
   * record; one that does goes through `rows`.
   */
  filter(layer: DataLayer, scope: object): Promise<boolean>;
  /**
   * A read's policies as a condition on each row (M10): the checks that do not read the record run in memory, as with
   * `filter`; each one that does is bound (its `sql` literal, with `scope`, its parameters computed marked with the frame)
   * and the policies are combined row by row: a row is returned when at least one covering policy applies to it and every
   * one that applies passes. `false` is no row (the read then runs no query), `true` every row, else the condition. A read
   * no policy covers is forbidden. Answering for `Mesh.checkPolicies`, the read is allowed unless the result is `false`:
   * what reads the record is part of the query, and denies no call.
   */
  rows(layer: DataLayer, scope: object, tableOf: TableOf): Promise<Where>;
  /**
   * A load's policies: the read policies of the entity a caller loads, run with the caller's scope. True when they
   * admit the caller, false when one fails, none applies or none covers the load: a load no policy covers gives nothing,
   * never an error. Inside the transaction, so a throw fails it. For policies none of whose checks reads the record.
   */
  admits(scope: object): Promise<boolean>;
  /** A load's policies as a condition on each row of the entity reached, as `rows` does for a read; none covering is `false`. */
  admitsRows(scope: object, tableOf: TableOf): Promise<Where>;
  /** True when the call runs for `Mesh.checkPolicies` or `Mesh.can` (known after `before`). */
  readonly answering: boolean;
  /**
   * After `before`, for a write that runs as one statement (ADR-0046, option B): every check that reads the record, of
   * every policy that applies, bound on `scope` (the pre-check's scope: actor, context, input, clock), with which of
   * them decide and how; undefined when no applying policy has one (`before` then decided). Throws a `FrameworkError`
   * when one of them has no `sql`, or when a policy's `when` reads the record (the build never guards such a write).
   */
  guard(scope: object, tableOf: TableOf): WriteGuard | undefined;
  /**
   * Run the guarded write. A `PolicyGuardDenial` it throws becomes the decision: its results are recorded as `inside`
   * would have recorded them and the same `ForbiddenError` is thrown. A denial whose results admit the call is a
   * `FrameworkError`, never an allow. Any other error passes through unchanged. Called while answering, it throws a
   * `FrameworkError`: a permission question never takes the guarded write.
   */
  statement<T>(write: () => Promise<T>): Promise<T>;
}

type Spec = PolicySpec["when"] & object;
type Result = boolean | null;
/** A two-valued part of the per-row formula: a constant, or a condition that is true or false on each row. */
type Part = boolean | Condition;

const call = (fn: "isTrue" | "isFalse" | "and" | "or", args: Condition[]): Condition => ({ kind: "call", fn, args });
/** `x IS TRUE`: unknown is not true. */
const isTrue = (value: Result | Condition): Part => (value === true || value === false || value === null ? value === true : call("isTrue", [value]));
/** `x IS FALSE`: unknown is not false. */
const isFalse = (value: Result | Condition): Part => (value === true || value === false || value === null ? value === false : call("isFalse", [value]));
/** `AND` (or `OR`) of two-valued parts, the constants folded away: `false` (`true`) absorbs, `true` (`false`) drops out. */
const combine = (fn: "and" | "or", parts: readonly Part[]): Part => {
  const absorbing = fn === "or";
  const kept: Condition[] = [];
  for (const part of parts) {
    if (part === absorbing) return absorbing;
    if (part !== !absorbing) kept.push(part as Condition);
  }
  if (kept.length === 0) return !absorbing;
  return kept.length === 1 ? kept[0]! : call(fn, kept);
};

/** `true` and `false` are themselves; anything else (null, undefined, a non-boolean from plain code) is unknown. */
const outcome = (value: unknown): Result => (value === true ? true : value === false ? false : null);

/**
 * `entity` is the entity's FQN (e.g. `blog.Post`); a denial carries it. `frame` is the binding's: a read policy (`filter`,
 * `admits`) runs marked with it, so a `privileged` read made while it is evaluated throws.
 */
export function authorizer(entity: string, action: string, policies: readonly PolicySpec[], frame?: Pick<ActionFrame, "marked">): Authorizer {
  const results = new Map<Spec | PolicyCheckSpec, Result>();
  let reading = false;
  /** True when the call runs for `Mesh.checkPolicies`: set by `before` or `filter` from the layer the call runs on. */
  let answering = false;
  const run = async (policy: PolicySpec, spec: Spec | PolicyCheckSpec, scope: object) => {
    if (results.has(spec)) return;
    const value = reading && frame ? frame.marked(`policy :${policy.name} of ${entity}`, () => spec.run(scope as never)) : spec.run(scope as never);
    results.set(spec, outcome(await value));
  };
  /** Runs the checks `wanted` selects, in the order written; a policy whose `when` is false covers nothing, so its checks are skipped. */
  const evaluate = async (scope: object, wanted: (record: boolean) => boolean) => {
    for (const policy of policies) {
      if (policy.when && wanted(policy.when.record)) await run(policy, policy.when, scope);
      if (policy.when && results.get(policy.when) === false) continue;
      for (const check of policy.checks) if (wanted(check.record)) await run(policy, check, scope);
    }
  };
  const covers = (policy: PolicySpec): "yes" | "no" | "not-yet" =>
    !policy.when ? "yes" : !results.has(policy.when) ? "not-yet" : results.get(policy.when) === false ? "no" : "yes";
  /** True when the policy has failed, false when it has passed, undefined while a check it needs has not run. */
  const fails = (policy: PolicySpec): boolean | undefined => {
    if (policy.when && results.get(policy.when) === null) return true;
    // a policy with no check is a build error; one that gets here anyway fails closed.
    if (policy.checks.length === 0) return true;
    const forbids = policy.checks.filter((check) => check.kind === "forbid-if");
    const authorizes = policy.checks.filter((check) => check.kind === "authorize-if");
    if (forbids.some((check) => results.has(check) && results.get(check) !== false)) return true;
    if (authorizes.length && authorizes.every((check) => results.has(check)) && !authorizes.some((check) => results.get(check) === true)) return true;
    return policy.checks.every((check) => results.has(check)) ? false : undefined;
  };
  /**
   * One entry per check that ran. On a denial, `decisive` marks what denied the call; on an allowed call (`allowed`, for
   * `Mesh.checkPolicies`), what allowed it: in each policy that applies, the `authorize-if` checks that held, or, in one
   * with no `authorize-if`, its `forbid-if` checks, all false.
   */
  const breakdown = (allowed = false): PolicyCheck[] => {
    const out: PolicyCheck[] = [];
    for (const policy of policies) {
      // A `when` that did not apply is listed only when no policy applied: it is then what decided.
      if (covers(policy) === "no" && !policies.some((other) => covers(other) === "yes"))
        out.push({ policy: policy.name, kind: "when", check: policy.when!.check, result: false, decisive: true });
      if (covers(policy) !== "yes") continue;
      const failed = fails(policy) === true;
      const unknownWhen = policy.when !== null && results.get(policy.when) === null;
      if (unknownWhen) out.push({ policy: policy.name, kind: "when", check: policy.when!.check, result: null, decisive: true });
      const ran = policy.checks.filter((check) => results.has(check));
      const forbidding = ran.filter((check) => check.kind === "forbid-if" && results.get(check) !== false);
      for (const check of ran) {
        const result = results.get(check)!;
        const decisive = allowed
          ? (policy.checks.some((each) => each.kind === "authorize-if") ? check.kind === "authorize-if" && result === true : check.kind === "forbid-if")
          : failed && !unknownWhen && (forbidding.length ? forbidding.includes(check) : check.kind === "authorize-if");
        out.push({ policy: policy.name, kind: check.kind, check: check.check, result, decisive });
      }
    }
    return out;
  };
  const denial = (failed: readonly PolicySpec[], reason: "failed" | "not-applied" = "failed") =>
    new ForbiddenError({ entity, action, policies: failed.map((policy) => policy.name), breakdown: breakdown(), reason });
  /** The final answer, once every check has run: undefined when allowed, else the error. */
  const decide = (): ForbiddenError | undefined => {
    if (policies.length === 0) return new ForbiddenError({ entity, action, policies: [], breakdown: [], reason: "not-covered" });
    const covering = policies.filter((policy) => covers(policy) === "yes");
    // Every covering policy's `when` is false: none applies to this call, which is denied, naming them.
    if (covering.length === 0) return denial(policies, "not-applied");
    const failed = covering.filter((policy) => fails(policy) === true);
    return failed.length ? denial(failed) : undefined;
  };
  /**
   * For `Mesh.checkPolicies`: stop the call with the decision, `error` being what `decide` gave. A denial carries the
   * `ForbiddenError`'s own breakdown, so the two are equal; an allowed call's is frozen the same way.
   */
  const answer = (error: ForbiddenError | undefined): never => {
    throw new Answer(Object.freeze(error
      ? { allowed: false, breakdown: error.breakdown }
      : { allowed: true, breakdown: Object.freeze(breakdown(true).map((check) => Object.freeze(check))) }));
  };
  /** `filter` and `admits` decide a read from the checks that do not read the record; one that does is `rows`' and `admitsRows`'. */
  const readsTheRecord = (): FrameworkError | undefined => {
    const reads = policies.find((policy) => policy.when?.record || policy.checks.some((check) => check.record));
    return reads && new FrameworkError(`${entity}#${action}: policy :${reads.name} reads the record, so it is a condition on each row `
      + "of the query and is folded into it by rows (a load: admitsRows), never decided for the whole read by filter or admits");
  };
  /** The conditions the checks that read the record were bound to, by spec; one bound to a constant is in `results`. */
  const bound = new Map<Spec | PolicyCheckSpec, Condition>();
  /** Bind each check that reads the record, of each policy that may still apply, with `scope`. */
  const bindAll = (scope: object, tableOf: TableOf) => {
    for (const policy of policies) {
      const mark: Mark | undefined = frame ? (fn) => frame.marked(`policy :${policy.name} of ${entity}`, fn) : undefined;
      const bindOne = (spec: Spec | PolicyCheckSpec) => {
        if (results.has(spec) || bound.has(spec)) return;
        if (!spec.sql)
          throw new FrameworkError(`${entity}#${action}: policy :${policy.name} reads the record, and its check carries no condition to fold into the query; rebuild the project with \`mesh build\``);
        const value = bindCondition(tableOf, spec.sql(), scope as never, mark);
        if (value === true || value === false || value === null) results.set(spec, value);
        else bound.set(spec, value);
      };
      if (policy.when?.record) bindOne(policy.when);
      if (policy.when && results.get(policy.when) === false) continue;
      for (const check of policy.checks) if (check.record) bindOne(check);
    }
  };
  /** What a function gave: its in-memory result or bound constant, else its condition; not run (its policy skipped) is unknown. */
  const valueOf = (spec: Spec | PolicyCheckSpec): Result | Condition => (results.has(spec) ? results.get(spec)! : bound.get(spec) ?? null);
  /**
   * The per-row formula over the covering policies: `applies(p)` is `when IS TRUE` (no `when`: true), `skips(p)` is
   * `when IS FALSE`, `passes(p)` is every `forbid-if IS FALSE` and, with any `authorize-if`, one `IS TRUE`; a row is
   * admitted when some policy applies and each one skips or applies and passes. Built over three-valued constants and
   * conditions, so an unknown `when` fails its policy and an unknown `forbid-if` forbids, as in memory.
   */
  const formula = (): Part => {
    const applies = (policy: PolicySpec): Part => (policy.when ? isTrue(valueOf(policy.when)) : true);
    const skips = (policy: PolicySpec): Part => (policy.when ? isFalse(valueOf(policy.when)) : false);
    const passes = (policy: PolicySpec): Part => {
      // a policy with no check is a build error; one that gets here anyway fails closed.
      if (policy.checks.length === 0) return false;
      const forbids = policy.checks.filter((check) => check.kind === "forbid-if").map((check) => isFalse(valueOf(check)));
      const authorizes = policy.checks.filter((check) => check.kind === "authorize-if").map((check) => isTrue(valueOf(check)));
      return combine("and", [...forbids, authorizes.length ? combine("or", authorizes) : true]);
    };
    return combine("and", [
      combine("or", policies.map(applies)),
      ...policies.map((policy) => combine("or", [skips(policy), combine("and", [applies(policy), passes(policy)])])),
    ]);
  };
  /** Known before any binding: a covering policy that applies already fails, or none can apply. */
  const deniedEarly = (): boolean =>
    policies.some((policy) => covers(policy) === "yes" && fails(policy) === true) || policies.every((policy) => covers(policy) === "no");
  /** The denial once `formula` gave false: the policies known to fail, else (none applies) `decide`'s. */
  const denialNow = (): ForbiddenError => {
    const known = policies.filter((policy) => covers(policy) === "yes" && fails(policy) === true);
    return known.length ? denial(known) : decide() ?? denial(policies);
  };
  /** A nested call (inside a running transaction) fails that transaction, as a failed cast does; a top-level call rejects. */
  const reject = (layer: DataLayer, error: Error): Promise<never> => {
    if (layer.refuseIfFailed()) return failJoined(layer, error);
    throw error;
  };
  /** A check that throws fails the call as a denial does: inside a running transaction, it fails that transaction. */
  const guarded = async (layer: DataLayer, scope: object, wanted: (record: boolean) => boolean) => {
    try { await evaluate(scope, wanted); }
    catch (error) { await reject(layer, error instanceof Error ? error : new FrameworkError(`A policy check of ${entity}#${action} threw ${String(error)}`)); }
  };
  /** The specs of the checks the last `guard` listed, in its order: `statement` records a denial's results on them. */
  let guardedSpecs: readonly PolicyCheckSpec[] | undefined;
  const stale = (policy: PolicySpec) => new FrameworkError(`${entity}#${action}: policy :${policy.name} has a check that reads the record and no SQL condition; the generated actions are out of date, rebuild the project`);
  return Object.freeze({
    get answering(): boolean { return answering; },
    guard(scope: object, tableOf: TableOf): WriteGuard | undefined {
      const checks: Bound[] = [];
      const specs: PolicyCheckSpec[] = [];
      const entries: { readonly forbid: readonly number[]; readonly authorize: readonly number[] | null }[] = [];
      for (const policy of policies) {
        const state = covers(policy);
        if (state === "no") continue;
        // A `when` that reads the record keeps the write on the read path (the build's strategy): one here is a stale build.
        if (state === "not-yet") throw stale(policy);
        const reading = policy.checks.filter((check) => check.record);
        if (reading.length === 0) continue;
        const index = new Map<PolicyCheckSpec, number>();
        for (const check of reading) {
          if (!check.sql) throw stale(policy);
          index.set(check, checks.push(bindCondition(tableOf, check.sql(), scope as never)) - 1);
          specs.push(check);
        }
        const authorizes = policy.checks.filter((check) => check.kind === "authorize-if");
        // Authorized before the transaction (an `authorize-if` that does not read the record held): its record-reading
        // `authorize-if` checks decide nothing, but are still evaluated for the breakdown, as `inside` runs them.
        const held = authorizes.some((check) => !check.record && results.get(check) === true);
        entries.push(Object.freeze({
          forbid: Object.freeze(reading.filter((check) => check.kind === "forbid-if").map((check) => index.get(check)!)),
          authorize: authorizes.length === 0 || held ? null : Object.freeze(reading.filter((check) => check.kind === "authorize-if").map((check) => index.get(check)!)),
        }));
      }
      if (checks.length === 0) return undefined;
      guardedSpecs = Object.freeze(specs);
      return Object.freeze({ checks: Object.freeze(checks), policies: Object.freeze(entries) });
    },
    async statement<T>(write: () => Promise<T>): Promise<T> {
      if (answering) throw new FrameworkError(`${entity}#${action}: a permission question took the guarded delete; the generated actions are out of date, rebuild the project`);
      try {
        return await write();
      } catch (error) {
        if (!(error instanceof PolicyGuardDenial)) throw error;
        const specs = guardedSpecs;
        if (specs === undefined)
          throw new FrameworkError(`${entity}#${action}: a guarded write reported a policy denial before guard() built its guard; the generated actions are out of date, rebuild the project`, { cause: error });
        if (error.results.length !== specs.length) throw guardCountMismatch(error.results.length, specs.length, error);
        specs.forEach((spec, i) => results.set(spec, outcome(error.results[i])));
        const denied = decide();
        if (denied === undefined)
          throw new FrameworkError(`${entity}#${action}: the data adapter's policy guard reported a denial that its own results admit; nothing was deleted, and the call fails`, { cause: error });
        throw denied;
      }
    },
    async before(layer: DataLayer, scope: object): Promise<void> {
      answering = answers(layer);
      await guarded(layer, scope, (record) => !record);
      const known = policies.filter((policy) => covers(policy) === "yes" && fails(policy) === true);
      if (known.length) return answering ? answer(denial(known)) : reject(layer, denial(known));
      // Nothing left for the transaction: this is the whole decision (no covering policy included).
      if (policies.every((policy) => covers(policy) === "no" || (covers(policy) === "yes" && fails(policy) !== undefined))) {
        const error = decide();
        if (answering) answer(error);
        if (error) return reject(layer, error);
      }
    },
    async inside(scope: object): Promise<void> {
      await evaluate(scope, () => true);
      const error = decide();
      if (answering) answer(error);
      if (error) throw error;
    },
    async filter(layer: DataLayer, scope: object): Promise<boolean> {
      answering = answers(layer);
      // No policy covers the read, by its scope: forbidden. One that applies to no caller is a different case (below).
      if (policies.length === 0) return answering ? answer(decide()) : reject(layer, decide()!);
      const reads = readsTheRecord();
      if (reads) return reject(layer, reads);
      reading = true;
      await guarded(layer, scope, () => true);
      const error = decide();
      if (answering) answer(error);
      return error === undefined;
    },
    async rows(layer: DataLayer, scope: object, tableOf: TableOf): Promise<Where> {
      answering = answers(layer);
      if (policies.length === 0) return answering ? answer(decide()) : reject(layer, decide()!);
      reading = true;
      await guarded(layer, scope, (record) => !record);
      let where: Part = false;
      if (!deniedEarly()) {
        // A binding that throws (a parameter's helper, a value of the wrong type) fails the call as a check that throws does.
        try { bindAll(scope, tableOf); }
        catch (error) { await reject(layer, error instanceof Error ? error : new FrameworkError(`A policy check of ${entity}#${action} threw ${String(error)}`)); }
        where = formula();
      }
      if (answering) answer(where === false ? denialNow() : undefined);
      return where;
    },
    async admits(scope: object): Promise<boolean> {
      if (policies.length === 0) return false;
      const reads = readsTheRecord();
      if (reads) throw reads;
      reading = true;
      await evaluate(scope, () => true);
      return decide() === undefined;
    },
    async admitsRows(scope: object, tableOf: TableOf): Promise<Where> {
      if (policies.length === 0) return false;
      reading = true;
      await evaluate(scope, (record) => !record);
      if (deniedEarly()) return false;
      bindAll(scope, tableOf);
      return formula();
    },
  });
}

