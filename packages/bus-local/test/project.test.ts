// localBus in a project built by the real `mesh` command on data-sqlite (fixture: `fixtures/project`, an Invoice whose
// `pay` publishes `InvoicePaid` and whose `refund` publishes `RefundIssued` once paid; the events module's process
// handler `refundOnPay` refunds each paid invoice and its listen handler `log` records every event). Acceptance 9 under
// `bind` with `deliver()` rounds and under `startDelivery()`, connect()/disconnect() cycles each with a fresh bus
// instance, and a second process on the same SQLite file: one that delivers too, and one connected with
// `{ deliver: false }` writing while this one does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DelivererTakenError, FrameworkError, HandlerStoppedError, type DataLayer } from "@meshfw/runtime";
import { localBus } from "../src/index.ts";

const repo = resolve(import.meta.dir, "../../..");
const PACKAGE = {
  name: "bus-local-project", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

let root: string;
type Layer = DataLayer & { close(): Promise<void> };
type Binding = { run<T>(fn: () => Promise<T>): Promise<T>; deliver(): Promise<void>; startDelivery(): Promise<{ stop(): Promise<void> }> };
let app: {
  bind(layer: DataLayer, options: object): Binding;
  connect(options?: { deliver?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  tables: Record<string, object>;
};
let Invoice: { open(input: object, context: object): Promise<{ id: string }>; pay(input: { id: string }, context: object): Promise<unknown> };
let events: { seen: string[]; control: { failPay: boolean }; handlers: object };
let config: { counts: { created: number }; default: { data: Layer } };
let data: { sqlite(options: { file: string }): Layer; createSchema(layer: DataLayer, tables: object): Promise<void> };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mesh-bus-local-project-"));
  await cp(join(import.meta.dir, "fixtures/project"), root, { recursive: true });
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
  events = await import(join(root, "events.ts"));
  config = await import(join(root, "mesh.config.ts"));
  data = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
  await data.createSchema(config.default.data, app.tables);
}, 30_000);
afterAll(async () => {
  await app?.disconnect();
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
const reset = () => { events.seen.length = 0; events.control.failPay = false; };

/** A memory cap for the second process where a systemd user manager runs (a developer's machine); CI runs it bare. */
const CAP: readonly string[] = Bun.which("systemd-run") !== null && Bun.spawnSync(["systemd-run", "--user", "--scope", "-q", "true"]).exitCode === 0
  ? ["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=1G", "-p", "MemorySwapMax=0"]
  : [];

/** A second process running `worker.ts`; resolves once it printed READY. */
async function worker(...args: string[]) {
  const child = Bun.spawn([...CAP, process.execPath, join(root, "worker.ts"), ...args], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env },
  });
  const reader = child.stdout.getReader();
  let buffer = "";
  const line = async (): Promise<string> => {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the worker exited before printing a line (so far: ${JSON.stringify(buffer)})`);
      buffer += new TextDecoder().decode(value);
    }
    const at = buffer.indexOf("\n");
    const out = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    return out;
  };
  const ready = await line();
  expect(ready).toStartWith("READY ");
  return {
    child, line, pid: Number(ready.slice("READY ".length)),
    send() { child.stdin.write("go\n"); child.stdin.flush(); },
    async end() { try { child.stdin.write("end\n"); child.stdin.flush(); } catch {} await Promise.race([child.exited, sleep(5000)]); child.kill(9); await child.exited; },
  };
}

describe("acceptance 9 with localBus", () => {
  test("under bind and deliver() rounds: process and listen handlers get every event; a stopped handler fails the round and the next one retries it", async () => {
    reset();
    const layer = data.sqlite({ file: ":memory:" });
    await data.createSchema(layer, app.tables);
    const binding = app.bind(layer, { events: { bus: localBus(), load: async () => events } });
    try {
      await binding.deliver();
      await binding.run(pay);
      await binding.deliver();
      // the refund's event, published by the process handler after the listen handler's turn, comes in the next round
      await binding.deliver();
      expect(events.seen).toEqual(["1 billing.InvoicePaid", "2 billing.RefundIssued"]);
      expect(await layer.readOutbox!(0, 10)).toEqual({ rows: [], deletedThrough: 2, highest: 2 });
      events.control.failPay = true;
      await binding.run(pay);
      const started = Date.now();
      const stopped = await rejection(binding.deliver());
      expect(Date.now() - started).toBeLessThan(2000);
      expect(stopped).toBeInstanceOf(HandlerStoppedError);
      expect(stopped).toMatchObject({ stopped: [{ handler: "refundOnPay", position: 3, event: "billing.InvoicePaid" }] });
      expect((await layer.readOutbox!(0, 10)).rows.map((row) => row.position)).toEqual([3]);
      events.control.failPay = false;
      await binding.deliver();
      await binding.deliver();
      expect(events.seen.slice(2)).toEqual(["3 billing.InvoicePaid", "4 billing.RefundIssued"]);
      expect(await layer.readOutbox!(0, 10)).toEqual({ rows: [], deletedThrough: 4, highest: 4 });
    } finally { await layer.close(); }
  });

  test("under startDelivery(): the events reach both handlers on their own, and every delivered row is deleted", async () => {
    reset();
    const layer = data.sqlite({ file: ":memory:" });
    await data.createSchema(layer, app.tables);
    const binding = app.bind(layer, { events: { bus: localBus({ pollInterval: 25 }), load: async () => events } });
    const delivery = await binding.startDelivery();
    try {
      await sleep(20);
      await binding.run(pay);
      await binding.run(pay);
      await until(() => events.seen.length === 4, "log gets both payments and both refunds");
      expect(events.seen.filter((line) => line.endsWith("InvoicePaid"))).toHaveLength(2);
      expect(events.seen.filter((line) => line.endsWith("RefundIssued"))).toHaveLength(2);
      await until(async () => (await layer.readOutbox!(0, 10)).rows.length === 0, "the deletion pass removes every delivered row");
    } finally {
      await delivery.stop();
      await layer.close();
    }
  });
});

describe("connect() and disconnect() with localBus", () => {
  test("eight connect() cycles each get a fresh bus instance and deliver; connect() while connected is refused and makes none", async () => {
    reset();
    const before = config.counts.created;
    for (let cycle = 1; cycle <= 8; cycle++) {
      await app.connect();
      if (cycle === 1) {
        await expect(app.connect()).rejects.toThrow(new FrameworkError("connect() was called while connected; call disconnect() first"));
      }
      expect(config.counts.created - before).toBe(cycle);
      if (cycle % 4 === 1) {
        const count = events.seen.length;
        await pay();
        await until(() => events.seen.length === count + 2, `cycle ${cycle} delivers the payment and its refund`);
      }
      await app.disconnect();
    }
    expect(config.counts.created - before).toBe(8);
  }, 30_000);
});

describe("a second process on the same SQLite file", () => {
  test("one that delivers holds the claim: connect() here fails with MESH_DELIVERER_TAKEN naming its pid, and succeeds once it disconnects", async () => {
    const other = await worker("deliver");
    try {
      const taken = await rejection(app.connect());
      expect(taken).toBeInstanceOf(DelivererTakenError);
      expect((taken as DelivererTakenError).holder).toMatchObject({ thisProcess: false, pid: other.pid });
      expect((taken as DelivererTakenError).retryable).toBe(true);
      await other.end();
      await app.connect();
      await app.disconnect();
    } finally { await other.end(); }
  }, 30_000);

  test("one connected with { deliver: false } writes while this one does, and every event reaches this process's handlers", async () => {
    reset();
    const COUNT = 15;
    await app.connect();
    const other = await worker("publish", String(COUNT));
    try {
      other.send();
      const mine = (async () => { for (let i = 0; i < COUNT; i++) await pay(); })();
      expect(await other.line()).toBe("DONE");
      await mine;
      await until(() => events.seen.length === COUNT * 4, "log gets every payment and refund of both processes", 15_000);
      const positions = events.seen.map((line) => Number(line.split(" ")[0]));
      expect(new Set(positions).size).toBe(COUNT * 4);
      expect(events.seen.filter((line) => line.endsWith("InvoicePaid"))).toHaveLength(COUNT * 2);
    } finally {
      await other.end();
      await app.disconnect();
    }
  }, 30_000);
});
