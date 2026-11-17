// M10 rollups over a joined route: a path through several relationships or a has-many through a link entity. Each is
// one `rollup` call with hops for every row, each row the path reaches counted once per owner row. The domain is built,
// generated, pushed to the adapter's database and loaded through the generated reads, actions and load functions;
// data-postgres runs the same suite.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, InvalidInputError, Mesh, type DataLayer, type DataOperations, type RollupQuery } from "@meshfw/runtime";
import { callsOf } from "../calls.ts";
import { SCRATCH, type DomainAdapter } from "./harness.ts";

const anyone = `  policies
    policy :anyone
      authorize-if=() => true
`;
const customer = `import { Invoice } from "./invoice.mesh.mx"
entity :Customer table="customers"
  attributes
    uuid :id primary-key
    integer :rating
  relationships
    has-many :invoices entity=Invoice
  actions auto=[:read]
${anyone}`;
// A guest may not read products: a caller's rollup whose path reaches them is null, with no query.
const product = `import { Line } from "./line.mesh.mx"
entity :Product table="products"
  attributes
    uuid :id primary-key
    integer :price
  relationships
    has-many :lines entity=Line
  actions auto=[:read]
  policies
    policy :members
      authorize-if=({ actor }) => actor.id !== "guest"
`;
const line = `import { Invoice } from "./invoice.mesh.mx"
import { Product } from "./product.mesh.mx"
entity :Line table="lines"
  attributes
    uuid :id primary-key
    integer :amount
  relationships
    belongs-to :invoice entity=Invoice
    belongs-to :product entity=Product
  computed
    max :customerRating of=&invoice.customer.rating
  actions auto=[:read]
    create :add
      input
        &amount
        &invoice
        &product
${anyone}`;
const invoice = `import { Customer } from "./customer.mesh.mx"
import { Line } from "./line.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    string :title
  relationships
    belongs-to :customer entity=Customer
    has-many :lines entity=Line
  computed
    sum :catalogValue of=&lines.product.price
    count :productCount of=&lines.product
    count :siblings of=&customer.invoices
  actions auto=[:read]
    update :rename
      input
        &title
      validate
        check :cheap that=() => &catalogValue === null || &catalogValue < 100 code="dear" message="too dear"
  policies
    policy :anyone types=[:read]
      authorize-if=() => true
    policy :small actions=[&rename]
      authorize-if=() => &productCount < 3
`;
const student = `import { Course } from "./course.mesh.mx"
import { Enrollment } from "./enrollment.mesh.mx"
entity :Student table="students"
  attributes
    uuid :id primary-key
  relationships
    has-many :courses entity=Course through=Enrollment
  computed
    count :courseCount of=&courses
    sum :credits of=&courses.credits
    min :firstOpens of=&courses.opens
  actions auto=[:read]
${anyone}`;
const course = `entity :Course table="courses"
  attributes
    uuid :id primary-key
    integer :credits
    date :opens
  actions auto=[:read]
  policies
    policy :members
      authorize-if=({ actor }) => actor.id !== "guest"
`;
const enrollment = `import { Student } from "./student.mesh.mx"
import { Course } from "./course.mesh.mx"
entity :Enrollment table="enrollments"
  attributes
    uuid :id primary-key
  relationships
    belongs-to :student entity=Student
    belongs-to :course entity=Course nullable
  actions auto=[:read]
${anyone}`;

type Row = Record<string, any>;

