// M10 rollups over one relationship: `sum`, `avg` and `min`, and any rollup over a belongs-to, load through the data
// layer's batched `rollup` (one call per rollup for every row, per 500 anchors), while `count` and `max` over one
// has-many keep their per-row calls. The domain is built, generated, pushed to the adapter's database and loaded through
// the generated reads, actions and load functions; data-postgres runs the same suite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { ForbiddenError, FrameworkError, InvalidInputError, Mesh, type DataLayer, type DataOperations, type RollupQuery } from "@meshfw/runtime";
import { callsOf } from "../calls.ts";
import { SCRATCH, type DomainAdapter } from "./harness.ts";

const customer = `import { Invoice } from "./invoice.mesh.mx"
entity :Customer table="customers"
  attributes
    uuid :id primary-key
    integer :rating
  relationships
    has-many :invoices entity=Invoice inverse=:customer
    has-many :referred entity=Invoice inverse=:referrer
  actions auto=[:read]
  policies
    policy :anyone
      authorize-if=() => true
`;
// A guest may not read lines: a caller's rollup over them is null, with no query.
const line = `import { Invoice } from "./invoice.mesh.mx"
entity :Line table="lines"
  attributes
    uuid :id primary-key
    decimal :amount
    integer :units nullable
    date :dueOn
  relationships
    belongs-to :invoice entity=Invoice
  actions auto=[:read]
    create :add
      input
        &amount
        &units
        &dueOn
        &invoice
  policies
    policy :readers types=[:read]
      authorize-if=({ actor }) => actor.id !== "guest"
    policy :writers types=[:create]
      authorize-if=() => true
`;
const invoice = `import { Customer } from "./customer.mesh.mx"
import { Line } from "./line.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    string :title
  relationships
    belongs-to :customer entity=Customer
    belongs-to :referrer entity=Customer nullable
    has-many :lines entity=Line
  computed
    sum :total of=&lines.amount
    avg :meanUnits of=&lines.units
    min :firstDue of=&lines.dueOn
    max :customerRating of=&customer.rating
    count :customerCount of=&customer
    min :referrerRating of=&referrer.rating
    count :lineCount of=&lines
  checks
    check :underHundred that=() => &total === null || &total <= 100 code="hundred" message="over a hundred"
    check :noTotalYet that=() => &total === null code="has_total" message="a new invoice has a total"
  actions auto=[:read]
    always types=[:create, :update]
      validate
        check :ceiling that=() => &total === null || &total <= 3000 code="ceiling" message="over the ceiling"
    create :open
      input
        &title
        &customer
      validate
        check :rated that=() => &customerRating === null || &customerRating > 0 code="rated" message="the customer is unrated"
        check &noTotalYet
    update :rename
      input
        &title
      validate
        check :underLimit that=() => &total === null || &total <= 1000 code="limit" message="over the limit"
    update :relabel
      input
        &title
      validate
        check &underHundred
  policies
    policy :anyone types=[:read, :create]
      authorize-if=() => true
    policy :small actions=[&rename]
      authorize-if=() => &total === null || &total < 2000
    policy :relabelers actions=[&relabel]
      authorize-if=() => true
`;

type Row = Record<string, any>;

