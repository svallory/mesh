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
}

/** One evaluated policy check, as reported by a denial or a can-action query. */
export interface PolicyCheck {
  policy: string;
  check: string;
  result: boolean;
  decisive: boolean;
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
    super(issues.map(({ path, message }) => `${path.length ? path.join(".") : "(input)"}: ${message}`).join("\n"), options);
    this.issues = Object.freeze([...issues]);
  }
}

/** A policy denied the action. */
export class ForbiddenError extends MeshError {
  readonly code = "forbidden";
  readonly breakdown: readonly PolicyCheck[];

  constructor(breakdown: readonly PolicyCheck[], options?: ErrorOptions) {
    super("Action forbidden by policy", options);
    this.breakdown = Object.freeze([...breakdown]);
  }
}

function describeKey(key: unknown): string {
  try { return JSON.stringify(key) ?? String(key); }
  catch { return "[unserializable key]"; }
}

/** The requested entity row does not exist or is not visible to the caller. */
export class NotFoundError extends MeshError {
  readonly code = "not_found";

  constructor(
    /** Name of the entity whose row was requested. */
    readonly entity: string,
    /** The requested key, whether scalar or composite. */
    readonly key: unknown,
    options?: ErrorOptions,
  ) {
    super(`Entity ${entity} not found for ${describeKey(key)}`, options);
  }
}
