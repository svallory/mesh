// CMP-17 and CMP-18 at run time: a project whose application code imports `#mesh` for the framework and
// `#mesh/domain/<path>` for a folder's entity values, types and subfolder namespaces, through the package.json `imports`
// mapping Mesh documents, on SQLite. The domain has a root entity, a module two folders deep below a folder that holds
// no entity, modules named like Mesh's top-level files, and two modules whose actions call each other through
// `actions`. Bun runs it and tsc type-checks it, both resolving the specifiers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { openPolicies } from "./open-policy.ts";
import { FrameworkError, InvalidInputError } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const order = `entity :Order table="orders"
  attributes
    uuid :id primary-key
    string :item min=1
    integer :amount
    boolean :closed default=false
  actions auto=[:read]
    create :place
      input
        &item
        &amount
      do
        run [after=:write] ({ self, actions, context }) {
          context.trail?.push(\`placed \${self.item}\`);
          await actions.issueInvoice({ ref: self.id, amount: self.amount });
        }
    update :close
      do
        set
          &closed=true
`;

const invoice = `entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    string :ref
    integer :amount
    boolean :paid default=false
  actions auto=[:read]
    create :issue
      input
        &ref
        &amount
      validate
        check :positive that=({ input }) => input.amount > 0 code="amount.positive" message="invoice a positive amount"
      do
        run({ input, context }) {
          context.trail?.push(\`invoiced \${input.amount}\`);
        }
    update :settle
      do
        set
          &paid=true
        run [after=:write] ({ self, actions }) {
          await actions.closeOrder({ id: self.ref });
        }
`;

const simple = (name: string) => `entity :${name}
  attributes
    uuid :id primary-key
    string :label
  actions auto=[:read]
    create :make
      input
        &label
`;

/** A module per Mesh top-level name, each with one entity: `schema` holds Column, `index` holds Entry, and so on. */
const NAMED = { schema: "Column", load: "Shipment", index: "Entry", binding: "Contract", composition: "Piece", domain: "Realm" } as const;

const SOURCES: Record<string, string> = {
  "tag.mesh.mx": simple("Tag"),
  "sales/orders/order.mesh.mx": order,
  "billing/invoice.mesh.mx": invoice,
  ...Object.fromEntries(Object.entries(NAMED).map(([module, name]) => [`${module}/${name.toLowerCase()}.mesh.mx`, simple(name)])),
};

/** What `mesh.config.ts`, `package.json` and the application hold in a project laid out as the docs describe it. */
const PACKAGE = {
  name: "modules-fixture", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};
// The adapter is imported by a computed specifier so that tsc does not type-check this package's sources under the
// fixture's stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { data: sqlite({ file: ":memory:" }) };
`;
const CONTEXT = `import "@meshfw/runtime";
declare module "@meshfw/runtime" {
  interface ActionContext {
    trail?: string[];
  }
}
export {};
`;
/** The application: every import is a specifier, never a path into .mesh/. */
const APP = `export * as mesh from "#mesh";
export * as root from "#mesh/domain";
export * as orders from "#mesh/domain/sales/orders";
export * as billing from "#mesh/domain/billing";
export * as schema from "#mesh/domain/schema";
export * as load from "#mesh/domain/load";
export * as index from "#mesh/domain/index";
export * as binding from "#mesh/domain/binding";
export * as composition from "#mesh/domain/composition";
export * as domain from "#mesh/domain/domain";
export { default as config } from "./mesh.config";
/** Resolve a specifier from inside the project, where its package.json maps it. */
export const resolveHere = (specifier: string): Promise<unknown> => import(specifier);
`;
/** Type-level checks: what each specifier exports and does not. */
const CHECK = `import { bind, connect, disconnect, tables, transaction, type Actions, type Binding, type Reads } from "#mesh";
// @ts-expect-error #mesh exports no entity value: it is its module's
import { Order as notInMesh } from "#mesh";
// @ts-expect-error nor $delegate
import { $delegate } from "#mesh";
// @ts-expect-error a module exports no function per action: its entity value holds them
import { placeOrder } from "#mesh/domain/sales/orders";
// @ts-expect-error a module exports its own entities, not another module's
import { Invoice as notInOrders } from "#mesh/domain/sales/orders";
import * as domain from "#mesh/domain";
import * as sales from "#mesh/domain/sales";
import { Order, type PlaceOrderInput } from "#mesh/domain/sales/orders";
import { Invoice } from "#mesh/domain/billing";
import { Tag } from "#mesh/domain";
import { Column } from "#mesh/domain/schema";
import { Shipment } from "#mesh/domain/load";
import { Entry } from "#mesh/domain/index";
import { Contract } from "#mesh/domain/binding";
import { Piece } from "#mesh/domain/composition";
import { Realm } from "#mesh/domain/domain";

