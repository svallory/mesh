// What is generated from a `handlers` section (`notes/architecture/handlers-design.md`, PR 2, sections 5.5, 7 and 8;
// ruling D44): `<owner>.handlers.ts` beside the owner's other files, for an entity or an aggregate whose section has a
// line, exporting `$handlers` (by kind and key, with where each one is written), and the binding that merges them and
// hands them to `bindDomain`. A project without a section generates what it did. How the handlers run is
// `packages/runtime/test/declared-handlers.test.ts`, `events.test.ts` and, built by the real `mesh` command,
// `packages/bus-local/test/section-handlers.test.ts`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { mergeHandlers } from "@meshfw/runtime";
import { closeTypeServer } from "./type-server.ts";
import { checkTypes, configOf } from "./generated.ts";

type Files = Record<string, string>;
const FIXTURE = resolve(import.meta.dir, "fixtures/handlers-generated");
const GOLDEN = resolve(import.meta.dir, "fixtures/handlers-golden");
const MODULE = "domain/billing";
/** The fixture's Mesh files, by project-relative path. */
const fixtureFiles = async (): Promise<Files> => {
  const files: Files = {};
  for await (const file of new Glob(`${MODULE}/*.mesh.mx`).scan({ cwd: FIXTURE })) files[file] = await readFile(join(FIXTURE, file), "utf8");
  return files;
};
const documentOf = (root: string, files: Files) => {
  const built = buildModel({ root, domainRoot: "domain", files: Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.document!;
};
const generate = async (files: Files, root = FIXTURE) => generateFiles({ document: documentOf(root, files), config: configOf(root, ".mesh") });
const contents = (generated: Awaited<ReturnType<typeof generate>>, path: string) => generated.find((file) => file.path === path)?.contents;
/** The fixture with the `handlers` section of each file cut off (every section ends the file). */
const withoutSections = (files: Files): Files => Object.fromEntries(Object.entries(files).map(([file, source]) => [file, source.includes("  handlers\n") ? source.slice(0, source.indexOf("  handlers\n")) : source]));
const disposers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const dispose of disposers) await dispose();
  await closeTypeServer();
});

