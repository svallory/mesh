// The concept generator and the barrels (concepts design, section 5 Emit and section 7; ruling D36, ADR-0092): one
// `<name>.concept.ts` per concept, its type and Zod schema, exported by the module's barrel. A project without a concept
// gets none of it (the examples' guards and the existing goldens hold that).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { closeTypeServer } from "./type-server.ts";
import { checkTypes, configOf } from "./generated.ts";
import { buildDialect, conceptProject } from "./helpers.ts";

const D = "src/domain/";
const disposers: (() => void | Promise<void>)[] = [];
beforeAll(() => buildDialect(), 60_000);
afterAll(async () => {
  for (const dispose of disposers) await dispose();
  await closeTypeServer();
});

const FILES = {
  [`${D}concepts/Money.mesh.mx`]: "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n",
  [`${D}billing/concepts/Fee.mesh.mx`]: "concept :Fee\n  enum :kind values=[:flat, :percent]\n  decimal :rate nullable\n  json :terms\n  string :constructor max=20\n",
  [`${D}billing/invoice.mesh.mx`]: "entity :Invoice\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n",
  [`${D}reports/concepts/Range.mesh.mx`]: "concept :Range\n  integer :from\n  integer :to\n",
};

function documentOf(files: Record<string, string>) {
  const made = conceptProject(files);
  disposers.push(made.dispose);
  const built = buildModel(made.project);
  expect(built.diagnostics).toEqual([]);
  return built.document!;
}
const golden = async (name: string, actual: string) => {
  const path = resolve(import.meta.dir, "fixtures/concepts-golden", name);
  if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
  expect(actual).toBe(await readFile(path, "utf8"));
};

describe("the concept generator", () => {
  const generated = (async () => generateFiles({ document: documentOf(FILES), config: configOf("/project", ".mesh") }))();
  const text = async (path: string) => (await generated).find((file) => file.path === path)!.contents;

  test("one file per concept beside its module's barrel, and a barrel for a module that holds only a concept", async () => {
    const paths = (await generated).map((file) => file.path);
    expect(paths.filter((path) => path.endsWith(".concept.ts"))).toEqual([
      ".mesh/domain/billing/fee.concept.ts",
      ".mesh/domain/money.concept.ts",
      ".mesh/domain/reports/range.concept.ts",
    ]);
    expect(paths).toContain(".mesh/domain/reports/index.ts");
  });

  test("the type and the schema: goldens", async () => {
    await golden("money.concept.ts.golden", await text(".mesh/domain/money.concept.ts"));
    await golden("fee.concept.ts.golden", await text(".mesh/domain/billing/fee.concept.ts"));
    await golden("domain.index.ts.golden", await text(".mesh/domain/index.ts"));
    await golden("billing.index.ts.golden", await text(".mesh/domain/billing/index.ts"));
    await golden("reports.index.ts.golden", await text(".mesh/domain/reports/index.ts"));
  });

  test("a regular expression goes through `$RegExp` and a json field through `$jsonValue`; a file that needs neither imports neither", async () => {
    expect(await text(".mesh/domain/money.concept.ts")).toContain('import { $RegExp } from "../$globals";');
    expect(await text(".mesh/domain/money.concept.ts")).not.toContain("jsonValue");
    expect(await text(".mesh/domain/billing/fee.concept.ts")).toContain('import { jsonValue as $jsonValue } from "@meshfw/runtime";');
    const range = await text(".mesh/domain/reports/range.concept.ts");
    expect(range).not.toContain("$globals");
    expect(range).not.toContain("@meshfw/runtime");
  });

  test("the generated tree type-checks, a concept's members are read-only, and its schema checks a value of it", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-concepts-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const config = configOf(root);
    const files = await generateFiles({ document: documentOf(FILES), config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    await writeFile(resolve(root, "use.ts"), [
      'import { moneySchema, type Money, billing } from "./generated/domain/index";',
      'const money: Money = moneySchema.parse({ currency: "EUR", amount: 1 });',
      "// @ts-expect-error a concept value is replaced whole, never changed in place",
      "money.amount = 2;",
      'const fee: billing.Fee = billing.feeSchema.parse({ kind: "flat", rate: null, terms: {}, constructor: "x" });',
      "// @ts-expect-error an enum field takes only its values",
      'const wrong: billing.Fee["kind"] = "other";',
      "export { money, fee, wrong };",
      "",
    ].join("\n"));
    const checked = await checkTypes(root, [...files.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts"), resolve(root, "use.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("a concept named like a type its module derives is MESH_EMIT_NAME naming both", async () => {
    const document = documentOf({
      [`${D}billing/concepts/InvoiceFilter.mesh.mx`]: "concept :InvoiceFilter\n  integer :x\n",
      [`${D}billing/invoice.mesh.mx`]: FILES[`${D}billing/invoice.mesh.mx`]!,
    });
    const error = await generateFiles({ document, config: configOf("/project", ".mesh") }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "the type InvoiceFilter of entity billing.Invoice and concept billing.InvoiceFilter would both be exported as InvoiceFilter from #mesh/domain/billing",
    });
  });

  test("legal neighbour: a concept beside an entity whose names differ", async () => {
    const document = documentOf({
      [`${D}billing/concepts/Money.mesh.mx`]: "concept :Money\n  integer :x\n",
      [`${D}billing/invoice.mesh.mx`]: FILES[`${D}billing/invoice.mesh.mx`]!,
    });
    const files = await generateFiles({ document, config: configOf("/project", ".mesh") });
    expect(files.find((file) => file.path === ".mesh/domain/billing/index.ts")!.contents).toContain('export { moneySchema, type Money } from "./money.concept";');
  });
});