export async function main(): Promise<[Order, Invoice[], Tag, Column]> {
  await connect();
  const input: PlaceOrderInput = { item: "book", amount: 3 };
  const placed = await Order.place(input, { trail: [] });
  // @ts-expect-error an entity's method is typed by its input
  await Order.place({ item: "book" });
  // The same entity value through the namespaces of the barrels above its folder.
  const viaSales: typeof Order = sales.orders.Order;
  const viaRoot: typeof Invoice = domain.billing.Invoice;
  const both = await transaction(async ({ actions, tx }: { actions: Actions; tx: Reads }) => {
    const invoices = await tx.readInvoice({});
    await actions.settleInvoice({ id: invoices[0]!.id });
    return invoices;
  }, { trail: [] });
  const tag = await Tag.make({ label: "t" });
  const column = await Column.make({ label: "c" });
  await Promise.all([Shipment.make({ label: "s" }), Entry.make({ label: "e" }), Contract.make({ label: "k" }), Piece.make({ label: "p" }), Realm.make({ label: "r" })]);
  await Order.close({ id: placed.id });
  await Invoice.settle({ id: both[0]!.id });
  // A binding of one's own: inside its run, a call keeps its type.
  const own: Binding = bind(null as never);
  const orders: Order[] = await own.run(() => Order.read({}));
  void tables; void disconnect; void viaSales; void viaRoot; void orders;
  return [placed, both, tag, column];
}
export const unreachable = [notInMesh, $delegate, placeOrder, notInOrders];
`;

let dir: string;
let app: any;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".modules-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: ["aggregates"] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies(Object.entries(SOURCES).map(([name, source]) => ({ file: `src/domain/${name}`, source }))) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await Bun.write(join(dir, "mesh.config.ts"), CONFIG);
  await Bun.write(join(dir, "context.ts"), CONTEXT);
  await Bun.write(join(dir, "app.ts"), APP);
  await Bun.write(join(dir, "check.ts"), CHECK);
  app = await import(join(dir, "app.ts"));
  await createSchema(app.config.data, app.mesh.tables);
});
afterAll(async () => {
  await app?.mesh.disconnect();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the specifiers", () => {
  test("#mesh exports bind, connect, disconnect, tables and transaction, and nothing else", () => {
    expect(Object.keys(app.mesh).sort()).toEqual(["bind", "connect", "disconnect", "tables", "transaction"]);
  });

  test("each barrel exports its own entities' values and one namespace per subfolder, and only those", () => {
    expect(Object.keys(app.root).sort()).toEqual(["Tag", "billing", "binding", "composition", "domain", "index", "load", "sales", "schema"]);
    expect(Object.keys(app.orders)).toEqual(["Order"]);
    expect(Object.keys(app.billing)).toEqual(["Invoice"]);
    expect(Object.keys(app.orders.Order)).toEqual(["place", "close", "read"]);
  });

  test.each(Object.entries(NAMED))("a module named %s resolves to its own barrel, not to Mesh's file of that name", (module, name) => {
    expect(Object.keys(app[module])).toEqual([name]);
    expect(app.root[module]).toBe(app[module]);
  });

  test("a folder that holds only folders resolves to a barrel of their namespaces: #mesh/domain/sales holds orders", async () => {
    const sales = await app.resolveHere("#mesh/domain/sales");
    expect(Object.keys(sales)).toEqual(["orders"]);
    expect(sales.orders).toBe(app.orders);
    expect(app.root.sales).toBe(sales);
    // One entity value, however it is reached.
    expect(app.root.sales.orders.Order).toBe(app.orders.Order);
  });

  test("Mesh's own files are not module specifiers: #mesh/binding and #mesh/domain/binding are different things", async () => {
    await expect(app.resolveHere("#mesh/binding")).rejects.toThrow();
    await expect(app.resolveHere("#mesh/schema")).rejects.toThrow();
    expect(await app.resolveHere("#mesh/domain/binding")).toBe(app.binding);
  });

  test("tsc resolves every specifier through package.json and checks what each exports, under the strictest flags", async () => {
    const generated = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "context.ts", "app.ts", "check.ts", ...generated,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 30_000);
});

describe("entity values on the connected binding", () => {
  test("before connect, an entity call throws a FrameworkError naming the entity by FQN and the action", async () => {
    await expect(app.orders.Order.place({ item: "x", amount: 1 })).rejects.toThrow(new FrameworkError(
      "sales.orders.Order.place was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
    await expect(app.domain.Realm.make({ label: "x" })).rejects.toBeInstanceOf(FrameworkError);
  });

  test("two modules call each other through `actions`: placing an order invoices it, settling the invoice closes the order", async () => {
    await app.mesh.connect();
    const { Order } = app.orders;
    const { Invoice } = app.billing;
    const trail: string[] = [];
    const placed = await Order.place({ item: "lamp", amount: 40 }, { trail });
    // The nested call carries the caller's context: Order's step runs after its write, then Invoice's before its own.
    expect(trail).toEqual(["placed lamp", "invoiced 40"]);
    const [issued] = await Invoice.read({ filter: { ref: { eq: placed.id } } });
    expect(issued).toMatchObject({ ref: placed.id, amount: 40, paid: false });
    await Invoice.settle({ id: issued.id });
    expect((await Order.read({ filter: { id: { eq: placed.id } } }))[0]).toMatchObject({ item: "lamp", closed: true });
    expect((await Invoice.read({ filter: { id: { eq: issued.id } } }))[0].paid).toBe(true);
  });

  test("a nested action that fails in the other module fails the whole call: no order, no invoice", async () => {
    const { Order } = app.orders;
    const { Invoice } = app.billing;
    const orders = (await Order.read({})).length;
    const invoices = (await Invoice.read({})).length;
    const error = await Order.place({ item: "free", amount: 0 }).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((await Order.read({})).length).toBe(orders);
    expect((await Invoice.read({})).length).toBe(invoices);
  });

  test("transaction(fn, context) from #mesh composes both modules' actions, carries the context, and rolls back as one", async () => {
    const { Order } = app.orders;
    const trail: string[] = [];
    const result = await app.mesh.transaction(async ({ actions, tx }: any) => {
      const made = await actions.placeOrder({ item: "desk", amount: 7 });
      const [bill] = await tx.readInvoice({ filter: { ref: { eq: made.id } } });
      await actions.settleInvoice({ id: bill.id });
      return made.id;
    }, { trail });
    expect(trail).toContain("placed desk");
    expect(trail).toContain("invoiced 7");
    expect((await Order.read({ filter: { id: { eq: result } } }))[0].closed).toBe(true);
    const before = (await Order.read({})).length;
    await expect(app.mesh.transaction(async ({ actions }: any) => {
      await actions.placeOrder({ item: "chair", amount: 2 });
      throw new Error("changed my mind");
    })).rejects.toThrow("changed my mind");
    expect((await Order.read({})).length).toBe(before);
  });

  test("while connected, a call inside run() of bind(layer) runs on that binding, and one outside any run on the connected one", async () => {
    const { Column } = app.schema;
    const own = sqlite({ file: ":memory:" });
    await createSchema(own, app.mesh.tables);
    try {
      const bound = app.mesh.bind(own);
      expect(Object.isFrozen(bound)).toBe(true);
      expect(Object.keys(bound)).toEqual(["run", "transaction"]);
      await bound.run(() => Column.make({ label: "own" }));
      await Column.make({ label: "connected" });
      const labels = (rows: { label: string }[]) => rows.map((row) => row.label);
      expect(labels(await bound.run(() => Column.read({})))).toEqual(["own"]);
      expect(labels(await Column.read({}))).not.toContain("own");
      expect(labels(await Column.read({}))).toContain("connected");
      // `transaction` from #mesh takes the binding in scope too.
      expect(await bound.run(() => app.mesh.transaction(async ({ tx }: any) => labels(await tx.readColumn({}))))).toEqual(["own"]);
    } finally { await own.close(); }
  });

  test("an entity of a nested module bound alone gets stand-ins that throw for `actions`, and stores nothing", async () => {
    const { bindOrder } = await import(join(dir, ".mesh/domain/sales/orders/order.actions.ts"));
    const alone = bindOrder(app.config.data);
    const before = (await app.orders.Order.read({})).length;
    const error = await alone.place({ item: "solo", amount: 1 }).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("sales.orders.Order#place reads `actions.issueInvoice`, which only a binding of the whole project has: bind with bind(layer) from #mesh, not with one entity's bind function");
    expect((await app.orders.Order.read({})).length).toBe(before);
  });

  test("disconnect waits for an entity call already in flight, then closes the layer", async () => {
    // Order.place nests Invoice.issue, so the call is still running when disconnect() starts.
    const pending = app.orders.Order.place({ item: "inflight", amount: 5 });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await app.mesh.disconnect();
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ item: "inflight", amount: 5 });
    // The layer is closed: a new call refuses until connect() runs again.
    await expect(app.orders.Order.read({})).rejects.toBeInstanceOf(FrameworkError);
    await app.mesh.connect();
  });

  test("after disconnect, every module's entity values refuse again", async () => {
    await app.mesh.disconnect();
    await expect(app.billing.Invoice.read({})).rejects.toBeInstanceOf(FrameworkError);
    await expect(app.index.Entry.make({ label: "late" })).rejects.toBeInstanceOf(FrameworkError);
  });
});
