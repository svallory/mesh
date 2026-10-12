// CMP-17: generated imports follow folder modules. Every module that holds an entity gets one index,
// `.mesh/domain/<module>/index.ts` (`.mesh/domain/index.ts` for the domain root), imported as `#mesh/domain/<module>`;
// `#mesh` (`.mesh/index.ts`) keeps only the framework's names. These tests pin the layout, the per-module contents and
// the names that must never collide; packages/data-sqlite/test/modules.test.ts runs it against SQLite through the
// package.json `imports` mapping.
import { describe, expect, test } from "bun:test";
import type { ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles } from "../src/typescript/emit.ts";
import { moduleSpecifier } from "../src/typescript/views/inputs.ts";
import { moduleViews } from "../src/typescript/views/module.ts";
import { configOf } from "./generated.ts";

const entity = (name: string, actions = "  actions auto=[:read]\n    create :create\n      input\n        &label\n") =>
  `entity :${name}\n  attributes\n    uuid :id primary-key\n    string :label\n${actions}`;

function documentOf(files: Record<string, string>): ModelDocument {
  const built = buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.document!;
}

/** Every Mesh file name at the top of `.mesh/` (and `domain`, the folder the modules live in) as a module name. */
const TOP_LEVEL = ["schema", "load", "index", "binding", "composition", "model", "domain"];
const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);

const domain = {
  "tag.mesh.mx": entity("Tag"),
  "sales/orders/order.mesh.mx": entity("Order"),
  "sales/orders/line.mesh.mx": entity("Line", ""),
  "billing/invoice.mesh.mx": entity("Invoice"),
  ...Object.fromEntries(TOP_LEVEL.map((module) => [`${module}/${module}-thing.mesh.mx`, entity(`${pascal(module)}Thing`)])),
};

const generate = () => generateFiles({ document: documentOf(domain), config: configOf("/project", ".mesh") });
const contentsOf = async (path: string) => (await generate()).find((file) => file.path === path)?.contents;

describe("the layout", () => {
  test("one index per module that holds an entity, under .mesh/domain/, and Mesh's own files beside it", async () => {
    const paths = (await generate()).map((file) => file.path);
    expect(paths.filter((path) => path.endsWith("/index.ts"))).toEqual([
      ".mesh/domain/billing/index.ts",
      ".mesh/domain/binding/index.ts",
      ".mesh/domain/composition/index.ts",
      ".mesh/domain/domain/index.ts",
      ".mesh/domain/index.ts",
      ".mesh/domain/index/index.ts",
      ".mesh/domain/load/index.ts",
      ".mesh/domain/model/index.ts",
      ".mesh/domain/sales/orders/index.ts",
      ".mesh/domain/schema/index.ts",
      ".mesh/index.ts",
    ]);
    // Mesh's top-level files stay where they were, whatever the modules are called.
    for (const path of [".mesh/index.ts", ".mesh/binding.ts", ".mesh/composition.ts", ".mesh/model.json"]) expect(paths).toContain(path);
    // Every entity file sits in its module's folder, next to the module's index.
    expect(paths).toContain(".mesh/domain/tag.actions.ts");
    expect(paths).toContain(".mesh/domain/sales/orders/order.actions.ts");
    expect(paths).toContain(".mesh/domain/schema/schemaThing.types.ts");
    expect(paths.filter((path) => !path.startsWith(".mesh/domain/")).sort()).toEqual([".mesh/binding.ts", ".mesh/composition.ts", ".mesh/index.ts", ".mesh/model.json"]);
  });

  test("a folder that holds only modules, not entities, has no index: sales/ has none, sales/orders/ has one", async () => {
    const paths = (await generate()).map((file) => file.path);
    expect(paths).not.toContain(".mesh/domain/sales/index.ts");
    expect(paths.filter((path) => path.startsWith(".mesh/domain/sales/") && !path.startsWith(".mesh/domain/sales/orders/"))).toEqual([]);
  });

  test("a domain with only root entities writes .mesh/domain/index.ts and no module folder", async () => {
    const files = await generateFiles({ document: documentOf({ "tag.mesh.mx": entity("Tag") }), config: configOf("/project", ".mesh") });
    expect(files.map((file) => file.path).filter((path) => path.startsWith(".mesh/domain/"))).toEqual(
      [".mesh/domain/index.ts", ".mesh/domain/tag.actions.ts", ".mesh/domain/tag.types.ts", ".mesh/domain/tag.validators.ts"]);
  });

  test("the specifier of a module is #mesh/domain, then its path", () => {
    expect(moduleSpecifier("")).toBe("#mesh/domain");
    expect(moduleSpecifier("billing")).toBe("#mesh/domain/billing");
    expect(moduleSpecifier("sales/orders")).toBe("#mesh/domain/sales/orders");
    expect(moduleSpecifier("index")).toBe("#mesh/domain/index");
  });

  test("group folders are not modules: an entity in tasks/_services/ is in module tasks's index", async () => {
    const files = await generateFiles({ document: documentOf({ "tasks/_services/runner.mesh.mx": entity("Runner") }), config: configOf("/project", ".mesh") });
    expect(files.map((file) => file.path).filter((path) => path.endsWith("/index.ts"))).toEqual([".mesh/domain/tasks/index.ts", ".mesh/index.ts"]);
    expect(files.find((file) => file.path === ".mesh/domain/tasks/index.ts")!.contents).toContain("export async function createRunner(");
  });

  test("two module folders that differ only in letter case are MESH_EMIT_PATH, naming both index files", async () => {
    const document = documentOf({ "Sales/order.mesh.mx": entity("Order"), "sales/line.mesh.mx": entity("Line") });
    const error = await generateFiles({ document, config: configOf("/project", ".mesh") }).then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_PATH",
      message: "Generated path collision: .mesh/domain/sales/index.ts and .mesh/domain/Sales/index.ts differ only in letter case",
      fix: "Rename one of the two module folders so that they differ in more than letter case",
      position: { file: "sales/line.mesh.mx" },
    });
  });
});

