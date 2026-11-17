// Core's deliverer over a data-sqlite layer wrapped to act as a server dialect would: a read that withholds rows above
// a settled position lower than the highest one (an append still open on Postgres), which cannot happen on SQLite
// itself, whose one writer makes settled equal highest.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import {
  bindDomain, DECLARATION, publishEvent,
  type DataLayer, type DataOperations, type Declaration, type DeliveryOperations, type EventsModule, type TableHandle,
} from "@meshfw/runtime";
import { setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";
import { openPolicies } from "./open-policy.ts";

const invoice = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
  actions
    create :open
      do
        publish=() => new InvoicePaid({ n: 1 })
`;
const paid = `event :InvoicePaid
  integer :n
`;

let dir: string;
let tables: Record<string, TableHandle>;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".core-delivery-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  ({ tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { setDeliveryTiming(null); });

function eventClass(fqn: string) {
  return class {
    readonly #brand = true;
    static readonly [DECLARATION]: Declaration = { kind: "event", fqn, is: (value: unknown): value is object => typeof value === "object" && value !== null && #brand in value };
    readonly n: number;
    constructor(fields: { n: number }) { this.n = fields.n; Object.freeze(this); }
  };
}
const Alpha = eventClass("core.Alpha");
const Beta = eventClass("core.Beta");
const domain = { Alpha, Beta };

interface Hooks {
  /** The settled position the read reports and withholds above; undefined passes the read through. */
  settled?: number;
}

/** A data-sqlite layer whose read the test steers through `hooks`. */
async function wrapped(hooks: Hooks): Promise<{ layer: DataLayer; inner: ReturnType<typeof sqlite> }> {
  const inner = sqlite({ file: ":memory:" });
  await createSchema(inner, tables);
  const layer: DataLayer = {
    database: inner.database,
    refuseIfFailed: () => inner.refuseIfFailed(),
    transaction: (run, options) => (inner as DataLayer).transaction(run, options),
    async readOutbox(after, limit) {
      const page = await inner.readOutbox(after, limit);
      const settled = hooks.settled;
      if (settled === undefined) return page;
      return Object.freeze({ ...page, rows: page.rows.filter((row) => row.position <= settled), settled });
    },
    close: () => inner.close(),
  };
  return { layer, inner };
}

const publish = (layer: DataLayer, ...events: InstanceType<typeof Alpha>[]) => layer.transaction(async (tx) => {
  for (const event of events) await publishEvent(tx, undefined, { entity: "core.Thing", action: "make", key: { id: "k" }, at: "test" }, event, {}, () => new Date());
});
const handlerPosition = (layer: DataLayer, name: string) => layer.transaction(async (tx) =>
  (await (tx as DataOperations & DeliveryOperations).readHandlerProgress()).find((row) => row.name === name)?.position);

describe("core's deletion pass", () => {
  for (const keep of ["until-delivered", "all"] as const) {
    test(`[keep: ${keep}] moves a handler that passes a short page to the page's settled position, never to highest`, async () => {
      const hooks: Hooks = {};
      const { layer } = await wrapped(hooks);
      try {
        const seen: number[] = [];
        const module: EventsModule = { handlers: { process: { h: { events: [Alpha], run: (event) => { seen.push(event.position); } } } } };
        const binding = bindDomain(domain, layer, { events: { bus: testBus({ retryDelays: [0, 0] }), keep, load: async () => module } }, new AsyncLocalStorage());
        await binding.deliver();
        // 1 and 3 are events h does not list; 2 is one it lists, still open elsewhere: the read stops at settled 1.
        await publish(layer, new Beta({ n: 1 }), new Alpha({ n: 2 }), new Beta({ n: 3 }));
        hooks.settled = 1;
        await binding.deliver();
        expect(await handlerPosition(layer, "h")).toBe(1);
        expect(seen).toEqual([]);
        // Once 2 is final the handler gets it; moving it to highest (3) would have skipped it for good.
        hooks.settled = undefined;
        await binding.deliver();
        expect(seen).toEqual([2]);
        expect(await handlerPosition(layer, "h")).toBe(3);
      } finally { await layer.close(); }
    });
  }

  test("with nothing withheld, a handler that passes every row moves to highest, as before", async () => {
    const { layer } = await wrapped({});
    try {
      const module: EventsModule = { handlers: { process: { h: { events: [Alpha], run: () => {} } } } };
      const binding = bindDomain(domain, layer, { events: { bus: testBus({ retryDelays: [0, 0] }), load: async () => module } }, new AsyncLocalStorage());
      await binding.deliver();
      await publish(layer, new Beta({ n: 1 }), new Beta({ n: 2 }));
      await binding.deliver();
      expect(await handlerPosition(layer, "h")).toBe(2);
    } finally { await layer.close(); }
  });
});
