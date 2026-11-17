import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseBusyError, FrameworkError, type DataOperations, type TransactionOptions } from "@meshfw/runtime";

/** One clock for everything a call waits for, from when it reaches the front of the queue. */
export interface Deadline { readonly started: number; readonly at: number }

/** What an SQL adapter supplies to `serialTransactions`: its connection and its statements, never the queue's rules. */
export interface TransactionDriver<Conn> {
  /** An error that refuses every transaction and exclusive job until close() (SQLite's "unusable" layer); else undefined. */
  health(): Error | undefined;
  /** The connection a job runs on, once the call reached the front of the queue, within the job's deadline. */
  acquire(deadline: Deadline): Promise<Conn>;
  /** After every job and transaction, whatever its outcome. */
  release(conn: Conn): void;
  begin(conn: Conn, deadline: Deadline): Promise<void>;
  /** The operations of the transaction; `guard` throws once it has ended; `failed` records a statement failure. */
  operations(conn: Conn, guard: () => void, failed: (cause: unknown) => void): DataOperations;
  /** Throws when the commit did not happen. */
  commit(conn: Conn): Promise<void>;
  /**
   * Roll back after `cause` failed the transaction. Resolves once the transaction is gone; when it rejects, the caller
   * gets that error instead of `cause` (SQLite: the layer becomes unusable and `health()` fails until close()).
   */
  rollback(conn: Conn, cause: unknown): Promise<void>;
  /** Map a raw failure of BEGIN, COMMIT or an exclusive job to what the caller sees. Statements map in the commands. */
  report(cause: unknown, stage: "begin" | "commit" | "job"): unknown;
}

/** The running transaction or job: `operations` is set once BEGIN succeeded, and `active` ends with the outer call. */
interface Token {
  active: boolean;
  operations?: DataOperations;
  /** The first joined call that failed: the transaction rolls back and later joined calls are refused. */
  failed?: { cause: unknown };
  /** The first statement failure a driver recorded through `failed`: the transaction never commits. */
  statementFailed?: { cause: unknown };
}

/**
 * Where a call runs: the outer transaction's callback, or one call joined to it. Each frame queues the calls joined
 * from it, so calls joined to one transaction run one at a time. A call joined from inside another queues on that
 * call's frame, not on the one it waits in, so it never waits for itself.
 */
interface Frame { readonly token: Token; tail: Promise<void> }

/** What a call that joins a transaction a joined call already failed gets instead of running. */
function refusal(failed: { cause: unknown }): FrameworkError {
  return new FrameworkError("A call joined a transaction that an earlier joined call failed, so it was refused before it ran: the transaction rolls back", { cause: failed.cause });
}