describe("the handlers generator", () => {
  test("each owner with a handler line gets its file, an aggregate included; nothing else is added or removed", async () => {
    const files = await fixtureFiles();
    const paths = (await generate(files)).map((file) => file.path);
    const before = (await generate(withoutSections(files))).map((file) => file.path);
    expect(paths.filter((path) => !before.includes(path))).toEqual([
      ".mesh/domain/billing/billing.handlers.ts",
      ".mesh/domain/billing/invoice.handlers.ts",
      ".mesh/domain/billing/ledger.handlers.ts",
    ]);
    expect(before.filter((path) => !paths.includes(path))).toEqual([]);
  });

  test("the handlers files and the binding: golden", async () => {
    const generated = await generate(await fixtureFiles());
    for (const name of ["billing.handlers.ts", "invoice.handlers.ts", "ledger.handlers.ts", "binding.ts"]) {
      const actual = contents(generated, name === "binding.ts" ? ".mesh/binding.ts" : `.mesh/${MODULE}/${name}`)!;
      const path = join(GOLDEN, `${name}.golden`);
      if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
      expect(actual).toBe(await readFile(path, "utf8"));
    }
  });

  test("H3 and H20: an empty section, or none, generates every file as a project without one does, the binding included", async () => {
    const files = await fixtureFiles();
    const bare = await generate(withoutSections(files));
    const empty = await generate(Object.fromEntries(Object.entries(withoutSections(files)).map(([file, source]) => [file, file.endsWith("ledger.mesh.mx") ? `${source}  handlers\n` : source])));
    expect(empty).toEqual(bare);
    const binding = contents(bare, ".mesh/binding.ts")!;
    expect(binding).toContain("return $bindDomain($domain, layer, options, $frame);");
    expect(binding).not.toContain("mergeHandlers");
    expect(binding).not.toContain(".handlers");
  });

  test("one owner's section alone: the binding merges that one file", async () => {
    const files = await fixtureFiles();
    const one = { ...withoutSections(files), [`${MODULE}/ledger.mesh.mx`]: files[`${MODULE}/ledger.mesh.mx`]! };
    const binding = contents(await generate(one), ".mesh/binding.ts")!;
    expect(binding).toContain('import { $handlers as $billing$Ledger$handlers } from "./domain/billing/ledger.handlers";');
    expect(binding).toContain("return $bindDomain($domain, layer, options, $frame, $mergeHandlers([$billing$Ledger$handlers]));");
  });

  test("the file declares nothing at module level a helper could be named, but the helpers the bodies read", async () => {
    const generated = await generate(await fixtureFiles());
    for (const name of ["billing", "invoice", "ledger"]) {
      const file = contents(generated, `.mesh/${MODULE}/${name}.handlers.ts`)!;
      expect(file).not.toMatch(/^(declare namespace|const|let|type|function|class|export const|export type) [^$]/m);
    }
  });

  test("the same handler name in two owners gives two keys that merge, and an aggregate named like an entity of its module is MESH_EMIT_PATH", async () => {
    const files = await fixtureFiles();
    const generated = await generate(files);
    // Invoice and Ledger both declare `listen :receipt`.
    expect(files[`${MODULE}/invoice.mesh.mx`]).toContain("listen :receipt ");
    expect(files[`${MODULE}/ledger.mesh.mx`]).toContain("listen :receipt ");
    expect(contents(generated, `.mesh/${MODULE}/invoice.handlers.ts`)).toContain('"billing.Invoice.receipt": $handler(');
    expect(contents(generated, `.mesh/${MODULE}/ledger.handlers.ts`)).toContain('"billing.Ledger.receipt": $handler(');
    // At run time the binding's merge keeps both keys (no "a key two hold" FrameworkError).
    const merged = mergeHandlers([
      { listen: { "billing.Invoice.receipt": { events: [], run: () => undefined } }, at: { "billing.Invoice.receipt": "a" } },
      { listen: { "billing.Ledger.receipt": { events: [], run: () => undefined } }, at: { "billing.Ledger.receipt": "b" } },
    ] as never) as { listen: object };
    expect(Object.keys(merged.listen).sort()).toEqual(["billing.Invoice.receipt", "billing.Ledger.receipt"]);
    const renamed = { ...files, [`${MODULE}/billing.mesh.mx`]: files[`${MODULE}/billing.mesh.mx`]!.replace("aggregate :Billing", "aggregate :Ledger") };
    const error = await generate(renamed).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_PATH",
      message: "Generated path collision: .mesh/domain/billing/ledger.handlers.ts (the handlers of billing.Ledger and of another owner of that name)",
      position: { file: `${MODULE}/billing.mesh.mx`, line: 4, column: 0 },
    });
  });
});

describe("the generated handlers type-check", () => {
  /** The fixture written to a scratch project and generated there, with `files` replacing some of its sources. */
  const project = async (replace: Files = {}) => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-handlers-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const sources = { ...(await fixtureFiles()), ...replace };
    for (const [file, source] of Object.entries(sources)) await Bun.write(join(root, file), source);
    await Bun.write(join(root, MODULE, "mailer.ts"), await readFile(join(FIXTURE, MODULE, "mailer.ts"), "utf8"));
    const config = configOf(root, ".mesh");
    const files = await generateFiles({ document: documentOf(root, sources), config });
    await writeGeneratedFiles(files, config);
    await writeFile(join(root, ".mesh/schema.ts"), "export const tables: any = {};\n");
    await writeFile(join(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    return { root, checked: [...files.filter((file) => file.path.endsWith(".ts")).map((file) => join(root, file.path)), join(root, "mesh.config.ts")] };
  };

  test("the whole tree type-checks: each body's event is the union of the events it lists", async () => {
    const { root, checked } = await project();
    expect(await checkTypes(root, checked)).toEqual({ code: 0, output: "" });
  });

  test("a body that reads a field no listed event has is a type error in the generated file", async () => {
    const files = await fixtureFiles();
    // `amount` is a field of PaymentRecorded only, and `receipt` also lists InvoicePaid.
    const ledger = files[`${MODULE}/ledger.mesh.mx`]!.replace("invoiceId: event.payload.invoiceId }) }", "invoiceId: `${event.payload.amount}` }) }");
    expect(ledger).not.toBe(files[`${MODULE}/ledger.mesh.mx`]);
    const { root, checked } = await project({ [`${MODULE}/ledger.mesh.mx`]: ledger });
    const result = await checkTypes(root, checked);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ledger.handlers.ts");
    expect(result.output).toContain("Property 'amount' does not exist on type 'InvoicePaid'");
  });
});
