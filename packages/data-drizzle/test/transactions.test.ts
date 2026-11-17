import { describe, expect, test } from "bun:test";
import { DatabaseBusyError, FrameworkError, type DataOperations } from "@meshfw/runtime";
import { serialTransactions, type Deadline, type TransactionDriver } from "../src/transactions.ts";

/** A connection that records what the queue sent it, in order. */
interface FakeConn { readonly id: number; readonly log: string[] }

/** A driver over fake connections; each test overrides the step it exercises. */
function fixture(overrides: Partial<TransactionDriver<FakeConn>> = {}) {
  const log: string[] = [];
  let acquired = 0;
  let fatal: Error | undefined;
  const failedHooks: ((cause: unknown) => void)[] = [];
  const deadlines: Deadline[] = [];
  const driver: TransactionDriver<FakeConn> = {
    health: () => fatal,
    acquire: async (deadline) => { deadlines.push(deadline); log.push("acquire"); return { id: ++acquired, log }; },
    release: (conn) => { log.push(`release ${conn.id}`); },
    begin: async () => { log.push("begin"); },
    operations: (_conn, guard, failed) => {
      failedHooks.push(failed);
      return { probe: () => { guard(); log.push("statement"); } } as unknown as DataOperations;
    },
    commit: async () => { log.push("commit"); },
    rollback: async () => { log.push("rollback"); },
    report: (cause) => cause,
    ...overrides,
  };
  const queue = serialTransactions(driver, 5000);
  return {
    log, queue, deadlines, failedHooks,
    setFatal(error: Error | undefined) { fatal = error; },
  };
}
const probe = (tx: DataOperations) => (tx as unknown as { probe(): void }).probe();

