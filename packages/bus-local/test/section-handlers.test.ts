// Section handlers with localBus, in a project built by the real `mesh` command on data-sqlite (handlers design, PR 2,
// section 8, "Run time"; fixture `fixtures/section-handlers`): Invoice's `handlers` section holds a `process` handler
// that calls an action its `system` policy admits for the handler's context, and a `listen` handler that records every
// event; Archive's holds a `listen` handler that, when the test turns it on, calls an action no policy admits; the
// events module registers one more handler, `log`, beside them. The generated `bind` merges the two owners' handler
// files and hands them to `bindDomain`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HandlerStoppedError, resumeHandler, type DataLayer } from "@meshfw/runtime";
import { localBus } from "../src/index.ts";

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "bus-local-section-handlers", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

let root: string;
type Layer = DataLayer & { close(): Promise<void> };
type Binding = { run<T>(fn: () => Promise<T>): Promise<T>; deliver(): Promise<void>; startDelivery(): Promise<{ stop(): Promise<void> }> };
let app: { bind(layer: DataLayer, options: object): Binding; tables: Record<string, object> };
let Invoice: { open(input: object, context: object): Promise<{ id: string }>; pay(input: { id: string }, context: object): Promise<unknown>; read(input: object, context: object): Promise<{ id: string; receiptSent: boolean }[]> };
let recorded: { seen: string[]; control: { archive: boolean } };
let events: object;
let data: { sqlite(options: { file: string }): Layer; createSchema(layer: DataLayer, tables: object): Promise<void> };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-bus-local-section-handlers-"));
  await cp(join(import.meta.dir, "fixtures/section-handlers"), root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite", "bus-local"]) await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  const built = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), "build"], { cwd: root });
  expect({ code: built.exitCode, stderr: built.stderr.toString() }).toEqual({ code: 0, stderr: "0 errors, 0 warnings\n" });
  app = await import(join(root, ".mesh/index.ts"));
  ({ Invoice } = await import(join(root, ".mesh/domain/billing/index.ts")));
  recorded = await import(join(root, "domain/billing/record.ts"));
  events = await import(join(root, "events.ts"));
  data = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
}, 30_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    await sleep(5);
  }
}
const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const CONTEXT = {};
const pay = async () => { const invoice = await Invoice.open({}, CONTEXT); await Invoice.pay({ id: invoice.id }, CONTEXT); return invoice.id; };
const reset = () => { recorded.seen.length = 0; recorded.control.archive = false; };
const layerWithSchema = async () => {
  const layer = data.sqlite({ file: ":memory:" });
  await data.createSchema(layer, app.tables);
  return layer;
};

describe("the generated binding", () => {
  test("imports both owners' handler files and hands them to bindDomain merged", async () => {
    const binding = await readFile(join(root, ".mesh/binding.ts"), "utf8");
    expect(binding).toContain('import { $handlers as $billing$Archive$handlers } from "./domain/billing/archive.handlers";');
    expect(binding).toContain('import { $handlers as $billing$Invoice$handlers } from "./domain/billing/invoice.handlers";');
    expect(binding).toMatch(/\$bindDomain\(\s*\$domain,\s*layer,\s*options,\s*\$frame,\s*\$mergeHandlers\(\[\$billing\$Archive\$handlers, \$billing\$Invoice\$handlers\]\),?\s*\)/);
  });
});

describe("section handlers under bind and deliver() rounds", () => {
  test("both owners' handlers and the module's run in one round, from now; a process handler's action publishes an event caused by the one it handles", async () => {
    reset();
    const layer = await layerWithSchema();
    const binding = app.bind(layer, { events: { bus: localBus(), load: async () => events } });
    try {
      // Published before the first registration: every handler starts at the highest position, so none gets it.
      await binding.run(pay);
      await binding.deliver();
      expect(recorded.seen).toEqual([]);
      const id = await binding.run(pay);
      await binding.deliver();
      // The process handler ran markReceiptSent with the system context, which published ReceiptSent in the handler
      // transaction, caused by the InvoicePaid it handled; the listen handler, after it by key, gets it in the same round.
      expect(recorded.seen.slice().sort()).toEqual([
        "archive 2",
        "listen 2 billing.InvoicePaid -",
        "listen 3 billing.ReceiptSent caused",
        "module 2 billing.InvoicePaid",
        'process 2 billing.InvoicePaid {"system":true}',
      ]);
      await binding.deliver();
      expect(recorded.seen).toHaveLength(5);
      const [invoice] = await binding.run(() => Invoice.read({ filter: { id: { eq: id } } }, CONTEXT));
      expect(invoice!.receiptSent).toBe(true);
      expect((await layer.readOutbox!(0, 10)).rows).toEqual([]);
    } finally { await layer.close(); }
  });

  test("a body whose action no policy admits stops its handler: deliver() rejects naming its key, the row is held, and the next round handles it once the call succeeds", async () => {
    reset();
    const layer = await layerWithSchema();
    const binding = app.bind(layer, { events: { bus: localBus(), load: async () => events } });
    try {
      await binding.deliver();
      recorded.control.archive = true;
      await binding.run(pay);
      const stopped = await rejection(binding.deliver());
      expect(stopped).toBeInstanceOf(HandlerStoppedError);
      expect(stopped).toMatchObject({ stopped: [{ handler: "billing.Archive.file", position: 1, event: "billing.InvoicePaid" }] });
      // The other handlers went past it; the stopped one holds the row against deletion.
      expect((await layer.readOutbox!(0, 10)).rows.map((row) => row.position)).toEqual([1, 2]);
      recorded.control.archive = false;
      recorded.seen.length = 0;
      await binding.deliver();
      expect(recorded.seen).toContain("archive 1");
      await binding.deliver();
      expect((await layer.readOutbox!(0, 10)).rows).toEqual([]);
    } finally { await layer.close(); }
  });
});

describe("section handlers under startDelivery()", () => {
  test("they run on their own; a stopped one is resumed by its key", async () => {
    reset();
    const layer = await layerWithSchema();
    const stops: unknown[] = [];
    const binding = app.bind(layer, { events: { bus: localBus({ pollInterval: 25, onStopped: (error) => { stops.push(error); } }), load: async () => events } });
    const delivery = await binding.startDelivery();
    try {
      recorded.control.archive = true;
      await binding.run(pay);
      await until(() => stops.length === 1, "the archive handler stops");
      expect(stops[0]).toMatchObject({ stopped: [{ handler: "billing.Archive.file" }] });
      await until(() => recorded.seen.includes("listen 2 billing.ReceiptSent caused"), "the invoice's handlers go on");
      recorded.control.archive = false;
      resumeHandler(binding as never, "billing.Archive.file");
      await until(() => recorded.seen.filter((line) => line === "archive 1").length === 2, "the resumed handler handles the held row");
      await until(async () => (await layer.readOutbox!(0, 10)).rows.length === 0, "the deletion pass removes every delivered row");
    } finally {
      await delivery.stop();
      await layer.close();
    }
  });
});
