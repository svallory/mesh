/** What every Mesh error's constructor accepts beside its own arguments: the cause, and whether a retry makes sense. */
export interface MeshErrorOptions extends ErrorOptions {
  /** Overrides the class default for this one error. */
  retryable?: boolean;
}

/** Base class for failures reported by Mesh. */
export abstract class MeshError extends Error {
  /**
   * The default of `retryable` for a class's errors: `false` here, since repeating a call unchanged cannot fix a
   * validation, policy, not-found or framework error; a class whose failure is transient (`DatabaseBusyError`) sets `true`.
   */
  static readonly retryableByDefault: boolean = false;
  /** Stable machine-readable failure category. */
  abstract readonly code: string;
  /**
   * Whether the same call may succeed if repeated unchanged. Set on each error when it is made; the class gives only
   * the default. A caller that retries, an event handler's bus among them, reads this instead of guessing from the class.
   */
  readonly retryable: boolean;

  constructor(message: string, options?: MeshErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.retryable = options?.retryable ?? (new.target as unknown as typeof MeshError).retryableByDefault;
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

  constructor(issues: readonly Issue[], options?: MeshErrorOptions) {
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

  constructor(denial: PolicyDenial, options?: MeshErrorOptions) {
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
    options?: MeshErrorOptions,
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
  /** A lock that was held may be free on the next try. */
  static override readonly retryableByDefault: boolean = true;
  readonly code = "MESH_DATABASE_BUSY";
  /** The database file that was locked. */
  readonly file: string;
  /** How long the call waited, in milliseconds; 0 for a statement that is not retried. */
  readonly waitedMs: number;

  constructor(file: string, waitedMs: number, options?: MeshErrorOptions) {
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

/**
 * A read of the outbox from behind its deleted-through position (`MESH_EVENTS_DELETED`): the rows between the cursor and
 * the oldest kept one were deleted once delivered, so reading on would skip them silently. The remedy is to reload current
 * state and read from the newest position; an application that reads history sets `events.keep` to `"all"`.
 */
export class EventsDeletedError extends MeshError {
  readonly code = "MESH_EVENTS_DELETED";
  /** The cursor the read was given. */
  readonly after: number;
  /** The oldest position still kept: one above the deleted-through position. */
  readonly oldestKept: number;

  constructor(after: number, oldestKept: number, options?: MeshErrorOptions) {
    super(
      `Cannot read the outbox after position ${after}: the rows up to position ${oldestKept - 1} were deleted, so the oldest kept position is ${oldestKept}. `
        + "Reload current state and read from the newest position, or set events.keep to \"all\" to keep every row",
      options,
    );
    this.after = after;
    this.oldestKept = oldestKept;
  }
}

/**
 * A read of the outbox from above the highest position it ever assigned (`MESH_CURSOR_AHEAD`): the cursor was kept outside
 * the database, which has since gone back (a restored backup), so it names rows this outbox never had.
 */
export class CursorAheadError extends MeshError {
  readonly code = "MESH_CURSOR_AHEAD";
  /** The cursor the read was given. */
  readonly after: number;
  /** The highest position the outbox ever assigned. */
  readonly highest: number;

  constructor(after: number, highest: number, options?: MeshErrorOptions) {
    super(
      `Cannot read the outbox after position ${after}: the highest position it ever assigned is ${highest}. `
        + "A cursor above it was kept outside the database, which has gone back (a restored backup), so the cursor is void: read from a position the outbox has",
      options,
    );
    this.after = after;
    this.highest = highest;
  }
}

/**
 * An outbox row whose stored name matches no declared event (`MESH_EVENT_UNDECLARED`): its declaration moved or was
 * renamed. The read stops at it rather than skip it; the remedy, until the rename map exists, is to move the declaration
 * back until its rows are delivered.
 */
export class EventUndeclaredError extends MeshError {
  readonly code = "MESH_EVENT_UNDECLARED";
  /** The stored name, e.g. `billing.InvoicePaid`. */
  readonly eventName: string;
  /** The row's position. */
  readonly position: number;

  constructor(eventName: string, position: number, options?: MeshErrorOptions) {
    super(
      `The outbox row at position ${position} names the event ${eventName}, which the project no longer declares (it moved or was renamed). `
        + "The read stops here rather than skip it: move the declaration back until its rows are delivered",
      options,
    );
    this.eventName = eventName;
    this.position = position;
  }
}

/** A time of day for a message, `12:04:18` (UTC). */
function clockTime(date: Date): string {
  return Number.isNaN(date.getTime()) ? "an unknown time" : date.toISOString().slice(11, 19);
}

/**
 * The events configuration is wrong in a way only the start can see (`MESH_EVENTS_CONFIG`, start time): the events module
 * exports `handlers` while no `events.bus` is configured. The build reports the same code for what it can see.
 */
export class EventsConfigError extends MeshError {
  readonly code = "MESH_EVENTS_CONFIG";
}

/**
 * A handler option or default the configured bus cannot honour, or a `renamedFrom` that names a handler the module still
 * registers or that two handlers name (`MESH_HANDLER_OPTION`, start time). Checked by `connect()`, `startDelivery()` and
 * the first `deliver()` before anything is claimed.
 */
export class HandlerOptionError extends MeshError {
  readonly code = "MESH_HANDLER_OPTION";
  /** The handler the problem is about. */
  readonly handler: string;

  constructor(handler: string, message: string, options?: MeshErrorOptions) {
    super(message, options);
    this.handler = handler;
  }
}

/** Who holds a deliverer claim, as `MESH_DELIVERER_TAKEN` reports it. */
export interface ClaimHolder {
  /** The database the claim is on, as the data layer names it (`app.db`). */
  readonly database: string;
  readonly pid: number | null;
  readonly host: string | null;
  readonly startedAt: Date | null;
  /** How long ago the holder last renewed the claim, in milliseconds, by the database's clock. */
  readonly renewedAgoMs: number;
  /** When the claim lapses if it is not renewed. */
  readonly lapsesAt: Date;
  /** True when the holder is another binding, or another round, of this process. */
  readonly thisProcess: boolean;
}

/**
 * The deliverer claim is held by another process or binding, or a `deliver()` overlapped a round
 * (`MESH_DELIVERER_TAKEN`). Retryable: the claim lapses at `lapsesAt` if its holder has died.
 */
export class DelivererTakenError extends MeshError {
  static override readonly retryableByDefault: boolean = true;
  readonly code = "MESH_DELIVERER_TAKEN";
  /** When the holder's claim lapses unless it is renewed. */
  readonly lapsesAt: Date;
  readonly holder: ClaimHolder;

  constructor(holder: ClaimHolder, options?: MeshErrorOptions) {
    const who = holder.thisProcess
      ? `Another binding or round of this process delivers this database's events: ${holder.database} is claimed by this process (pid ${holder.pid ?? "unknown"}, renewed ${Math.round(holder.renewedAgoMs / 1000)} s ago). One binding per process per database delivers at a time.`
      : `Another process delivers this database's events: ${holder.database} is claimed by pid ${holder.pid ?? "unknown"} on host ${holder.host ?? "unknown"} `
        + `(started ${holder.startedAt ? clockTime(holder.startedAt) : "at an unknown time"}, renewed ${Math.round(holder.renewedAgoMs / 1000)} s ago). One process delivers per database.`;
    const fix = holder.thisProcess
      ? "\n  fix: Stop the other delivery first (`await delivery.stop()`, `disconnect()`, or await the running `deliver()`), or bind this one without delivering."
      : `\n  fix: Stop that process first, or connect this one without delivering: \`await connect({ deliver: false })\`. If that process has died, its claim lapses at ${clockTime(holder.lapsesAt)}.`;
    super(who + fix, options);
    this.lapsesAt = holder.lapsesAt;
    this.holder = Object.freeze({ ...holder });
  }
}

/**
 * The deliverer claim was lost (`MESH_DELIVERER_LOST`): another process took it over, a renewal updated no row, or a
 * blocked renewal waited past the lapse. The instance stops: its handlers stop, its subscriptions end with this error,
 * and a pending `deliver()` rejects with it. Nothing is handled twice and nothing is deleted after it.
 */
export class DelivererLostError extends MeshError {
  readonly code = "MESH_DELIVERER_LOST";
  /** The database the claim was on. */
  readonly database: string;

  constructor(database: string, reason: string, options?: MeshErrorOptions) {
    super(`This process lost the claim to deliver ${database}'s events: ${reason}. Its handlers and subscriptions stopped; the process now holding the claim delivers, and nothing was handled twice or deleted after the loss`, options);
    this.database = database;
  }
}

/**
 * A subscription's queue passed `maxQueue` (`MESH_SUBSCRIPTION_OVERFLOW`): the subscription ends rather than skip a row.
 * Retryable: its row stays, and a reopen under its name resumes from the acknowledged position.
 */
export class SubscriptionOverflowError extends MeshError {
  static override readonly retryableByDefault: boolean = true;
  readonly code = "MESH_SUBSCRIPTION_OVERFLOW";
  readonly subscription: string;
  readonly maxQueue: number;

  constructor(subscription: string, maxQueue: number, options?: MeshErrorOptions) {
    super(`The subscription ${JSON.stringify(subscription)} ended: its queue passed ${maxQueue} rows waiting for the callback. Its row is kept: open it again under the same name to resume from its acknowledged position`, options);
    this.subscription = subscription;
    this.maxQueue = maxQueue;
  }
}

/** One handler that stopped in a `deliver()` round: its name, the event it stopped at, and its last error. */
export interface StoppedHandler {
  readonly handler: string;
  readonly position: number;
  /** The event's FQN as stored. */
  readonly event: string;
  readonly cause: unknown;
}

/**
 * `deliver()` when handlers stopped in the round (`MESH_HANDLER_STOPPED`). Not retryable: it reports what already
 * stopped; the next round retries each stopped handler. The outbox keeps every row from each position on until the
 * handler resumes.
 */
export class HandlerStoppedError extends MeshError {
  readonly code = "MESH_HANDLER_STOPPED";
  readonly stopped: readonly StoppedHandler[];

  constructor(stopped: readonly StoppedHandler[], options?: MeshErrorOptions) {
    const lines = stopped.map(({ handler, position, event, cause }) =>
      `  ${handler} stopped at position ${position} (${event}): ${cause instanceof Error ? cause.message : String(cause)}`);
    super(`${stopped.length === 1 ? "A handler" : `${stopped.length} handlers`} stopped in this delivery round; the outbox keeps every row from each position on until the handler resumes:\n${lines.join("\n")}`, options);
    this.stopped = Object.freeze(stopped.map((entry) => Object.freeze({ ...entry })));
  }
}
