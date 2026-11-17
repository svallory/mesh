// A rollup read where SQL is required (unit m10-rollups, PR 5; ruling D33, OD10): a read's declared filter, a declared
// sort key and a read policy may read `&rollup`, which the build lowers to a correlated subquery over the rollup's route.
// Its value is the one a load through `Mesh.privileged` gives (each row once, a filter applied), whatever the caller's
// read policies (R23, following m10-sql-translation's O7). The domain is built, generated, type-checked under the
// strictest flags and called against `:memory:` SQLite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { Mesh, type DataOperations } from "@meshfw/runtime";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const privilegedOf = (entity: unknown): any => Mesh.privileged(entity as never);

// A customer is read only while its biggest invoice is under 200: a read policy that reads a `max`.
const customer = `import { Invoice } from "./invoice.mesh.mx"
entity :Customer table="customers"
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :invoices entity=Invoice
  computed
    count :invoiceCount of=&invoices
    max :biggest of=&invoices.total
  actions auto=[:read]
    read :repeat filter=() => &invoiceCount > 1
  policies
    policy :small types=[:read]
      authorize-if=() => &biggest === null || &biggest < 200
`;
const invoice = `import { Customer } from "./customer.mesh.mx"
import { Line } from "./line.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    string :name
    integer :total
  relationships
    belongs-to :customer entity=Customer
    has-many :lines entity=Line
  computed
    count :lineCount of=&lines
    sum :amount of=&lines.amount
    avg :avgAmount of=&lines.amount
    count :openLines of=&lines filter=(line) => line.state === :open
    sum :catalogValue of=&lines.product.price
  actions auto=[:read]
    read :withLines filter=() => &lineCount > 0
    read :byAmount
      sort
        desc &amount
    read :busyOpen filter=() => &openLines >= 2
    read :pricey filter=() => &catalogValue > 15
    read :ofRepeat filter=() => &customer.invoiceCount > 1
    read :aboveAverage filter=() => &lines.some((l) => l.amount > &avgAmount)
  policies
    policy :anyone types=[:read]
      authorize-if=() => true
`;
// A line is shown unless it is hidden: a caller's load of a rollup leaves hidden lines out, a rollup in SQL does not.
const line = `import { Invoice } from "./invoice.mesh.mx"
import { Product } from "./product.mesh.mx"
entity :Line table="lines"
  attributes
    uuid :id primary-key
    enum :state values=[:open, :closed]
    integer :amount
    boolean :hidden
  relationships
    belongs-to :invoice entity=Invoice
    belongs-to :product entity=Product nullable
  actions auto=[:read]
  policies
    policy :shown types=[:read]
      authorize-if=() => &hidden === false
`;
const product = `import { Line } from "./line.mesh.mx"
entity :Product table="products"
  attributes
    uuid :id primary-key
    integer :price
  relationships
    has-many :lines entity=Line
  actions auto=[:read]
  policies
    policy :anyone types=[:read]
      authorize-if=() => true
`;

async function generate(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-reads-rollup-"));
  const data: ResolvedConfig["data"] = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: { file: ":memory:" } };
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data };
  await mkdir(join(dir, "src/domain"), { recursive: true });
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ customer, invoice, line, product }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  return dir;
}

