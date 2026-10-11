import type { DataLayer, DataOperations, Row } from "./data-layer.ts";
import { cloneValue } from "./load.ts";

/**
 * The three lifecycle seams (M6, ADR-0075): code the application runs before an action's transaction, after each row an
 * action writes, and after the outermost transaction commits. They are registered when the application binds a data
 * layer (`bind(layer, { seams })`), and `connect()` reads the same object from the `seams` key of `mesh.config.ts`.
 * Payloads are plain data; a seam never receives a read handle, a data layer or a function of the entity files.
 */

/** The context a call carries (`ActionContext`), as a seam sees it: plain data, `{}` when the call passed none. */
export type SeamContext = Readonly<Record<string, unknown>>;

/** One row an action wrote: the row as it was (`null` for a create) and as written (`null` for a destroy). */
export interface Change {
  /** The entity's name, e.g. `Review`. */
  readonly entity: string;
  /** The action's name, e.g. `accept`. */
  readonly action: string;
  readonly before: Readonly<Row> | null;
  readonly after: Readonly<Row> | null;
}

/** What `beforeTransaction` receives. */
export interface BeforeTransactionEvent {
  readonly entity: string;
  readonly action: string;
  /** The validated input of the call. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: SeamContext;
}

/** What `afterWrite` receives besides `db`: the change, and the input and context of the call that made it. */
export interface AfterWriteEvent extends Change {
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: SeamContext;
}

/** What `afterCommit` receives: every change the transaction made, in the order the rows were written. */
export interface AfterCommitEvent {
  readonly changes: readonly Change[];
}

/**
 * The transaction's data operations a seam may use (ADR-0075, ruling 6): the four that read and write one row by key.
 * A write through it runs no seam and is not a change in `afterCommit`.
 */
export type SeamDb = Pick<DataOperations, "insert" | "selectByKey" | "updateByKey" | "deleteByKey">;

/** The registered seams; every one is optional. */
export interface Seams {
  /**
   * Before the transaction opens, for the call that opens it: a top-level action call. A call that joins a running
   * transaction (through `actions`, or inside the application's `transaction`) has no "before the transaction" and runs
   * none. Throw to refuse the call: nothing is written.
   */
  beforeTransaction?(event: BeforeTransactionEvent): void | Promise<void>;
  /**
   * Inside the transaction, right after a row is written and before any `run [after=:write]` step. May write through
   * `db`; a throw rolls back the whole outermost transaction.
   */
  afterWrite?(db: SeamDb, event: AfterWriteEvent): void | Promise<void>;
  /**
   * Once, after the outermost transaction commits, with every change it made. Not called on rollback. A throw does not
   * fail the call, whose data is committed: it is reported with `console.error`.
   */
  afterCommit?(event: AfterCommitEvent): void | Promise<void>;
}

/** What names an action to a seam. */
export interface SeamTarget {
  readonly entity: string;
  readonly action: string;
}

const changesOf = new WeakMap<DataOperations, Change[]>();

/** True when a seam wants to see each row an action writes, and so a destroy must read the row first. */
export function wantsChanges(seams: Seams | undefined): boolean {
  return seams?.afterWrite !== undefined || seams?.afterCommit !== undefined;
}

/**
 * Mark `operations` as the start of an outermost transaction: whatever an earlier transaction that rolled back left
 * for them is dropped, so a data layer that hands out one operations object for every transaction cannot leak a change
 * into the next commit.
 */
export function begin(operations: DataOperations): DataOperations {
  changesOf.delete(operations);
  return operations;
}

/**
 * Run one generated write action's transaction. The call that opens the transaction (the data layer says so: it is not
 * inside a running one) runs `beforeTransaction` first and `afterCommit` once the transaction has committed; a call
 * that joins a running transaction runs neither, and its changes wait for the outermost call.
 */
export async function runAction<T>(
  layer: DataLayer, seams: Seams | undefined, target: SeamTarget, input: unknown, context: unknown,
  body: (tx: DataOperations) => Promise<T>,
): Promise<T> {
  const joined = layer.refuseIfFailed();
  if (!joined && seams?.beforeTransaction)
    await seams.beforeTransaction({ ...target, input: input as BeforeTransactionEvent["input"], context: (context ?? {}) as SeamContext });
  if (joined) return layer.transaction(body);
  let operations: DataOperations | undefined;
  const result = await layer.transaction((tx) => { operations = begin(tx); return body(tx); });
  await commit(operations, seams);
  return result;
}

/**
 * Run `afterCommit` for the transaction whose operations are `operations`, after it committed, with the changes it
 * collected. Nothing runs when it wrote nothing. A throw is reported and swallowed: the data is committed.
 */
export async function commit(operations: DataOperations | undefined, seams: Seams | undefined): Promise<void> {
  if (!operations) return;
  const changes = changesOf.get(operations);
  changesOf.delete(operations);
  if (!seams?.afterCommit || !changes?.length) return;
  try {
    await seams.afterCommit({ changes });
  } catch (error) {
    console.error("The afterCommit seam threw. The transaction is committed and the call resolved; the remaining changes are not retried:", error);
  }
}

/** The data operations a seam gets: the four by-key ones, so no seam can read or write more than the contract promises. */
function dbOf(tx: DataOperations): SeamDb {
  return Object.freeze({
    insert: (table, row) => tx.insert(table, row),
    selectByKey: (table, key) => tx.selectByKey(table, key),
    updateByKey: (table, key, changes) => tx.updateByKey(table, key, changes),
    deleteByKey: (table, key) => tx.deleteByKey(table, key),
  });
}

/**
 * Called by a generated write action right after it wrote its row: records the change for `afterCommit` and runs
 * `afterWrite`. `before` and `after` are copied, so the seams see the row as it was written whatever a step does next.
 */
export async function afterWrite(
  tx: DataOperations, seams: Seams | undefined, target: SeamTarget, before: Row | null, after: Row | null,
  input: unknown, context: unknown,
): Promise<void> {
  if (!wantsChanges(seams)) return;
  const change: Change = Object.freeze({ ...target, before: before && cloneValue(before), after: after && cloneValue(after) });
  const list = changesOf.get(tx);
  if (list) list.push(change); else changesOf.set(tx, [change]);
  if (seams?.afterWrite)
    await seams.afterWrite(dbOf(tx), { ...change, input: input as AfterWriteEvent["input"], context: (context ?? {}) as SeamContext });
}
