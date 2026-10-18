// The outbox on data-sqlite: the emitted tables (AUTOINCREMENT), the three operations, the conformance checks with
// gapless-positions, and what only a file database shows: a read beside another connection's open transaction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, type TableHandle } from "@meshfw/runtime";
import { outboxConformance, outboxRow } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";
import { openPolicies } from "./open-policy.ts";

const invoice = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    integer :n default=0
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
let schema: string;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".outbox-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  schema = await Bun.file(join(dir, ".mesh/schema.ts")).text();
  ({ tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("the emitted outbox tables", () => {
  test("a project that declares an event gets core's tables after its entities' tables", () => {
    expect(Object.keys(tables)).toEqual(["invoices", "mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]);
    expect(schema).toMatch(/position: integer\("position"\)\s*\.notNull\(\)\s*\.primaryKey\(\{ autoIncrement: true \}\)/);
    expect(schema.match(/autoIncrement/g)).toHaveLength(1);
  });

  test("an entity whose table is mesh_outbox, in letter case or not, is MESH_SCHEMA_DUPLICATE_TABLE once an event is declared", async () => {
    for (const table of ["mesh_outbox", "MESH_OUTBOX_STATE"]) {
      const clash = `entity :Log table="${table}"\n  attributes\n    uuid :id primary-key\n`;
      const config = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".clash"),
        data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } } } as ResolvedConfig;
      const files = openPolicies([{ file: "src/domain/log.mesh.mx", source: clash }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }]);
      const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files });
      expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const error = await generateFiles({ config, document: built.document as ModelDocument }, build).then(() => null, (thrown: unknown) => thrown);
      expect((error as { diagnostic?: { code: string; message: string } }).diagnostic).toMatchObject({ code: "MESH_SCHEMA_DUPLICATE_TABLE", message: expect.stringContaining("Mesh's own") });
      // Without an event the name is free.
      const alone = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: [files[0]!] });
      await generateFiles({ config, document: alone.document as ModelDocument }, build);
    }
  });

  test("createSchema creates the outbox with AUTOINCREMENT, and pushing again changes nothing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "mesh-outbox-schema-"));
    try {
      const file = join(scratch, "app.db");
      const layer = sqlite({ file });
      await createSchema(layer, tables);
      await createSchema(layer, tables);
      await layer.close();
      const probe = new Database(file);
      try {
        const sqlOf = (name: string) => (probe.query("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;
        expect(sqlOf("mesh_outbox")).toMatch(/`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL/);
        expect(sqlOf("mesh_outbox_state")).toMatch(/`deleted_through` integer NOT NULL/);
      } finally { probe.close(); }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

for (const kind of ["memory", "file"] as const) {
  describe(`outbox conformance, ${kind} database`, () => {
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const make = async () => {
      const scratch = kind === "file" ? mkdtempSync(join(tmpdir(), "mesh-outbox-")) : undefined;
      if (scratch) dirs.push(scratch);
      const layer = sqlite({ file: scratch ? join(scratch, "app.db") : ":memory:" });
      await createSchema(layer, tables);
      return layer;
    };
    const checks = outboxConformance(make, capabilities);
    test("the manifest declares gapless-positions, so its checks run beside the 8 every adapter passes", () => {
      expect(Object.keys(checks).filter((name) => name.startsWith("gapless-positions"))).toHaveLength(2);
      expect(Object.keys(checks)).toHaveLength(10);
      // never reusing a position is the spec's rule for every adapter, not part of gapless-positions
      const without = Object.keys(outboxConformance(make, { ...capabilities, capabilities: capabilities.capabilities.filter((c) => c !== "gapless-positions") }));
      expect(without).toHaveLength(8);
      expect(without).toContain("a delete that empties the outbox never lets a position be reused");
    });
    for (const [name, check] of Object.entries(checks)) test(name, check, 30_000);
  });
}

describe("data-sqlite's outbox", () => {
  let scratch: string;
  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "mesh-outbox-file-")); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  test("a read while another connection's transaction is open sees none of its rows", async () => {
    const file = join(scratch, "beside.db");
    const reader = sqlite({ file });
    const writer = sqlite({ file });
    try {
      await createSchema(reader, tables);
      await writer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let appended!: () => void;
      const inside = new Promise<void>((resolve) => { appended = resolve; });
      const open = writer.transaction(async (tx) => {
        await tx.appendEvent!(outboxRow(2));
        await tx.appendEvent!(outboxRow(3));
        appended();
        await held;
      });
      await inside;
      const during = await reader.readOutbox(0, 10);
      expect(during.rows.map((row) => row.position)).toEqual([1]);
      expect(during.highest).toBe(1);
      release();
      await open;
      const after = await reader.readOutbox(0, 10);
      expect(after.rows.map((row) => row.position)).toEqual([1, 2, 3]);
      expect(after.highest).toBe(3);
    } finally { await reader.close(); await writer.close(); }
  });

  test("a read on the same layer queues behind the running transaction and sees what it committed", async () => {
    const layer = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, tables);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let appended!: () => void;
      const inside = new Promise<void>((resolve) => { appended = resolve; });
      const open = layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(1)); appended(); await held; });
      await inside;
      let read = false;
      const reading = layer.readOutbox(0, 10).then((page) => { read = true; return page; });
      await Bun.sleep(20);
      expect(read).toBe(false);
      release();
      await open;
      expect((await reading).rows).toHaveLength(1);
    } finally { await layer.close(); }
  });

  test("core's tables are not reachable through data operations", async () => {
    const layer = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, tables);
      for (const name of ["mesh_outbox", "mesh_outbox_state", "mesh_handler_progress", "mesh_subscription_progress"]) {
        await expect(layer.transaction((tx) => tx.select(tables[name]!))).rejects.toThrow(`The table ${name} is Mesh's own`);
        await expect(layer.transaction((tx) => tx.insert(tables[name]!, { id: 1, deleted_through: 9 }))).rejects.toBeInstanceOf(FrameworkError);
      }
    } finally { await layer.close(); }
  });

  test("a database without the outbox tables says how to create them", async () => {
    const layer = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, { invoices: tables.invoices! });
      await expect(layer.readOutbox(0, 10)).rejects.toThrow("mesh db push");
      await expect(layer.transaction((tx) => tx.appendEvent!(outboxRow(1)))).rejects.toThrow("mesh db push");
    } finally { await layer.close(); }
  });

  test.each([[-1, 10], [1.5, 10], [0, 0], [0, -2], [Number.NaN, 1]])("readOutbox(%p, %p) is refused", async (after, limit) => {
    const layer = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, tables);
      await expect(layer.readOutbox(after, limit)).rejects.toBeInstanceOf(FrameworkError);
    } finally { await layer.close(); }
  });

  test("operations kept past their transaction refuse to append", async () => {
    const layer = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, tables);
      const kept = await layer.transaction(async (tx) => tx);
      await expect(kept.appendEvent!(outboxRow(1))).rejects.toThrow("no longer active");
      await expect(kept.deleteOutboxThrough!(0)).rejects.toThrow("no longer active");
    } finally { await layer.close(); }
  });
});
