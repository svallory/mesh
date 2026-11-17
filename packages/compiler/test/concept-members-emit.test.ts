// Concept-typed members in the generated tree (concepts design, sections 5 Emit and 7; ruling D36, ADR-0092): a member,
// an input, an event or command field and a concept field that hold a concept print the concept's type and check it with
// the concept's schema, each imported under its FQN-derived local; a `set` literal is printed by the concept's fields.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModel } from "../src/front-end/build.ts";
import { conceptTypeImport } from "../src/index.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
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

export const CONCEPT_MEMBER_FILES = {
  [`${D}concepts/Money.mesh.mx`]: "concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0\n",
  [`${D}concepts/One.mesh.mx`]: "concept :One\n  string :value\n",
  [`${D}billing/concepts/Status.mesh.mx`]: "concept :Status\n  enum :state values=[:open, :closed]\n  Money :fee nullable\n  json :notes\n",
  [`${D}billing/invoice.mesh.mx`]: `import { Paid } from "./paid.mesh.mx"
import { Charge } from "./charge.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    Money :total
    Money :refund nullable
    Status :status
    One :label
  actions auto=[:read]
    always types=[:update]
      do
        set
          &label={ value: "touched" }
    create :open
      input
        &total
        &refund
        &status
        &label
      do
        publish=({ self }) => new Paid({ id: self.id, total: self.total })
    update :close
      do
        set
          &status={ state: :closed, fee: { currency: "EUR", amount: 5 }, notes: { why: [1, "a"] } }
          &refund=null
    update :retotal
      input
        &total
    update on=Charge
      input
        &total
        &status
`,
  [`${D}billing/paid.mesh.mx`]: "event :Paid\n  uuid :id\n  Money :total\n",
  [`${D}billing/charge.mesh.mx`]: "command :Charge\n  uuid :id\n  Money :total\n  Status :status optional\n",
};

function documentOf(files: Record<string, string>) {
  const made = conceptProject(files);
  disposers.push(made.dispose);
  const built = buildModel(made.project);
  expect(built.diagnostics.filter((d) => d.code !== "MESH_COMMAND_UNANSWERED")).toEqual([]);
  return built.document!;
}
const golden = async (name: string, actual: string) => {
  const path = resolve(import.meta.dir, "fixtures/concept-members-golden", name);
  if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
  expect(actual).toBe(await readFile(path, "utf8"));
};

