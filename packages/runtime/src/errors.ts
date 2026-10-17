/** Base class for failures reported by Mesh. */
export abstract class MeshError extends Error {
  /** Stable machine-readable failure category. */
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Position of the declared rule that failed; line and column are 1-based. */
export interface IssueSource {
  file: string;
  line: number;
  column: number;
}

/** One input or declared-rule validation failure. */
export interface Issue {
  label: string | null;
  code: string | null;
  path: (string | number)[];
  message: string;
  source: IssueSource | null;
  /** What the failed `check` returned from its `details` function (G22), or `null`: a check without one, or a rule of an attribute line. */
  details: unknown;
}

/**
 * One check of a policy that covered a denied call, as plain data. `check` is the function as written in the entity file;
 * `result` is what it gave: `true`, `false`, or `null` for unknown (ADR-0012). `decisive` marks the checks that made their
 * policy fail: a `forbid-if` that held or was unknown, or, when none did, every `authorize-if` of a policy none of whose
 * `authorize-if` held. A policy's `when` is listed only when it was unknown, which fails the policy.
 */
export interface PolicyCheck {
  policy: string;
  kind: "authorize-if" | "forbid-if" | "when";
  check: string;
  result: boolean | null;
  decisive: boolean;
}

/**
 * Why a call is forbidden: `failed`, a covering policy failed; `not-covered`, no policy covers the action by its scope
 * (`types=`/`actions=`); `not-applied`, policies cover it, but the `when=` of each was false for this call.
 */
export type DenialReason = "failed" | "not-covered" | "not-applied";

/** What a `ForbiddenError` reports: the action, the policies that decided (none when no policy covers it) and the checks that ran. */
export interface PolicyDenial {
  entity: string;
  action: string;
  policies: readonly string[];
  breakdown: readonly PolicyCheck[];
  /** Taken from `policies` when left out: `not-covered` when it is empty, else `failed`. */
  reason?: DenialReason;
}

/** A programming or configuration mistake, rather than invalid caller input. */
export class FrameworkError extends MeshError {
  readonly code = "framework";
}

/** Collected input failures, formatted one per line with their input paths. */
export class InvalidInputError extends MeshError {
  readonly code = "invalid_input";
  /** A frozen copy of the supplied issue array. */
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[], options?: ErrorOptions) {
    if (issues.length === 0) {
      throw new FrameworkError("InvalidInputError requires at least one issue", options);
    }
    // A rule you declared is named by its label; a field's own rule by the path to the field.
    super(issues.map(({ path, label, message }) => `${path.length ? path.join(".") : (label ?? "(input)")}: ${message}`).join("\n"), options);
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * A policy denied the call, or no policy covers the action (deny by default, ADR-0055). The message names the
 * entity, the action and each covering policy that failed; with no covering policy it shows an open policy to copy.
 */
export class ForbiddenError extends MeshError {
  readonly code = "forbidden";
  /** The entity's FQN, e.g. `blog.Post`. */
  readonly entity: string;
  /** The action, e.g. `publish`. */
  readonly action: string;
  /**
   * The covering policies that failed, in the order the entity file declares them; with `reason` `not-applied`, the covering
   * policies whose `when` was false; empty when no policy covers the action.
   */
  readonly policies: readonly string[];
  /** Why the call is forbidden. */
  readonly reason: DenialReason;
  /** Every check that ran, of every covering policy, as frozen plain data. */
  readonly breakdown: readonly PolicyCheck[];

  constructor(denial: PolicyDenial, options?: ErrorOptions) {
    super(denialMessage(denial), options);
    this.entity = denial.entity;
    this.action = denial.action;
    this.policies = Object.freeze([...denial.policies]);
    this.reason = denial.reason ?? (denial.policies.length ? "failed" : "not-covered");
    this.breakdown = Object.freeze(denial.breakdown.map((check) => Object.freeze({ ...check })));
  }
}

function denialMessage({ entity, action, policies, reason }: PolicyDenial): string {
  const names = policies.map((name) => `:${name}`);
  if (reason === "not-applied")
    return `${entity}#${action} is forbidden: ${names.length === 1 ? "policy" : "policies"} ${names.join(", ")} cover${names.length === 1 ? "s" : ""} it, `
      + `but the \`when\` of each was false for this call, so none applies, and a call no policy applies to is denied`;
  if (policies.length === 0)
    return `${entity}#${action} is forbidden: no policy of ${entity} covers it, and an action no policy covers is denied. `
      + `To let every caller run it, add to the entity's \`policies\`:\n  policy :open actions=[&${action}] authorize-if=() => true`;
  return `${entity}#${action} is forbidden by ${names.length === 1 ? "policy" : "policies"} ${names.join(", ")}`;
}

function describeKey(key: unknown): string {
  try { return JSON.stringify(key) ?? String(key); }
  catch { return "[unserializable key]"; }
}

/** The requested entity row does not exist or is not visible to the caller. */
export class NotFoundError extends MeshError {
  readonly code = "not_found";

  constructor(
    /** FQN of the entity whose row was requested, e.g. `work.Task`. */
    readonly entity: string,
    /** The requested key, whether scalar or composite. */
    readonly key: unknown,
    options?: ErrorOptions,
  ) {
    super(`Entity ${entity} not found for ${describeKey(key)}`, options);
  }
}

/**
 * A database call stayed blocked by another connection and was given up (`MESH_DATABASE_BUSY`): a transaction that
 * waited out its retries, or a statement that met a lock and is not retried. data-sqlite is the adapter that raises it.
 * The code is `MESH_*`, unlike the lowercase category codes of the other classes, as the specification names it.
 */
export class DatabaseBusyError extends MeshError {
  readonly code = "MESH_DATABASE_BUSY";
  /** The database file that was locked. */
  readonly file: string;
  /** How long the call waited, in milliseconds; 0 for a statement that is not retried. */
  readonly waitedMs: number;

  constructor(file: string, waitedMs: number, options?: ErrorOptions) {
    super(
      waitedMs > 0
        ? `The database file ${JSON.stringify(file)} stayed locked by another connection for ${waitedMs} ms, so the call gave up`
        : `The database file ${JSON.stringify(file)} is locked by another connection, and this statement is not retried`,
      options,
    );
    this.file = file;
    this.waitedMs = waitedMs;
  }
}
