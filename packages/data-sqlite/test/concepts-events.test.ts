// An event field of a concept (concepts design, section 5 Run time; ruling D36): the event is published with the concept
// value, stored in the outbox as JSON, and rebuilt by the event class from the stored row, which checks it with the
// concept's schema as it checks every field.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { bindDomain, readEvents, type TableHandle } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";
import { openPolicies } from "./open-policy.ts";

const FILES: Record<string, string> = {
  "src/domain/concepts/Money.mesh.mx": "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n",
  "src/domain/billing/paid.mesh.mx": "event :Paid\n  uuid :invoice\n  Money :total\n  Money :refund nullable\n",
  "src/domain/billing/invoice.mesh.mx": `import { Paid } from "./paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    Money :total
  actions auto=[:read]
    create :open
      input
        &total
      do
        publish=({ self }) => new Paid({ invoice: self.id, total: self.total, refund: null })
`,
};

const CLI = resolve(import.meta.dir, "../../cli");
let dir: string;
let tables: Record<string, TableHandle>;
beforeAll(async () => {
  const dialect = Bun.spawnSync(["bun", "run", "build"], { cwd: CLI, stdout: "pipe", stderr: "pipe" });
  if (dialect.exitCode !== 0) throw new Error(`meshfw build failed: ${dialect.stdout}${dialect.stderr}`);
  // On disk, with a package.json that depends on `meshfw`: MX finds concept files by scanning `concepts` folders.
  dir = mkdtempSync(join(import.meta.dir, ".scratch-concepts-events-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "concepts", private: true, type: "module", dependencies: { meshfw: "*" } }));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(CLI, join(dir, "node_modules/meshfw"), "dir");
  const files = openPolicies(Object.entries(FILES).map(([file, source]) => ({ file, source })));
  for (const { file, source } of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files });
  expect(built.diagnostics).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  ({ tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> });
}, 60_000);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test("a published event's concept field goes through the outbox and comes back as the class instance, equal to what was published", async () => {
  const domain = await import(join(dir, ".mesh/domain/index.ts")) as { billing: { Invoice: { open: (input: unknown) => Promise<{ id: string }> }; Paid: new (fields: unknown) => object } };
  const layer = sqlite({ file: ":memory:" });
  await createSchema(layer, tables);
  try {
    const frame = new AsyncLocalStorage();
    const binding = bindDomain(domain, layer, { events: { bus: testBus(), load: async () => ({}) } }, frame);
    const opened = await binding.run(() => domain.billing.Invoice.open({ total: { currency: "EUR", amount: 1200 } }));
    const page = await binding.run(() => readEvents(frame, undefined, {}));
    expect(page.events).toHaveLength(1);
    const [record] = page.events;
    expect(record!.name).toBe("billing.Paid");
    expect(record!.payload).toBeInstanceOf(domain.billing.Paid);
    expect({ ...record!.payload }).toEqual({ invoice: opened.id, total: { currency: "EUR", amount: 1200 }, refund: null });
    // The stored payload is the concept value as JSON.
    const [row] = (await layer.readOutbox!(0, 10)).rows;
    expect(row!.payload).toEqual({ invoice: opened.id, total: { currency: "EUR", amount: 1200 }, refund: null });
  } finally { await layer.close(); }
});

test("the event class checks a concept field with the concept's schema: a wrong shape, as a stored row could hold, is refused", async () => {
  const { Paid } = await import(join(dir, ".mesh/domain/billing/paid.event.ts")) as { Paid: new (fields: unknown) => object };
  const id = "00000000-0000-7000-8000-000000000000";
  expect(() => new Paid({ invoice: id, total: { currency: "eur", amount: 1 }, refund: null })).toThrow();
  expect(() => new Paid({ invoice: id, total: { currency: "EUR" }, refund: null })).toThrow();
  expect(() => new Paid({ invoice: id, total: { currency: "EUR", amount: 1, extra: true }, refund: null })).toThrow();
  const made = new Paid({ invoice: id, total: { currency: "EUR", amount: 1 }, refund: { currency: "USD", amount: 0 } });
  // The instance is frozen at its top; a concept value's own members are typed read-only, not frozen at run time.
  expect(Object.isFrozen(made)).toBe(true);
});
