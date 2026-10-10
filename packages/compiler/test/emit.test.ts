import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Entity, ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { orderedDocument } from "../src/typescript/emitters/order.ts";
import { entityInputs } from "../src/typescript/views/inputs.ts";
import { project } from "./v4.ts";
import { checkTypes, configOf } from "./generated.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function documentOf(): ModelDocument {
  const built = buildModel(project());
  expect(built.diagnostics).toEqual([]);
  return built.document!;
}
const todo = (document: ModelDocument): Entity =>
  document.entities.find((entity) => entity.name === "Todo")!;
test("v4 record and input types preserve the legacy layout and action names", async () => {
  const document = documentOf();
  const files = await generateFiles({ document, config: configOf("/project") });
  const output = files.find((f) => f.path.endsWith("/todo.types.ts"))!.contents;
  expect(output).toContain('import type { List } from "./list.types"');
  expect(output).toContain("export type Todo");
  expect(output).toContain("title: string;");
  expect(output).toContain("rating: number | null;");
  expect(output).toContain("listId: string;");
  // A computed field is not on the stored record; it is what `load` attaches (TodoLoadable).
  expect(/export type Todo = \{[^}]*\};/.exec(output)![0]).not.toContain("total:");
  expect(output).toContain("total: number | null;");
  expect(output).toContain('list: List["id"]');
  const inputs = entityInputs(todo(document), document);
  expect(inputs.map((input) => input.name)).toEqual(
    expect.arrayContaining([
      "CreateTodoInput",
      "CompleteTodoInput",
      "DestroyTodoInput",
      "ReadTodoInput",
    ]),
  );
  expect(files.map((f) => f.path)).toContain("generated/todo/todo.types.ts");
});

test("deterministic bytes, independent of source discovery order or machine root", async () => {
  const document = documentOf();
  const first = await generateFiles({
    document,
    config: configOf("/a/project"),
  });
  expect(
    await generateFiles({
      document: { entities: [...document.entities].reverse() },
      config: configOf("/b/project"),
    }),
  ).toEqual(first);
  expect(
    await generateFiles({ document, config: configOf("/a/project") }),
  ).toEqual(first);
  for (const file of first) {
    expect(file.contents).not.toContain("/a/project");
    expect(file.contents).not.toContain("/b/project");
  }
});

test("model.json round-trips every v4 construct and serialises keys deterministically", async () => {
  const document = documentOf();
  const files = await generateFiles({ document, config: configOf("/project") });
  expect(
    JSON.parse(files.find((f) => f.path.endsWith("model.json"))!.contents),
  ).toEqual(orderedDocument(document));
  expect(
    Object.keys(
      JSON.parse(files.find((f) => f.path.endsWith("model.json"))!.contents),
    ),
  ).toEqual(["entities"]);
});

test("generated types and validators typecheck with strict exact-optional flags and a consumer", async () => {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-emit-"));
  roots.push(root);
  const config = configOf(root);
  const files = await generateFiles({ document: documentOf(), config });
  await writeGeneratedFiles(files, config);
  // The data adapter writes schema.ts; a stub stands in for it with the same `tables` keys.
  await writeFile(resolve(root, "generated/schema.ts"), "export const listTable = {};\nexport const todoTable = {};\nexport const tables = { list: listTable, todo: todoTable };\n");
  await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
  await writeFile(
    resolve(root, "consumer.ts"),
    `import type { CreateTodoInput, CompleteTodoInput, DestroyTodoInput, Todo } from "./generated/todo/todo.types";
const update: CompleteTodoInput = { id: "id", count: 1 };
const destroy: DestroyTodoInput = { id: "id" };
// @ts-expect-error row selector is required
const bad: CompleteTodoInput = { count: 1 };
// @ts-expect-error computed members are not stored record fields
const computed: keyof Todo = "total";
export type Create = CreateTodoInput;
export { update, destroy, bad, computed };
`,
  );
  expect(
    checkTypes(root, [
      ...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path),
      "generated/schema.ts",
      "mesh.config.ts",
      "consumer.ts",
    ]),
  ).toEqual({ code: 0, output: "" });
});

test("argument defaults and nullable fields are optional, update member fields are patches", () => {
  const document = documentOf();
  const entity = todo(document);
  const title = entity.attributes.find((a) => a.name === "title")!;
  entity.actions = [
    {
      kind: "create",
      name: "make",
      input: [
        { kind: "member", ref: { name: "title", position: title.position } },
        {
          kind: "argument",
          name: "optional",
          type: "integer",
          nullable: false,
          default: 0,
          position: title.position,
        },
      ],
      validate: [],
      do: [],
      position: entity.position,
    },
    {
      kind: "update",
      name: "patch",
      input: [
        { kind: "member", ref: { name: "title", position: title.position } },
      ],
      validate: [],
      do: [],
      position: entity.position,
    },
  ];
  entity.auto = [];
  const [create, update] = entityInputs(entity, document);
  expect(create!.fields.map((f) => [f.attribute.name, f.optional])).toEqual([
    ["title", false],
    ["optional", true],
  ]);
  expect(update!.fields.map((f) => [f.attribute.name, f.optional])).toEqual([
    ["id", false],
    ["title", true],
  ]);
});

