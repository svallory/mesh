// The tables of a project that declares an event, built once per test file into a scratch directory beside the tests,
// for a bus without multi-process (`single`) and for one that declares it (`multi`): the schemas the multi-process
// tests prepare their databases with.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import type { TableHandle } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { openPolicies } from "./open-policy.ts";

const invoice = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
  actions
    create :open
      do
        publish=() => new InvoicePaid({ n: 1 })
`;
const paid = `event :InvoicePaid
  integer :n
`;

import { MULTI_CAPABILITIES } from "./multi-capabilities.ts";

/** Build both schemas; resolves with their tables and a function that deletes the scratch directory. */
export async function buildSchemas(): Promise<{ single: Record<string, TableHandle>; multi: Record<string, TableHandle>; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-multi-"));
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const tablesFor = async (name: string, multi: boolean) => {
    const config: ResolvedConfig = {
      root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, name),
      data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
      events: { bus: testBus(multi ? { capabilities: MULTI_CAPABILITIES } : {}) },
    };
    await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
    return (await import(join(dir, name, "schema.ts")) as { tables: Record<string, TableHandle> }).tables;
  };
  return { single: await tablesFor(".single", false), multi: await tablesFor(".multi", true), remove: () => rm(dir, { recursive: true, force: true }) };
}
