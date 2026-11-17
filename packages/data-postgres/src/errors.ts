import { DatabaseBusyError, FrameworkError, MeshError } from "@meshfw/runtime";

/** Where a failure happened: a statement of a transaction, its BEGIN or COMMIT, an exclusive job, or opening a connection. */
export type Stage = "statement" | "begin" | "commit" | "job" | "connect";

/** Bun's own codes for a connection that was open and broke. */
const CONNECTION_LOST = new Set(["ERR_POSTGRES_CONNECTION_CLOSED", "ERR_POSTGRES_IDLE_TIMEOUT", "ERR_POSTGRES_LIFETIME_TIMEOUT"]);
/** Bun's own codes for a connection that could not be opened because the server did not answer. */
const NO_ANSWER = new Set(["ERR_POSTGRES_CONNECTION_REFUSED", "ERR_POSTGRES_CONNECTION_TIMEOUT", "ERR_POSTGRES_CONNECTION_FAILED"]);
/** Bun's own codes for a connection the server or the client refused for a reason a repeat cannot fix. */
const REFUSED = /^ERR_POSTGRES_(AUTHENTICATION_FAILED_PBKDF|SASL_.*|UNKNOWN_AUTHENTICATION_METHOD|UNSUPPORTED_AUTHENTICATION_METHOD|TLS_.*|INVALID_SERVER_KEY|INVALID_SERVER_SIGNATURE)$/;

/** Bun's message for a statement sent on a reserved connection that is already closed. */
const RESERVED_CONNECTION_GONE = "connection must be a PostgresSQLConnection";

/** What the cause chain says: the Mesh error already made, or the first driver error with its SQLSTATE or Bun code. */
interface Reading {
  readonly mesh?: MeshError;
  readonly error?: object;
  readonly sqlstate?: string;
  readonly code?: string;
}

/**
 * Walk the cause chain (Drizzle wraps Bun's `PostgresError` in `DrizzleQueryError`) and stop at a Mesh error, which
 * is the adapter's own report and is never rewritten. Bun's `PostgresError` carries the SQLSTATE in `errno` and its
 * own code (`ERR_POSTGRES_SERVER_ERROR`, `ERR_POSTGRES_CONNECTION_CLOSED`, ...) in `code`.
 */
function read(cause: unknown): Reading {
  const seen = new Set<object>();
  let current = cause;
  let found: Reading = {};
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof MeshError) return { mesh: current };
    seen.add(current);
    const errno = "errno" in current ? current.errno : undefined;
    const code = "code" in current ? current.code : undefined;
    if (found.error === undefined) {
      if (typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno)) found = { error: current, sqlstate: errno, code: typeof code === "string" ? code : undefined };
      else if (typeof code === "string" && (code.startsWith("ERR_POSTGRES_") || code === "ERR_INVALID_URL")) found = { error: current, code };
      else if (current instanceof URIError) found = { error: current, code: "ERR_INVALID_URL" };
      // Bun 1.4.2: a statement on a reserved connection whose socket the server already closed fails with this plain
      // Error and no code (the server's 57P01 went to nobody), so it is read as the closed connection it is.
      else if (current instanceof Error && current.message === RESERVED_CONNECTION_GONE) found = { error: current, code: "ERR_POSTGRES_CONNECTION_CLOSED" };
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return found;
}

/** The SQLSTATEs of a lost connection: class 08, the server shutting down or crashing (57P01-57P03), too many connections. */
function lostConnection(sqlstate: string): boolean {
  return sqlstate.startsWith("08") || sqlstate === "57P01" || sqlstate === "57P02" || sqlstate === "57P03" || sqlstate === "53300";
}

/**
 * The error a caller gets for a raw Postgres failure, the transient ones as `DatabaseBusyError` (spec, Actions, "Run-time
 * errors and `retryable`"): `40001` serialization, `40P01` deadlock, `55P03` a lock wait that timed out (`waitedMs`),
 * a lost connection (at COMMIT with `retryable: false`, since the commit may have happened), and a server that did not
 * answer. A login or database name the server refused (`28xxx`, `3D000`), or a URL that cannot be parsed, is a
 * `FrameworkError` that names the database without credentials. Anything else, a Mesh error included, passes on
 * unchanged.
 */
export function mapPostgresError(cause: unknown, database: string, stage: Stage, waitedMs = 0): unknown {
  const { mesh, error, sqlstate, code } = read(cause);
  if (mesh) return mesh;
  if (!error) return cause;
  if (sqlstate === "40001") return new DatabaseBusyError(database, 0, { reason: "serialization", sqlstate, cause });
  if (sqlstate === "40P01") return new DatabaseBusyError(database, 0, { reason: "deadlock", sqlstate, cause });
  if (sqlstate === "55P03") return new DatabaseBusyError(database, waitedMs, { reason: "lock-timeout", sqlstate, cause });
  if ((sqlstate !== undefined && lostConnection(sqlstate)) || (code !== undefined && CONNECTION_LOST.has(code))) {
    return new DatabaseBusyError(database, 0, {
      reason: "connection", cause, ...(sqlstate === undefined ? {} : { sqlstate }), ...(stage === "commit" ? { during: "commit" as const } : {}),
    });
  }
  if (code !== undefined && NO_ANSWER.has(code)) return new DatabaseBusyError(database, 0, { reason: "connection", during: "connect", cause });
  if ((sqlstate !== undefined && (sqlstate.startsWith("28") || sqlstate === "3D000")) || (code !== undefined && (REFUSED.test(code) || code === "ERR_INVALID_URL"))) {
    const message = error instanceof Error ? error.message : String(error);
    return new FrameworkError(`Cannot connect to the database ${database}: ${message}${sqlstate === undefined ? "" : ` (SQLSTATE ${sqlstate})`}`, { cause });
  }
  return cause;
}
