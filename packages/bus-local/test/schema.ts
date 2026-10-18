// The tables a project that declares an event gets from data-sqlite, built once per test file into a scratch directory
// beside the tests: one entity whose `open` publishes `InvoicePaid`, as data-sqlite's own bus conformance test builds them.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import type { TableHandle } from "@meshfw/runtime";
import build from "@meshfw/data-sqlite/build";

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

/** Build the project into a scratch directory; resolves with the directory (`.mesh` in it), its tables and a function that deletes the scratch directory. */
export async function buildSchema(): Promise<{ dir: string; tables: Record<string, TableHandle>; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: [
    { file: "src/domain/invoice.mesh.mx", source: invoice }, { file: "src/domain/invoice-paid.mesh.mx", source: paid }] });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  const { tables } = await import(join(dir, ".mesh/schema.ts")) as { tables: Record<string, TableHandle> };
  return { dir, tables, remove: () => rm(dir, { recursive: true, force: true }) };
}