export function rollupsSuite(adapter: DomainAdapter): void {
  let dir: string;
  let app: any;
  let domain: any;
  beforeAll(async () => {
    dir = await mkdtemp(join(SCRATCH, ".scratch-rollups-"));
    const config: ResolvedConfig = {
      root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
      data: adapter.data(["aggregates", "integer-key-fill", "conditions", "joins"]),
    };
    const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ customer, line, invoice }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, adapter.build), config);
    await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'test', transaction: async () => undefined, close: async () => undefined } };\n");
    domain = await import(join(dir, ".mesh/domain/index.ts"));
    app = { ...await import(join(dir, ".mesh/index.ts")), ...domain };
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  const member = { actor: { id: "member" } };
  const guest = { actor: { id: "guest" } };

  /** A transaction whose `rollup`, `count` and `max` calls are recorded. */
  function counted(tx: DataOperations) {
    const calls: string[] = [];
    const rollups: RollupQuery[] = [];
    return {
      calls, rollups,
      tx: {
        ...tx,
        rollup: (query: RollupQuery) => { calls.push(`rollup ${query.fn}`); rollups.push(query); return tx.rollup(query); },
        count: (...args: Parameters<DataOperations["count"]>) => { calls.push("count"); return tx.count(...args); },
        max: (...args: Parameters<DataOperations["max"]>) => { calls.push("max"); return tx.max(...args); },
      } as DataOperations,
    };
  }

  // Two invoices of Ada (rating 4), one of Bo (rating 2) referred by Ada. i1 has three lines, i2 one with no units, i3 none.
  async function seeded(): Promise<DataLayer> {
    const db = await adapter.layer(app.tables);
    await db.transaction(async (tx) => {
      const t = app.tables;
      await tx.insert(t.customers, { id: id(1), rating: 4 });
      await tx.insert(t.customers, { id: id(2), rating: 2 });
      await tx.insert(t.invoices, { id: id(11), title: "i1", customerId: id(1), referrerId: null });
      await tx.insert(t.invoices, { id: id(12), title: "i2", customerId: id(1), referrerId: null });
      await tx.insert(t.invoices, { id: id(13), title: "i3", customerId: id(2), referrerId: id(1) });
      await tx.insert(t.lines, { id: id(21), amount: 10.5, units: 1, dueOn: day(5), invoiceId: id(11) });
      await tx.insert(t.lines, { id: id(22), amount: 20.25, units: 2, dueOn: day(3), invoiceId: id(11) });
      await tx.insert(t.lines, { id: id(23), amount: 0.25, units: 2, dueOn: day(9), invoiceId: id(11) });
      await tx.insert(t.lines, { id: id(24), amount: 7, units: null, dueOn: day(1), invoiceId: id(12) });
    });
    return db;
  }
  const invoicesOf = (tx: DataOperations) => tx.select(app.tables.invoices, { sort: ["title"] });
  const ALL = ["total", "meanUnits", "firstDue", "customerRating", "customerCount", "referrerRating"];

  test("sum, avg, min over a has-many and max, count, min over a belongs-to: one rollup call each for every row", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const { tx: counting, calls } = counted(tx);
        const loaded = await app.loadInvoiceFields(counting, await invoicesOf(tx), ALL);
        expect(loaded.map((r: Row) => [r.title, r.total, r.meanUnits, r.firstDue, r.customerRating, r.customerCount, r.referrerRating])).toEqual([
          ["i1", 31, 5 / 3, day(3), 4, 1, null],
          ["i2", 7, null, day(1), 4, 1, null],
          ["i3", null, null, null, 2, 1, 4],
        ]);
        for (const row of loaded) expect(row.firstDue === null || row.firstDue instanceof Date).toBe(true);
        expect(typeof loaded[0].total).toBe("number");
        expect(typeof loaded[0].meanUnits).toBe("number");
        expect(calls.sort()).toEqual(["rollup avg", "rollup count", "rollup max", "rollup min", "rollup min", "rollup sum"]);
      });
    } finally { await db.close(); }
  });

  test("invoices that share a customer ask once for it, and a null referrer asks nothing", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const { tx: counting, rollups } = counted(tx);
        await app.loadInvoiceFields(counting, await invoicesOf(tx), ["customerRating", "referrerRating"]);
        expect(rollups.map((q) => [q.fn, q.anchor, [...q.anchors].sort()])).toEqual([["max", "id", [id(1), id(2)]], ["min", "id", [id(1)]]]);
      });
    } finally { await db.close(); }
  });

  test("count and max over one has-many keep one call per row", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const { tx: counting, calls } = counted(tx);
        const loaded = await app.loadInvoiceFields(counting, await invoicesOf(tx), ["lineCount"]);
        expect(loaded.map((r: Row) => r.lineCount)).toEqual([3, 1, 0]);
        expect(calls).toEqual(["count", "count", "count"]);
      });
    } finally { await db.close(); }
  });

  test("min uses lines the same call loaded; sum and avg still ask the database", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const { tx: counting, calls } = counted(tx);
        const loaded = await app.loadInvoiceFields(counting, await invoicesOf(tx), ["lines", "firstDue", "total", "meanUnits"]);
        expect(loaded.map((r: Row) => [r.firstDue, r.total, r.meanUnits])).toEqual([[day(3), 31, 5 / 3], [day(1), 7, null], [null, null, null]]);
        expect(calls.sort()).toEqual(["rollup avg", "rollup sum"]);
      });
    } finally { await db.close(); }
  });

  test("a customer key that points at no row is an error, as loading the customer is", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(app.tables.invoices, { id: id(14), title: "i4", customerId: id(99), referrerId: id(98) });
        const [dangling] = await tx.select(app.tables.invoices, { filter: { id: { eq: id(14) } } });
        await expect(app.loadInvoiceFields(tx, [dangling], ["customerRating"])).rejects.toThrow(FrameworkError);
        await expect(app.loadInvoiceFields(tx, [dangling], ["customerRating"])).rejects.toThrow(`\`max :customerRating of=&customer.rating\` on Invoice ${JSON.stringify(id(14))} reaches no Customer row: a key on its path points at a row that does not exist`);
        // A nullable referrer that points at nothing reaches nothing.
        expect((await app.loadInvoiceFields(tx, [dangling], ["referrerRating"]))[0].referrerRating).toBeNull();
      });
    } finally { await db.close(); }
  });

  test("a caller the lines' read policy denies gets null for every rollup over them; through privileged every value", async () => {
    const db = await seeded();
    try {
      const calls = callsOf(app.bind(db), domain);
      const asGuest = await calls.readInvoice({ sort: ["title"], load: ALL }, guest);
      expect(asGuest.map((r: Row) => [r.total, r.meanUnits, r.firstDue, r.customerRating])).toEqual([[null, null, null, 4], [null, null, null, 4], [null, null, null, 2]]);
      const asMember = await calls.readInvoice({ sort: ["title"], load: ALL }, member);
      expect(asMember.map((r: Row) => [r.total, r.firstDue])).toEqual([[31, day(3)], [7, day(1)], [null, null]]);
      const privileged = await calls.run(() => (Mesh.privileged(domain.Invoice as never) as any).read({ sort: ["title"], load: ["total"] }));
      expect(privileged.map((r: Row) => r.total)).toEqual([31, 7, null]);
    } finally { await db.close(); }
  });

  test("a create's check sees no customer rating yet: the new instance has no customer to start from", async () => {
    const db = await seeded();
    try {
      const calls = callsOf(app.bind(db), domain);
      await calls.run(() => db.transaction((tx) => tx.insert(app.tables.customers, { id: id(3), rating: 0 })));
      // Rating 0 fails `&customerRating > 0`, yet the create passes: on the new instance the rollup is null.
      const made = await calls.openInvoice({ title: "new", customer: id(3) }, member);
      expect(made.title).toBe("new");
    } finally { await db.close(); }
  });

  test("an update's check and its write policy read a sum, and Mesh.checkPolicies runs it through its read-only view", async () => {
    const db = await seeded();
    try {
      const calls = callsOf(app.bind(db), domain);
      // i1 totals 31: the check (at most 1000) and the policy (under 2000) both pass.
      expect((await calls.renameInvoice({ id: id(11), title: "i1b" }, member)).title).toBe("i1b");
      await calls.addLine({ amount: 1000, units: 1, dueOn: day(2), invoice: id(11) }, member);
      // 1031: the policy passes and the check fails.
      expect((await calls.run(() => Mesh.checkPolicies(domain.Invoice.rename, { id: id(11), title: "x" }, member as never))).allowed).toBe(true);
      const invalid = await calls.renameInvoice({ id: id(11), title: "x" }, member).catch((error: unknown) => error);
      expect(invalid).toBeInstanceOf(InvalidInputError);
      expect((invalid as InvalidInputError).issues.map((issue) => issue.code)).toEqual(["limit"]);
      await calls.addLine({ amount: 1000, units: 1, dueOn: day(2), invoice: id(11) }, member);
      // 2031: the policy denies, and Mesh.checkPolicies says so without writing.
      expect((await calls.run(() => Mesh.checkPolicies(domain.Invoice.rename, { id: id(11), title: "x" }, member as never))).allowed).toBe(false);
      await expect(calls.renameInvoice({ id: id(11), title: "x" }, member)).rejects.toBeInstanceOf(ForbiddenError);
    } finally { await db.close(); }
  });

  test("an always block and a named check read a batched sum on update, and see null on create", async () => {
    const db = await seeded();
    try {
      const calls = callsOf(app.bind(db), domain);
      // The create's named check `&noTotalYet` passes only if the new instance's sum is null (not 0, not undefined),
      // and the always block's `&total <= 3000` would fail on undefined.
      expect((await calls.openInvoice({ title: "fresh", customer: id(1) }, member)).title).toBe("fresh");
      // i1 totals 31: the named check (at most 100) and the always block (at most 3000) pass.
      expect((await calls.relabelInvoice({ id: id(11), title: "i1b" }, member)).title).toBe("i1b");
      await calls.addLine({ amount: 1000, units: 1, dueOn: day(2), invoice: id(11) }, member);
      // 1031: the named check fails, the always block passes.
      const named = await calls.relabelInvoice({ id: id(11), title: "x" }, member).catch((error: unknown) => error);
      expect(named).toBeInstanceOf(InvalidInputError);
      expect((named as InvalidInputError).issues.map((issue) => issue.code)).toEqual(["hundred"]);
      await calls.addLine({ amount: 2500, units: 1, dueOn: day(2), invoice: id(11) }, member);
      // 3531: the always block fails too, on every update.
      const always = await calls.relabelInvoice({ id: id(11), title: "x" }, member).catch((error: unknown) => error);
      expect(always).toBeInstanceOf(InvalidInputError);
      expect((always as InvalidInputError).issues.map((issue) => issue.code).sort()).toEqual(["ceiling", "hundred"]);
    } finally { await db.close(); }
  });

  // 1,001 inserts one by one take a few seconds on Postgres.
  test("1,001 invoices ask for a sum in three chunks of at most 500 anchors", async () => {
    const db = await adapter.layer(app.tables);
    try {
      await db.transaction(async (tx) => {
        const t = app.tables;
        await tx.insert(t.customers, { id: id(1), rating: 4 });
        for (let n = 0; n < 1001; n++) await tx.insert(t.invoices, { id: id(100000 + n), title: `n${n}`, customerId: id(1), referrerId: null });
        await tx.insert(t.lines, { id: id(21), amount: 5, units: 1, dueOn: day(5), invoiceId: id(100000) });
        await tx.insert(t.lines, { id: id(22), amount: 6, units: 1, dueOn: day(5), invoiceId: id(101000) });
        const { tx: counting, rollups } = counted(tx);
        const loaded = await app.loadInvoiceFields(counting, await tx.select(t.invoices, {}), ["total"]);
        expect(rollups.map((q) => q.anchors.length)).toEqual([500, 500, 1]);
        const totals = new Map(loaded.map((r: Row) => [r.id, r.total]));
        expect(totals.get(id(100000))).toBe(5);
        expect(totals.get(id(101000))).toBe(6);
        expect(loaded.filter((r: Row) => r.total !== null)).toHaveLength(2);
      });
    } finally { await db.close(); }
    }, 60_000);

  test("a stored invoice with no customer key is an error, as loading its required customer is", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const [stored] = await invoicesOf(tx);
        // The column is NOT NULL in the database, so the row comes from a load that bypassed it.
        const keyless = { ...stored, customerId: null };
        await expect(app.loadInvoiceFields(tx, [keyless], ["customerRating"])).rejects.toThrow(FrameworkError);
        await expect(app.loadInvoiceFields(tx, [keyless], ["customerRating"])).rejects.toThrow("has no key in customerId, and it is not nullable");
      });
    } finally { await db.close(); }
  });

  test("the generated new-instance scope types a rollup over the customer as possibly null", async () => {
    const source = await Bun.file(join(dir, ".mesh/domain/invoice.expressions.ts")).text();
    const scope = source.slice(source.indexOf("export type $Invoice$NewScope"));
    expect(scope.slice(0, scope.indexOf("};"))).toMatch(/\[K in [^\]]*"customerRating"[^\]]*\]: \$Invoice\$Loaded\[K\] \| null;/);
  });
}
