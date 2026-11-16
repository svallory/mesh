// An entity's name may be written in any casing (`notes/spec/names.md`, ADR-0086's CMP-28 amendment): Mesh converts it as it
// converts an event's or a command's (`classNameOf`: the first letter is upper case, each `_` is dropped and the letter after
// it is upper case), and the converted name is the entity's name everywhere: `Entity.name`, the FQN, the default table, the
// name another file imports and the name the entity's own file relates to itself by. Casing is never an error;
// `MESH_ENTITY_NAME` reports only a name that converts to no identifier. What `mesh build` generates from such a name, type
// checked and run on SQLite, is `packages/cli/test/generated-names.test.ts`.
import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";

const build = (files: Record<string, string>) =>
  buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message]);
const entity = (name: string, rest = "") => `entity :${name}${rest}\n  attributes\n    uuid :id primary-key\n`;

describe("the name is converted", () => {
  test.each([
    // written, name, table
    ["todo", "Todo", "todo"],
    ["invoice_line", "InvoiceLine", "invoice_line"],
    ["invoiceLine", "InvoiceLine", "invoice_line"],
    ["Invoice_line", "InvoiceLine", "invoice_line"],
    // The table is the snake_case of the converted name, not of the written one: `todo2`, not `todo_2`.
    ["Todo_2", "Todo2", "todo2"],
    ["a1", "A1", "a1"],
    // A `_` in front, at the end or doubled is dropped like any other.
    ["_todo", "Todo", "todo"],
    ["_Todo", "Todo", "todo"],
    ["todo_", "Todo", "todo"],
    ["invoice__line", "InvoiceLine", "invoice_line"],
    // Only the first letter of each word changes: the rest keeps its casing.
    ["hTTPLog", "HTTPLog", "http_log"],
    ["http_LOG", "HttpLOG", "http_log"],
  ])("entity :%s is %s, stored in %s", (written, name, table) => {
    const result = build({ "billing/thing.mesh.mx": entity(written) });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities).toMatchObject([{ name, fqn: `billing.${name}`, table, module: "billing" }]);
  });

  // The legal neighbours every build before the conversion accepted: each is the conversion's fixed point.
  test.each(["Todo", "TodoItem", "HTTPLog", "Todo2", "A"])("a PascalCase name stays as written: entity :%s", (name) => {
    const result = build({ "thing.mesh.mx": entity(name) });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities).toMatchObject([{ name, fqn: name }]);
  });

  test("table= names the table whatever the name converts to", () => {
    const result = build({ "billing/line.mesh.mx": entity("invoice_line", ' table="lines"') });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities).toMatchObject([{ name: "InvoiceLine", fqn: "billing.InvoiceLine", table: "lines" }]);
  });
});

describe("MESH_ENTITY_NAME: a name that converts to no identifier", () => {
  test.each([
    ["_1", "`1`"],
    ["__2x", "`2x`"],
    ["_1_todo", "`1Todo`"],
    ["_", "nothing"],
    ["__", "nothing"],
  ])("entity :%s is refused once, at the entity line, with the converted form", (written, converted) => {
    const result = build({ "billing/thing.mesh.mx": entity(written) });
    expect(result.document).toBeNull();
    expect(brief(result.diagnostics)).toEqual([["billing/thing.mesh.mx", 1, 0, "MESH_ENTITY_NAME",
      `Entity :${written} converts to ${converted}, which is no class name: Mesh drops each \`_\` and capitalises the letter after it, so the name needs a letter${converted === "nothing" ? "" : " before any digit"}, such as :Todo`]]);
  });

  // A digit is refused only in front: after a letter it is part of the name.
  test.each([["todo_1", "Todo1"], ["_a1", "A1"], ["a_1_b", "A1B"]])("entity :%s has a letter first and is %s", (written, name) => {
    const result = build({ "thing.mesh.mx": entity(written) });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities[0]!.name).toBe(name);
  });

  test("a character the name slot refuses never reaches the check: it is MESH_SYNTAX", () => {
    for (const written of ["invoice-line", "todo$", "1todo"]) {
      const codes = build({ "thing.mesh.mx": entity(written) }).diagnostics.map((d) => d.code);
      expect(codes, written).not.toContain("MESH_ENTITY_NAME");
      expect(codes.length, written).toBeGreaterThan(0);
    }
  });
});

