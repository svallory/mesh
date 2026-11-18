import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { postgresDialect } from "../src/dialect.ts";
import { describeServer, testDatabase } from "./support.ts";

// `raised` decides which driver errors a policy guard's denial may be read from (ADR-0046, option B): only the error
// the guard's own cast to integer fails with, Bun's PostgresError with SQLSTATE 22P02, and never a wrapper such as
// Drizzle's DrizzleQueryError, whose message echoes the statement's bound parameters.
describe("postgresDialect.raised", () => {
  const raised = postgresDialect.raised!;
  const marker = 'invalid input syntax for type integer: "mesh:forbidden:abc12345:f:1"';

  test("a PostgresError with SQLSTATE 22P02 gives its message", () => {
    expect(raised(Object.assign(new Error(marker), { errno: "22P02", code: "ERR_POSTGRES_SERVER_ERROR" }))).toBe(marker);
  });

  test("the message is not matched, so a server whose messages are not in English still reports the denial", () => {
    const localized = 'ungültige Eingabesyntax für Typ integer: »mesh:forbidden:abc12345:f:1«';
    expect(raised(Object.assign(new Error(localized), { errno: "22P02" }))).toBe(localized);
  });

  test("another SQLSTATE, no SQLSTATE, or a wrapper whose cause is the raise give undefined", () => {
    expect(raised(Object.assign(new Error(marker), { errno: "23503" }))).toBeUndefined();
    expect(raised(Object.assign(new Error(marker), { errno: "25P02" }))).toBeUndefined();
    expect(raised(Object.assign(new Error(marker), { code: "ERR_POSTGRES_SERVER_ERROR" }))).toBeUndefined();
    expect(raised({ errno: 22, message: marker })).toBeUndefined();
    expect(raised({ errno: "22P02", message: 42 })).toBeUndefined();
    // The wrapper itself is not accepted; `guardDenialOf` walks to its cause and asks again.
    const wrapper = Object.assign(new Error(`Failed query: delete ...\nparams: ${marker}`), { cause: Object.assign(new Error(marker), { errno: "22P02" }) });
    expect(raised(wrapper)).toBeUndefined();
    expect(raised(wrapper.cause)).toBe(marker);
  });

  test("a value that is not an object gives undefined", () => {
    for (const value of [undefined, null, marker, 1, true]) expect(raised(value)).toBeUndefined();
  });
});

describeServer("the policy-guard raise on a Postgres server", () => {
  const database = testDatabase({});

  test("Bun's own PostgresError for the cast is accepted, with the marker in its message", async () => {
    const connection = new SQL(database.url, { max: 1 });
    let error: unknown;
    try { await connection.unsafe("select (('mesh:forbidden:' || $1::text || ':f:' || 'k1')::int = 0) as raised", ["abc12345"]); }
    catch (cause) { error = cause; }
    finally { await connection.close(); }
    expect(error).toBeDefined();
    const message = postgresDialect.raised!(error);
    expect(message).toBeString();
    expect(message).toContain("mesh:forbidden:abc12345:f:k1");
  });
});
