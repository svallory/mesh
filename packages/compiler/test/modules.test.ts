// CMP-17, CMP-18: generated imports follow folders. Every folder of the domain that holds an entity, or a folder below it
// that does, gets one barrel, `.mesh/domain/<path>/index.ts` (`.mesh/domain/index.ts` for the domain root, always
// written), imported as `#mesh/domain/<path>`: each entity's value and types, and `export * as <name>` for each
// subfolder (PRJ-21 names it). `#mesh` (`.mesh/index.ts`) keeps only the framework's names. These tests pin the layout,
// each barrel's contents and the names that must never collide (CMP-05); packages/data-sqlite/test/modules.test.ts
// runs it against SQLite through the package.json `imports` mapping.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { moduleSpecifier } from "../src/typescript/views/inputs.ts";
import { moduleViews, namespaceName } from "../src/typescript/views/module.ts";
import { checkTypes, configOf } from "./generated.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const entity = (name: string, actions = "  actions auto=[:read]\n    create :create\n      input\n        &label\n") =>
  `entity :${name}\n  attributes\n    uuid :id primary-key\n    string :label\n${actions}`;

function documentOf(files: Record<string, string>): ModelDocument {
  const built = buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.document!;
}

/** Every Mesh file name at the top of `.mesh/` (and `domain`, the folder the modules live in) as a module name. */
const TOP_LEVEL = ["schema", "load", "index", "binding", "model", "domain"];
const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);

const domain = {
  "tag.mesh.mx": entity("Tag"),
  "sales/orders/order.mesh.mx": entity("Order"),
  "sales/orders/line.mesh.mx": entity("Line", ""),
  "billing/invoice.mesh.mx": entity("Invoice"),
  ...Object.fromEntries(TOP_LEVEL.map((module) => [`${module}/${module}-thing.mesh.mx`, entity(`${pascal(module)}Thing`)])),
};

const generate = () => generateFiles({ document: documentOf(domain), config: configOf("/project", ".mesh") });
/** A generated file without its comment lines: what it exports. */
const code = (contents: string) => contents.split("\n").filter((line) => !line.startsWith("//")).join("\n").trim();
const contentsOf = async (path: string) => (await generate()).find((file) => file.path === path)?.contents;

