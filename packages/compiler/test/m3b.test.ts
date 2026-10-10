import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModel } from "../src/front-end/build.ts";
import { loadConfig, loadProject } from "../src/index.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { typesView } from "../src/typescript/views/types.ts";
import { validatorsView } from "../src/typescript/views/validators.ts";
import { checkTypes, configOf } from "./generated.ts";
import { build, keyed } from "./v4.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const withJson = (line: string, actions = "") => keyed + `    ${line}\n` + actions;
const codes = (source: string) => build(source).diagnostics.map((d) => d.code);

describe("json in an entity file (ADR-0069)", () => {
  test.each([
    ["json :data", undefined],
    ["json :data nullable", undefined],
    ["json :data default={}", {}],
    ["json :data default=[]", []],
    ["json :data default=[1, \"two\", null, { three: [3] }]", [1, "two", null, { three: [3] }]],
    ["json :data default={ list: [{ a: 1 }], flag: true, none: null }", { list: [{ a: 1 }], flag: true, none: null }],
    ["json :data default=\"text\"", "text"],
    ["json :data default=0", 0],
    ["json :data default=false", false],
    ["json :data nullable default=null", null],
    ["json :data default={ value: \"looks like an atom\" }", { value: "looks like an atom" }],
  ] as [string, unknown][])("%s builds", (line, expected) => {
    const result = build(withJson(line));
    expect(result.diagnostics).toEqual([]);
    const attribute = result.document!.entities[0]!.attributes.find((a) => a.name === "data")!;
    expect(attribute.type).toBe("json");
    if (expected === undefined) expect(attribute.default).toBeUndefined();
    else expect(attribute.default).toEqual(expected as never);
  });

  test.each([
    ["unique", "json :data unique"],
    ["min", "json :data min=1"],
    ["max", "json :data max=1"],
    ["match", "json :data match=/x/"],
    ["values", "json :data values=[:a]"],
    ["primary-key", "json :data primary-key"],
    ["on", "json :data on=:create"],
  ])("%s is a build error on json", (_option, line) => {
    const result = build(withJson(line));
    expect(result.document).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test.each([
    ["an atom", "json :data default=:draft"],
    ["an atom inside a list", "json :data default=[:draft]"],
    ["an atom inside an object", "json :data default={ a: :draft }"],
    ["null on a json that is not nullable", "json :data default=null"],
  ])("a default of %s is MESH_DEFAULT", (_name, line) => {
    expect(codes(withJson(line))).toEqual(["MESH_DEFAULT"]);
  });

  test("a json attribute cannot be sorted by, in a read's sort", () => {
    const source = withJson("json :data", "  actions\n    read :ordered\n      sort\n        asc &data\n");
    const result = build(source);
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_SORT_TYPE", message: expect.stringContaining("&data is :json") })]);
  });

  test("a json attribute cannot be used in a declared filter, in either spelling", () => {
    for (const filter of ["    read :byData filter=() => &data === 1\n", "    read :byData\n      filter=() => &data.size > 1\n"]) {
      const result = build(withJson("json :data", "  actions\n" + filter));
      expect(result.document).toBeNull();
      expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_FILTER_TYPE", message: expect.stringContaining("&data is :json, which a filter cannot use") })]);
    }
    expect(build(withJson("json :data\n    string :name", "  actions\n    read :byName filter=() => &name === \"a\"\n")).diagnostics).toEqual([]);
  });

  test("a json attribute is not a rollup operand", () => {
    const list = "entity :List\n  attributes\n    uuid :id primary-key\n    json :data\n";
    const source = `import { List } from "./list.mesh.mx"\nentity :Todo\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :lists entity=List\n  computed\n    max :biggest of="lists.data"\n`;
    const result = buildModel({ root: "/project", files: [{ file: "todo/todo.mesh.mx", source }, { file: "todo/list.mesh.mx", source: list }] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_ROLLUP_TYPE"]);
  });

  test("json is a type of an argument and of a set value that is an array, but a set value cannot hold an atom", () => {
    const argument = withJson("json :data nullable", "  actions\n    update :change\n      input\n        json :patch\n        &data\n");
    expect(build(argument).diagnostics).toEqual([]);
    const set = (value: string) => withJson("json :data", `  actions\n    update :change\n      do\n        set\n          &data=${value}\n`);
    expect(build(set("[1, 2]")).diagnostics).toEqual([]);
    expect(build(set("{ a: 1 }")).diagnostics).toEqual([]);
    expect(codes(set("[:a]"))).toEqual(["MESH_SET_VALUE"]);
  });
});

/** Generate the files of one project and type-check them with the strictest flags. */
async function generated(sources: Record<string, string>) {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-m3b-"));
  roots.push(root);
  const built = buildModel({ root, files: Object.entries(sources).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics).toEqual([]);
  const config = configOf(root);
  const files = await generateFiles({ document: built.document!, config });
  await writeGeneratedFiles(files, config);
  await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { note: {}, item: {} };\n");
  return { root, files, document: built.document!, config };
}

describe("json in the generated code", () => {
  const note = `entity :Note table="notes"
  attributes
    uuid :id primary-key
    json :payload default={}
    json :extra nullable
    string :title
  actions auto=[:read]
    create :create
      input
        &title
        &payload
        &extra
    update :change
      input
        &payload
        &extra
`;

  test("the types say unknown, the filter and sort leave the json attributes out", async () => {
    const { document } = await generated({ "m/note.mesh.mx": note });
    const entity = document.entities[0]!;
    const view = typesView({ document, config: configOf("/p") }, entity);
    expect(view.record.members.map((m) => `${m.key}: ${m.type}`)).toEqual(["id: string", "payload: unknown", "extra: unknown", "title: string"]);
    expect(view.query!.filterMembers.map((m) => m.key)).toEqual(["id", "title"]);
    expect(view.query!.sortKeys).toEqual(['"id"', '"-id"', '"title"', '"-title"']);
    const create = view.inputs.find((i) => i.name === "CreateNoteInput")!;
    expect(create.members.map((m) => `${m.key}${m.optional ? "?" : ""}: ${m.type}`)).toEqual(["title: string", "payload?: unknown | undefined", "extra?: unknown | undefined"]);
  });

  test("the generated files type-check under the strictest flags", async () => {
    const { root, files } = await generated({ "m/note.mesh.mx": note });
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts") && !f.path.endsWith("index.ts")).map((f) => f.path), "generated/schema.ts"])).toEqual({ code: 0, output: "" });
  });

  test("the validator accepts any JSON value and nothing else; null only when nullable", async () => {
    const { root } = await generated({ "m/note.mesh.mx": note });
    const { createNoteInput, changeNoteInput } = await import(resolve(root, "generated/m/note.validators.ts"));
    const ok = (payload: unknown, extra: unknown = undefined) => createNoteInput.safeParse({ title: "t", payload, ...(extra === undefined ? {} : { extra }) }).success;
    for (const value of [{}, [], "s", 0, 1.5, true, false, { a: [1, { b: null }] }, [null, [[]]], ""]) expect(ok(value)).toBe(true);
    for (const value of [() => 1, new Date(), new Map(), Symbol("s"), 1n, Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, { a: () => 1 }, new (class X {})(), null])
      expect(ok(value)).toBe(false);
    expect(createNoteInput.safeParse({ title: "t" }).success).toBe(true);
    expect(ok({}, null)).toBe(true);
    expect(ok({}, [1])).toBe(true);
    expect(createNoteInput.safeParse({ title: "t", payload: {}, extra: undefined }).success).toBe(true);
    expect(changeNoteInput.safeParse({ id: "00000000-0000-4000-8000-000000000000", extra: null }).success).toBe(true);
    expect(changeNoteInput.safeParse({ id: "00000000-0000-4000-8000-000000000000", payload: null }).success).toBe(false);
  });

  test("a create writes the default of a json attribute as data, even when it looks like an atom", async () => {
    const source = note.replace("json :payload default={}", 'json :payload default={ value: "x" }');
    const { document } = await generated({ "m/note.mesh.mx": source });
    const view = actionsView({ document, config: configOf("/p") }, document.entities[0]!);
    expect(view.methods.find((m) => m.name === "create")!.statements.join("\n")).toContain('payload: parsed.payload === undefined ? {"value":"x"} : parsed.payload');
  });
});

describe("the key of a create", () => {
  const items = (key: string) => `entity :Item table="items"
  attributes
    ${key}
    string :name
  actions auto=[:read]
    create :create
      input
        &name
`;

  test.each(["uuid :id primary-key", "string :code primary-key", "integer :seq primary-key"])("%s is left to the data layer", async (key) => {
    const { document } = await generated({ "m/item.mesh.mx": items(key) });
    const statements = actionsView({ document, config: configOf("/p") }, document.entities[0]!).methods.find((m) => m.name === "create")!.statements;
    expect(statements).toEqual(["const row = await tx.insert(tables.item, {", "  name: parsed.name,", "});", "return row as Item;"]);
  });

  test("no generated file writes a random id", async () => {
    const { files } = await generated({ "m/item.mesh.mx": items("uuid :id primary-key") });
    for (const file of files) expect(file.contents).not.toMatch(/randomUUID|uuidv4/i);
  });

  test("an integer key is a number in the record, the key input and the filter", async () => {
    const { document, root, files } = await generated({ "m/item.mesh.mx": items("integer :seq primary-key").replace("create :create", "create :create").replace("  actions auto=[:read]", "  actions auto=[:read, :destroy]") });
    const types = typesView({ document, config: configOf("/p") }, document.entities[0]!);
    expect(types.record.members[0]).toMatchObject({ key: "seq", type: "number" });
    expect(types.inputs.find((i) => i.name === "DestroyItemInput")!.members).toEqual([{ name: "seq", optional: false, key: "seq", type: "number" }]);
    expect(types.query!.filterMembers[0]).toMatchObject({ key: "seq", type: "$Comparison<number>" });
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts") && !f.path.endsWith("index.ts")).map((f) => f.path), "generated/schema.ts"])).toEqual({ code: 0, output: "" });
  });

  test.each([["uuid :id primary-key", "id"], ["integer :seq primary-key", "seq"]])("a client cannot send the key of %s", (key, name) => {
    const source = items(key).replace("        &name\n", `        &name\n        &${name}\n`);
    expect(codes(source)).toEqual(["MESH_INPUT_MANAGED"]);
  });
});

describe("a read's input", () => {
  const entity = `entity :Item table="items"
  attributes
    uuid :id primary-key
    string :name
    integer :count nullable
  actions auto=[:read]
    read :byOwner
      input
        uuid :ownerId
`;

  test("keeps its own arguments beside filter, sort, limit and offset", async () => {
    const { document } = await generated({ "m/item.mesh.mx": entity });
    const view = typesView({ document, config: configOf("/p") }, document.entities[0]!);
    expect(view.inputs.find((i) => i.name === "ByOwnerItemInput")!.members.map((m) => m.key)).toEqual(["ownerId", "filter", "sort", "limit", "offset"]);
    expect(view.inputs.find((i) => i.name === "ReadItemInput")!.members.map((m) => m.key)).toEqual(["filter", "sort", "limit", "offset"]);
    const schema = validatorsView({ document, config: configOf("/p") }, document.entities[0]!);
    expect(schema.query!.filterFields.map((f) => f.key)).toEqual(["id", "name", "count"]);
    expect(schema.query!.filterFields[0]!.schema).toBe("comparison(z.uuid()).exactOptional()");
  });

  test.each(["filter", "sort", "limit", "offset"])("an argument called %s is refused: the read takes it from the caller", async (name) => {
    const source = entity.replace("uuid :ownerId", `string :${name}`);
    const built = buildModel({ root: "/p", files: [{ file: "m/item.mesh.mx", source }] });
    expect(built.diagnostics).toEqual([]);
    await expect(generateFiles({ document: built.document!, config: configOf("/p") })).rejects.toMatchObject({
      diagnostic: { code: "MESH_DUPLICATE_INPUT", message: expect.stringContaining(`Input ${name} conflicts`) },
    });
  });

  test("an attribute called and or or cannot be filtered, and the rest can", async () => {
    const source = entity.replace("    string :name\n", "    string :and\n    string :or\n    string :name\n");
    const { document, root, files } = await generated({ "m/item.mesh.mx": source });
    const view = typesView({ document, config: configOf("/p") }, document.entities[0]!);
    expect(view.query!.filterMembers.map((m) => m.key)).toEqual(["id", "name", "count"]);
    expect(view.query!.sortKeys).toContain('"and"');
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts") && !f.path.endsWith("index.ts")).map((f) => f.path), "generated/schema.ts"])).toEqual({ code: 0, output: "" });
  });

  test("an entity without a read has no query types", async () => {
    const source = "entity :Item table=\"items\"\n  attributes\n    uuid :id primary-key\n  actions auto=[:destroy]\n";
    const { document } = await generated({ "m/item.mesh.mx": source });
    expect(typesView({ document, config: configOf("/p") }, document.entities[0]!).query).toBeNull();
  });
});

describe("the data adapter's capabilities", () => {
  async function project(adapter: string, entity = "integer :seq primary-key") {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-cap-"));
    roots.push(root);
    await mkdir(resolve(root, "src/domain"), { recursive: true });
    await writeFile(resolve(root, "src/domain/item.mesh.mx"), `entity :Item\n  attributes\n    ${entity}\n    string :name\n`);
    await writeFile(resolve(root, "mesh.config.ts"), `export default { domain: "src/domain", output: ".mesh", data: { kind: "data-adapter", name: "fake", build: "./none", ${adapter} options: {} } };\n`);
    return root;
  }
  const manifest = (...names: string[]) => `capabilities: { adapter: "fake", capabilities: ${JSON.stringify(names)} },`;

  test("an integer key needs integer-key-fill: the build fails without it, positioned at the key", async () => {
    const loaded = await loadConfig(await project(manifest("aggregates")));
    expect(loaded.diagnostics).toEqual([]);
    const built = await loadProject(loaded.config!);
    expect(built.document).toBeNull();
    expect(built.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_CAPABILITY", severity: "error",
      message: 'Entity :Item has the integer primary key :seq, which the data layer fills, and the data adapter "fake" does not declare the integer-key-fill capability',
      position: expect.objectContaining({ line: 3 }),
      fix: "Use a data adapter that declares integer-key-fill, or make :seq a uuid",
    })]);
  });

  test("the build passes when the adapter declares it, and for a uuid key without it", async () => {
    for (const [adapter, key] of [[manifest("integer-key-fill"), "integer :seq primary-key"], [manifest(), "uuid :id primary-key"], [manifest("aggregates", "integer-key-fill"), "string :code primary-key"]] as const) {
      const loaded = await loadConfig(await project(adapter, key));
      const built = await loadProject(loaded.config!);
      expect(built.diagnostics).toEqual([]);
      expect(built.document).not.toBeNull();
    }
  });

  test("an adapter with no manifest, or an invalid one, fails the configuration", async () => {
    const missing = await loadConfig(await project(""));
    expect(missing.config).toBeNull();
    expect(missing.diagnostics).toEqual([expect.objectContaining({ code: "MESH_CONFIG", message: expect.stringContaining('The data adapter "fake" declares no capabilities') })]);
    const unknown = await loadConfig(await project(manifest("teleport")));
    expect(unknown.config).toBeNull();
    expect(unknown.diagnostics[0]!.message).toContain('unknown capability "teleport"');
    const duplicate = await loadConfig(await project(manifest("joins", "joins")));
    expect(duplicate.diagnostics[0]!.message).toContain('capability "joins" is listed twice');
    const wrongShape = await loadConfig(await project("capabilities: [],"));
    expect(wrongShape.config).toBeNull();
    expect(wrongShape.diagnostics[0]!.message).toContain("adapter must be a non-empty string");
  });
});
