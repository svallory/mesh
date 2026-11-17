import { describe, expect, test } from "bun:test";
import type { ReservedSQL } from "bun";
import { DatabaseBusyError, FrameworkError } from "@meshfw/runtime";
import { mapPostgresError } from "../src/errors.ts";
import { abortedError, checkCommitTag, postgresWith, reserveWithin } from "../src/layer.ts";

describe("checkCommitTag, R27's last line of defence", () => {
  test("a COMMIT that answered COMMIT passes", () => {
    expect(() => checkCommitTag({ command: "COMMIT" })).not.toThrow();
  });

  test.each([
    ["ROLLBACK, the answer to a COMMIT of an aborted transaction", { command: "ROLLBACK" }],
    ["no command tag", {}],
    ["a tag in the wrong case", { command: "commit" }],
    ["no result at all", undefined],
    ["null", null],
  ])("%s throws R27's FrameworkError", (_name, result) => {
    expect(() => checkCommitTag(result)).toThrow(FrameworkError);
    expect(() => checkCommitTag(result)).toThrow(abortedError(undefined).message);
  });
});

/** A fake pool whose reserve() settles when the test says so. */
function slowPool() {
  let resolve!: (value: ReservedSQL) => void;
  let released = 0;
  const connection = { release: () => { released++; } } as unknown as ReservedSQL;
  const pool = { reserve: () => new Promise<ReservedSQL>((done) => { resolve = done; }) };
  return { pool, arrive: () => resolve(connection), connection, released: () => released };
}

describe("reserveWithin, a connection before the job's deadline", () => {
  test("a connection that arrives in time is returned", async () => {
    const fake = slowPool();
    const now = performance.now();
    const reserving = reserveWithin(fake.pool, { started: now, at: now + 1000 });
    fake.arrive();
    expect(await reserving).toBe(fake.connection);
    expect(fake.released()).toBe(0);
  });

  test("past the deadline it rejects, maps to a retryable connection error, and a late connection goes back to the pool", async () => {
    const fake = slowPool();
    const now = performance.now();
    const error = await reserveWithin(fake.pool, { started: now, at: now + 30 }).catch((cause: unknown) => cause);
    const waited = performance.now() - now;
    expect(waited).toBeGreaterThanOrEqual(25);
    expect(waited).toBeLessThan(2000);
    const mapped = mapPostgresError(error, "postgres://h:5432/d", "connect");
    expect(mapped).toBeInstanceOf(DatabaseBusyError);
    expect(mapped).toMatchObject({ reason: "connection", retryable: true });
    expect((mapped as Error).message).toStartWith("Could not connect to the database postgres://h:5432/d: no connection within ");
    fake.arrive();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.released()).toBe(1);
  });

  test("a server that never answers gives up at the transaction's waitMs, not Bun's 30 s connect timeout", async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): nothing answers there, so the connect hangs until a timeout (a network
    // that refuses the route at once gives the same error sooner, so the message is not pinned here).
    // The layer's lock wait (1 s here, 5 s by default) also bounds Bun's connect, so close() is not held 30 s either.
    const layer = postgresWith({ url: "postgres://u:p@192.0.2.1:5432/none" }, { waitMs: 1000 });
    const started = performance.now();
    const error = await layer.transaction(async () => 1, { waitMs: 200 }).catch((cause: unknown) => cause);
    const waited = performance.now() - started;
    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(error).toMatchObject({ reason: "connection", retryable: true });
    expect(waited).toBeLessThan(1000);
    const closing = performance.now();
    await layer.close();
    expect(performance.now() - closing).toBeLessThan(5000);
  }, 15_000);
});
