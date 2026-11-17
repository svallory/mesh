import type { CapabilityManifest } from "./capabilities.ts";
import type { DataLayer, DataOperations, FailureOperations, FailureRow, OutboxAppend, OutboxPage, RetentionOperations } from "./data-layer.ts";
import { FrameworkError, MeshError } from "./errors.ts";

/** A fresh layer whose database has the outbox tables and no outbox row. Each check closes it. */
export type OutboxFixture = DataLayer;

/** What `outboxConformance` takes beside the layer factory and the manifest. */
export interface OutboxConformanceOptions {
  /**
   * A second layer object over the same database as `layer` (its own connection), which the check closes. With it the
   * suite runs the check only a second connection can: a commit beside a transaction that is still open, which is where
   * a read that ignores the reader rule skips a row. Leave it out where no second connection exists (a private memory
   * database).
   */
  readonly sibling?: (layer: DataLayer) => Promise<DataLayer>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Outbox conformance: ${message}`);
}

let counter = 0;
/** One appendable row; `n` goes into the payload so a read can be matched to its append. */
export function outboxRow(n: number, overrides: Partial<OutboxAppend> = {}): OutboxAppend {
  counter++;
  return {
    id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    name: "billing.InvoicePaid",
    entity: "billing.Invoice",
    action: "pay",
    key: { id: `invoice-${n}` },
    causedBy: null,
    metadata: { requestId: `r${n}` },
    occurredAt: new Date(1_760_000_000_000 + n),
    payload: { n, nested: { list: [1, "two", null] } },
    ...overrides,
  };
}

const positions = (page: OutboxPage) => page.rows.map((row) => row.position);

/** The page invariants every read keeps (`OutboxPage`): `deletedThrough <= settled <= highest`, rows in range and in order. */
function checkPage(page: OutboxPage, after: number, limit: number): void {
  const where = `readOutbox(${after}, ${limit}) gave deletedThrough ${page.deletedThrough}, settled ${String(page.settled)}, highest ${page.highest}`;
  assert(Number.isSafeInteger(page.settled), `${where}: settled must be a whole number`);
  assert(page.deletedThrough <= page.settled && page.settled <= page.highest, `${where}: deletedThrough <= settled <= highest must hold`);
  assert(page.rows.length <= limit, `${where}: ${page.rows.length} rows, above the limit`);
  let previous = after;
  for (const row of page.rows) {
    assert(row.position > previous && row.position <= page.settled, `${where}: row ${row.position} is out of order, at or below after, or above settled`);
    previous = row.position;
  }
}
const payloads = (page: OutboxPage) => page.rows.map((row) => (row.payload as { n: number }).n);
const consecutive = (list: readonly number[], from: number) => list.every((value, index) => value === from + index);

async function rejects(run: () => Promise<unknown>, test: (error: unknown) => boolean, message: string): Promise<void> {
  let thrown: unknown;
  let failed = false;
  try { await run(); } catch (error) { failed = true; thrown = error; }
  assert(failed && test(thrown), `${message} (got ${failed ? String(thrown) : "no error"})`);
}

/**
 * The outbox checks (spec, Events and commands, "The outbox"): the three operations every adapter of a project that
 * declares an event has, never reusing a position among them, and, when `manifest` declares `gapless-positions`, the checks of that capability. Named,
 * runner-independent asynchronous checks, like `dataLayerConformanceV1`; each owns and closes its layer. Every page any
 * check reads is held to the `OutboxPage` invariants: `deletedThrough <= settled <= highest`, at most `limit` rows, in
 * increasing order, above `after` and none above `settled`. With `options.sibling` (a second layer over the same
 * database) a further check reads while another connection's transaction is open and asserts that the read never
 * skips a row that commits later: no row a later read returns sits below the earlier read's highest returned position
 * without the earlier read having returned it.
 */
export function outboxConformance(makeLayer: () => Promise<OutboxFixture>, manifest: CapabilityManifest, options: OutboxConformanceOptions = {}): Record<string, () => Promise<void>> {
  type Readable = DataLayer & Required<Pick<DataLayer, "readOutbox">>;
  /** Each check gets the layer with every read held to the page invariants, and the layer itself for `sibling`. */
  const withLayer = (run: (layer: Readable, raw: DataLayer) => Promise<void>) => async () => {
    const layer = await makeLayer();
    try {
      assert(typeof layer.readOutbox === "function", "the layer has no readOutbox");
      const read = layer.readOutbox.bind(layer);
      const checked: Readable = {
        database: layer.database,
        transaction: (body, given) => layer.transaction(body, given),
        refuseIfFailed: () => layer.refuseIfFailed(),
        close: () => layer.close(),
        readOutbox: async (after, limit) => { const page = await read(after, limit); checkPage(page, after, limit); return page; },
      };
      await run(checked, layer);
    } finally { await layer.close(); }
  };
  const append = (layer: DataLayer, ...rows: OutboxAppend[]) => layer.transaction(async (tx) => {
    assert(typeof tx.appendEvent === "function" && typeof tx.deleteOutboxThrough === "function", "the transaction's operations lack appendEvent or deleteOutboxThrough");
    const out: number[] = [];
    for (const row of rows) out.push(await tx.appendEvent(row));
    return out;
  });
  const checks: Record<string, () => Promise<void>> = {
    "an empty outbox reads no rows, with both positions 0": withLayer(async (layer) => {
      const page = await layer.readOutbox(0, 10);
      assert(page.rows.length === 0 && page.deletedThrough === 0 && page.highest === 0, `got ${JSON.stringify(page)}`);
    }),
    "appends get increasing positions from 1, and a read returns every field as appended, in order": withLayer(async (layer) => {
      const first = outboxRow(1, { causedBy: "00000000-0000-7000-8000-00000000cafe" });
      const given = await append(layer, first, outboxRow(2), outboxRow(3));
      assert(JSON.stringify(given) === "[1,2,3]", `appendEvent returned ${JSON.stringify(given)}`);
      const page = await layer.readOutbox(0, 10);
      assert(JSON.stringify(positions(page)) === "[1,2,3]" && page.highest === 3 && page.deletedThrough === 0, `read ${JSON.stringify(page)}`);
      const row = page.rows[0]!;
      assert(row.id === first.id && row.name === first.name && row.entity === first.entity && row.action === first.action
        && row.causedBy === first.causedBy && JSON.stringify(row.key) === JSON.stringify(first.key)
        && JSON.stringify(row.metadata) === JSON.stringify(first.metadata) && JSON.stringify(row.payload) === JSON.stringify(first.payload)
        && row.occurredAt instanceof Date && row.occurredAt.getTime() === first.occurredAt.getTime(), `row 1 read back as ${JSON.stringify(row)}`);
      assert(page.rows[1]!.causedBy === null, "a null causedBy reads back as null");
    }),
    "a read pages by after and limit": withLayer(async (layer) => {
      await append(layer, outboxRow(1), outboxRow(2), outboxRow(3), outboxRow(4), outboxRow(5));
      const first = await layer.readOutbox(0, 2);
      assert(JSON.stringify(positions(first)) === "[1,2]" && first.highest === 5, "first page keeps the head beyond its limit");
      const second = await layer.readOutbox(2, 2);
      assert(JSON.stringify(positions(second)) === "[3,4]" && second.highest === 5, "second page keeps the same head");
      const last = await layer.readOutbox(4, 2);
      assert(JSON.stringify(positions(last)) === "[5]" && last.highest === 5, "last page");
      const empty = await layer.readOutbox(5, 2);
      assert(empty.rows.length === 0 && empty.highest === 5, "an empty page at the head retains highest");
    }),
    "a rolled-back transaction leaves no row": withLayer(async (layer) => {
      await rejects(() => layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); throw new Error("roll back"); }),
        (error) => error instanceof Error && error.message === "roll back", "the transaction rejects with its own error");
      const page = await layer.readOutbox(0, 10);
      assert(page.rows.length === 0, `read ${page.rows.length} rows after a rollback`);
    }),
    "the read is refused inside a transaction, pointing to published()": withLayer(async (layer) => {
      await layer.transaction(async () => {
        await rejects(() => layer.readOutbox(0, 10),
          (error) => error instanceof FrameworkError && error.message.includes("published()"), "a read inside a transaction is a FrameworkError naming published()");
      });
    }),
    "a delete removes the prefix, records the deleted-through position and returns the rows deleted": withLayer(async (layer) => {
      await append(layer, outboxRow(1), outboxRow(2), outboxRow(3), outboxRow(4));
      const deleted = await layer.transaction(async (tx) => tx.deleteOutboxThrough!(2));
      assert(deleted === 2, `deleted ${deleted}`);
      const page = await layer.readOutbox(0, 10);
      assert(JSON.stringify(positions(page)) === "[3,4]" && page.deletedThrough === 2 && page.highest === 4, `read ${JSON.stringify(page)}`);
      assert(await layer.transaction(async (tx) => tx.deleteOutboxThrough!(1)) === 0, "a delete below the recorded position deletes nothing");
      assert((await layer.readOutbox(0, 10)).deletedThrough === 2, "and does not move the position back");
      await rejects(() => layer.transaction(async (tx) => tx.deleteOutboxThrough!(5)), (error) => error instanceof FrameworkError, "a delete above the highest position is refused");
      assert((await layer.readOutbox(0, 10)).rows.length === 2, "the refused delete deleted nothing");
    }),
    "a delete that rolls back leaves the rows and the position": withLayer(async (layer) => {
      await append(layer, outboxRow(1), outboxRow(2));
      await rejects(() => layer.transaction(async (tx) => { await tx.deleteOutboxThrough!(2); throw new Error("roll back"); }), () => true, "rejects");
      const page = await layer.readOutbox(0, 10);
      assert(page.rows.length === 2 && page.deletedThrough === 0, `read ${JSON.stringify(page)}`);
    }),
    "with no transaction open, settled is highest, after appends, a rollback and a delete": withLayer(async (layer) => {
      const settledIsHighest = async (what: string) => {
        const page = await layer.readOutbox(0, 10);
        assert(page.settled === page.highest, `${what}: settled ${page.settled}, highest ${page.highest}`);
      };
      await settledIsHighest("an empty outbox");
      await append(layer, outboxRow(1), outboxRow(2));
      await settledIsHighest("after two appends");
      await rejects(() => layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(3)); throw new Error("roll back"); }), () => true, "rejects");
      await settledIsHighest("after a rolled-back append");
      await layer.transaction(async (tx) => tx.deleteOutboxThrough!(1));
      await settledIsHighest("after a delete");
      const short = await layer.readOutbox(1, 10);
      assert(short.rows.every((row) => row.position <= short.settled) && short.rows.at(-1)?.position === 2, `read ${JSON.stringify(positions(short))}`);
    }),
    "a statement the database refuses, caught by the callback, never lets the transaction resolve as if nothing was written": withLayer(async (layer) => {
      let outcome: "resolved" | "rejected";
      try {
        await layer.transaction(async (tx) => {
          await tx.appendEvent!(outboxRow(1));
          // A row the database refuses (a required column given null) fails inside the statement; the callback goes on.
          await rejects(() => tx.appendEvent!(outboxRow(2, { name: null as never })), () => true, "a row with a null name is refused");
          await tx.appendEvent!(outboxRow(3));
        });
        outcome = "resolved";
      } catch { outcome = "rejected"; }
      const page = await layer.readOutbox(0, 10);
      if (outcome === "rejected") assert(page.rows.length === 0, `the transaction rejected, and ${page.rows.length} of its rows are visible`);
      else assert(JSON.stringify(payloads(page)) === "[1,3]", `the transaction resolved, and the rows read back are ${JSON.stringify(payloads(page))}, not [1,3]`);
    }),
    "a delete that empties the outbox never lets a position be reused": withLayer(async (layer) => {
      await append(layer, outboxRow(1), outboxRow(2), outboxRow(3));
      await layer.transaction(async (tx) => tx.deleteOutboxThrough!(3));
      const empty = await layer.readOutbox(0, 10);
      assert(empty.rows.length === 0 && empty.deletedThrough === 3 && empty.highest === 3, `read ${JSON.stringify(empty)}`);
      const [next] = await append(layer, outboxRow(4));
      assert(next! > 3, `the append after an emptying delete got position ${next}, which a deleted row had`);
      const page = await layer.readOutbox(3, 10);
      assert(JSON.stringify(positions(page)) === JSON.stringify([next]) && page.highest === next, `read ${JSON.stringify(page)}`);
    }),
  };
  if (options.sibling) {
    const sibling = options.sibling;
    checks["a read beside a transaction still open never skips a row that commits after it (two more connections)"] = withLayer(async (layer, raw) => {
      const second = await sibling(raw);
      const third = await sibling(raw);
      try {
        const reader = third.readOutbox;
        assert(typeof reader === "function", "the sibling layer has no readOutbox");
        const read = async (after: number, limit: number) => { const page = await reader.call(third, after, limit); checkPage(page, after, limit); return page; };
        let open!: () => void;
        const gate = new Promise<void>((resolve) => { open = resolve; });
        let appended!: () => void;
        const inside = new Promise<void>((resolve) => { appended = resolve; });
        const first = layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); appended(); await gate; });
        await inside;
        // A second connection appends and commits while the first is open: on a server dialect its position is above
        // the open one's; on SQLite it waits for the file lock, and commits once the first does or gives up after 300 ms.
        const beside = second.transaction(async (tx) => { await tx.appendEvent!(outboxRow(2)); }, { waitMs: 300 })
          .then(() => "committed" as const, (error: unknown) => error);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const r1 = await read(0, 100);
        open();
        await first;
        // On SQLite the second may get the lock once the first commits, within its wait; read 2 comes after both settle.
        const besideOutcome = await beside;
        const r2 = await read(0, 100);
        assert(besideOutcome === "committed" || (besideOutcome instanceof MeshError && besideOutcome.code === "MESH_DATABASE_BUSY"),
          `the transaction beside the open one either commits or is MESH_DATABASE_BUSY, and gave ${String(besideOutcome)}`);
        const top = Math.max(0, ...positions(r1));
        const seen = new Set(positions(r1));
        const skipped = positions(r2).filter((position) => position < top && !seen.has(position));
        assert(skipped.length === 0, `read 1 returned ${JSON.stringify(positions(r1))}, and read 2 returned ${JSON.stringify(skipped)} below it: a reader past read 1 skips them`);
        assert(payloads(r2).includes(1), `the first transaction committed, and read 2 is ${JSON.stringify(payloads(r2))}`);
        if (besideOutcome === "committed") assert(payloads(r2).includes(2), `the second transaction committed, and read 2 is ${JSON.stringify(payloads(r2))}`);
      } finally { await second.close(); await third.close(); }
    });
  }
  if (!manifest.capabilities.includes("gapless-positions")) return checks;
  return {
    ...checks,
    "gapless-positions: no gap after rolled-back transactions": withLayer(async (layer) => {
      await append(layer, outboxRow(1));
      for (let attempt = 0; attempt < 3; attempt++) {
        await rejects(() => layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(90)); await tx.appendEvent!(outboxRow(91)); throw new Error("no"); }), () => true, "rejects");
      }
      await append(layer, outboxRow(2), outboxRow(3));
      const page = await layer.readOutbox(0, 10);
      assert(consecutive(positions(page), 1) && JSON.stringify(payloads(page)) === "[1,2,3]", `positions ${JSON.stringify(positions(page))}`);
    }),
    "gapless-positions: no gap after a failed insert in a transaction that commits": withLayer(async (layer) => {
      await layer.transaction(async (tx) => {
        await tx.appendEvent!(outboxRow(1));
        // A row the database refuses (a required column given null) fails inside the statement.
        await rejects(() => tx.appendEvent!(outboxRow(2, { name: null as never })), () => true, "a row with a null name is refused");
        await tx.appendEvent!(outboxRow(3));
      });
      const page = await layer.readOutbox(0, 10);
      assert(JSON.stringify(positions(page)) === "[1,2]" && JSON.stringify(payloads(page)) === "[1,3]", `positions ${JSON.stringify(positions(page))}`);
    }),
  };
}

/** A set-aside event as `writeFailure` takes it: `row`'s fields, the handler and the error. */
function failureOf(position: number, row: OutboxAppend, handler: string, error: FailureRow["error"] = { code: null, message: "down" }): Omit<FailureRow, "failure" | "failedAt"> {
  return { ...row, position, handler, error };
}

/** The four dead-letter operations of a transaction, asserted present together. */
function failures(tx: DataOperations): FailureOperations {
  const names = ["writeFailure", "readFailures", "deleteFailure", "renameFailures"] as const;
  const present = names.filter((name) => typeof tx[name] === "function");
  assert(present.length === names.length, `the transaction's operations have ${present.join(", ") || "none"} of ${names.join(", ")}: an adapter has all four or none`);
  return tx as DataOperations & FailureOperations;
}

