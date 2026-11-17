// The tables of a project that declares an event, as data-postgres's schema generator writes them: one entity, one
// event, and core's outbox and delivery tables. Built into a scratch directory beside the tests; the caller removes it.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import type { TableHandle } from "@meshfw/runtime";
import build from "../src/build.ts";

const invoice = `import { InvoicePaid } from "./invoice-paid.mesh.mx"
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
  actions
    create :open
      do
        publish=() => new InvoicePaid({ n: 1 })
  policies
    policy :anyCaller
      authorize-if=() => true
`;
const paid = `event :InvoicePaid
  integer :n
`;

export async function eventTables(): Promise<{ tables: Record<string, TableHandle>; schema: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-events-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", capabilities: { adapter: "postgres", capabilities: [] }, options: { url: undefined } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: [
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }] });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  const schema = await Bun.file(join(dir, ".mesh/schema.ts")).text();
  const { tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> };
  return { tables, schema, remove: () => rm(dir, { recursive: true, force: true }) };
}