describe("the layout", () => {
  test("one barrel per folder that holds an entity or a folder that does, under .mesh/domain/, and Mesh's own files beside them", async () => {
    const paths = (await generate()).map((file) => file.path);
    expect(paths.filter((path) => path.endsWith("/index.ts"))).toEqual([
      ".mesh/domain/billing/index.ts",
      ".mesh/domain/binding/index.ts",
      ".mesh/domain/domain/index.ts",
      ".mesh/domain/index.ts",
      ".mesh/domain/index/index.ts",
      ".mesh/domain/load/index.ts",
      ".mesh/domain/model/index.ts",
      ".mesh/domain/sales/index.ts",
      ".mesh/domain/sales/orders/index.ts",
      ".mesh/domain/schema/index.ts",
      ".mesh/index.ts",
    ]);
    // Mesh's top-level files stay where they were, whatever the modules are called.
    for (const path of [".mesh/index.ts", ".mesh/binding.ts", ".mesh/model.json"]) expect(paths).toContain(path);
    // Every entity file sits in its module's folder, next to the module's barrel.
    expect(paths).toContain(".mesh/domain/tag.actions.ts");
    expect(paths).toContain(".mesh/domain/sales/orders/order.actions.ts");
    expect(paths).toContain(".mesh/domain/schema/schemaThing.types.ts");
    expect(paths.filter((path) => !path.startsWith(".mesh/domain/")).sort()).toEqual([".mesh/$globals.ts", ".mesh/binding.ts", ".mesh/index.ts", ".mesh/model.json"]);
  });

  test("a folder that holds only folders, not entities, has a barrel of namespaces: sales/ reaches sales/orders/", async () => {
    const files = await generate();
    const paths = files.map((file) => file.path);
    expect(paths.filter((path) => path.startsWith(".mesh/domain/sales/") && !path.startsWith(".mesh/domain/sales/orders/"))).toEqual([".mesh/domain/sales/index.ts"]);
    const sales = files.find((file) => file.path === ".mesh/domain/sales/index.ts")!.contents;
    expect(sales).toContain('from the entity files of folder "sales";');
    expect(code(sales)).toBe('export * as orders from "./orders/index";');
    expect(code(files.find((file) => file.path === ".mesh/domain/index.ts")!.contents)).toContain('export * as sales from "./sales/index";');
  });

  test("a folder whose entities are all deeper gets a barrel at every level down to them", async () => {
    const files = await generateFiles({ document: documentOf({ "a/b/c/deep.mesh.mx": entity("Deep") }), config: configOf("/project", ".mesh") });
    const barrel = (path: string) => code(files.find((file) => file.path === path)!.contents);
    expect(files.map((file) => file.path).filter((path) => path.endsWith("/index.ts")))
      .toEqual([".mesh/domain/a/b/c/index.ts", ".mesh/domain/a/b/index.ts", ".mesh/domain/a/index.ts", ".mesh/domain/index.ts", ".mesh/index.ts"]);
    expect(barrel(".mesh/domain/index.ts")).toBe('export * as a from "./a/index";');
    expect(barrel(".mesh/domain/a/index.ts")).toBe('export * as b from "./b/index";');
    expect(barrel(".mesh/domain/a/b/index.ts")).toBe('export * as c from "./c/index";');
    expect(barrel(".mesh/domain/a/b/c/index.ts")).toContain('export { Deep } from "./deep.actions";');
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

  test("group folders are not modules: an entity in tasks/_services/ is in module tasks's barrel", async () => {
    const files = await generateFiles({ document: documentOf({ "tasks/_services/runner.mesh.mx": entity("Runner") }), config: configOf("/project", ".mesh") });
    expect(files.map((file) => file.path).filter((path) => path.endsWith("/index.ts"))).toEqual([".mesh/domain/index.ts", ".mesh/domain/tasks/index.ts", ".mesh/index.ts"]);
    expect(files.find((file) => file.path === ".mesh/domain/tasks/index.ts")!.contents).toContain('export { Runner } from "./runner.actions";');
    expect(code(files.find((file) => file.path === ".mesh/domain/index.ts")!.contents)).toBe('export * as tasks from "./tasks/index";');
  });

  test("two module folders that differ only in letter case are MESH_EMIT_PATH, naming both index files", async () => {
    // In the parent's barrel the two namespaces differ in case too, so only the paths can collide.
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

describe("what each barrel holds", () => {
  test("#mesh re-exports bind, connect, disconnect, transaction, Binding, privileged, Privileged and tables, and names every module in its header", async () => {
    const index = (await contentsOf(".mesh/index.ts"))!;
    expect(code(index)).toBe([
      'export { bind, connect, disconnect, transaction, type Binding } from "./binding";',
      'export { privileged, type Privileged } from "@meshfw/runtime";',
      'export { tables } from "./schema";',
    ].join("\n"));
    for (const specifier of ["#mesh/domain", "#mesh/domain/billing", "#mesh/domain/sales/orders", "#mesh/domain/schema"])
      expect(index).toContain(`//   "${specifier}"\n`);
  });

  test("a nested module's barrel exports its own entities' values and types, and nothing of another module", async () => {
    const orders = (await contentsOf(".mesh/domain/sales/orders/index.ts"))!;
    expect(orders).toContain('// Import it as "#mesh/domain/sales/orders"');
    expect(code(orders)).toBe([
      'export { Line } from "./line.actions";',
      'export { Order } from "./order.actions";',
      'export type { CreateOrderInput, ReadOrderInput, OrderFilter, OrderSort } from "./order.types";',
    ].join("\n"));
    // Line has no action: its value (with no member) and its record type are exported, and nothing else of it.
    expect(moduleViews({ document: documentOf(domain), config: configOf("/project", ".mesh") })
      .find(({ view }) => view.module === "sales/orders")!.view).toMatchObject({
      entities: [{ name: "Line", types: [], hasTypes: false }, { name: "Order", types: ["CreateOrderInput", "ReadOrderInput", "OrderFilter", "OrderSort"] }],
      namespaces: [],
    });
  });

  test("the root barrel exports the root entities and one namespace per top folder, and imports nothing", async () => {
    const root = (await contentsOf(".mesh/domain/index.ts"))!;
    expect(root).toContain("from the entity files of the domain root;");
    expect(root).toContain('// Import it as "#mesh/domain":');
    expect(root).not.toMatch(/^import /m);
    expect(code(root)).toBe([
      'export { Tag } from "./tag.actions";',
      'export type { CreateTagInput, ReadTagInput, TagFilter, TagSort } from "./tag.types";',
      'export * as billing from "./billing/index";',
      'export * as binding from "./binding/index";',
      'export * as domain from "./domain/index";',
      'export * as index from "./index/index";',
      'export * as load from "./load/index";',
      'export * as model from "./model/index";',
      'export * as sales from "./sales/index";',
      'export * as schema from "./schema/index";',
    ].join("\n"));
  });

  test.each(TOP_LEVEL)("a module named %s gets its own barrel, and Mesh's top-level file keeps its contents", async (module) => {
    const files = await generate();
    const own = files.find((file) => file.path === `.mesh/domain/${module}/index.ts`)!.contents;
    expect(own).toContain(`// Import it as "#mesh/domain/${module}"`);
    expect(own).toContain(`export { ${pascal(module)}Thing } from "./${module}Thing.actions";`);
    const index = files.find((file) => file.path === ".mesh/index.ts")!.contents;
    expect(index).not.toContain(`${pascal(module)}Thing`);
    // `bind` walks the root barrel, which reaches the module through its namespace.
    expect(files.find((file) => file.path === ".mesh/binding.ts")!.contents).toContain('import * as $domain from "./domain/index";');
    expect(files.find((file) => file.path === ".mesh/domain/index.ts")!.contents).toContain(`export * as ${module} from "./${module}/index";`);
  });

  test("an entity without actions is exported as its value and its record type, and its barrel imports nothing", async () => {
    const files = await generateFiles({ document: documentOf({ "tag.mesh.mx": entity("Tag", "") }), config: configOf("/project", ".mesh") });
    expect(code(files.find((file) => file.path === ".mesh/domain/index.ts")!.contents)).toBe('export { Tag } from "./tag.actions";');
  });
});

describe("folder names as export names (PRJ-21)", () => {
  test("a character invalid in an identifier becomes `_`, a leading digit gets `_` in front, and a reserved word stays", () => {
    expect(namespaceName("billing")).toBe("billing");
    expect(namespaceName("order-management")).toBe("order_management");
    expect(namespaceName("2024-reports")).toBe("_2024_reports");
    expect(namespaceName("_services")).toBe("_services");
    expect(namespaceName("Billing")).toBe("Billing");
    expect(namespaceName("class")).toBe("class");
    expect(namespaceName("default")).toBe("default");
  });

  const open = (name: string) => `${entity(name)}  policies\n    policy :open\n      authorize-if=() => true\n`;

  test("folders named class and default build, type-check strictly, and are reachable as domain.class and domain.default", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-modules-reserved-"));
    roots.push(root);
    const config = configOf(root, ".mesh");
    const files = await generateFiles({
      document: documentOf({ "class/lesson.mesh.mx": open("Lesson"), "default/fallback.mesh.mx": open("Fallback"), "2024-reports/report.mesh.mx": open("Report") }),
      config,
    });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, ".mesh/schema.ts"), "export const tables = { lesson: {}, fallback: {}, report: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"),
      'export default { data: { kind: "data-adapter", name: "remote", build: "./none", capabilities: { adapter: "remote", capabilities: [] }, options: {} } };\n');
    expect(code(files.find((file) => file.path === ".mesh/domain/index.ts")!.contents)).toBe([
      'export * as _2024_reports from "./2024-reports/index";',
      'export * as class from "./class/index";',
      'export * as default from "./default/index";',
    ].join("\n"));
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
    const domain = await import(resolve(root, ".mesh/domain/index.ts"));
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const rows: object[] = [];
    const bound = mesh.bind({ transaction: (run: (tx: object) => Promise<unknown>) => run({ insert: async (_t: object, row: object) => { rows.push(row); return row; } }), refuseIfFailed: () => false, close: async () => {} });
    expect((await bound.run(() => domain.class.Lesson.create({ label: "a" }))).label).toBe("a");
    expect((await bound.run(() => domain.default.Fallback.create({ label: "b" }))).label).toBe("b");
    expect((await bound.run(() => domain._2024_reports.Report.create({ label: "c" }))).label).toBe("c");
    expect(rows).toHaveLength(3);
  }, 30_000);
});

describe("names in one barrel (CMP-05)", () => {
  const failure = async (files: Record<string, string>) => {
    const error = await generateFiles({ document: documentOf(files), config: configOf("/project", ".mesh") }).then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    return (error as EmitError).diagnostic;
  };

  test("two sibling folders whose names normalise alike are MESH_EMIT_NAME naming both folders", async () => {
    expect(await failure({ "sales/order-management/a.mesh.mx": entity("A"), "sales/order_management/b.mesh.mx": entity("B") })).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "the folder sales/order-management and the folder sales/order_management would both be exported as order_management from #mesh/domain/sales",
      fix: "Rename one of the two: an entity file, an entity or a folder",
      position: { file: "sales/order_management/b.mesh.mx" },
    });
  });

  test("an entity and a subfolder of one name are MESH_EMIT_NAME naming the entity by FQN and the folder by path", async () => {
    expect(await failure({ "sales/billing.mesh.mx": entity("Billing"), "sales/Billing/invoice.mesh.mx": entity("Invoice") })).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "entity sales.Billing and the folder sales/Billing would both be exported as Billing from #mesh/domain/sales",
      position: { file: "sales/Billing/invoice.mesh.mx" },
    });
  });

  test("a subfolder named like a type of an entity beside it is MESH_EMIT_NAME naming both", async () => {
    expect(await failure({ "order.mesh.mx": entity("Order"), "OrderFilter/x.mesh.mx": entity("X") })).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "the type OrderFilter of entity Order and the folder OrderFilter would both be exported as OrderFilter from #mesh/domain",
    });
  });
});