describe("serialTransactions", () => {
  test("a transaction acquires, begins, runs, commits and releases, in that order", async () => {
    const { log, queue } = fixture();
    expect(await queue.transaction(async (tx) => { probe(tx); return 7; })).toBe(7);
    expect(log).toEqual(["acquire", "begin", "statement", "commit", "release 1"]);
    expect(queue.counts()).toEqual({ running: 0, queued: 0 });
  });

  test("transactions run one at a time, in call order, and report running and queued counts", async () => {
    const { log, queue } = fixture();
    let open!: () => void;
    const first = queue.transaction(async () => { log.push("first"); await new Promise<void>((resolve) => { open = resolve; }); });
    const second = queue.transaction(async () => { log.push("second"); });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.counts()).toEqual({ running: 1, queued: 1 });
    open();
    await Promise.all([first, second]);
    expect(log.filter((entry) => entry === "first" || entry === "second" || entry === "commit")).toEqual(["first", "commit", "second", "commit"]);
  });

  test("a failed callback rolls back, rejects with its error and releases the queue", async () => {
    const { log, queue } = fixture();
    const boom = new Error("boom");
    await expect(queue.transaction(async () => { throw boom; })).rejects.toBe(boom);
    expect(log).toEqual(["acquire", "begin", "rollback", "release 1"]);
    expect(await queue.transaction(async () => "next")).toBe("next");
  });

  test("the deadline starts when the call reaches the front of the queue and uses waitMs when given", async () => {
    const { queue, deadlines } = fixture();
    await queue.transaction(async () => undefined);
    await queue.transaction(async () => undefined, { waitMs: 20 });
    expect(deadlines[0]!.at - deadlines[0]!.started).toBe(5000);
    expect(deadlines[1]!.at - deadlines[1]!.started).toBe(20);

    // A call queued behind a held transaction starts its clock only when that one has settled, not when it was made.
    let firstSettled = 0;
    const first = queue.transaction(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); })
      .then(() => { firstSettled = performance.now(); });
    const second = queue.transaction(async () => undefined);
    await Promise.all([first, second]);
    expect(deadlines[3]!.started).toBeGreaterThanOrEqual(deadlines[2]!.started + 25);
    expect(deadlines[3]!.started).toBeGreaterThanOrEqual(firstSettled - 1);
  });

  test("begin and commit failures map through report with their stage; a commit failure rolls back", async () => {
    const stages: string[] = [];
    const mapped = new Error("mapped");
    const { log, queue } = fixture({
      commit: async () => { throw new Error("raw commit"); },
      report: (cause, stage) => { stages.push(stage); return stage === "commit" ? mapped : cause; },
    });
    await expect(queue.transaction(async () => undefined)).rejects.toBe(mapped);
    expect(stages).toEqual(["commit", "job"]);
    expect(log).toEqual(["acquire", "begin", "rollback", "release 1"]);

    const begin = fixture({ begin: async () => { throw new Error("raw begin"); }, report: (cause, stage) => { stages.push(stage); return stage === "begin" ? mapped : cause; } });
    stages.length = 0;
    await expect(begin.queue.transaction(async () => undefined)).rejects.toBe(mapped);
    expect(stages).toEqual(["begin", "job"]);
    expect(begin.log).toEqual(["acquire", "release 1"]);
  });

  test("a failed rollback rejects with the driver's error instead of the callback's", async () => {
    const fatal = new FrameworkError("rollback failed");
    const { queue, log } = fixture({ rollback: async () => { throw fatal; } });
    await expect(queue.transaction(async () => { throw new Error("boom"); })).rejects.toBe(fatal);
    // The connection is released even though rollback rejected, and the queue moves on.
    expect(log.at(-1)).toBe("release 1");
    expect(queue.counts()).toEqual({ running: 0, queued: 0 });
    expect(await queue.transaction(async () => "next")).toBe("next");
  });

  test("the health gate refuses a call at once, and refuses a queued call when its turn comes", async () => {
    const { queue, setFatal, log } = fixture();
    const unusable = new FrameworkError("unusable");
    setFatal(unusable);
    await expect(queue.transaction(async () => undefined)).rejects.toBe(unusable);
    await expect(queue.exclusive(async () => undefined)).rejects.toBe(unusable);
    expect(log).toEqual([]);

    setFatal(undefined);
    let open!: () => void;
    const first = queue.transaction(async () => { await new Promise<void>((resolve) => { open = resolve; }); });
    const second = queue.transaction(async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    setFatal(unusable);
    open();
    await first;
    await expect(second).rejects.toBe(unusable);
    expect(queue.counts()).toEqual({ running: 0, queued: 0 });
  });

  test("an exclusive job runs alone on the acquired connection, its failures mapped as a job", async () => {
    const stages: string[] = [];
    const { queue, log } = fixture({ report: (cause, stage) => { stages.push(stage); return cause; } });
    expect(await queue.exclusive(async (conn, deadline) => { expect(deadline.at - deadline.started).toBe(5000); return conn.id; })).toBe(1);
    await expect(queue.exclusive(async () => { throw new Error("job"); })).rejects.toThrow("job");
    expect(stages).toEqual(["job"]);
    expect(log).toEqual(["acquire", "release 1", "acquire", "release 2"]);
  });

  test("an exclusive job waits in the same queue as transactions, and is refused inside one", async () => {
    const { queue, log } = fixture();
    let open!: () => void;
    const held = queue.transaction(async () => {
      expect(() => queue.exclusive(async () => undefined)).toThrow("nested transactions are not supported");
      log.push("tx");
      await new Promise<void>((resolve) => { open = resolve; });
    });
    const job = queue.exclusive(async () => { log.push("job"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.counts()).toEqual({ running: 1, queued: 1 });
    expect(log).not.toContain("job");
    open();
    await Promise.all([held, job]);
    expect(log).toEqual(["acquire", "begin", "tx", "commit", "release 1", "acquire", "job", "release 2"]);
  });

  test("a call made while COMMIT is pending starts a transaction of its own instead of joining", async () => {
    let commitEntered!: () => void;
    const entered = new Promise<void>((resolve) => { commitEntered = resolve; });
    let finishCommit!: () => void;
    let commits = 0;
    const { queue, log } = fixture({
      commit: async () => {
        log.push("commit");
        if (++commits === 1) { commitEntered(); await new Promise<void>((resolve) => { finishCommit = resolve; }); }
      },
    });
    let late!: Promise<string>;
    // The continuation is registered inside the callback, so it runs in the outer transaction's async context.
    const outer = queue.transaction(async () => {
      void entered.then(() => { late = queue.transaction(async () => { log.push("late"); return "own"; }); finishCommit(); });
    });
    await outer;
    expect(await late).toBe("own");
    expect(log).toEqual(["acquire", "begin", "commit", "release 1", "acquire", "begin", "late", "commit", "release 2"]);
  });

  test("a transaction or job started inside an exclusive job is refused as nested; insideTransaction says so", async () => {
    const { queue } = fixture();
    await queue.exclusive(async () => {
      expect(queue.insideTransaction()).toBe(true);
      expect(queue.refuseIfFailed()).toBe(false);
      expect(() => queue.transaction(async () => undefined)).toThrow("nested transactions are not supported");
      expect(() => queue.exclusive(async () => undefined)).toThrow("nested transactions are not supported");
    });
    expect(queue.insideTransaction()).toBe(false);
  });

  test("a call inside a transaction joins it, and joined calls run one at a time", async () => {
    const { queue, log } = fixture();
    await queue.transaction(async (outer) => {
      expect(queue.refuseIfFailed()).toBe(true);
      const order: string[] = [];
      await Promise.all([
        queue.transaction(async (tx) => { expect(tx).toBe(outer); order.push("a start"); await new Promise((resolve) => setTimeout(resolve, 5)); order.push("a end"); }),
        queue.transaction(async () => { order.push("b"); }),
      ]);
      expect(order).toEqual(["a start", "a end", "b"]);
    });
    expect(log.filter((entry) => entry === "begin" || entry === "commit")).toEqual(["begin", "commit"]);
    expect(queue.refuseIfFailed()).toBe(false);
  });

  test("a failed joined call rolls the transaction back even when caught, and later joined calls are refused", async () => {
    const { queue, log } = fixture();
    const inner = new Error("inner");
    const outcome = queue.transaction(async () => {
      await queue.transaction(async () => { throw inner; }).catch(() => undefined);
      expect(() => queue.refuseIfFailed()).toThrow("an earlier joined call failed");
      await expect(queue.transaction(async () => undefined)).rejects.toThrow("an earlier joined call failed");
    });
    await expect(outcome).rejects.toThrow("A call joined to this transaction failed");
    expect(log).toContain("rollback");
    expect(log).not.toContain("commit");
  });

  test("a joined call queued after the transaction ended is refused", async () => {
    const { queue } = fixture();
    let late!: Promise<unknown>;
    await queue.transaction(async () => {
      void queue.transaction(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      late = queue.transaction(async () => undefined);
      late.catch(() => undefined);
    });
    await expect(late).rejects.toThrow("ended before the call's turn came");
  });

  test("operations' guard throws once the transaction ended", async () => {
    const { queue } = fixture();
    let kept!: DataOperations;
    await queue.transaction(async (tx) => { kept = tx; });
    expect(() => probe(kept)).toThrow("Transaction operations are no longer active");
  });

  describe("the failed hook (a statement failure the callback caught)", () => {
    test("refuses COMMIT and rejects with a FrameworkError whose cause is the first failure", async () => {
      const { queue, log, failedHooks } = fixture();
      const first = new Error("23505");
      const outcome = queue.transaction(async () => { failedHooks[0]!(first); failedHooks[0]!(new Error("25P02")); return "caught"; });
      const error = await outcome.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe("A statement of this transaction failed, so Postgres aborted the transaction even though its callback caught the error");
      expect((error as Error).cause).toBe(first);
      expect(log).not.toContain("commit");
      expect(log).toContain("rollback");
    });

    test("rejects with the first failure itself when it is a DatabaseBusyError", async () => {
      const { queue, failedHooks } = fixture();
      const busy = new DatabaseBusyError("postgres://db", 0, { reason: "serialization", sqlstate: "40001" });
      await expect(queue.transaction(async () => { failedHooks[0]!(busy); })).rejects.toBe(busy);
    });

    test("a recorded statement failure wins over a failed joined call", async () => {
      const { queue, failedHooks } = fixture();
      const busy = new DatabaseBusyError("postgres://db", 0, { reason: "serialization", sqlstate: "40001" });
      const outcome = queue.transaction(async () => {
        await queue.transaction(async () => { throw new Error("inner"); }).catch(() => undefined);
        failedHooks[0]!(busy);
      });
      await expect(outcome).rejects.toBe(busy);
    });

    test("a transaction no statement of which failed commits as before", async () => {
      const { queue, log } = fixture();
      await queue.transaction(async () => undefined);
      expect(log).toContain("commit");
    });
  });
});