/** The retention operation of a transaction, asserted present. */
function retention(tx: DataOperations): RetentionOperations {
  assert(typeof tx.firstOutboxRowSince === "function", "the transaction's operations have no firstOutboxRowSince (RetentionOperations)");
  return tx as DataOperations & RetentionOperations;
}

/**
 * The retention checks a data adapter runs beside `outboxConformance` (spec, Events and commands, "Retention", "Handler
 * failures"): the four dead-letter operations on `mesh_outbox_failures` (`FailureOperations`), all present together,
 * and the keep period's `firstOutboxRowSince` (`RetentionOperations`); each check owns and closes its layer, as
 * `outboxConformance`'s do. `makeLayer` gives a fresh database with
 * core's tables for a project that declares an event.
 */
export function retentionConformance(makeLayer: () => Promise<OutboxFixture>): Record<string, () => Promise<void>> {
  const withLayer = (run: (layer: DataLayer) => Promise<void>) => async () => {
    const layer = await makeLayer();
    try { await run(layer); } finally { await layer.close(); }
  };
  const read = (layer: DataLayer, handler: string, after: Parameters<FailureOperations["readFailures"]>[1], limit: number) =>
    layer.transaction(async (tx) => failures(tx).readFailures(handler, after, limit));
  const write = (layer: DataLayer, ...rows: Omit<FailureRow, "failure" | "failedAt">[]) => layer.transaction(async (tx) => {
    for (const row of rows) await failures(tx).writeFailure(row);
  });
  return {
    "dead letters: a written failure reads back whole, with its own id, the handler, the error and the database's failedAt": withLayer(async (layer) => {
      const row = outboxRow(7, { causedBy: "00000000-0000-7000-8000-00000000beef" });
      const before = Date.now();
      await write(layer, failureOf(42, row, "receipts", { code: "MESH_FORBIDDEN", message: "denied" }));
      const [read1, ...rest] = await read(layer, "receipts", null, 10);
      assert(read1 !== undefined && rest.length === 0, "one failure was written and one is to be read");
      assert(Number.isSafeInteger(read1.failure) && read1.failure > 0, `failure is the row's id, a positive whole number, and is ${String(read1.failure)}`);
      assert(read1.handler === "receipts" && read1.position === 42 && read1.id === row.id && read1.name === row.name && read1.entity === row.entity
        && read1.action === row.action && read1.causedBy === row.causedBy && JSON.stringify(read1.key) === JSON.stringify(row.key)
        && JSON.stringify(read1.metadata) === JSON.stringify(row.metadata) && JSON.stringify(read1.payload) === JSON.stringify(row.payload)
        && read1.occurredAt instanceof Date && read1.occurredAt.getTime() === row.occurredAt.getTime(), `the failure read back as ${JSON.stringify(read1)}`);
      assert(read1.error.code === "MESH_FORBIDDEN" && read1.error.message === "denied", `error read back as ${JSON.stringify(read1.error)}`);
      assert(read1.failedAt instanceof Date && Math.abs(read1.failedAt.getTime() - before) < 60_000, `failedAt is the database's clock now, and is ${String(read1.failedAt)}`);
      await write(layer, failureOf(43, outboxRow(8), "receipts", { code: null, message: "plain" }));
      const second = (await read(layer, "receipts", null, 10))[1]!;
      assert(second.error.code === null && second.causedBy === null, `a null code and causedBy read back as null, got ${JSON.stringify(second)}`);
      assert((await read(layer, "other", null, 10)).length === 0, "another handler's list is empty");
    }),
    "dead letters: readFailures pages a handler's rows in (position, failure) order, across equal positions and ids written out of position order": withLayer(async (layer) => {
      // Written in the order 30, 10, 20, 10, 30: the ids rise in that order, the positions do not.
      await write(layer, ...[30, 10, 20, 10, 30].map((position, n) => failureOf(position, outboxRow(n), "h")), failureOf(15, outboxRow(9), "other"));
      const all = await read(layer, "h", null, 100);
      const order = all.map((row) => `${row.position}:${(row.payload as { n: number }).n}`);
      assert(JSON.stringify(order) === '["10:1","10:3","20:2","30:0","30:4"]', `the order is (position, failure), got ${JSON.stringify(order)}`);
      const pages: string[] = [];
      let cursor: { position: number; failure: number } | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page: readonly FailureRow[] = await read(layer, "h", cursor, 2);
        assert(page.length <= 2, `a page of limit 2 held ${page.length} rows`);
        pages.push(...page.map((row) => `${row.position}:${(row.payload as { n: number }).n}`));
        if (page.length < 2) break;
        cursor = { position: page.at(-1)!.position, failure: page.at(-1)!.failure };
      }
      assert(JSON.stringify(pages) === JSON.stringify(order), `paging by the keyset gave ${JSON.stringify(pages)}`);
      const past = await read(layer, "h", { position: 10, failure: all[1]!.failure }, 100);
      assert(JSON.stringify(past.map((row) => row.position)) === "[20,30,30]", `after the second row at 10 come 20, 30, 30, got ${JSON.stringify(past.map((row) => row.position))}`);
    }),
    "dead letters: deleteFailure removes one row by its id and is false the second time; a rolled-back delete keeps it": withLayer(async (layer) => {
      await write(layer, failureOf(1, outboxRow(1), "h"), failureOf(2, outboxRow(2), "h"));
      const [first, second] = await read(layer, "h", null, 10);
      await rejects(() => layer.transaction(async (tx) => { await failures(tx).deleteFailure(first!.failure); throw new Error("roll back"); }), () => true, "the transaction rolls back");
      assert((await read(layer, "h", null, 10)).length === 2, "a rolled-back delete removed the row");
      assert(await layer.transaction((tx) => failures(tx).deleteFailure(first!.failure)), "deleteFailure of a present row is true");
      assert(!(await layer.transaction((tx) => failures(tx).deleteFailure(first!.failure))), "deleteFailure of a gone row is false");
      const left = await read(layer, "h", null, 10);
      assert(left.length === 1 && left[0]!.failure === second!.failure, `the other row stays, got ${JSON.stringify(left.map((row) => row.failure))}`);
    }),
    "dead letters: a failure id is never reused, even after the highest one is deleted": withLayer(async (layer) => {
      await write(layer, failureOf(1, outboxRow(1), "h"), failureOf(2, outboxRow(2), "h"));
      const highest = (await read(layer, "h", null, 10)).at(-1)!.failure;
      await layer.transaction((tx) => failures(tx).deleteFailure(highest));
      await write(layer, failureOf(3, outboxRow(3), "h"));
      const next = (await read(layer, "h", null, 10)).at(-1)!;
      assert(next.position === 3 && next.failure > highest, `the next failure id is ${next.failure}, not above the deleted ${highest}`);
    }),
    "dead letters: renameFailures re-keys every row of one handler to another and leaves the rest": withLayer(async (layer) => {
      await write(layer, failureOf(1, outboxRow(1), "before"), failureOf(2, outboxRow(2), "before"), failureOf(3, outboxRow(3), "kept"));
      await layer.transaction((tx) => failures(tx).renameFailures("before", "after"));
      assert((await read(layer, "before", null, 10)).length === 0, "the former name keeps no row");
      const moved = await read(layer, "after", null, 10);
      assert(JSON.stringify(moved.map((row) => [row.position, row.handler])) === '[[1,"after"],[2,"after"]]', `got ${JSON.stringify(moved.map((row) => [row.position, row.handler]))}`);
      assert((await read(layer, "kept", null, 10)).length === 1, "another handler's row was touched");
      await layer.transaction((tx) => failures(tx).renameFailures("nobody", "after"));
      assert((await read(layer, "after", null, 10)).length === 2, "renaming a handler with no rows changes nothing");
    }),
    "keep periods: firstOutboxRowSince gives the first row above after and at or below through stamped after since, and a row stamped exactly since is not after it": withLayer(async (layer) => {
      const base = 1_760_000_000_000;
      // Rows 1 to 5, each one second younger than the one before: since = row 3's instant makes rows 4 and 5 the young ones.
      const positions = await layer.transaction(async (tx) => {
        const out: number[] = [];
        for (let n = 1; n <= 5; n++) out.push(await tx.appendEvent!(outboxRow(n, { occurredAt: new Date(base + n * 1000) })));
        return out;
      });
      const [p1, p2, p3, p4, p5] = positions as [number, number, number, number, number];
      const first = (after: number, through: number, since: number) => layer.transaction((tx) => retention(tx).firstOutboxRowSince(after, through, new Date(since)));
      const since = base + 3000;
      assert((await first(0, p5, since)) === p4, "row 3 is stamped exactly since, so row 4 is the first after it");
      assert((await first(0, p3, since)) === null, "no row at or below row 3 is after since");
      assert((await first(0, p4, since)) === p4, "through is inclusive");
      assert((await first(p4, p5, since)) === p5, "after is exclusive");
      assert((await first(p5, p5, since)) === null, "an empty range gives null");
      assert((await first(0, p5, base + 2999)) === p3, "a since one millisecond before row 3's instant makes row 3 the first after it");
      assert((await first(0, p5, base)) === p1, "every row is after a since older than all of them");
      assert((await first(0, p5, base + 10_000)) === null, "no row is after a since younger than all of them");
      await layer.transaction((tx) => tx.deleteOutboxThrough!(p2));
      assert((await first(0, p5, base)) === p3, "a deleted row is not found");
    }),
    "dead letters: a failure row outlives the deletion of its outbox row": withLayer(async (layer) => {
      const row = outboxRow(1);
      const [position] = await layer.transaction(async (tx) => [await tx.appendEvent!(row)]);
      await write(layer, failureOf(position!, row, "h"));
      await layer.transaction((tx) => tx.deleteOutboxThrough!(position!));
      assert((await layer.readOutbox!(0, 10)).rows.length === 0, "the outbox row was to be deleted");
      const kept = await read(layer, "h", null, 10);
      assert(kept.length === 1 && kept[0]!.position === position && kept[0]!.id === row.id, "the failure row was deleted with its outbox row");
    }),
  };
}
