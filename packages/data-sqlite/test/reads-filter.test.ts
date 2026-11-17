// A read's own `filter` and `sort` run as SQL (M10): the build lowers them to condition literals, the generated read binds
// each (its parameters computed in memory on the read's scope) and hands SQLite `where` and `order`. The domain is built,
// generated, type-checked under the strictest flags and called against `:memory:` SQLite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, Mesh, type DataOperations } from "@meshfw/runtime";
import { callsOf } from "./calls.ts";
import { openPolicies } from "./open-policy.ts";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const privilegedOf = (entity: unknown): any => Mesh.privileged(entity as never);

const helpers = "export const limit = (n: number) => n * 2;\n// Typed as a number, returns a promise: `$.pure` refuses it when the filter is bound.\nexport const slow = (n: number): number => Promise.resolve(n) as unknown as number;\n";
const customer = `import { Invoice } from "./invoice.mesh.mx"
import { limit as cap } from "./helpers"
import { Mesh } from "meshfw"
entity :Customer table="customers"
  attributes
    uuid :id primary-key
    uuid :ownerId
    string :name
  relationships
    has-many :invoices entity=Invoice
  computed
    boolean :rich() { return &invoices.length >= cap(1) }
  actions auto=[:read]
    read :busy
      filter=() => &invoices.some((i) => i.total > 100)
    update :touch
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :owning actions=[&touch]
      authorize-if=async ({ context }) => (await Mesh.privileged(Invoice).owned({}, context)).length > 0
`;
const invoice = `import { Customer } from "./customer.mesh.mx"
import { Line } from "./line.mesh.mx"
import { slow, limit } from "./helpers"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    integer :total
    date :dueOn nullable
  relationships
    belongs-to :customer entity=Customer
    has-many :lines entity=Line
  computed
    boolean :isLate() { return &dueOn < %.today }
    string :label() { return &total + "!" }
  actions auto=[:read]
    read :forCustomer
      input
        uuid :customerId
      filter=({ input }) => &customer.id === input.customerId
      sort
        asc &dueOn
    read :late filter=() => &isLate
    read :owned
      filter=({ actor }) => &customer.ownerId === actor.id
      sort
        desc &total
    read :ofRich filter=() => &customer.rich
    read :byLate
      sort
        desc &isLate
        asc &total
    read :withBigLines filter=() => &lines.some((l) => l.qty > 2)
    read :stalled filter=() => &total > slow(1)
    read :cheapUndated filter=() => &total < (&dueOn === null ? limit(15) : 0)
    read :allSmallLines filter=() => &lines.every((l) => l.qty < 3)
    read :noHugeBigLine filter=() => &lines.filter((l) => l.qty > 2).every((l) => l.qty > 9)
    read :lateFirst
      sort
        desc &isLate
`;
const line = `import { Invoice } from "./invoice.mesh.mx"
entity :Line table="lines"
  attributes
    uuid :id primary-key
    integer :qty
  relationships
    belongs-to :invoice entity=Invoice
  actions auto=[:read]
`;

async function generate(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-reads-filter-"));
  const data: ResolvedConfig["data"] = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: { file: ":memory:" } };
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data };
  await mkdir(join(dir, "src/domain"), { recursive: true });
  await Bun.write(join(dir, "src/domain/helpers.ts"), helpers);
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies(Object.entries({ customer, invoice, line }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source }))) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string | null };\n  }\n}\nexport {};\n');
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
const day = (d: number) => new Date(Date.UTC(2026, 0, d));
const alice = { actor: { id: id(91) } };

/**
 * Three customers: c1 (owner 91) holds i1 (total 50, due Jan 3), i2 (150, Jan 1), i3 (20, no date); c2 (owner 92) holds
 * i4 (300, Jan 9); c3 (owner 93) holds i5 (100, Jan 9), inserted before i4 so that row order is not key order.
 */
async function seed(tx: DataOperations) {
  await tx.insert(app.tables.customers, { id: id(2), ownerId: id(92), name: "bo" });
  await tx.insert(app.tables.customers, { id: id(1), ownerId: id(91), name: "ada" });
  await tx.insert(app.tables.customers, { id: id(3), ownerId: id(93), name: "cy" });
  await tx.insert(app.tables.invoices, { id: id(15), total: 100, dueOn: day(9), customerId: id(3) });
  await tx.insert(app.tables.invoices, { id: id(13), total: 20, dueOn: null, customerId: id(1) });
  await tx.insert(app.tables.invoices, { id: id(14), total: 300, dueOn: day(9), customerId: id(2) });
  await tx.insert(app.tables.invoices, { id: id(11), total: 50, dueOn: day(3), customerId: id(1) });
  await tx.insert(app.tables.invoices, { id: id(12), total: 150, dueOn: day(1), customerId: id(1) });
  await tx.insert(app.tables.lines, { id: id(21), qty: 1, invoiceId: id(11) });
  await tx.insert(app.tables.lines, { id: id(22), qty: 5, invoiceId: id(14) });
}
/** A seeded `:memory:` database bound with a clock at Jan 5 2026. */
async function seeded() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  await db.transaction(seed);
  const binding = app.bind(db, { clock: () => day(5) });
  return { db, binding, mesh: callsOf(binding, domain) };
}
const totals = (rows: readonly { total: number }[]) => rows.map((row) => row.total);

describe("the generated files", () => {
  test("type-check under the strictest flags", async () => {
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "context.ts", ...files,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
  }, 30_000);

  test("a helper of another entity's inlined body is imported under that entity's local", async () => {
    const expressions = await Bun.file(join(dir, ".mesh/domain/invoice.expressions.ts")).text();
    expect(expressions).toContain('import { limit as $Customer$cap } from "../../src/domain/helpers";');
    expect(expressions).toContain('$.pure($Customer$cap(1), "cap")');
  });
});