describe("names across modules", () => {
  // PRJ-15: nothing global in the syntax. Entities of one name in several folders build: each barrel keeps its own names
  // unique (CMP-05), and every file that names another entity does so at module level by a local derived from the FQN
  // (`entityLocal`); the alias an entity file wrote is bound only inside the functions of its expressions file. The
  // whole case run on SQLite is the CLI's same-name fixture
  // (packages/cli/test/same-name.test.ts).
  const listOf = (table: string | null, extra = "") =>
    `${extra}entity :List${table ? ` table="${table}"` : ""}\n  attributes\n    uuid :id primary-key\n    string :label\n` +
    "  computed\n    string :shout value=({ self }) => self.label.toUpperCase()\n" +
    "  actions auto=[:read]\n    create :create\n      input\n        &label\n" +
    "  policies\n    policy :open\n      authorize-if=() => true\n";
  // A root entity that names three Lists: the root one by its own name, the others under the aliases its imports wrote.
  // `Pick` is a global the types file uses, as `$Pick` from `$globals.ts`: an alias is never a module-level local in generated code.
  const board = [
    'import { List } from "./list.mesh.mx"',
    'import { List as OrderList } from "./order-management/list.mesh.mx"',
    'import { List as Pick } from "./billing/list.mesh.mx"',
    "entity :Board",
    "  attributes\n    uuid :id primary-key\n    string :label",
    "  relationships\n    belongs-to :list entity=List nullable\n    belongs-to :orderList entity=OrderList nullable\n    belongs-to :billingList entity=Pick nullable",
    "  actions auto=[:read]\n    create :create\n      input\n        &label\n        &list\n        &orderList\n        &billingList",
    "  policies\n    policy :open\n      authorize-if=() => true",
    "",
  ].join("\n");
  const project = {
    "list.mesh.mx": listOf(null),
    "board.mesh.mx": board,
    "order-management/list.mesh.mx": listOf("om_list"),
    "billing/list.mesh.mx": listOf("billing_list"),
  };

  test("a List at the root and in order-management/ and billing/ build, type-check strictly, and each writes its own table", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-modules-same-name-"));
    roots.push(root);
    const config = configOf(root, ".mesh");
    const document = documentOf(project);
    expect(document.entities.map((e) => e.fqn).sort()).toEqual(["Board", "List", "billing.List", "order-management.List"]);
    const files = await generateFiles({ document, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, ".mesh/schema.ts"),
      'export const tables = { list: { name: "list" }, board: { name: "board" }, om_list: { name: "om_list" }, billing_list: { name: "billing_list" } };\n');
    await writeFile(resolve(root, "mesh.config.ts"),
      'export default { data: { kind: "data-adapter", name: "remote", build: "./none", capabilities: { adapter: "remote", capabilities: [] }, options: {} } };\n');
    const contents = (path: string) => files.find((file) => file.path === path)!.contents;
    // load.ts: one expressions local per entity, each from its FQN; a root entity's has no folder part.
    const load = contents(".mesh/load.ts");
    for (const local of ["$List$expressions", "$order_management$List$expressions", "$billing$List$expressions"])
      expect(load).toContain(`import { $expressions as ${local} } from`);
    expect(load).not.toMatch(/\b(list|List)Expressions\b/);
    // Board's types file: every List by its FQN-derived local, whatever alias the entity file wrote.
    const types = contents(".mesh/domain/board.types.ts");
    expect(types).toContain('import type { List as $List$Record, ListLoaded as $List$Loaded } from "./list.types";');
    expect(types).toMatch(/import type \{\s*List as \$order_management\$List\$Record,\s*ListLoaded as \$order_management\$List\$Loaded,?\s*\} from "\.\/order-management\/list\.types";/);
    expect(types).toMatch(/import type \{\s*List as \$billing\$List\$Record,\s*ListLoaded as \$billing\$List\$Loaded,?\s*\} from "\.\/billing\/list\.types";/);
    expect(types).not.toMatch(/(?<![\w$])(OrderList|Pick)\b/);
    // Each barrel exports its own List and its load function, from its own actions file.
    expect(code(contents(".mesh/domain/order-management/index.ts"))).toContain('export { List, loadListFields } from "./list.actions";');
    expect(code(contents(".mesh/domain/index.ts"))).toContain('export { List, loadListFields } from "./list.actions";');
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
    const domain = await import(resolve(root, ".mesh/domain/index.ts"));
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const written: string[] = [];
    const bound = mesh.bind({
      transaction: (run: (tx: object) => Promise<unknown>) => run({ insert: async (table: { name: string }, row: object) => { written.push(table.name); return row; } }),
      refuseIfFailed: () => false, close: async () => {},
    });
    await bound.run(() => domain.List.create({ label: "root" }));
    await bound.run(() => domain.order_management.List.create({ label: "orders" }));
    await bound.run(() => domain.billing.List.create({ label: "bills" }));
    expect(written).toEqual(["list", "om_list", "billing_list"]);
    expect([domain.List, domain.order_management.List, domain.billing.List].every((value, index, all) => all.indexOf(value) === index)).toBe(true);
  }, 60_000);

  test("order-management/ and order_management/ still clash as barrels, however their entities are named", async () => {
    const error = await generateFiles({
      document: documentOf({ "order-management/list.mesh.mx": listOf(null), "order_management/list.mesh.mx": listOf("other_list") }),
      config: configOf("/project", ".mesh"),
    }).then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "the folder order-management and the folder order_management would both be exported as order_management from #mesh/domain",
    });
  });

  // No name is project-wide, no generated file imports under an authored name and generated code reaches every global
  // it uses through `$globals.ts` under a `$` name (PRJ-20: an entity named `Promise`, `Partial` or `Date` builds,
  // index.test.ts), so an entity file reaches MESH_EMIT_NAME in two ways only: two exports of one barrel (above) and a
  // duplicate generated type (here). An invalid identifier cannot come from an entity file: every name atom is one.
  test("MESH_EMIT_NAME is left for two exports of one barrel and a duplicate generated type: two actions whose input types are spelled alike name the entity by FQN (PRJ-17)", async () => {
    const item = "entity :Item\n  attributes\n    uuid :id primary-key\n  actions\n    create :fooBar\n    create :foo_bar\n";
    const error = await generateFiles({ document: documentOf({ "sales/item.mesh.mx": item }), config: configOf("/project", ".mesh") })
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "Entity sales.Item would generate the type FooBarItemInput twice",
    });
  });

  test("two actions one flat name would have spelled alike, in two modules, build: an action is called on its entity (CMP-16)", async () => {
    // `:forUser` of Item and `:for` of UserItem were both `actions.forUserItem`.
    const document = documentOf({
      "a/item.mesh.mx": entity("Item", "  actions\n    read :forUser\n"),
      "b/user-item.mesh.mx": entity("UserItem", "  actions\n    read :for\n"),
    });
    const files = await generateFiles({ document, config: configOf("/project", ".mesh") });
    expect(files.map((file) => file.path)).toContain(".mesh/domain/b/userItem.actions.ts");
  });
});
