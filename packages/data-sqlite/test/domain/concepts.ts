// Concept-typed members end to end (concepts design, sections 5 and 7; ruling D36, ADR-0092): a concept member is stored
// as one JSON value, checked on the way in by the concept's generated schema, and read back as the object. data-sqlite
// runs this suite on an in-memory database, data-postgres on a schema of its own.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { InvalidInputError, type DataLayer, type TableHandle } from "@meshfw/runtime";
import { callsOf } from "../calls.ts";
import { openPolicies } from "../open-policy.ts";
import { SCRATCH, TSC, type DomainAdapter } from "./harness.ts";

const FILES: Record<string, string> = {
  "src/domain/concepts/Money.mesh.mx": "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n",
  "src/domain/billing/concepts/Status.mesh.mx": "concept :Status\n  enum :state values=[:open, :closed]\n  Money :fee nullable\n",
  "src/domain/billing/invoice.mesh.mx": `entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    Money :total
    Money :refund nullable
    Status :status
  actions auto=[:read]
    create :open
      input
        &total
        &refund
        &status
    update :retotal
      input
        &total
    update :close
      do
        set
          &status={ state: :closed, fee: { currency: "EUR", amount: 5 } }
          &refund=null
`,
};

const CLI = resolve(import.meta.dir, "../../../cli");
let dialectBuilt = false;
/** `meshfw`'s `dist/dialect.js` carries the concept hook MX runs; build it once per test process. */
function buildDialect(): void {
  if (dialectBuilt) return;
  const built = Bun.spawnSync(["bun", "run", "build"], { cwd: CLI, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`meshfw build failed: ${built.stdout}${built.stderr}`);
  dialectBuilt = true;
}

export function conceptsSuite(adapter: DomainAdapter): void {
  let dir: string;
  let tables: Record<string, TableHandle>;
  beforeAll(async () => {
    buildDialect();
    // On disk, with a package.json that depends on `meshfw`: MX finds concept files by scanning `concepts` folders.
    dir = mkdtempSync(join(SCRATCH, ".scratch-concepts-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "concepts", private: true, type: "module", dependencies: { meshfw: "*" } }));
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(CLI, join(dir, "node_modules/meshfw"), "dir");
    const files = openPolicies(Object.entries(FILES).map(([file, source]) => ({ file, source })));
    for (const { file, source } of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), source);
    }
    const config: ResolvedConfig = {
      root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
      data: adapter.data([]),
    };
    const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files });
    expect(built.diagnostics).toEqual([]);
    await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, adapter.build), config);
    ({ tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> });
  }, 60_000);
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const app = async () => {
    const { bind } = await import(join(dir, ".mesh/index.ts")) as { bind: (layer: DataLayer) => any };
    const db = await adapter.layer(tables);
    return { db, calls: callsOf(bind(db), await import(join(dir, ".mesh/domain/index.ts"))) };
  };
  const EUR = (amount: number) => ({ currency: "EUR", amount });

  test("the schema types the column with the concept's type, so Drizzle's row is the record", async () => {
    const schema = await Bun.file(join(dir, ".mesh/schema.ts")).text();
    expect(schema).toContain('import type { Money as $Money$concept } from "./domain/money.concept";');
    expect(schema).toContain('import type { Status as $billing$Status$concept } from "./domain/billing/status.concept";');
    await Bun.write(join(dir, "check.ts"), `import type { Invoice } from "./.mesh/domain/billing/invoice.types";
import { tables } from "./.mesh/schema";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const same: Equal<typeof tables.invoices.$inferSelect, Invoice> = true;
`);
    const result = Bun.spawnSync([TSC, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck",
      "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--types", "bun", join(dir, "check.ts")], { cwd: dir });
    expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  }, 30_000);

  test("a create stores the concept values and a read returns them as written; a nullable one round-trips null", async () => {
    const { db, calls } = await app();
    try {
      const status = { state: "open", fee: null };
      const opened = await calls.openInvoice({ total: EUR(1200), refund: null, status });
      expect(opened).toEqual({ id: opened.id, total: EUR(1200), refund: null, status });
      const withRefund = await calls.openInvoice({ total: EUR(1), refund: EUR(1), status: { state: "open", fee: EUR(2) } });
      expect(await calls.readInvoice({ sort: ["id"] })).toEqual([opened, withRefund].sort((a, b) => (a.id < b.id ? -1 : 1)));
      expect(withRefund.status.fee).toEqual(EUR(2));
    } finally { await db.close(); }
  });

  test("a value that breaks the concept is a validation issue on the concept's path, and nothing is written", async () => {
    const { db, calls } = await app();
    try {
      const failed = await calls.openInvoice({ total: { currency: "eur", amount: 1 }, status: { state: "open", fee: null } }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(InvalidInputError);
      expect((failed as InvalidInputError).issues.map((issue) => issue.path)).toEqual([["total", "currency"]]);
      const extra = await calls.openInvoice({ total: { ...EUR(1), note: "x" }, status: { state: "open", fee: null } }).catch((error: unknown) => error);
      expect(extra).toBeInstanceOf(InvalidInputError);
      const nested = await calls.openInvoice({ total: EUR(1), status: { state: "open", fee: { currency: "EUR", amount: -1 } } }).catch((error: unknown) => error);
      expect((nested as InvalidInputError).issues.map((issue) => issue.path)).toEqual([["status", "fee", "amount"]]);
      expect(await calls.readInvoice({})).toEqual([]);
    } finally { await db.close(); }
  });

  test("the stored value is never the caller's object: changing it after the create leaves the record as stored", async () => {
    const { db, calls } = await app();
    try {
      const total = EUR(10);
      const opened = await calls.openInvoice({ total, status: { state: "open", fee: null } });
      total.amount = 99;
      expect(opened.total).toEqual(EUR(10));
      expect((await calls.readInvoice({}))[0].total).toEqual(EUR(10));
    } finally { await db.close(); }
  });

  test("an update replaces the value whole, and a `set` literal with an enum field and a nested concept round-trips", async () => {
    const { db, calls } = await app();
    try {
      const opened = await calls.openInvoice({ total: EUR(10), refund: EUR(3), status: { state: "open", fee: null } });
      const retotaled = await calls.retotalInvoice({ id: opened.id, total: { currency: "USD", amount: 7 } });
      expect(retotaled.total).toEqual({ currency: "USD", amount: 7 });
      const closed = await calls.closeInvoice({ id: opened.id });
      expect(closed).toEqual({ id: opened.id, total: { currency: "USD", amount: 7 }, refund: null, status: { state: "closed", fee: EUR(5) } });
      expect(await calls.readInvoice({})).toEqual([closed]);
    } finally { await db.close(); }
  });

  test("a caller's filter or sort cannot name a concept member", async () => {
    const { db, calls } = await app();
    try {
      await expect(calls.readInvoice({ filter: { total: { nil: true } } })).rejects.toBeInstanceOf(InvalidInputError);
      await expect(calls.readInvoice({ sort: ["total"] })).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });
}