describe("a read's own filter and sort", () => {
  test("a filter with a parameter, combined with the caller's filter, sort and paging (the caller's keys first)", async () => {
    const { db, mesh } = await seeded();
    try {
      expect(totals(await mesh.forCustomerInvoice({ customerId: id(1) }, alice))).toEqual([20, 150, 50]);
      expect(totals(await mesh.forCustomerInvoice({ customerId: id(1), filter: { total: { gte: 50 } } }, alice))).toEqual([150, 50]);
      expect(totals(await mesh.forCustomerInvoice({ customerId: id(1), sort: ["-total"] }, alice))).toEqual([150, 50, 20]);
      expect(totals(await mesh.forCustomerInvoice({ customerId: id(1), limit: 1, offset: 1 }, alice))).toEqual([150]);
      expect(await mesh.forCustomerInvoice({ customerId: id(4) }, alice)).toEqual([]);
    } finally { await db.close(); }
  });

  test("`%.today` in an inlined computed field reads the read's instant", async () => {
    const { db, mesh } = await seeded();
    try {
      // Jan 5: i2 (Jan 1) and i1 (Jan 3) are late; i3 has no date (unknown leaves the row out); i4 is due Jan 9.
      expect(totals(await mesh.lateInvoice({}, alice)).sort()).toEqual([150, 50].sort());
    } finally { await db.close(); }
  });

  test("a filter reads the actor and a related record; an unknown comparison leaves every row out", async () => {
    const { db, mesh } = await seeded();
    try {
      expect(totals(await mesh.ownedInvoice({}, alice))).toEqual([150, 50, 20]);
      expect(totals(await mesh.ownedInvoice({}, { actor: { id: id(92) } }))).toEqual([300]);
      expect(await mesh.ownedInvoice({}, { actor: { id: null } })).toEqual([]);
    } finally { await db.close(); }
  });

  test("`Mesh.privileged` runs the read's filter and sort", async () => {
    const { db, binding } = await seeded();
    try {
      expect(totals(await binding.run(() => privilegedOf(domain.Invoice).owned({}, alice)))).toEqual([150, 50, 20]);
      expect(totals(await binding.run(() => privilegedOf(domain.Invoice).forCustomer({ customerId: id(2) })))).toEqual([300]);
    } finally { await db.close(); }
  });

  test("a filter over a computed field of a related entity whose body calls that file's helper", async () => {
    const { db, mesh } = await seeded();
    try {
      // `rich`: two invoices or more (`cap(1)` is 2): c1 only.
      expect(totals(await mesh.ofRichInvoice({}, alice)).sort()).toEqual([150, 20, 50].sort());
    } finally { await db.close(); }
  });

  test("a computed sort key orders by its SQL value, nulls as the smallest, then the next key", async () => {
    const { db, mesh } = await seeded();
    try {
      // desc &isLate: true (i2, i1), false (i4, i5), unknown (i3); then asc &total within each.
      expect(totals(await mesh.byLateInvoice({}, alice))).toEqual([50, 150, 100, 300, 20]);
    } finally { await db.close(); }
  });

  test("quantifiers over a has-many, from either side", async () => {
    const { db, mesh } = await seeded();
    try {
      expect(totals(await mesh.withBigLinesInvoice({}, alice))).toEqual([300]);
      // c3's one invoice totals 100, which is not over 100: it is left out.
      expect((await mesh.busyCustomer({}, alice)).map((c: { name: string }) => c.name).sort()).toEqual(["ada", "bo"]);
      // `every` holds over no rows: i2, i3 and i5 have no line; i1's one line has qty 1; i4's has 5.
      expect(totals(await mesh.allSmallLinesInvoice({}, alice)).sort()).toEqual([20, 50, 100, 150].sort());
      // `filter(p).every(q)`: only i4 keeps a line (qty 5), and it is not over 9.
      expect(totals(await mesh.noHugeBigLineInvoice({}, alice)).sort()).toEqual([20, 50, 100, 150].sort());
    } finally { await db.close(); }
  });

  test("a declared sort's ties are broken by the primary key", async () => {
    const { db, mesh } = await seeded();
    try {
      // desc &isLate: true (i1, i2 by key), false (i4 before i5 by key, though i5 was inserted first), unknown (i3).
      expect(totals(await mesh.lateFirstInvoice({}, alice))).toEqual([50, 150, 300, 100, 20]);
    } finally { await db.close(); }
  });

  test("a ternary's helper branch takes the class of the column it is compared with", async () => {
    const { db, mesh } = await seeded();
    try {
      // `limit(15)` is 30, for the undated invoices only: i3 (20).
      expect(totals(await mesh.cheapUndatedInvoice({}, alice))).toEqual([20]);
    } finally { await db.close(); }
  });

  test("a filtered read inside a question runs on the question's layer, which carries the layer's capabilities", async () => {
    const { db, binding } = await seeded();
    try {
      // `policy :owning` reads `Invoice.owned` through `Mesh.privileged`: asked, it runs on the question's probe layer.
      expect(await binding.run(() => Mesh.can(domain.Customer.touch, { id: id(1) }, alice as never))).toBe(true);
      expect(await binding.run(() => Mesh.can(domain.Customer.touch, { id: id(1) }, { actor: { id: id(99) } } as never))).toBe(false);
    } finally { await db.close(); }
  });

  test("a filter whose helper returns a promise fails naming the helper, before any query", async () => {
    const { db, mesh } = await seeded();
    try {
      const error = await mesh.stalledInvoice({}, alice).then(() => undefined, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(FrameworkError);
      expect(String((error as Error).message)).toContain("slow");
    } finally { await db.close(); }
  });
});
