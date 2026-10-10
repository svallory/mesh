import { describe, expect, test } from "bun:test";
import type { Entity, ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import type { ResolvedConfig } from "../src/config.ts";
import type { EmitInput } from "../src/typescript/emit.ts";
import { EmitError } from "../src/typescript/emit-error.ts";
import { typesView, validatorsView, type TypesView, type ValidatorsView } from "../src/index.ts";
import { project } from "./v4.ts";

/**
 * The views are the whole decision layer of the types and validators generators;
 * the templates only print them. Every `@if` and `@each` in
 * `templates/types.ts.jig` and `templates/validators.ts.jig` names the test here
 * that covers both of its sides (see the Jig port report).
 */

function documentOf(): ModelDocument {
  const built = buildModel(project());
  expect(built.diagnostics).toEqual([]);
  return built.document!;
}
const config: ResolvedConfig = {
  root: "/project",
  configFile: "/project/mesh.config.ts",
  entityFiles: [],
  domainRoot: "/project",
  data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  output: "/project/generated",
};
const inputOf = (document: ModelDocument): EmitInput => ({ document, config });
const entityOf = (document: ModelDocument, name: string): Entity =>
  document.entities.find((entity) => entity.name === name)!;
const types = (document: ModelDocument, name: string): TypesView => typesView(inputOf(document), entityOf(document, name));
const validators = (document: ModelDocument, name: string): ValidatorsView =>
  validatorsView(inputOf(document), entityOf(document, name));

describe("views are plain data", () => {
  test("synchronous, JSON round-trips unchanged, and equal on a second call", () => {
    const document = documentOf();
    for (const entity of document.entities) {
      for (const view of [typesView(inputOf(document), entity), validatorsView(inputOf(document), entity)]) {
        expect(view).not.toBeInstanceOf(Promise);
        expect(JSON.parse(JSON.stringify(view))).toEqual(view);
      }
      expect(typesView(inputOf(document), entity)).toEqual(typesView(inputOf(document), entity));
    }
  });

  test("the model is not mutated", () => {
    const document = documentOf();
    const before = structuredClone(document);
    for (const entity of document.entities) {
      typesView(inputOf(document), entity);
      validatorsView(inputOf(document), entity);
    }
    expect(document).toEqual(before);
  });
});

describe("typesView", () => {
  test("an entity with no references and no actions: no imports, no inputs, the record's members in order", () => {
    expect(types(documentOf(), "List")).toEqual({
      entityFile: "todo/list.mesh.mx",
      imports: [],
      record: {
        name: "List",
        members: [
          { name: "id", optional: false, key: "id", type: "string" },
          { name: "amount", optional: false, key: "amount", type: "number" },
        ],
      },
      inputs: [],
      query: null,
    });
  });

  test("imports: each referenced entity in another file once, with a relative quoted specifier", () => {
    const document = documentOf();
    expect(types(document, "Todo").imports).toEqual([{ name: "List", fromLiteral: '"./list.types"' }]);
    entityOf(document, "List").module = "lists";
    entityOf(document, "Todo").module = "todos";
    expect(types(document, "Todo").imports).toEqual([{ name: "List", fromLiteral: '"../lists/list.types"' }]);
  });

  test("record: attributes then relationship key columns; nullable and enum types are printed in full", () => {
    const document = documentOf();
    const record = types(document, "Todo").record;
    expect(record.name).toBe("Todo");
    expect(record.members.map((m) => `${m.key}: ${m.type}`)).toEqual([
      "id: string",
      "title: string",
      "done: boolean",
      'status: "draft" | "sent"',
      "views: number",
      "rating: number | null",
      "amount: number",
      "dueOn: Date | null",
      "paidAt: Date | null",
      "insertedAt: Date",
      "updatedAt: Date",
      "metadata: unknown",
      "listId: string",
    ]);
    entityOf(document, "Todo").relationships.find((r) => r.name === "list")!.nullable = true;
    expect(types(document, "Todo").record.members.at(-1)).toEqual({ name: "listId", optional: false, key: "listId", type: "string | null" });
  });

  test("inputs: one per action, explicit then auto; an input with members is not empty", () => {
    const view = types(documentOf(), "Todo");
    expect(view.inputs.map((input) => [input.name, input.empty])).toEqual([
      ["CreateTodoInput", false],
      ["CompleteTodoInput", false],
      ["PendingTodoInput", false],
      ["ReadTodoInput", false],
      ["DestroyTodoInput", false],
    ]);
    expect(view.inputs[0]!.members).toEqual([
      { name: "title", optional: false, key: "title", type: "string" },
      { name: "list", optional: false, key: "list", type: 'List["id"]' },
      { name: "status", optional: true, key: "status", type: '"draft" | "sent" | undefined' },
      { name: "reason", optional: true, key: "reason", type: "string | null | undefined" },
    ]);
  });

  test("inputs: a read takes the caller's filter, sort, limit and offset, all optional", () => {
    const read = types(documentOf(), "Todo").inputs.find((input) => input.name === "ReadTodoInput")!;
    expect(read).toEqual({ name: "ReadTodoInput", empty: false, members: [
      { name: "filter", optional: true, key: "filter", type: "TodoFilter | undefined" },
      { name: "sort", optional: true, key: "sort", type: "TodoSort | undefined" },
      { name: "limit", optional: true, key: "limit", type: "number | undefined" },
      { name: "offset", optional: true, key: "offset", type: "number | undefined" },
    ] });
  });

  test("inputs: an action that is not a read has no empty input either; destroy holds its key", () => {
    const destroy = types(documentOf(), "Todo").inputs.find((input) => input.name === "DestroyTodoInput")!;
    expect(destroy.members.map((member) => member.name)).toEqual(["id"]);
  });

  test("inputs: update members are optional patches after the required row selector", () => {
    const complete = types(documentOf(), "Todo").inputs.find((input) => input.name === "CompleteTodoInput")!;
    expect(complete.members.map((m) => [m.key, m.optional, m.type])).toEqual([
      ["id", false, "string"],
      ["title", true, "string | undefined"],
      ["count", false, "number"],
    ]);
  });

  test("a nullable relationship input prints its reference type with `| null`", () => {
    const document = documentOf();
    entityOf(document, "Todo").relationships.find((r) => r.name === "list")!.nullable = true;
    const create = types(document, "Todo").inputs[0]!;
    expect(create.members.find((m) => m.name === "list")).toEqual({
      name: "list", optional: true, key: "list", type: 'List["id"] | null | undefined',
    });
  });

  test("a name that is not an identifier becomes a JSON-quoted key", () => {
    const document = documentOf();
    entityOf(document, "List").attributes[1]!.name = "unit price";
    expect(types(document, "List").record.members[1]).toEqual({ name: "unit price", optional: false, key: '"unit price"', type: "number" });
  });

  test("entityFile escapes line terminators so the header comment cannot be ended early", () => {
    const document = documentOf();
    entityOf(document, "List").file = "todo/a\nb\r  .mesh.mx";
    expect(types(document, "List").entityFile).toBe("todo/a\\u000ab\\u000d\\u2028\\u2029.mesh.mx");
  });

  test("names it cannot render are EmitErrors, not views", () => {
    const document = documentOf();
    const todo = entityOf(document, "Todo");
    todo.actions.push({ ...todo.actions[0]!, name: "Create" });
    expect(() => types(document, "Todo")).toThrow(EmitError);
    const list = entityOf(document, "List");
    list.name = "Date";
    list.attributes.push({ ...list.attributes[1]!, name: "at", type: "date" });
    expect(() => types(document, "Date")).toThrow("Generated Date would shadow the Date type");
  });
});

describe("validatorsView", () => {
  test("an entity with no actions has no inputs and no schemas", () => {
    expect(validators(documentOf(), "List")).toEqual({
      entityFile: "todo/list.mesh.mx",
      hasInputs: false,
      typesFromLiteral: '"./list.types"',
      schemas: [],
      query: null,
    });
  });

  test("an entity with actions has one schema per input, in the types view's order and names", () => {
    const document = documentOf();
    const view = validators(document, "Todo");
    expect(view.hasInputs).toBe(true);
    expect(view.typesFromLiteral).toBe('"./todo.types"');
    expect(view.schemas.map((s) => [s.typeName, s.constName, s.shapeTypeName])).toEqual([
      ["CreateTodoInput", "createTodoInput", "CreateTodoInputShape"],
      ["CompleteTodoInput", "completeTodoInput", "CompleteTodoInputShape"],
      ["PendingTodoInput", "pendingTodoInput", "PendingTodoInputShape"],
      ["ReadTodoInput", "readTodoInput", "ReadTodoInputShape"],
      ["DestroyTodoInput", "destroyTodoInput", "DestroyTodoInputShape"],
    ]);
    expect(view.schemas.map((s) => s.fields.map((f) => f.name))).toEqual(
      types(document, "Todo").inputs.map((input) => input.members.map((m) => m.name)),
    );
  });

  test("a read's schema holds the four query fields, each optional", () => {
    expect(validators(documentOf(), "Todo").schemas.find((s) => s.typeName === "ReadTodoInput")!.fields).toEqual([
      { name: "filter", key: "filter", schema: "todoFilter.optional()" },
      { name: "sort", key: "sort", schema: "todoSort.optional()" },
      { name: "limit", key: "limit", schema: "z.int().min(0).optional()" },
      { name: "offset", key: "offset", schema: "z.int().min(0).optional()" },
    ]);
  });

  test("field schemas: bounds, pattern, enum values, nullability and optionality", () => {
    const view = validators(documentOf(), "Todo");
    expect(view.schemas[0]!.fields).toEqual([
      { name: "title", key: "title", schema: 'z.string().min(1).max(100).regex(new RegExp("^.+$", ""))' },
      { name: "list", key: "list", schema: "z.uuid()" },
      { name: "status", key: "status", schema: 'z.enum(["draft", "sent"]).optional()' },
      { name: "reason", key: "reason", schema: "z.string().nullable().optional()" },
    ]);
    expect(view.schemas[1]!.fields.map((f) => f.schema)).toEqual([
      "z.uuid()",
      'z.string().min(1).max(100).regex(new RegExp("^.+$", "")).optional()',
      "z.int().min(1)",
    ]);
  });

  test("a name that is not an identifier becomes a JSON-quoted key", () => {
    const document = documentOf();
    const todo = entityOf(document, "Todo");
    todo.actions[0]!.input.push({ kind: "argument", name: "two words", type: "boolean", nullable: false, position: todo.position });
    expect(validators(document, "Todo").schemas[0]!.fields.at(-1)).toEqual({ name: "two words", key: '"two words"', schema: "z.boolean()" });
  });
});