describe("MESH_DUPLICATE_ENTITY: two names of one module that convert alike", () => {
  test("todo and Todo in one module share an FQN", () => {
    const result = build({ "work/a.mesh.mx": entity("todo"), "work/b.mesh.mx": entity("Todo") });
    expect(brief(result.diagnostics)).toEqual([["work/b.mesh.mx", 1, 0, "MESH_DUPLICATE_ENTITY", "Duplicate entity work.Todo; first declared in work/a.mesh.mx"]]);
  });

  test("every spelling of one name collides: invoice_line, invoiceLine and InvoiceLine", () => {
    const result = build({ "a.mesh.mx": entity("invoice_line"), "b.mesh.mx": entity("invoiceLine"), "c.mesh.mx": entity("InvoiceLine") });
    expect(brief(result.diagnostics)).toEqual([
      ["b.mesh.mx", 1, 0, "MESH_DUPLICATE_ENTITY", "Duplicate entity InvoiceLine; first declared in a.mesh.mx"],
      ["c.mesh.mx", 1, 0, "MESH_DUPLICATE_ENTITY", "Duplicate entity InvoiceLine; first declared in a.mesh.mx"],
    ]);
  });

  test("the same spellings in two modules are two entities, and so are two names that convert apart", () => {
    expect(build({ "work/a.mesh.mx": entity("todo"), "home/a.mesh.mx": entity("Todo") }).diagnostics).toEqual([]);
    // `todo_item` is `TodoItem`; `todoitem` is `Todoitem`: no `_` and no capital marks a second word.
    const apart = build({ "work/a.mesh.mx": entity("todo_item"), "work/b.mesh.mx": entity("todoitem") });
    expect(apart.diagnostics).toEqual([]);
    expect(apart.document!.entities.map((e) => e.fqn)).toEqual(["work.TodoItem", "work.Todoitem"]);
  });
});

describe("another file names the entity by its converted name", () => {
  const line = `${entity("invoice_line")}  actions auto=[:read]\n`;
  const invoice = (imports: string, reference: string) => `${imports}\nentity :invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :line entity=${reference}\n`;
  const files = (imports: string, reference: string) => ({ "billing/line.mesh.mx": line, "billing/invoice.mesh.mx": invoice(imports, reference) });

  test.each([
    ["by name", 'import { InvoiceLine } from "./line.mesh.mx"', "InvoiceLine"],
    ["under an alias", 'import { InvoiceLine as Line } from "./line.mesh.mx"', "Line"],
    // An alias is the author's own name: the written spelling of the entity is free for it.
    ["under the written spelling as an alias", 'import { InvoiceLine as invoice_line } from "./line.mesh.mx"', "invoice_line"],
    ["as a member of a namespace import", 'import * as lines from "./line.mesh.mx"', "lines.InvoiceLine"],
  ])("an import %s resolves", (_, imports, reference) => {
    const result = build(files(imports, reference));
    expect(result.diagnostics).toEqual([]);
    const owner = result.document!.entities.find((e) => e.fqn === "billing.Invoice")!;
    expect(owner.relationships).toMatchObject([{ kind: "belongs-to", entity: { identifier: reference, from: "./line.mesh.mx" }, keyColumn: "lineId", keyType: "uuid" }]);
  });

  test("the written spelling is not what the file declares", () => {
    expect(brief(build(files('import { invoice_line } from "./line.mesh.mx"', "invoice_line")).diagnostics)).toEqual([
      ["billing/invoice.mesh.mx", 1, 9, "MESH_UNKNOWN_IMPORT", "`invoice_line` is not what ./line.mesh.mx declares; it declares `InvoiceLine`"],
    ]);
    expect(brief(build(files('import * as lines from "./line.mesh.mx"', "lines.invoice_line")).diagnostics)).toEqual([
      ["billing/invoice.mesh.mx", 6, 34, "MESH_UNKNOWN_ENTITY", "lines.invoice_line is not an imported entity: ./line.mesh.mx declares `InvoiceLine`. Did you mean lines.InvoiceLine?"],
    ]);
  });
});