test("empty inputs reject extra properties and primitives; records without actions need no Zod imports", async () => {
  const document = documentOf();
  const entity = todo(document);
  document.entities = [entity];
  entity.actions = [];
  // A create that accepts nothing has an empty input; the key alone leaves nothing else to fill.
  entity.auto = ["create"];
  entity.attributes = entity.attributes.filter((attribute) => attribute.primaryKey);
  entity.relationships = [];
  entity.computed = [];
  let files = await generateFiles({ document, config: configOf("/project") });
  expect(files.find((f) => f.path.endsWith("types.ts"))!.contents).toContain(
    "[key: string]: never",
  );
  entity.auto = [];
  files = await generateFiles({ document, config: configOf("/project") });
  expect(
    files.find((f) => f.path.endsWith("validators.ts"))!.contents,
  ).not.toContain('from "zod"');
});

test("generated paths and type declarations refuse collisions", async () => {
  const document = documentOf();
  const entity = todo(document);
  document.entities.push({ ...structuredClone(entity), name: "todo" });
  await expect(
    generateFiles({ document, config: configOf("/project") }),
  ).rejects.toBeInstanceOf(EmitError);
  document.entities.pop();
  entity.actions = entity.actions.slice(0, 1);
  entity.auto = [];
  entity.actions.push({
    ...entity.actions[0]!,
    name:
      entity.actions[0]!.name.toUpperCase().slice(0, 1) +
      entity.actions[0]!.name.slice(1),
  });
  await expect(
    generateFiles({ document, config: configOf("/project") }),
  ).rejects.toBeInstanceOf(EmitError);
});

test.each(["../escape", "/escape", "a\\b", ".", "a//b", "C:"])(
  "unsafe module %s never escapes output",
  async (module) => {
    const document = documentOf();
    todo(document).module = module;
    await expect(
      generateFiles({ document, config: configOf("/project") }),
    ).rejects.toBeInstanceOf(EmitError);
  },
);

test.each(["", "sales/billing"])("module %j emits verbatim relative paths", async (module) => {
  const document = documentOf();
  const entity = todo(document);
  entity.module = module;
  const files = await generateFiles({ document, config: configOf("/project", ".mesh") });
  const prefix = module ? `.mesh/${module}` : ".mesh";
  expect(files.map((file) => file.path)).toContain(`${prefix}/todo.types.ts`);
  expect(files.map((file) => file.path)).toContain(`${prefix}/todo.validators.ts`);
});

test("Date type shadows are diagnosed only where the global is used", async () => {
  const document = documentOf();
  const entity = todo(document);
  document.entities = [entity];
  entity.relationships = [];
  entity.actions = [];
  entity.auto = [];
  entity.name = "Date";
  await expect(
    generateFiles({ document, config: configOf("/project") }),
  ).rejects.toBeInstanceOf(EmitError);
  entity.attributes = entity.attributes.filter(
    (a) => !["date", "datetime", "timestamp"].includes(a.type),
  );
  expect(
    (await generateFiles({ document, config: configOf("/project") })).length,
  ).toBe(7); // model.json, types, validators, expressions, load, actions and index for one entity
});

test("source path line terminators are escaped in headers", async () => {
  const document = documentOf();
  document.entities = [todo(document)];
  const entity = document.entities[0]!;
  entity.file = "todo/file\nINJECT\r\u2028\u2029.mesh.mx";
  entity.relationships = [];
  entity.actions = [];
  entity.auto = [];
  const files = await generateFiles({ document, config: configOf("/project") });
  expect(
    files.find((f) => f.path.endsWith("types.ts"))!.contents,
  ).not.toContain("\nINJECT");
});

test("formatter ignores project configuration and serialisation failures never emit partial files", async () => {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-emit-"));
  roots.push(root);
  const document = documentOf();
  const config = configOf(root);
  const first = await generateFiles({ document, config });
  await writeFile(
    resolve(root, ".prettierrc.json"),
    '{"singleQuote":true,"semi":false}',
  );
  expect(await generateFiles({ document, config })).toEqual(first);
  (todo(document) as unknown as Record<string, unknown>).bad = () => 1;
  await expect(generateFiles({ document, config })).rejects.toThrow(
    "model must be plain JSON data",
  );
  expect(await Bun.file(resolve(root, "generated/model.json")).exists()).toBe(
    false,
  );
});

test("relationship input uses the actual target key and never inherits its creation default", async () => {
  const document = documentOf();
  const list = document.entities.find((entity) => entity.name === "List")!;
  const key = list.attributes.find((attribute) => attribute.primaryKey)!;
  key.name = "code";
  key.default = "00000000-0000-4000-8000-000000000001";
  const input = entityInputs(todo(document), document).find((input) => input.name === "CreateTodoInput")!;
  const relation = input.fields.find((field) => field.attribute.name === "list")!;
  expect(relation.optional).toBe(false);
  expect(relation.attribute.default).toBeUndefined();
  expect(key.default).toBeDefined();
  const files = await generateFiles({ document, config: configOf("/project") });
  expect(files.find((file) => file.path.endsWith("todo.types.ts"))!.contents).toContain('list: List["code"]');
});

test("writer produces the exact planned bytes", async () => {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-emit-"));
  roots.push(root);
  const config = configOf(root);
  const files = await generateFiles({ document: documentOf(), config });
  await writeGeneratedFiles(files, config);
  for (const file of files)
    expect(await readFile(resolve(root, file.path), "utf8")).toBe(
      file.contents,
    );
});
