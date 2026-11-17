import type { CapabilityManifest } from "./capabilities.ts";
import type { DataLayer, OutboxAppend, OutboxPage } from "./data-layer.ts";
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
 * runner-independent asynchronous checks, like `dataLayerConformanceV1`; each owns and closes its layer.
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