describe("inside its own file an entity names itself by the converted name", () => {
  const tree = (reference: string, imports = "") => `${imports}entity :work_item
  attributes
    uuid :id primary-key
  relationships
    belongs-to :parent entity=${reference} nullable
    has-many :children entity=${reference}
  actions auto=[:read]
`;

  test("entity=WorkItem in entity :work_item needs no import", () => {
    const result = build({ "work/item.mesh.mx": tree("WorkItem") });
    expect(result.diagnostics).toEqual([]);
    const [item] = result.document!.entities;
    expect(item).toMatchObject({ name: "WorkItem", fqn: "work.WorkItem", table: "work_item", imports: [] });
    expect(item!.relationships).toMatchObject([
      { kind: "belongs-to", entity: { identifier: "WorkItem", from: "./item.mesh.mx" }, keyColumn: "parentId" },
      { kind: "has-many", entity: { identifier: "WorkItem", from: "./item.mesh.mx" }, inverse: "parent" },
    ]);
  });

  test("the written spelling is no name of the file: it is an unknown entity", () => {
    // The advice is the nearest name within two edits, as for any unknown entity: `work_item` is three edits from `WorkItem`.
    expect(brief(build({ "work/item.mesh.mx": tree("work_item") }).diagnostics)).toEqual([
      ["work/item.mesh.mx", 5, 30, "MESH_UNKNOWN_ENTITY", "work_item is not an imported entity."],
      ["work/item.mesh.mx", 6, 30, "MESH_UNKNOWN_ENTITY", "work_item is not an imported entity."],
    ]);
    const todo = "entity :todo\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :parent entity=todo nullable\n";
    expect(brief(build({ "work/todo.mesh.mx": todo }).diagnostics)).toEqual([
      ["work/todo.mesh.mx", 5, 30, "MESH_UNKNOWN_ENTITY", "todo is not an imported entity. Did you mean Todo?"],
    ]);
  });

  test("the written spelling is free for an import of the file: it names what the import binds", () => {
    const item = `import { Board as work_item } from "./board.mesh.mx"
${entity("work_item")}  relationships
    belongs-to :board entity=work_item
    belongs-to :parent entity=WorkItem nullable
  actions auto=[:read]
`;
    const result = build({ "work/item.mesh.mx": item, "work/board.mesh.mx": `${entity("board")}  actions auto=[:read]\n` });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities.find((e) => e.name === "WorkItem")!.relationships).toMatchObject([
      { name: "board", entity: { identifier: "work_item", from: "./board.mesh.mx" } },
      { name: "parent", entity: { identifier: "WorkItem", from: "./item.mesh.mx" } },
    ]);
  });

  test("a self-import takes the converted name too", () => {
    expect(build({ "work/item.mesh.mx": tree("WorkItem", 'import { WorkItem } from "./item.mesh.mx"\n') }).diagnostics).toEqual([]);
    expect(brief(build({ "work/item.mesh.mx": tree("WorkItem", 'import { work_item } from "./item.mesh.mx"\n') }).diagnostics)).toEqual([
      ["work/item.mesh.mx", 1, 9, "MESH_UNKNOWN_IMPORT", "`work_item` is not what ./item.mesh.mx declares; it declares `WorkItem`"],
    ]);
  });

  test("a has-many finds the belongs-to named after the converted name in lower camel case", () => {
    const owner = `import { Step } from "./step.mesh.mx"\n${entity("work_item")}  relationships\n    has-many :steps entity=Step\n  actions auto=[:read]\n`;
    const step = `import { WorkItem } from "./item.mesh.mx"\n${entity("step")}  relationships\n    belongs-to :workItem entity=WorkItem\n    belongs-to :blockedBy entity=WorkItem nullable\n  actions auto=[:read]\n`;
    const result = build({ "work/item.mesh.mx": owner, "work/step.mesh.mx": step });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities.find((e) => e.name === "WorkItem")!.relationships).toMatchObject([{ kind: "has-many", inverse: "workItem" }]);
  });
});
