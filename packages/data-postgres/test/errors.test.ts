import { describe, expect, test } from "bun:test";
import { DatabaseBusyError, FrameworkError } from "@meshfw/runtime";
import { mapPostgresError } from "../src/errors.ts";

const DB = "postgres://db.example:5432/shop";
/** Shaped as Bun 1.4's `PostgresError`: the SQLSTATE in `errno`, Bun's own code in `code`. */
function pgError(errno: string | undefined, code = "ERR_POSTGRES_SERVER_ERROR", message = `server said ${errno}`): Error {
  const error = new Error(message);
  error.name = "PostgresError";
  Object.assign(error, { code, ...(errno === undefined ? {} : { errno }) });
  return error;
}
/** As Drizzle wraps it. */
const wrapped = (cause: Error) => Object.assign(new Error("Failed query: select 1"), { cause });

describe("mapPostgresError", () => {
  test.each([
    ["40001", "serialization", "could not serialize this transaction with a concurrent one"],
    ["40P01", "deadlock", "found this transaction in a deadlock"],
  ] as const)("SQLSTATE %s is a retryable DatabaseBusyError (%s), through Drizzle's wrapper", (sqlstate, reason, text) => {
    const raw = pgError(sqlstate);
    const error = mapPostgresError(wrapped(raw), DB, "statement") as DatabaseBusyError;
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(error).toMatchObject({ code: "MESH_DATABASE_BUSY", reason, sqlstate, retryable: true, file: DB, waitedMs: 0 });
    expect(error.message).toContain(text);
    expect(error.message).toEndWith(`(SQLSTATE ${sqlstate})`);
    expect((error.cause as Error).cause).toBe(raw);
  });

  test("55P03 is a lock wait that timed out, with the wait the transaction set", () => {
    const error = mapPostgresError(pgError("55P03"), DB, "statement", 200) as DatabaseBusyError;
    expect(error).toMatchObject({ reason: "lock-timeout", sqlstate: "55P03", waitedMs: 200, retryable: true });
    expect(error.message).toBe(`The database ${DB} kept a row or table locked by another transaction for 200 ms, so the call gave up (SQLSTATE 55P03)`);
  });

  test.each(["57P01", "57P02", "57P03", "53300", "08006", "08003"])("SQLSTATE %s is a lost connection, retryable", (sqlstate) => {
    expect(mapPostgresError(pgError(sqlstate), DB, "statement")).toMatchObject({ reason: "connection", sqlstate, retryable: true });
  });

  test.each(["ERR_POSTGRES_CONNECTION_CLOSED", "ERR_POSTGRES_IDLE_TIMEOUT", "ERR_POSTGRES_LIFETIME_TIMEOUT"])("Bun's %s is a lost connection without a SQLSTATE", (code) => {
    const error = mapPostgresError(pgError(undefined, code), DB, "statement") as DatabaseBusyError;
    expect(error).toMatchObject({ reason: "connection", sqlstate: null, retryable: true });
    expect(error.message).toBe(`The connection to the database ${DB} was lost, so the transaction was rolled back`);
  });

  test("Bun's codeless error for a statement on a reserved connection the server closed is a lost connection", () => {
    expect(mapPostgresError(wrapped(new Error("connection must be a PostgresSQLConnection")), DB, "statement")).toMatchObject({ reason: "connection", sqlstate: null });
    expect(mapPostgresError(new Error("connection must be a PostgresSQLConnection"), DB, "commit")).toMatchObject({ reason: "connection", retryable: false });
  });

  test("a connection lost during COMMIT is not retryable: the commit may have happened", () => {
    for (const raw of [pgError(undefined, "ERR_POSTGRES_CONNECTION_CLOSED"), pgError("57P01")]) {
      const error = mapPostgresError(raw, DB, "commit") as DatabaseBusyError;
      expect(error).toMatchObject({ reason: "connection", retryable: false });
      expect(error.message).toBe(`The connection to the database ${DB} was lost during COMMIT, so whether the transaction committed is unknown; check before repeating the call`);
    }
  });

  test.each(["ERR_POSTGRES_CONNECTION_REFUSED", "ERR_POSTGRES_CONNECTION_TIMEOUT", "ERR_POSTGRES_CONNECTION_FAILED"])("Bun's %s: the server did not answer, so the call may succeed later", (code) => {
    const error = mapPostgresError(pgError(undefined, code, "Failed to connect"), DB, "connect") as DatabaseBusyError;
    expect(error).toMatchObject({ reason: "connection", retryable: true });
    expect(error.message).toBe(`Could not connect to the database ${DB}: Failed to connect; the same call may succeed once the server answers`);
  });

  test.each([
    ["28P01", 'password authentication failed for user "app"'],
    ["28000", "no pg_hba.conf entry"],
    ["3D000", 'database "shop" does not exist'],
  ])("SQLSTATE %s is a FrameworkError naming the database, never the password", (sqlstate, message) => {
    const error = mapPostgresError(pgError(sqlstate, "ERR_POSTGRES_SERVER_ERROR", message), DB, "connect") as FrameworkError;
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error.message).toBe(`Cannot connect to the database ${DB}: ${message} (SQLSTATE ${sqlstate})`);
    expect(error.retryable).toBe(false);
  });

  test("a malformed URL and Bun's authentication codes are FrameworkErrors too", () => {
    expect(mapPostgresError(Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" }), DB, "connect")).toBeInstanceOf(FrameworkError);
    expect(mapPostgresError(new URIError("URI error"), DB, "connect")).toBeInstanceOf(FrameworkError);
    expect(mapPostgresError(pgError(undefined, "ERR_POSTGRES_SASL_SIGNATURE_MISMATCH"), DB, "connect")).toBeInstanceOf(FrameworkError);
    expect(mapPostgresError(pgError(undefined, "ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD"), DB, "connect")).toBeInstanceOf(FrameworkError);
  });

  test("anything else passes through unchanged, a constraint error and a Mesh error included", () => {
    const unique = wrapped(pgError("23505"));
    expect(mapPostgresError(unique, DB, "statement")).toBe(unique);
    expect(mapPostgresError(pgError("25P02"), DB, "statement")).toBeInstanceOf(Error);
    const plain = new Error("not a database error");
    expect(mapPostgresError(plain, DB, "statement")).toBe(plain);
    const mesh = new FrameworkError("already reported");
    expect(mapPostgresError(Object.assign(new Error("outer"), { cause: mesh }), DB, "statement")).toBe(mesh);
    expect(mapPostgresError("a string", DB, "statement")).toBe("a string");
  });

  test("a cause chain with a cycle ends", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(mapPostgresError(a, DB, "statement")).toBe(a);
  });
});
