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
  path: string[];
  message: string;
  source?: IssueSource;
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

/** The requested resource row does not exist or is not visible to the caller. */
export class NotFoundError extends MeshError {
  readonly code = "not_found";

  constructor(
    /** Name of the resource whose row was requested. */
    readonly resource: string,
    /** Primary-key attribute names and values. */
    readonly key: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`${resource} not found for ${JSON.stringify(key)}`, options);
  }
}