export interface SerialTransactions<Conn> {
  /** `DataLayer.transaction`: queued, re-entrant (a call inside a running transaction joins it), rollback-only. */
  transaction<T>(run: (tx: DataOperations) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** A non-transaction job in the same queue (data-sqlite's readOutbox, createSchema, db push). */
  exclusive<T>(run: (conn: Conn, deadline: Deadline) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** `DataLayer.refuseIfFailed`, for the caller's async context. */
  refuseIfFailed(): boolean;
  /** True inside a running transaction or exclusive job of this queue, in the caller's async context. */
  insideTransaction(): boolean;
  /** What `close()` reports: the jobs running and the jobs waiting for their turn. */
  counts(): { running: number; queued: number };
}

/**
 * One queue of transactions and exclusive jobs over one connection at a time, shared by the SQL adapters. There is
 * no callback timeout: a callback that never settles holds the queue. Joined calls run one at a time; once one of
 * them failed, the later ones are refused and the transaction rolls back even if its callback caught the error.
 */
export function serialTransactions<Conn>(driver: TransactionDriver<Conn>, defaultWaitMs: number): SerialTransactions<Conn> {
  let running = 0;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();
  const context = new AsyncLocalStorage<Frame>();

  function exclusiveWith<T>(run: (conn: Conn, token: Token, deadline: Deadline) => Promise<T>, options: TransactionOptions | undefined): Promise<T> {
    const fatal = driver.health();
    if (fatal) return Promise.reject(fatal);
    if (context.getStore()?.token.active) throw new FrameworkError("nested transactions are not supported");
    queued++;
    const work = tail.then(async () => {
      queued--;
      running++;
      const token: Token = { active: true };
      // One clock for the connection's acquisition and BEGIN, from when this call reaches the front of the queue.
      const started = performance.now();
      const deadline: Deadline = { started, at: started + (options?.waitMs ?? defaultWaitMs) };
      try {
        const fatal = driver.health();
        if (fatal) throw fatal;
        const conn = await driver.acquire(deadline);
        try {
          try { return await context.run({ token, tail: Promise.resolve() }, () => run(conn, token, deadline)); }
          catch (cause) { throw driver.report(cause, "job"); }
        } finally { driver.release(conn); }
      } finally { token.active = false; running--; }
    });
    // Consume the queue link's rejection, not the caller's result. A failed
    // transaction releases the next one without changing the error it receives.
    tail = work.then(() => undefined, () => undefined);
    return work;
  }

  function transaction<T>(run: (tx: DataOperations) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const frame = context.getStore();
    if (frame?.token.active && frame.token.operations) {
      // Joined calls run one at a time: this call waits for the ones joined before it from the same frame, so two
      // read-then-write calls on one row cannot both read before either writes. It runs in a frame of its own.
      // Rollback-only: a joined call that fails poisons the whole transaction, even if the
      // outer callback catches the error, so a half-done inner call can never commit.
      // Fail fast: once a joined call failed, a call that joins afterwards is refused before its callback runs, at
      // once or, if it was queued before the failure, when its turn comes.
      const { token } = frame;
      if (token.failed) return Promise.reject(refusal(token.failed));
      const operations = frame.token.operations;
      const work = frame.tail.then(() => {
        if (!token.active) throw new FrameworkError("A call joined a transaction that ended before the call's turn came: await every call joined to a transaction before its callback returns");
        if (token.failed) throw refusal(token.failed);
        // Inside then, so a callback that throws before returning a promise is caught too.
        return context.run({ token, tail: Promise.resolve() }, () => run(operations));
      }).catch((cause: unknown) => { token.failed ??= { cause }; throw cause; });
      frame.tail = work.then(() => undefined, () => undefined);
      return work;
    }
    return exclusiveWith(async (conn, token, deadline) => {
      // The queue is held while this waits, so a write begins only after the one before it has committed.
      try { await driver.begin(conn, deadline); }
      catch (cause) { throw driver.report(cause, "begin"); }
      let active = true;
      const guard = () => { if (!active) throw new FrameworkError("Transaction operations are no longer active"); };
      const failed = (cause: unknown) => { token.statementFailed ??= { cause }; };
      token.operations = driver.operations(conn, guard, failed);
      try {
        const result = await run(token.operations);
        active = false;
        token.active = false; // a call from here on starts a new transaction instead of joining
        if (token.statementFailed) {
          const first = token.statementFailed.cause;
          throw first instanceof DatabaseBusyError ? first : new FrameworkError("A statement of this transaction failed, so Postgres aborted the transaction even though its callback caught the error", { cause: first });
        }
        if (token.failed) {
          throw new FrameworkError("A call joined to this transaction failed, so the transaction is rolled back even though its callback caught the error", { cause: token.failed.cause });
        }
        try { await driver.commit(conn); }
        catch (cause) { throw driver.report(cause, "commit"); }
        return result;
      } catch (cause) {
        active = false;
        token.active = false;
        await driver.rollback(conn, cause);
        throw cause;
      } finally { active = false; }
    }, options);
  }

  return {
    transaction,
    exclusive: (run, options) => exclusiveWith((conn, _token, deadline) => run(conn, deadline), options),
    refuseIfFailed() {
      // The same test as the join in `transaction`: true exactly when a call made here would join.
      const token = context.getStore()?.token;
      if (!token?.active || !token.operations) return false;
      if (token.failed) throw refusal(token.failed);
      return true;
    },
    insideTransaction: () => context.getStore()?.token.active === true,
    counts: () => ({ running, queued }),
  };
}