export function joinedRollupsSuite(adapter: DomainAdapter): void {
  let dir: string;
  let app: any;
  let domain: any;
  beforeAll(async () => {
    dir = await mkdtemp(join(SCRATCH, ".scratch-joined-rollups-"));
    const config: ResolvedConfig = {
      root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
      data: adapter.data(["aggregates", "conditions", "joins"]),
    };
    const files = { customer, product, line, invoice, student, course, enrollment };
    const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(files).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
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

  /** A transaction whose `rollup` calls are recorded. */
  function counted(tx: DataOperations) {
    const rollups: RollupQuery[] = [];
    return { rollups, tx: { ...tx, rollup: (query: RollupQuery) => { rollups.push(query); return tx.rollup(query); } } as DataOperations };
  }

  // Ada (rating 4) has i1 and i2, Bo (rating 2) has i3. i1's three lines reach p1 (price 10) twice and p2 (price 5) once;
  // i2's one line reaches p2; i3 has none. s1 takes k1 twice, k2 once, and has one enrollment with no course and one
  // whose course is gone; s2 takes k2; s3 nothing.
  async function seeded(): Promise<DataLayer> {
    const db = await adapter.layer(app.tables);
    await db.transaction(async (tx) => {
      const t = app.tables;
      await tx.insert(t.customers, { id: id(1), rating: 4 });
      await tx.insert(t.customers, { id: id(2), rating: 2 });
      await tx.insert(t.products, { id: id(31), price: 10 });
      await tx.insert(t.products, { id: id(32), price: 5 });
      await tx.insert(t.invoices, { id: id(11), title: "i1", customerId: id(1) });
      await tx.insert(t.invoices, { id: id(12), title: "i2", customerId: id(1) });
      await tx.insert(t.invoices, { id: id(13), title: "i3", customerId: id(2) });
      await tx.insert(t.lines, { id: id(21), amount: 1, invoiceId: id(11), productId: id(31) });
      await tx.insert(t.lines, { id: id(22), amount: 2, invoiceId: id(11), productId: id(31) });
      await tx.insert(t.lines, { id: id(23), amount: 3, invoiceId: id(11), productId: id(32) });
      await tx.insert(t.lines, { id: id(24), amount: 4, invoiceId: id(12), productId: id(32) });
      await tx.insert(t.students, { id: id(41) });
      await tx.insert(t.students, { id: id(42) });
      await tx.insert(t.students, { id: id(43) });
      await tx.insert(t.courses, { id: id(51), credits: 3, opens: day(5) });
      await tx.insert(t.courses, { id: id(52), credits: 4, opens: day(2) });
      for (const [n, studentId, courseId] of [[61, 41, 51], [62, 41, 51], [63, 41, 52], [64, 41, null], [65, 41, 99], [66, 42, 52]] as const)
        await tx.insert(t.enrollments, { id: id(n), studentId: id(studentId), courseId: courseId === null ? null : id(courseId) });
    });
    return db;
  }
  const invoicesOf = (tx: DataOperations) => tx.select(app.tables.invoices, { sort: ["title"] });
  const studentsOf = (tx: DataOperations) => tx.select(app.tables.students, { sort: ["id"] });

  test("a has-many then a belongs-to counts each product once; a belongs-to then a has-many reaches back; one call each", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const { tx: counting, rollups } = counted(tx);
        const loaded = await app.loadInvoiceFields(counting, await invoicesOf(tx), ["catalogValue", "productCount", "siblings"]);
        expect(loaded.map((r: Row) => [r.title, r.catalogValue, r.productCount, r.siblings])).toEqual([["i1", 15, 2, 2], ["i2", 5, 1, 2], ["i3", null, 0, 1]]);
        expect(typeof loaded[0].catalogValue).toBe("number");
        // The two from the invoice table, anchored on its key; the third from the customers', on the distinct customer keys.
        expect(rollups.map((q) => [q.fn, q.hops?.length, q.anchors.length])).toEqual([["sum", 2, 3], ["count", 2, 3], ["count", 1, 2]]);
      });
    } finally { await db.close(); }
  });

  test("through a link entity each course counts once, a link with no course or a gone one adds nothing, and min is a date", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const { tx: counting, rollups } = counted(tx);
        const loaded = await app.loadStudentFields(counting, await studentsOf(tx), ["courseCount", "credits", "firstOpens"]);
        expect(loaded.map((r: Row) => [r.courseCount, r.credits, r.firstOpens])).toEqual([[2, 7, day(2)], [1, 4, day(2)], [0, null, null]]);
        expect(loaded[0].firstOpens).toBeInstanceOf(Date);
        expect(rollups).toHaveLength(3);
      });
    } finally { await db.close(); }
  });

  test("over required belongs-to only the rollup is never null, and a key on its path that points at nothing is an error", async () => {
    const db = await seeded();
    try {
      await db.transaction(async (tx) => {
        const lines = await tx.select(app.tables.lines, { sort: ["amount"] });
        expect((await app.loadLineFields(tx, lines, ["customerRating"])).map((r: Row) => r.customerRating)).toEqual([4, 4, 4, 4]);
        await tx.insert(app.tables.invoices, { id: id(14), title: "i4", customerId: id(99) });
        await tx.insert(app.tables.lines, { id: id(25), amount: 5, invoiceId: id(14), productId: id(31) });
        await tx.insert(app.tables.lines, { id: id(26), amount: 6, invoiceId: id(98), productId: id(31) });
        const missing = "reaches no Customer row: a key on its path points at a row that does not exist";
        for (const n of [25, 26]) {
          const [dangling] = await tx.select(app.tables.lines, { filter: { id: { eq: id(n) } } });
          await expect(app.loadLineFields(tx, [dangling], ["customerRating"])).rejects.toThrow(FrameworkError);
          await expect(app.loadLineFields(tx, [dangling], ["customerRating"])).rejects.toThrow(`\`max :customerRating of=&invoice.customer.rating\` on Line ${JSON.stringify(id(n))} ${missing}`);
        }
      });
    } finally { await db.close(); }
  });

  test("a caller the products' or the courses' read policy denies gets 0 or null; through privileged every value", async () => {
    const db = await seeded();
    try {
      const calls = callsOf(app.bind(db), domain);
      const asGuest = await calls.readInvoice({ sort: ["title"], load: ["catalogValue", "productCount", "siblings"] }, guest);
      expect(asGuest.map((r: Row) => [r.catalogValue, r.productCount, r.siblings])).toEqual([[null, 0, 2], [null, 0, 2], [null, 0, 1]]);
      const asMember = await calls.readInvoice({ sort: ["title"], load: ["catalogValue"] }, member);
      expect(asMember.map((r: Row) => r.catalogValue)).toEqual([15, 5, null]);
      const students = await calls.readStudent({ sort: ["id"], load: ["courseCount", "credits"] }, guest);
      expect(students.map((r: Row) => [r.courseCount, r.credits])).toEqual([[0, null], [0, null], [0, null]]);
      const privileged = await calls.run(() => (Mesh.privileged(domain.Student as never) as any).read({ sort: ["id"], load: ["courseCount"] }));
      expect(privileged.map((r: Row) => r.courseCount)).toEqual([2, 1, 0]);
    } finally { await db.close(); }
  });

  test("an update's check and its write policy read a joined rollup", async () => {
    const db = await seeded();
    try {
      const calls = callsOf(app.bind(db), domain);
      // i1: catalog 15 (under 100), two products (under 3).
      expect((await calls.renameInvoice({ id: id(11), title: "i1b" }, member)).title).toBe("i1b");
      await calls.run(() => db.transaction((tx) => tx.insert(app.tables.products, { id: id(33), price: 96 })));
      await calls.addLine({ amount: 1, invoice: id(11), product: id(33) }, member);
      // 111: the check fails; three products: the policy denies, and checkPolicies says so.
      expect((await calls.run(() => Mesh.checkPolicies(domain.Invoice.rename, { id: id(11), title: "x" }, member as never))).allowed).toBe(false);
      const second = await calls.renameInvoice({ id: id(12), title: "i2b" }, member);
      expect(second.title).toBe("i2b");
      await calls.addLine({ amount: 1, invoice: id(12), product: id(33) }, member);
      // i2: 5 + 96 is over 100 with two products: the policy passes and the check fails.
      const invalid = await calls.renameInvoice({ id: id(12), title: "x" }, member).catch((error: unknown) => error);
      expect(invalid).toBeInstanceOf(InvalidInputError);
      expect((invalid as InvalidInputError).issues.map((issue) => issue.code)).toEqual(["dear"]);
    } finally { await db.close(); }
  });

  test("the generated types: a caller's load types a joined rollup as possibly null, privileged keeps a required route's type", async () => {
    const source = await Bun.file(join(dir, ".mesh/domain/line.types.ts")).text();
    const block = (name: string) => source.slice(source.indexOf(`export type ${name} = {`), source.indexOf("};", source.indexOf(`export type ${name} = {`)));
    expect(block("LineLoadable")).toContain("customerRating: number | null;");
    expect(block("LineTxLoadable")).toMatch(/customerRating: number;/);
  });
}
