// The event-bus conformance suite (`busConformance` from `@meshfw/runtime/testing`) run with `testBus` over data-sqlite,
// on a memory and a file database, and what only a file database shows: a claim held by another process, and a claim
// that waits for the database lock longer than the layer allows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { bindDomain, DatabaseBusyError, DelivererTakenError, type TableHandle } from "@meshfw/runtime";
import { busConformance, setDeliveryTiming, testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";
import { sqliteWith } from "../src/layer.ts";
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
  dir = await mkdtemp(join(import.meta.dir, ".bus-"));
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

test("the schema holds core's delivery tables after the outbox's", () => {
  expect(Object.keys(tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
});

for (const kind of ["memory", "file"] as const) {
  describe(`bus conformance with testBus, ${kind} database`, () => {
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const checks = busConformance({
      async makeLayer() {
        const scratch = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-bus-")) : undefined;
        if (scratch) dirs.push(scratch);
        const layer = sqlite({ file: scratch ? join(scratch, "app.db") : ":memory:" });
        await createSchema(layer, tables);
        return layer;
      },
      frame: () => new AsyncLocalStorage(),
      bus: ({ retryDelays, pollMs }) => testBus({ retryDelays, pollMs }),
    });
    test("every check runs under both keep values", () => {
      const names = Object.keys(checks);
      expect(names.filter((name) => name.startsWith("[keep: until-delivered]")).length).toBe(names.length / 2);
      expect(names.some((name) => name.includes("subscribe:"))).toBe(true);
    });
    for (const [name, check] of Object.entries(checks)) test(name, check, 30_000);
  });
}

describe("data-sqlite's claim", () => {
  let scratch: string;
  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "mesh-claim-")); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
  const empty = (layer: ReturnType<typeof sqlite>) =>
    bindDomain({}, layer, { events: { bus: testBus(), load: async () => ({}) } }, new AsyncLocalStorage());

  test("a claim another process holds is MESH_DELIVERER_TAKEN naming its pid, and is claimed once that process is killed and its claim lapses", async () => {
    const file = join(scratch, "other.db");
    const layer = sqlite({ file });
    await createSchema(layer, tables);
    await layer.close();
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "claim-worker.ts"), file], { stdout: "pipe", stderr: "inherit", env: { ...process.env } });
    try {
      const reader = worker.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the claim worker exited before READY");
        line += new TextDecoder().decode(value);
      }
      expect(line).toStartWith("READY ");
      setDeliveryTiming({ lapseMs: 400 });
      const binding = empty(layer);
      const taken = await binding.deliver().then(() => undefined, (error: unknown) => error);
      expect(taken).toBeInstanceOf(DelivererTakenError);
      // core leaves the host out of the claim, and data-sqlite records the host it runs on
      expect((taken as DelivererTakenError).holder).toMatchObject({ thisProcess: false, pid: worker.pid, host: hostname() });
      expect((taken as DelivererTakenError).retryable).toBe(true);
      worker.kill(9);
      await worker.exited;
      await Bun.sleep(500);
      await binding.deliver();
    } finally {
      worker.kill(9);
      await worker.exited;
      setDeliveryTiming(null);
      await layer.close();
    }
  }, 30_000);

  test("a claim that waits for the lock past the layer's wait is MESH_DATABASE_BUSY, and the next deliver() claims", async () => {
    const file = join(scratch, "busy.db");
    const layer = sqliteWith({ file }, { waitMs: 50 });
    await createSchema(layer, tables);
    await layer.transaction(async () => {});
    const other = new Database(file);
    try {
      other.run("BEGIN IMMEDIATE");
      const binding = empty(layer);
      const busy = await binding.deliver().then(() => undefined, (error: unknown) => error);
      expect(busy).toBeInstanceOf(DatabaseBusyError);
      expect((busy as DatabaseBusyError).retryable).toBe(true);
      other.run("COMMIT");
      await binding.deliver();
    } finally {
      if (other.inTransaction) other.run("ROLLBACK");
      other.close();
      await layer.close();
    }
  }, 30_000);
});
