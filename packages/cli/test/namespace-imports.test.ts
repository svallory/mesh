// an entity file imports another file as a namespace (`import * as entries from "../ledger/line.mesh.mx"`) and
// names what it declares as a member (`entity=entries.Line`), or imports it by name (`entity=Invoice`); one project mixes
// both, and one file imports the same file both ways. A helper module can be a namespace too (`money.format(...)`). The
// fixture (`fixtures/namespace-imports/domain`) is built by the real `mesh` command, type-checked by tsc under the
// strictest flags and run on SQLite in memory. The aliases (`people`, `entries`, `bills`) differ from the modules
// (`billing`, `ledger`), so the generated names show that an alias is never part of an FQN.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mesh, project as sharedProject, repo, removeProjects } from "./project.ts";

const fixture = join(import.meta.dir, "fixtures/namespace-imports/domain");

const project = () => sharedProject({ prefix: "namespace-imports-", name: "namespace-imports", domain: fixture });

let root: string;
beforeAll(async () => {
  root = await project();
  const built = mesh(root, "build");
  expect({ code: built.code, stdout: built.stdout, stderr: built.stderr }).toEqual({ code: 0, stdout: "", stderr: expect.not.stringContaining(" error ") });
}, 30_000);
afterAll(removeProjects);

describe("namespace imports of entity files and helper modules", () => {
  test("a function binds the alias to the values of what the file declares, and the file declares the alias's types", async () => {
    const invoice = await readFile(join(root, ".mesh/domain/billing/invoice.expressions.ts"), "utf8");
    // The helper module is imported as the entity file imports it, its namespace call kept as written.
    expect(invoice).toContain('import * as money from "../../../domain/billing/money";');
    expect(invoice).toContain('money.format(');
    expect(invoice).toContain('money.isPositive(');
    // The entity imported both ways is imported once, under its FQN-derived locals, never the alias.
    expect(invoice).toContain("Line as $ledger$Line$value");
    expect(invoice).not.toMatch(/\$entries\$/);
    expect(invoice).toContain("const entries: { readonly Line: $ledger$Line$ReadOnly } = { Line: $ledger$Line$value };");
    expect(invoice).toMatch(/declare namespace entries \{\s*export type Line = \$ledger\$Line\$Record;\s*\}/);
    const line = await readFile(join(root, ".mesh/domain/ledger/line.expressions.ts"), "utf8");
    expect(line).toMatch(/const bills: \{ readonly Invoice: \$billing\$Invoice\$ReadOnly \} = \{\s*Invoice: \$billing\$Invoice\$value,?\s*\};/);
    expect(line).toMatch(/declare namespace bills \{\s*export type Invoice = \$billing\$Invoice\$Record;\s*\}/);
    // A helper module the functions name only in a type is a type import: the generated file loads none of its code.
    expect(line).toContain('import type * as money from "../../../domain/billing/money";');
    expect(line).not.toContain('import * as money');
  });

  test("the model records each reference as written and resolves it to the entity the file declares; FQNs carry no alias", async () => {
    const models = await readdir(join(root, ".mesh"), { recursive: true });
    const modelFile = models.find((name) => name.endsWith("model.json"));
    expect(modelFile).toBeDefined();
    const document = JSON.parse(await readFile(join(root, ".mesh", modelFile!), "utf8")) as {
      entities: { fqn: string; relationships: { name: string; entity: { identifier: string; from: string } }[]; imports: { identifiers: string[]; namespace?: true }[] }[];
    };
    const entity = (fqn: string) => document.entities.find((candidate) => candidate.fqn === fqn)!;
    expect(document.entities.map((candidate) => candidate.fqn).sort()).toEqual(["billing.Customer", "billing.Invoice", "ledger.Line"]);
    expect(entity("billing.Invoice").relationships.map((r) => [r.name, r.entity])).toEqual([
      ["customer", { identifier: "people.Customer", from: "./customer.mesh.mx" }],
      ["lines", { identifier: "entries.Line", from: "../ledger/line.mesh.mx" }],
    ]);
    expect(entity("ledger.Line").relationships.map((r) => r.entity)).toEqual([{ identifier: "bills.Invoice", from: "../billing/invoice.mesh.mx" }]);
    expect(entity("billing.Customer").relationships.map((r) => r.entity)).toEqual([{ identifier: "Invoice", from: "./invoice.mesh.mx" }]);
    expect(entity("billing.Invoice").imports.filter((i) => i.namespace).map((i) => i.identifiers)).toEqual([["people"], ["entries"], ["money"]]);
  });

  test("tsc type-checks the generated tree under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  test("on SQLite the relationships through namespace imports load, and the functions call through them", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { billing, ledger } = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const context = { actor: { id: "someone" } };
    try {
      await app.bind(layer, {}).run(async () => {
        const customer = await billing.Customer.join({ name: "Ada" }, context);
        await expect(billing.Invoice.open({ amount: 0, label: "none", customer: customer.id }, context)).rejects.toThrow();
        const invoice = await billing.Invoice.open({ amount: 500, label: "first", customer: customer.id }, context);
        await billing.Invoice.split({ id: invoice.id }, context);
        const [read] = await billing.Invoice.read({ load: ["customer", "lines", "lineCount", "shown"] }, context);
        expect(read).toMatchObject({ customer: { name: "Ada" }, lineCount: 2, shown: "$5.00" });
        expect(read.lines.map((line: { amount: number }) => line.amount).sort((a: number, b: number) => a - b)).toEqual([1, 499]);
        const [first] = await ledger.Line.read({ load: ["invoice"] }, context);
        expect(first.invoice).toMatchObject({ label: "first" });
        await ledger.Line.check({ id: first.id }, context);
        const [owner] = await billing.Customer.read({ load: ["invoiceCount"] }, context);
        expect(owner).toMatchObject({ invoiceCount: 1 });
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
