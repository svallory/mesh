// A rollup's `filter=(line) => ...` (unit m10-rollups, PR 4; ruling D33): the build lowers it to a condition literal in the
// owner's `$conditions`, the load plan reads it through a thunk, and the loader binds it with the load's clock and ANDs it
// into the last table of the route, beside a read policy's row condition. The domain is built, generated, type-checked
// under the strictest flags and called against `:memory:` SQLite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { Mesh, type DataOperations } from "@meshfw/runtime";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const privilegedOf = (entity: unknown): any => Mesh.privileged(entity as never);

const invoice = `import { Line } from "./line.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :lines entity=Line
  computed
    count :openLines of=&lines filter=(line) => line.state === :open
    count :allLines of=&lines
    sum :openTotal of=&lines.amount filter=(line) => line.state === :open
    max :lateDue of=&lines.dueOn filter=(line) => line.dueOn < %.now
    count :activeProducts of=&lines.product filter=(p) => p.active === true
    count :ofProduct of=&lines filter=(line) => line.productId !== null
  actions auto=[:read]
  policies
    policy :anyone types=[:read]
      authorize-if=() => true
`;
// A line is shown unless it is hidden: a read policy that reads the record, folded beside the filter on the same table.
const line = `import { Invoice } from "./invoice.mesh.mx"
import { Product } from "./product.mesh.mx"
entity :Line table="lines"
  attributes
    uuid :id primary-key
    enum :state values=[:open, :closed]
    integer :amount
    datetime :dueOn nullable
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
    boolean :active
  relationships
    has-many :lines entity=Line
  actions auto=[:read]
  policies
    policy :anyone types=[:read]
      authorize-if=() => true
`;

async function generate(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-rollup-filter-"));
  const data: ResolvedConfig["data"] = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: { file: ":memory:" } };
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data };
  await mkdir(join(dir, "src/domain"), { recursive: true });
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ invoice, line, product }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
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
const at = (iso: string) => new Date(iso);

/**
 * Invoice i1 has l1 (open, 5, due Jan, product p1 active), l2 (open, 7, due Mar, hidden, product p1), l3 (closed, 11, due
 * Feb, product p2 inactive) and l4 (open, 2, no due date, no product); invoice i2 has no line.
 */
async function seed(tx: DataOperations) {
  await tx.insert(app.tables.invoices, { id: id(1), name: "i1" });
  await tx.insert(app.tables.invoices, { id: id(2), name: "i2" });
  await tx.insert(app.tables.products, { id: id(21), active: true });
  await tx.insert(app.tables.products, { id: id(22), active: false });
  await tx.insert(app.tables.lines, { id: id(11), state: "open", amount: 5, dueOn: at("2026-01-10"), hidden: false, invoiceId: id(1), productId: id(21) });
  await tx.insert(app.tables.lines, { id: id(12), state: "open", amount: 7, dueOn: at("2026-03-10"), hidden: true, invoiceId: id(1), productId: id(21) });
  await tx.insert(app.tables.lines, { id: id(13), state: "closed", amount: 11, dueOn: at("2026-02-10"), hidden: false, invoiceId: id(1), productId: id(22) });
  await tx.insert(app.tables.lines, { id: id(14), state: "open", amount: 2, dueOn: null, hidden: false, invoiceId: id(1), productId: null });
}

async function seeded(clock?: () => Date) {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  await db.transaction(seed);
  return { db, binding: app.bind(db, clock ? { clock } : {}) };
}
const names = ["openLines", "allLines", "openTotal", "lateDue", "activeProducts", "ofProduct"] as const;

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

  test("the plan reads each filter when a load runs, never when it loads", async () => {
    const load = await Bun.file(join(dir, ".mesh/load.ts")).text();
    expect(load).toContain('filter: () => $Invoice$conditions["rollup.openLines.filter"]');
    expect(load).toContain('allLines: { kind: "rollup", fn: "count", of: ["lines"] }');
    // Enter the import cycle through the expressions file, then read a filter from the plan: no temporal dead zone.
    const script = `const e = await import(${JSON.stringify(join(dir, ".mesh/domain/invoice.expressions.ts"))});
const { loadPlan } = await import(${JSON.stringify(join(dir, ".mesh/load.ts"))});
console.log(Object.keys(e.$expressions).length, Object.keys(e.$conditions).join(","), loadPlan.Invoice.computed.openLines.filter().entity);`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: dir });
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString().trim())
      .toBe("1 rollup.openLines.filter,rollup.openTotal.filter,rollup.lateDue.filter,rollup.activeProducts.filter,rollup.ofProduct.filter Line");
  });
});

describe("a filtered rollup aggregates only the rows its filter keeps", () => {
  test("a privileged load: every row the filter keeps, over one has-many and over two hops", async () => {
    const { db, binding } = await seeded(() => at("2026-02-20"));
    try {
      const rows = await binding.run(() => privilegedOf(domain.Invoice).read({ sort: ["name"], load: names }));
      expect(rows.map((row: Record<string, unknown>) => names.map((name) => row[name]))).toEqual([
        // open: l1, l2, l4; due before Feb 20: l1 (Jan 10) and l3 (Feb 10); active products reached: p1 once; a product: l1-l3.
        [3, 4, 14, at("2026-02-10"), 1, 3],
        [0, 0, null, null, 0, 0],
      ]);
    } finally { await db.close(); }
  });

  test("%.now is the transaction's instant: a later clock keeps more rows", async () => {
    const { db, binding } = await seeded(() => at("2026-04-01"));
    try {
      const rows = await binding.run(() => privilegedOf(domain.Invoice).read({ sort: ["name"], load: ["lateDue"] }));
      expect(rows.map((row: { lateDue: unknown }) => row.lateDue)).toEqual([at("2026-03-10"), null]);
    } finally { await db.close(); }
  });

  test("a caller's load: the filter and the read policy of the rows both apply", async () => {
    const { db, binding } = await seeded(() => at("2026-04-01"));
    try {
      const rows = await binding.run(() => domain.Invoice.read({ sort: ["name"], load: names }, {}));
      // The hidden l2 is out for the caller: open l1 and l4; due before April: l1 and l3; p1 still reached through l1.
      expect(rows.map((row: Record<string, unknown>) => names.map((name) => row[name]))).toEqual([
        [2, 3, 7, at("2026-02-10"), 1, 2],
        [0, 0, null, null, 0, 0],
      ]);
    } finally { await db.close(); }
  });
});
