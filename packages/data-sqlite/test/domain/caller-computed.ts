// A caller's `filter` and `sort` by a computed field (M10, ruling D32 O6 (a)): a field whose body translates runs as SQL,
// its body inlined into the query by `callerQuery`; a field Mesh runs in memory and a rollup are refused before any query.
// The domain is built, generated, type-checked under the strictest flags and called against `:memory:` SQLite, and every
// answer is checked against the value the same field has when it is loaded. data-postgres runs the same suite, so the null
// order and the code-point string order of ruling O4 (a) are checked on both databases.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, Mesh, type DataOperations } from "@meshfw/runtime";
import { callsOf } from "../calls.ts";
import { openPolicies } from "../open-policy.ts";
import { SCRATCH, TSC, type DomainAdapter } from "./harness.ts";

const privilegedOf = (entity: unknown): any => Mesh.privileged(entity as never);

const customer = `import { Invoice } from "./invoice.mesh.mx"
entity :Customer table="customers"
  attributes
    uuid :id primary-key
    uuid :ownerId
    string :name
  relationships
    has-many :invoices entity=Invoice
  actions auto=[:read]
`;
const invoice = `import { Customer } from "./customer.mesh.mx"
import { Line } from "./line.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    integer :total
    date :dueOn nullable
  relationships
    belongs-to :customer entity=Customer
    has-many :lines entity=Line
  computed
    integer :doubled() { return &total * 2 }
    boolean :isLate() { return &dueOn < %.today }
    boolean :lateAndBig() { return &isLate && &total > 100 }
    string :owner() { return &customer.name }
    boolean :hasBigLine() { return &lines.some((l) => l.qty > 2) }
    enum :size values=[:small, :large] value=() => &total >= 100 ? :large : :small
    string :label() { return &total + "!" }
    count :lineCount of=&lines
  actions auto=[:read]
    read :big filter=() => &total >= 100
    read :byDue
      sort
        asc &dueOn
  policies
    policy :mine types=[:read]
      authorize-if=({ actor }) => &customer.ownerId === actor.id
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

/** The caller-computed suite on `adapter`: the generated reads of one domain, called against a fresh layer per test. */
export function callerComputedSuite(adapter: DomainAdapter): void {
  async function generate(sources: Record<string, string> = { customer, invoice, line }): Promise<string> {
    const dir = await mkdtemp(join(SCRATCH, ".scratch-caller-computed-"));
    const data = adapter.data(["aggregates", "conditions", "joins"]);
    const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data };
    await mkdir(join(dir, "src/domain"), { recursive: true });
    const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies(Object.entries(sources).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source }))) });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, adapter.build), config);
    await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'test', transaction: async () => undefined, close: async () => undefined } };\n");
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
  const bo = { actor: { id: id(92) } };

  /**
   * Customers ada (owner 91) and bo (owner 92). ada holds i1 (50, due Jan 3), i2 (150, Jan 1), i3 (20, no date); bo holds
   * i4 (300, Jan 9). Lines: i1 has qty 1, i4 qty 5. The clock reads Jan 5, so i1 and i2 are late, i3's lateness is unknown.
   */
  async function seedOn(app: any, tx: DataOperations) {
    await tx.insert(app.tables.customers, { id: id(1), ownerId: id(91), name: "ada" });
    await tx.insert(app.tables.customers, { id: id(2), ownerId: id(92), name: "bo" });
    await tx.insert(app.tables.invoices, { id: id(13), total: 20, dueOn: null, customerId: id(1) });
    await tx.insert(app.tables.invoices, { id: id(14), total: 300, dueOn: day(9), customerId: id(2) });
    await tx.insert(app.tables.invoices, { id: id(11), total: 50, dueOn: day(3), customerId: id(1) });
    await tx.insert(app.tables.invoices, { id: id(12), total: 150, dueOn: day(1), customerId: id(1) });
    await tx.insert(app.tables.lines, { id: id(21), qty: 1, invoiceId: id(11) });
    await tx.insert(app.tables.lines, { id: id(22), qty: 5, invoiceId: id(14) });
  }
  async function seeded(on: { app: any; domain: any } = { app, domain }) {
    const db = await adapter.layer(on.app.tables);
    await db.transaction((tx) => seedOn(on.app, tx));
    const binding = on.app.bind(db, { clock: () => day(5) });
    return { db, binding, mesh: callsOf(binding, on.domain) };
  }
  const totals = (rows: readonly { total: number }[]) => rows.map((row) => row.total);
  /** Every invoice, privileged, sorted by total, with `names` loaded: what each computed field is, for the reads to agree with. */
  async function loaded(binding: any, names: readonly string[]) {
    return binding.run(() => privilegedOf(domain.Invoice).read({ sort: ["total"], load: names }));
  }

  describe("the generated files", () => {
    test("type-check under the strictest flags", async () => {
      const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
      const child = Bun.spawnSync([
        TSC, "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
        "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
        "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "context.ts", ...files,
      ], { cwd: dir });
      expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    }, 30_000);

    test("each translated computed field has a literal; the plain one and the rollup are refused by name", async () => {
      const actions = await Bun.file(join(dir, ".mesh/domain/invoice.actions.ts")).text();
      expect(actions).toContain('label: "plain"');
      expect(actions).toContain('lineCount: "rollup"');
      expect(actions).toContain('doubled: { class: "integer", literal: () => $conditions["computed.doubled"] }');
      expect(actions).toContain('size: { class: "string", literal: () => $conditions["computed.size"] }');
      // An entity with no computed field is unchanged: no caller map, no scope.
      const lines = await Bun.file(join(dir, ".mesh/domain/line.actions.ts")).text();
      expect(lines).not.toContain("callerQuery");
    });
  });

  describe("a caller's filter by a translated computed field", () => {
    test("gives the rows the loaded value picks, for each kind of body", async () => {
      const { db, binding } = await seeded();
      try {
        const all = await loaded(binding, ["doubled", "isLate", "lateAndBig", "owner", "hasBigLine", "size"]);
        const picked = (name: string, value: unknown) => all.filter((row: any) => row[name] === value).map((row: any) => row.total);
        const read = async (filter: unknown) => totals(await binding.run(() => privilegedOf(domain.Invoice).read({ filter, sort: ["total"] })));
        // arithmetic
        expect(await read({ doubled: { gt: 100 } })).toEqual([150, 300]);
        expect(await read({ doubled: { in: [40, 600] } })).toEqual([20, 300]);
        // %.today, at the read's instant; an unknown result (no date) leaves the row out of both answers
        expect(await read({ isLate: { eq: true } })).toEqual(picked("isLate", true));
        expect(await read({ isLate: { eq: false } })).toEqual([300]);
        expect(await read({ isLate: { eq: null } })).toEqual(picked("isLate", null));
        // a body that reads another computed field
        expect(await read({ lateAndBig: { eq: true } })).toEqual(picked("lateAndBig", true));
        // through a belongs-to and a has-many
        expect(await read({ owner: { eq: "bo" } })).toEqual(picked("owner", "bo"));
        expect(await read({ owner: { gte: "b" } })).toEqual([300]);
        expect(await read({ hasBigLine: { eq: true } })).toEqual(picked("hasBigLine", true));
        expect(await read({ hasBigLine: { ne: true } })).toEqual(picked("hasBigLine", false));
        // an enum
        expect(await read({ size: { eq: "large" } })).toEqual(picked("size", "large"));
        expect(await read({ size: { nil: false } })).toEqual([20, 50, 150, 300]);
        expect(await read({ size: { in: [] } })).toEqual([]);
      } finally { await db.close(); }
    });

    test("combines with stored columns under and/or, with the read's own filter, and with paging", async () => {
      const { db, binding } = await seeded();
      try {
        const read = async (input: Record<string, unknown>, name = "read") => totals(await binding.run(() => privilegedOf(domain.Invoice)[name](input)));
        expect(await read({ filter: { or: [{ total: { lt: 30 } }, { hasBigLine: { eq: true } }] }, sort: ["total"] })).toEqual([20, 300]);
        expect(await read({ filter: { and: [{ customerId: { eq: id(1) } }, { isLate: { eq: true } }] }, sort: ["-total"] })).toEqual([150, 50]);
        expect(await read({ filter: { dueOn: { nil: true }, doubled: { lt: 100 } } })).toEqual([20]);
        // the read's own filter (total >= 100) and the caller's both hold
        expect(await read({ filter: { isLate: { eq: true } } }, "big")).toEqual([150]);
        expect(await read({ filter: { doubled: { gt: 0 } }, sort: ["total"], limit: 2, offset: 1 })).toEqual([50, 150]);
      } finally { await db.close(); }
    });

    test("with load, the rows and the loaded values agree with the filter and the sort", async () => {
      const { db, mesh } = await seeded();
      try {
        const rows = await mesh.readInvoice({ filter: { doubled: { gt: 0 }, isLate: { eq: true } }, sort: ["-doubled"], load: ["owner", "doubled", "isLate", "customer"] }, alice);
        expect(rows.map((row: any) => [row.total, row.doubled, row.isLate, row.owner, row.customer?.name])).toEqual([[150, 300, true, "ada", "ada"], [50, 100, true, "ada", "ada"]]);
        const sized = await mesh.readInvoice({ filter: { size: { eq: "small" } }, sort: ["owner", "-total"], load: ["size", "owner"] }, alice);
        expect(sized.map((row: any) => [row.total, row.size, row.owner])).toEqual([[50, "small", "ada"], [20, "small", "ada"]]);
      } finally { await db.close(); }
    });

    test("under a read policy that reads the record, only the admitted rows; Mesh.privileged runs no policy", async () => {
      const { db, mesh, binding } = await seeded();
      try {
        expect(totals(await mesh.readInvoice({ filter: { size: { eq: "large" } }, sort: ["total"] }, alice))).toEqual([150]);
        expect(totals(await mesh.readInvoice({ filter: { size: { eq: "large" } } }, bo))).toEqual([300]);
        expect(totals(await mesh.readInvoice({ filter: { owner: { eq: "bo" } } }, alice))).toEqual([]);
        expect(totals(await binding.run(() => privilegedOf(domain.Invoice).read({ filter: { size: { eq: "large" } }, sort: ["total"] })))).toEqual([150, 300]);
      } finally { await db.close(); }
    });
  });

  describe("the generated modules", () => {
    test("a read by a translated field works when the expressions file is imported before the actions file", async () => {
      const fresh = await generate();
      try {
        // A fresh directory is a fresh module graph: the expressions file is evaluated first, so the actions file it
        // imports finishes before it; the caller-computed literals must still be read only when a read runs.
        await import(join(fresh, ".mesh/domain/invoice.expressions.ts"));
        const on = { app: await import(join(fresh, ".mesh/index.ts")), domain: await import(join(fresh, ".mesh/domain/index.ts")) };
        const { db, binding } = await seeded(on);
        try {
          expect(totals(await binding.run(() => privilegedOf(on.domain.Invoice).read({ filter: { doubled: { gt: 100 } }, sort: ["-size", "total"] })))).toEqual([150, 300]);
        } finally { await db.close(); }
      } finally { await rm(fresh, { recursive: true, force: true }); }
    }, 30_000);
  });

  describe("a body that reaches an entity the caller may not read (ruling O7 (a))", () => {
    test("the inlined SQL still reads the related row, as the loaded body does; the loaded relationship is denied", async () => {
      const closed = customer.replace("  actions auto=[:read]\n", "  actions auto=[:read]\n  policies\n    policy :nobody types=[:read]\n      authorize-if=() => false\n");
      expect(closed).not.toBe(customer);
      const fresh = await generate({ customer: closed, invoice, line });
      try {
        const on = { app: await import(join(fresh, ".mesh/index.ts")), domain: await import(join(fresh, ".mesh/domain/index.ts")) };
        const { db, mesh } = await seeded(on);
        try {
          expect(await mesh.readCustomer({}, alice)).toEqual([]);
          expect(totals(await mesh.readInvoice({ filter: { owner: { eq: "ada" } }, sort: ["total"] }, alice))).toEqual([20, 50, 150]);
          expect(totals(await mesh.readInvoice({ sort: ["-owner", "total"] }, alice))).toEqual([20, 50, 150]);
          const rows = await mesh.readInvoice({ filter: { owner: { eq: "ada" } }, sort: ["total"], load: ["owner", "customer"] }, alice);
          expect(rows.map((row: any) => [row.total, row.owner, row.customer])).toEqual([[20, "ada", null], [50, "ada", null], [150, "ada", null]]);
        } finally { await db.close(); }
      } finally { await rm(fresh, { recursive: true, force: true }); }
    }, 30_000);
  });

  describe("a caller's sort by a translated computed field", () => {
    test("orders by the body, ties in primary-key order, with paging", async () => {
      const { db, binding } = await seeded();
      try {
        const read = async (input: Record<string, unknown>, name = "read") => totals(await binding.run(() => privilegedOf(domain.Invoice)[name](input)));
        expect(await read({ sort: ["-doubled"] })).toEqual([300, 150, 50, 20]);
        // size descending: "small" (i1 50, i3 20) before "large" (i2 150, i4 300); ties in key order, i1 < i3 and i2 < i4
        expect(await read({ sort: ["-size"] })).toEqual([50, 20, 150, 300]);
        expect(await read({ sort: ["size", "-total"] })).toEqual([300, 150, 50, 20]);
        expect(await read({ sort: ["owner", "total"], limit: 3 })).toEqual([20, 50, 150]);
        // nulls are the smallest value: i3's unknown lateness first ascending
        expect(await read({ sort: ["isLate", "total"] })).toEqual([20, 300, 50, 150]);
        // the caller's computed key first, then the read's declared `asc &dueOn`
        expect(await read({ sort: ["-hasBigLine"] }, "byDue")).toEqual([300, 20, 150, 50]);
        expect(await read({}, "byDue")).toEqual([20, 150, 50, 300]);
      } finally { await db.close(); }
    });
  });

  describe("what a caller cannot name", () => {
    test("a computed field Mesh runs in memory and a rollup are refused before any query", async () => {
      const { db, mesh } = await seeded();
      try {
        const plain = "A filter by Invoice#label is not available: label is a computed field Mesh runs in memory";
        await expect(mesh.readInvoice({ filter: { label: { eq: "50!" } } }, alice)).rejects.toThrow(plain);
        await expect(mesh.readInvoice({ filter: { or: [{ doubled: { eq: 1 } }, { label: { eq: "50!" } }] } }, alice)).rejects.toThrow(FrameworkError);
        await expect(mesh.readInvoice({ sort: ["label"] }, alice)).rejects.toThrow("A sort by Invoice#label is not available: label is a computed field Mesh runs in memory");
        await expect(mesh.readInvoice({ filter: { lineCount: { gt: 0 } } }, alice)).rejects.toThrow("A filter by Invoice#lineCount is not available: lineCount is a rollup, which a caller's filter and sort cannot name; a read's own filter= and sort can");
        await expect(mesh.readInvoice({ sort: ["-lineCount"] }, alice)).rejects.toThrow("A sort by Invoice#lineCount is not available: lineCount is a rollup");
        // left out as undefined, they are no comparison
        expect(totals(await mesh.readInvoice({ filter: { label: undefined, lineCount: undefined, total: { eq: 50 } } }, alice))).toEqual([50]);
      } finally { await db.close(); }
    });
  });
}