describe("a concept member in the generated tree", () => {
  const document = (() => {
    let made: ReturnType<typeof documentOf> | undefined;
    return () => (made ??= documentOf(CONCEPT_MEMBER_FILES));
  })();
  const generated = (async () => generateFiles({ document: document(), config: configOf("/project", ".mesh") }))();
  const text = async (path: string) => (await generated).find((file) => file.path === path)!.contents;

  test("the record, input, validator, event, command and nested-concept files: goldens", async () => {
    await golden("invoice.types.ts.golden", await text(".mesh/domain/billing/invoice.types.ts"));
    await golden("invoice.validators.ts.golden", await text(".mesh/domain/billing/invoice.validators.ts"));
    await golden("status.concept.ts.golden", await text(".mesh/domain/billing/status.concept.ts"));
    await golden("paid.event.ts.golden", await text(".mesh/domain/billing/paid.event.ts"));
    await golden("charge.command.ts.golden", await text(".mesh/domain/billing/charge.command.ts"));
  });

  test("a set literal is printed by the concept's fields: an enum's atom by its name, a nested concept, a field named `value`", async () => {
    // Prettier formats the printed literal; compare with whitespace collapsed.
    const actions = (await text(".mesh/domain/billing/invoice.actions.ts")).replace(/\s+/g, " ");
    expect(actions).toContain('$record.status = { state: "closed", fee: { currency: "EUR", amount: 5 }, notes: { why: [1, "a"] }, };');
    expect(actions).toContain('$record.label = { value: "touched" };');
    expect(actions).toContain("$record.refund = null;");
  });

  test("explain prints the literal as the action assigns it", () => {
    const invoice = document().entities.find((entity) => entity.name === "Invoice")!;
    const lines = explainAction(invoice, "close", document())!;
    const steps = lines.map((line) => line.trim().replace(/^steps\s+/, ""));
    expect(steps).toContain('set &status = {"state":"closed","fee":{"currency":"EUR","amount":5},"notes":{"why":[1,"a"]}}');
    expect(steps).toContain('set &label = {"value":"touched"}');
  });

  test("a filter and a sort type name no concept member", async () => {
    const types = await text(".mesh/domain/billing/invoice.types.ts");
    const filter = types.slice(types.indexOf("export type InvoiceFilter"));
    expect(filter.slice(0, filter.indexOf("};"))).not.toMatch(/total|refund|status|label/);
    expect(types).not.toContain('"total"');
  });

  test("conceptTypeImport names a concept from any generated file by one rule", () => {
    expect(conceptTypeImport(document(), "Money", "schema.ts")).toEqual({ local: "$Money$concept", specifier: "./domain/money.concept" });
    expect(conceptTypeImport(document(), "billing.Status", "schema.ts")).toEqual({ local: "$billing$Status$concept", specifier: "./domain/billing/status.concept" });
    expect(conceptTypeImport(document(), "Money", "domain/billing/invoice.types")).toEqual({ local: "$Money$concept", specifier: "../money.concept" });
    expect(() => conceptTypeImport(document(), "Nope", "schema.ts")).toThrow("The concept Nope is not in the model");
  });

  test("the generated tree type-checks, and a concept member read off a record is read-only", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-concept-members-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const config = configOf(root);
    const files = await generateFiles({ document: document(), config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { invoice: {}, mesh_outbox: {}, mesh_outbox_state: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    await writeFile(resolve(root, "use.ts"), [
      'import type { Invoice, OpenInvoiceInput } from "./generated/domain/billing/index";',
      'import { Paid } from "./generated/domain/billing/paid.event";',
      "declare const invoice: Invoice;",
      "// @ts-expect-error a concept value is replaced whole, never changed in place",
      "invoice.total.amount = 2;",
      "const refund: number | undefined = invoice.refund?.amount;",
      'const input: OpenInvoiceInput = { total: { currency: "EUR", amount: 1 }, status: { state: "open", fee: null, notes: null }, label: { value: "x" } };',
      "// @ts-expect-error a missing field of the concept",
      'const missing: OpenInvoiceInput = { total: { currency: "EUR" }, status: { state: "open", fee: null, notes: null }, label: { value: "x" } };',
      'const paid = new Paid({ id: "00000000-0000-0000-0000-000000000000", total: { currency: "EUR", amount: 1 } });',
      "export { refund, input, missing, paid };",
      "",
    ].join("\n"));
    const checked = await checkTypes(root, [...files.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts"), resolve(root, "use.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
  }, 60_000);
});

test("a set literal of a concept with a field named `source` is printed as a literal, not read as a function", async () => {
  const document = documentOf({
    [`${D}concepts/Ref.mesh.mx`]: "concept :Ref\n  string :source\n  integer :line\n",
    [`${D}doc.mesh.mx`]: "entity :Doc\n  attributes\n    uuid :id primary-key\n    Ref :origin\n  actions auto=[:read]\n    update :u\n      do\n        set\n          &origin={ source: \"a.ts\", line: 3 }\n",
  });
  const files = await generateFiles({ document, config: configOf("/project", ".mesh") });
  const actions = files.find((file) => file.path === ".mesh/domain/doc.actions.ts")!.contents.replace(/\s+/g, " ");
  expect(actions).toContain('$record.origin = { source: "a.ts", line: 3 };');
  expect(explainAction(document.entities[0]!, "u", document)!.map((line) => line.trim().replace(/^steps\s+/, ""))).toContain('set &origin = {"source":"a.ts","line":3}');
});