describe("what each index holds", () => {
  test("#mesh re-exports bind, connect, disconnect, transaction, Actions, ReadOnlyActions, ReadOnlyReads, Reads and tables, and names every module in its header", async () => {
    const index = (await contentsOf(".mesh/index.ts"))!;
    const code = index.split("\n").filter((line) => !line.startsWith("//")).join("\n").trim();
    expect(code).toBe([
      'export { bind, connect, disconnect, transaction } from "./binding";',
      'export type { Actions, ReadOnlyActions, ReadOnlyReads, Reads } from "./composition";',
      'export { tables } from "./schema";',
    ].join("\n"));
    for (const specifier of ["#mesh/domain", "#mesh/domain/billing", "#mesh/domain/sales/orders", "#mesh/domain/schema"])
      expect(index).toContain(`//   "${specifier}"\n`);
  });

  test("a nested module's index exports its own entities' functions and types, and nothing of another module", async () => {
    const orders = (await contentsOf(".mesh/domain/sales/orders/index.ts"))!;
    expect(orders).toContain('// Import it as "#mesh/domain/sales/orders"');
    expect(orders).toContain('import { $delegate } from "../../../binding";');
    expect(orders).toContain('from "./order.types";');
    expect(orders).toContain('from "./line.types";');
    expect(orders).toContain("export async function createOrder(");
    expect(orders).toContain("export async function readOrder(");
    expect(orders).not.toMatch(/Invoice|Tag\b|createTag|SchemaThing/);
    // Line has no action: its record type is exported, and it adds no function.
    expect(moduleViews({ document: documentOf(domain), config: configOf("/project", ".mesh") })
      .find(({ view }) => view.module === "sales/orders")!.view).toMatchObject({
      types: ["Line", "Order", "CreateOrderInput", "ReadOrderInput", "OrderFilter", "OrderSort"],
      functions: [{ name: "createOrder" }, { name: "readOrder" }],
    });
  });

  test("the root module's index reaches binding.ts one folder up", async () => {
    const root = (await contentsOf(".mesh/domain/index.ts"))!;
    expect(root).toContain("from the entity files of the domain root;");
    expect(root).toContain('// Import it as "#mesh/domain":');
    expect(root).toContain('import { $delegate } from "../binding";');
    expect(root).toContain("export async function createTag(");
  });

  test.each(TOP_LEVEL)("a module named %s gets its own index, and Mesh's top-level file keeps its contents", async (module) => {
    const files = await generate();
    const own = files.find((file) => file.path === `.mesh/domain/${module}/index.ts`)!.contents;
    expect(own).toContain(`// Import it as "#mesh/domain/${module}"`);
    expect(own).toContain(`export async function create${pascal(module)}Thing(`);
    expect(own).toContain('import { $delegate } from "../../binding";');
    const index = files.find((file) => file.path === ".mesh/index.ts")!.contents;
    expect(index).not.toContain(`${pascal(module)}Thing`);
    expect(files.find((file) => file.path === ".mesh/binding.ts")!.contents)
      .toContain(`from "./domain/${module}/${module}Thing.actions";`);
  });

  test("a module without actions imports neither $delegate nor the context type", async () => {
    const files = await generateFiles({ document: documentOf({ "tag.mesh.mx": entity("Tag", "") }), config: configOf("/project", ".mesh") });
    const root = files.find((file) => file.path === ".mesh/domain/index.ts")!.contents;
    expect(root).not.toContain("$delegate");
    expect(root).not.toContain("$ContextArgument");
    expect(root).toContain("export type { Tag };");
  });
});

describe("names across modules", () => {
  // The behaviour before CMP-17 is kept: a project-wide name is still project-wide, even though the module indexes
  // would no longer clash. `actions`, `tx` and what `bind` returns are flat records by action function name.
  test("two entities of one name in two modules build a model, then fail the build on `bind<Entity>`", async () => {
    const document = documentOf({ "a/note.mesh.mx": entity("Note"), "b/note.mesh.mx": entity("Note") });
    expect(document.entities.map((e) => `${e.module}/${e.name}`)).toEqual(["a/Note", "b/Note"]);
    const error = await generateFiles({ document, config: configOf("/project", ".mesh") }).then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "Entity b.Note's binding and Entity a.Note's binding (a/note.mesh.mx:1:1) both become the top-level name `bindNote`",
    });
  });

  test("two action functions of one name in two modules are MESH_EMIT_NAME, though each module's index alone would hold it", async () => {
    // `:forUser` of Item and `:for` of UserItem are both `forUserItem`.
    const document = documentOf({
      "a/item.mesh.mx": entity("Item", "  actions\n    read :forUser\n"),
      "b/user-item.mesh.mx": entity("UserItem", "  actions\n    read :for\n"),
    });
    const error = await generateFiles({ document, config: configOf("/project", ".mesh") }).then(() => undefined, (cause: unknown) => cause);
    expect((error as EmitError).diagnostic).toMatchObject({ code: "MESH_EMIT_NAME",
      fix: "Rename one of them: every action function is a member of `actions` and of what `bind` returns, by name" });
  });
});