let dir: string;
let app: any;
let domain: any;
beforeAll(async () => {
  dir = await generate();
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Customers ada (i1 total 50, i2 total 150), bo (i3, 300) and cy (i4, 100). i1 has l1 (open, 5, p1), l2 (open, 7, hidden,
 * p1) and l3 (closed, 11, p2); i2 has no line; i3 has l4 (open, 2, p1), l5 (open, 20, p2) and l6 (open, 4, p3); i4 has l7
 * (closed, 1, no product). Products p1 6, p2 5, p3 9. Rows go in out of key order, so row order is not key order.
 */
async function seed(tx: DataOperations) {
  await tx.insert(app.tables.customers, { id: id(2), name: "bo" });
  await tx.insert(app.tables.customers, { id: id(1), name: "ada" });
  await tx.insert(app.tables.customers, { id: id(3), name: "cy" });
  await tx.insert(app.tables.invoices, { id: id(13), name: "i3", total: 300, customerId: id(2) });
  await tx.insert(app.tables.invoices, { id: id(11), name: "i1", total: 50, customerId: id(1) });
  await tx.insert(app.tables.invoices, { id: id(14), name: "i4", total: 100, customerId: id(3) });
  await tx.insert(app.tables.invoices, { id: id(12), name: "i2", total: 150, customerId: id(1) });
  await tx.insert(app.tables.products, { id: id(31), price: 6 });
  await tx.insert(app.tables.products, { id: id(32), price: 5 });
  await tx.insert(app.tables.products, { id: id(33), price: 9 });
  const lines = [
    [21, 11, "open", 5, false, 31], [22, 11, "open", 7, true, 31], [23, 11, "closed", 11, false, 32],
    [24, 13, "open", 2, false, 31], [25, 13, "open", 20, false, 32], [26, 13, "open", 4, false, 33], [27, 14, "closed", 1, false, null],
  ] as const;
  for (const [n, of, state, amount, hidden, productN] of lines)
    await tx.insert(app.tables.lines, { id: id(n), state, amount, hidden, invoiceId: id(of), productId: productN === null ? null : id(productN) });
}

async function seeded() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  await db.transaction(seed);
  return { db, binding: app.bind(db) };
}
const named = (rows: readonly { name: string }[]) => rows.map((row) => row.name);
const ROLLUPS = ["lineCount", "amount", "avgAmount", "openLines", "catalogValue"] as const;

describe("the generated files", () => {
  test("type-check under the strictest flags", async () => {
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", ...files,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
  }, 30_000);

  test("a read's filter holds a rollup node over the route, and its file resolves every table the route reaches", async () => {
    const expressions = await Bun.file(join(dir, ".mesh/domain/invoice.expressions.ts")).text();
    expect(expressions).toContain('kind: "rollup"');
    expect(expressions).not.toContain("arrives with SQL rollups");
    // The route of `catalogValue` reaches Product, which no other condition of the file reaches.
    const actions = await Bun.file(join(dir, ".mesh/domain/invoice.actions.ts")).text();
    expect(actions.match(/const \$tableOf[^\n]*\n?[^;]*;/)?.[0]).toContain("Product: tables.products");
  });
});

describe("a rollup in a read's filter and sort gives the value a privileged load gives", () => {
  test("each read keeps and orders the rows the loaded values say", async () => {
    const { db, binding } = await seeded();
    try {
      const loaded = await binding.run(() => privilegedOf(domain.Invoice).read({ sort: ["name"], load: ROLLUPS }));
      expect(loaded.map((row: Record<string, unknown>) => [row.name, ...ROLLUPS.map((name) => row[name])])).toEqual([
        // i1: p1 is reached by l1 and l2 and counts once (6 + 5), and the hidden l2 counts: no read policy runs.
        ["i1", 3, 23, 23 / 3, 2, 11],
        ["i2", 0, null, null, 0, null],
        ["i3", 3, 26, 26 / 3, 3, 20],
        ["i4", 1, 1, 1, 0, null],
      ]);
      const read = async (name: string) => named(await binding.run(() => domain.Invoice[name]({}, {})));
      const kept = (keep: (row: Record<string, any>) => boolean) => loaded.filter(keep).map((row: { name: string }) => row.name);
      expect(await read("withLines")).toEqual(kept((row) => row.lineCount > 0));
      expect(await read("withLines")).toEqual(["i1", "i3", "i4"]);
      // Under each row once, i1's catalog value is 11, not the 17 a sum over both lines of p1 would give.
      expect(await read("pricey")).toEqual(["i3"]);
      expect(await read("busyOpen")).toEqual(kept((row) => row.openLines >= 2));
      expect(await read("busyOpen")).toEqual(["i1", "i3"]);
      // The outer row's rollup inside a quantifier over its own lines: l3 (11) is over i1's average, l5 (20) over i3's.
      expect(await read("aboveAverage")).toEqual(["i1", "i3"]);
      // Descending, the null sum (no line) sorts last, as the smallest value.
      expect(await read("byAmount")).toEqual(["i3", "i1", "i4", "i2"]);
      // A rollup of the related record: ada has two invoices.
      expect(await read("ofRepeat")).toEqual(["i1", "i2"]);
      expect(named(await binding.run(() => privilegedOf(domain.Invoice).withLines({})))).toEqual(["i1", "i3", "i4"]);
    } finally { await db.close(); }
  });

  test("a caller's load leaves the hidden line out; the filter, run as SQL, counts it (R23)", async () => {
    const { db, binding } = await seeded();
    try {
      const rows = await binding.run(() => domain.Invoice.read({ sort: ["name"], load: ["openLines"] }, {}));
      expect(rows.map((row: { openLines: number }) => row.openLines)).toEqual([1, 0, 3, 0]);
      expect(named(await binding.run(() => domain.Invoice.busyOpen({}, {})))).toEqual(["i1", "i3"]);
    } finally { await db.close(); }
  });
});

describe("a read policy that reads a rollup", () => {
  test("is folded into the read's query: a customer whose biggest invoice is 200 or more is not read", async () => {
    const { db, binding } = await seeded();
    try {
      expect(named(await binding.run(() => domain.Customer.read({ sort: ["name"] }, {})))).toEqual(["ada", "cy"]);
      expect(named(await binding.run(() => privilegedOf(domain.Customer).read({ sort: ["name"] })))).toEqual(["ada", "bo", "cy"]);
      // Beside a declared filter over another rollup.
      expect(named(await binding.run(() => domain.Customer.repeat({}, {})))).toEqual(["ada"]);
      // A caller's load of the invoice's customer runs it too: bo's invoice i3 loads no customer.
      const invoices = await binding.run(() => domain.Invoice.read({ sort: ["name"], load: ["customer"] }, {}));
      expect(invoices.map((row: { customer: { name: string } | null }) => row.customer?.name ?? null)).toEqual(["ada", "ada", null, "cy"]);
    } finally { await db.close(); }
  });
});
