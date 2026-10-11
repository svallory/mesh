// CMP-17 at run time: a project whose application code imports `#mesh` for the framework and `#mesh/domain/<module>`
// for a module's action functions and types, through the package.json `imports` mapping Mesh documents, on SQLite.
// The domain has a root entity, a module two folders deep, modules named like Mesh's top-level files, and two modules
// whose actions call each other through `actions`. Bun runs it and tsc type-checks it, both resolving the specifiers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { openPolicies } from "./open-policy.ts";
import { FrameworkError, InvalidInputError } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema } from "../src/index.ts";

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
const CHECK = `import { bind, connect, disconnect, tables, transaction, type Actions, type Reads } from "#mesh";
// @ts-expect-error #mesh exports no action function: it is its module's
import { placeOrder as notInMesh } from "#mesh";
// @ts-expect-error nor an entity type
import type { Order as NotInMesh } from "#mesh";
// @ts-expect-error nor a load function, nor $delegate
import { $delegate } from "#mesh";
// @ts-expect-error a folder that holds only modules has no index of its own
import * as sales from "#mesh/domain/sales";
// @ts-expect-error a module exports its own entities, not another module's
import { settleInvoice as notInOrders } from "#mesh/domain/sales/orders";
import { closeOrder, placeOrder, readOrder, type Order, type PlaceOrderInput } from "#mesh/domain/sales/orders";
import { settleInvoice, type Invoice } from "#mesh/domain/billing";
import { makeTag, type Tag } from "#mesh/domain";
import { makeColumn, type Column } from "#mesh/domain/schema";
import { makeShipment } from "#mesh/domain/load";
import { makeEntry } from "#mesh/domain/index";
import { makeContract } from "#mesh/domain/binding";
import { makePiece } from "#mesh/domain/composition";
import { makeRealm } from "#mesh/domain/domain";

export async function main(): Promise<[Order, Invoice[], Tag, Column]> {
  await connect();
  const input: PlaceOrderInput = { item: "book", amount: 3 };
  const placed = await placeOrder(input, { trail: [] });
  // @ts-expect-error a module's function is typed by its input
  await placeOrder({ item: "book" });
  const both = await transaction(async ({ actions, tx }: { actions: Actions; tx: Reads }) => {
    const invoices = await tx.readInvoice({});
    await actions.settleInvoice({ id: invoices[0]!.id });
    return invoices;
  }, { trail: [] });
  const tag = await makeTag({ label: "t" });
  const column = await makeColumn({ label: "c" });
  await Promise.all([makeShipment({ label: "s" }), makeEntry({ label: "e" }), makeContract({ label: "k" }), makePiece({ label: "p" }), makeRealm({ label: "r" })]);
  await closeOrder({ id: placed.id });
  await settleInvoice({ id: both[0]!.id });
  void (await readOrder({}));
  void bind; void tables; void disconnect;
  return [placed, both, tag, column];
}
export const unreachable = [notInMesh, $delegate, sales, notInOrders];
export type Unreachable = NotInMesh;
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

  test("each module's specifier exports its own entities' action functions, and only those", () => {
    expect(Object.keys(app.root).sort()).toEqual(["makeTag", "readTag"]);
    expect(Object.keys(app.orders).sort()).toEqual(["closeOrder", "placeOrder", "readOrder"]);
    expect(Object.keys(app.billing).sort()).toEqual(["issueInvoice", "readInvoice", "settleInvoice"]);
  });

  test.each(Object.entries(NAMED))("a module named %s resolves to its own index, not to Mesh's file of that name", (module, name) => {
    expect(Object.keys(app[module]).sort()).toEqual([`make${name}`, `read${name}`]);
  });

  test("a folder that holds only modules has no specifier: #mesh/domain/sales does not resolve", async () => {
    await expect(app.resolveHere("#mesh/domain/sales")).rejects.toThrow();
    // The nested module does, through the same pattern.
    expect(await app.resolveHere("#mesh/domain/sales/orders")).toBe(app.orders);
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

describe("a module's action functions on the default binding", () => {
  test("before connect, a module's function throws the FrameworkError #mesh's did", async () => {
    await expect(app.orders.placeOrder({ item: "x", amount: 1 })).rejects.toThrow(new FrameworkError(
      "placeOrder was called while not connected: call connect() first, or use bind(db) with a data layer of your own"));
    await expect(app.domain.makeRealm({ label: "x" })).rejects.toBeInstanceOf(FrameworkError);
  });

  test("two modules call each other through `actions`: placing an order invoices it, settling the invoice closes the order", async () => {
    await app.mesh.connect();
    const trail: string[] = [];
    const placed = await app.orders.placeOrder({ item: "lamp", amount: 40 }, { trail });
    // The nested call carries the caller's context: Order's step runs after its write, then Invoice's before its own.
    expect(trail).toEqual(["placed lamp", "invoiced 40"]);
    const [issued] = await app.billing.readInvoice({ filter: { ref: { eq: placed.id } } });
    expect(issued).toMatchObject({ ref: placed.id, amount: 40, paid: false });
    await app.billing.settleInvoice({ id: issued.id });
    expect((await app.orders.readOrder({ filter: { id: { eq: placed.id } } }))[0]).toMatchObject({ item: "lamp", closed: true });
    expect((await app.billing.readInvoice({ filter: { id: { eq: issued.id } } }))[0].paid).toBe(true);
  });

  test("a nested action that fails in the other module fails the whole call: no order, no invoice", async () => {
    const orders = (await app.orders.readOrder({})).length;
    const invoices = (await app.billing.readInvoice({})).length;
    const error = await app.orders.placeOrder({ item: "free", amount: 0 }).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((await app.orders.readOrder({})).length).toBe(orders);
    expect((await app.billing.readInvoice({})).length).toBe(invoices);
  });

  test("transaction(fn, context) from #mesh composes both modules' actions, carries the context, and rolls back as one", async () => {
    const trail: string[] = [];
    const result = await app.mesh.transaction(async ({ actions, tx }: any) => {
      const made = await actions.placeOrder({ item: "desk", amount: 7 });
      const [bill] = await tx.readInvoice({ filter: { ref: { eq: made.id } } });
      await actions.settleInvoice({ id: bill.id });
      return made.id;
    }, { trail });
    expect(trail).toContain("placed desk");
    expect(trail).toContain("invoiced 7");
    expect((await app.orders.readOrder({ filter: { id: { eq: result } } }))[0].closed).toBe(true);
    const before = (await app.orders.readOrder({})).length;
    await expect(app.mesh.transaction(async ({ actions }: any) => {
      await actions.placeOrder({ item: "chair", amount: 2 });
      throw new Error("changed my mind");
    })).rejects.toThrow("changed my mind");
    expect((await app.orders.readOrder({})).length).toBe(before);
  });

  test("a module's function and the same member of bind(layer) give the same result on the same layer", async () => {
    const bound = app.mesh.bind(app.config.data);
    const viaModule = await app.schema.makeColumn({ label: "same" });
    const viaBind = await bound.makeColumn({ label: "same" });
    expect(Object.keys(viaModule).sort()).toEqual(Object.keys(viaBind).sort());
    expect({ ...viaModule, id: "" }).toEqual({ ...viaBind, id: "" });
    // `bind` still binds every entity of every module, flat, by action function name.
    expect(Object.keys(bound).sort()).toEqual([
      "closeOrder", "issueInvoice", "makeColumn", "makeContract", "makeEntry", "makePiece", "makeRealm", "makeShipment", "makeTag",
      "placeOrder", "readColumn", "readContract", "readEntry", "readInvoice", "readOrder", "readPiece", "readRealm", "readShipment", "readTag",
      "settleInvoice", "transaction"]);
  });

  test("an entity of a nested module bound alone gets stand-ins that throw for `actions`, and stores nothing", async () => {
    const { bindOrder } = await import(join(dir, ".mesh/domain/sales/orders/order.actions.ts"));
    const alone = bindOrder(app.config.data);
    const before = (await app.orders.readOrder({})).length;
    const error = await alone.place({ item: "solo", amount: 1 }).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("Order.place reads `actions.issueInvoice`, which only a binding of the whole project has: bind with bind(layer) from #mesh, not with one entity's bind function");
    expect((await app.orders.readOrder({})).length).toBe(before);
  });

  test("disconnect waits for a module's call already in flight, then closes the layer", async () => {
    // placeOrder nests issueInvoice, so the call is still running when disconnect() starts.
    const pending = app.orders.placeOrder({ item: "inflight", amount: 5 });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await app.mesh.disconnect();
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ item: "inflight", amount: 5 });
    // The layer is closed: a new call refuses until connect() runs again.
    await expect(app.orders.readOrder({})).rejects.toBeInstanceOf(FrameworkError);
    await app.mesh.connect();
  });

  test("after disconnect, every module's functions refuse again", async () => {
    await app.mesh.disconnect();
    await expect(app.billing.readInvoice({})).rejects.toBeInstanceOf(FrameworkError);
    await expect(app.index.makeEntry({ label: "late" })).rejects.toBeInstanceOf(FrameworkError);
  });
});
