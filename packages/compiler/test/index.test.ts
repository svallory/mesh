import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { FrameworkError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { actionsGenerator } from "../src/typescript/emitters/actions.ts";
import { indexView } from "../src/typescript/views/index.ts";
import { checkTypes, configOf } from "./generated.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const note = `entity :Note table="notes"
  attributes
    uuid :id primary-key
    string :text
  actions auto=[:read, :destroy]
    create :create
      input
        &text
    update :edit
      input
        &text
`;
const tag = "entity :Tag\n  attributes\n    uuid :id primary-key\n";

function documentOf(files: Record<string, string> = { "notes/note.mesh.mx": note, "tag.mesh.mx": tag }): ModelDocument {
  const built = buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics).toEqual([]);
  return built.document!;
}

describe("index view", () => {
  test("every action function in entity order, types and table handles re-exported", () => {
    const view = indexView({ document: documentOf(), config: configOf("/project", ".mesh") });
    expect(view.configFromLiteral).toBe('"../mesh.config"');
    expect(view.functions.map((fn) => [fn.name, fn.method, fn.inputType, fn.returnType])).toEqual([
      ["createNote", "noteActions.create", "CreateNoteInput", "Note"],
      ["editNote", "noteActions.edit", "EditNoteInput", "Note"],
      ["readNote", "noteActions.read", "ReadNoteInput", "Note[]"],
      ["destroyNote", "noteActions.destroy", "DestroyNoteInput", "void"],
    ]);
    expect(view.types).toEqual(["Note", "CreateNoteInput", "EditNoteInput", "ReadNoteInput", "DestroyNoteInput", "NoteFilter", "NoteSort", "Tag"]);
    expect(view.schemaExports).toEqual(["tables", "noteTable", "tagTable"]);
    expect(view.entities.map((e) => [e.local, e.hasActions, e.actionsFromLiteral, e.typesFromLiteral])).toEqual([
      ["noteActions", true, '"./notes/note.actions"', '"./notes/note.types"'],
      ["tagActions", false, '"./tag.actions"', '"./tag.types"'],
    ]);
  });

  test("the config import is relative to a nested output folder", () => {
    expect(indexView({ document: documentOf(), config: configOf("/project", "src/generated") }).configFromLiteral).toBe('"../../mesh.config"');
  });

  test("an action function that takes a table handle's name is MESH_EMIT_NAME", () => {
    const table = "entity :Table\n  attributes\n    uuid :id primary-key\n  actions\n    read :note\n";
    let error: unknown;
    try { actionsGenerator.views({ document: documentOf({ "a/note.mesh.mx": note, "b/table.mesh.mx": table }), config: configOf("/project") }); }
    catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic.message).toBe(
      "Action :note of :Table and Entity :Note's table handle (a/note.mesh.mx:1:1) both become the top-level name `noteTable`");
  });
});

/** A config whose `data` is a Map-backed layer counting its closes, or a descriptor without a run-time half. */
const memoryConfig = `const rows = new Map();
export const closes = { count: 0 };
export const events = [];
export const failClose = { next: false };
const ops = {
  async insert(_table, row) { const stored = { ...row, id: row.id ?? crypto.randomUUID() }; rows.set(stored.id, stored); return { ...stored }; },
  async select() { return [...rows.values()]; },
  async selectByKey(_table, key) { return rows.get(key.id); },
  async selectByKeyForUpdate(_table, key) { return rows.get(key.id); },
  async updateByKey(_table, key, changes) {
    const row = rows.get(key.id);
    if (!row) return undefined;
    rows.set(key.id, { ...row, ...changes });
    return rows.get(key.id);
  },
  async deleteByKey(_table, key) { return rows.delete(key.id); },
};
export default { data: { kind: "data-adapter", name: "memory", build: "./none", capabilities: { adapter: "memory", capabilities: [] }, options: {},
  transaction: async (run) => { const result = await run(ops); events.push("commit"); return result; },
  close: async () => {
    if (failClose.next) { failClose.next = false; throw new Error("close failed"); }
    closes.count++; events.push("close");
  } } };
`;
const descriptorConfig = `export default { data: { kind: "data-adapter", name: "remote", build: "./none", capabilities: { adapter: "remote", capabilities: [] }, options: {} } };\n`;

async function generated(config = memoryConfig) {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-index-"));
  roots.push(root);
  const files = await generateFiles({ document: documentOf(), config: configOf(root, ".mesh") });
  await writeGeneratedFiles(files, configOf(root, ".mesh"));
  await writeFile(resolve(root, ".mesh/schema.ts"),
    "export const noteTable = {};\nexport const tagTable = {};\nexport const tables = { note: noteTable, tag: tagTable };\n");
  await writeFile(resolve(root, "mesh.config.ts"), config);
  return { root, files };
}

describe("the generated index", () => {
  test("typechecks with strict unused-name and exact-optional flags", async () => {
    const { root, files } = await generated(descriptorConfig);
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
  });

  test("connect, call, duplicate connect, disconnect, calls after it, no-op disconnect, reconnect", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const { closes } = await import(resolve(root, "mesh.config.ts"));
    await expect(mesh.createNote({ text: "a" })).rejects.toThrow(
      new FrameworkError("createNote was called while not connected: call connect() first, or use bind(db) with a data layer of your own"));
    await mesh.disconnect();
    expect(closes.count).toBe(0);
    await mesh.connect();
    await expect(mesh.connect()).rejects.toThrow("connect() was called while connected; call disconnect() first");
    const created = await mesh.createNote({ text: "a" });
    expect((await mesh.editNote({ id: created.id, text: "b" })).text).toBe("b");
    expect(await mesh.readNote({})).toHaveLength(1);
    await mesh.disconnect();
    expect(closes.count).toBe(1);
    await expect(mesh.readNote({})).rejects.toBeInstanceOf(FrameworkError);
    await mesh.disconnect();
    expect(closes.count).toBe(1);
    await mesh.connect();
    await mesh.destroyNote({ id: created.id });
    await expect(mesh.destroyNote({ id: created.id })).rejects.toBeInstanceOf(NotFoundError);
    await mesh.disconnect();
  });

  test("disconnect waits for calls already made, refuses new ones at once, then closes", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const { events } = await import(resolve(root, "mesh.config.ts"));
    await mesh.connect();
    const pending = mesh.createNote({ text: "in flight" });
    const failing = mesh.createNote({ text: 42 }).then(() => null, (error: unknown) => error);
    const closing = mesh.disconnect();
    await expect(mesh.readNote({})).rejects.toBeInstanceOf(FrameworkError);
    await expect(mesh.connect()).resolves.toBeUndefined();
    await mesh.disconnect();
    await closing;
    expect((await pending).text).toBe("in flight");
    expect(await failing).toBeInstanceOf(InvalidInputError);
    expect(events).toEqual(["commit", "close", "close"]);
  });

  test("a disconnect whose close() rejects leaves the program connected, and can be retried", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const { closes, failClose } = await import(resolve(root, "mesh.config.ts"));
    await mesh.connect();
    failClose.next = true;
    await expect(mesh.disconnect()).rejects.toThrow("close failed");
    expect(await mesh.readNote({})).toEqual([]);
    await expect(mesh.connect()).rejects.toThrow("connect() was called while connected; call disconnect() first");
    await mesh.disconnect();
    expect(closes.count).toBe(1);
    await expect(mesh.readNote({})).rejects.toBeInstanceOf(FrameworkError);
  });

  test("an index for a domain without actions type-checks strictly", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-index-empty-"));
    roots.push(root);
    const config = configOf(root, ".mesh");
    const files = await generateFiles({ document: documentOf({ "tag.mesh.mx": tag }), config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, ".mesh/schema.ts"), "export const tagTable = {};\nexport const tables = { tag: tagTable };\n");
    await writeFile(resolve(root, "mesh.config.ts"), descriptorConfig);
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    expect(Object.keys(mesh.bind({ transaction: async () => undefined, close: async () => {} }))).toEqual([]);
  });

  test("bind returns frozen functions over a caller's layer and disconnect never closes it", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    let closed = 0;
    const rows: unknown[] = [];
    const layer = {
      transaction: (run: (tx: object) => Promise<unknown>) => run({ insert: async (_t: object, row: object) => { rows.push(row); return row; } }),
      close: async () => { closed++; },
    };
    const bound = mesh.bind(layer);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.keys(bound)).toEqual(["createNote", "editNote", "readNote", "destroyNote"]);
    await bound.createNote({ text: "x" });
    expect(rows).toHaveLength(1);
    await mesh.connect();
    await mesh.disconnect();
    expect(closed).toBe(0);
  });

  test("a configured adapter without a run-time half is a FrameworkError at connect", async () => {
    const { root } = await generated(descriptorConfig);
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    await expect(mesh.connect()).rejects.toThrow(new FrameworkError(
      'The data adapter "remote" configured in mesh.config.ts has no run-time half: connect() needs a data layer with transaction() and close()'));
    await expect(mesh.readNote({})).rejects.toBeInstanceOf(FrameworkError);
  });
});

describe("entity names never break the generated files", () => {
  // Reserved words, `bind`'s parameter, and the names of Mesh's own imports.
  const names = ["Class", "Default", "Function", "Layer", "DataLayer", "ContextArgument", "FrameworkError", "NotFoundError", "Tables", "Flight", "Binding"];
  // And action functions spelling the index's internal names: `:in` on Flight is `inFlight`,
  // `:default` on Binding is `defaultBinding`.
  const extra: Record<string, string> = { Flight: "    read :in\n", Binding: "    read :default\n" };
  const files = Object.fromEntries(names.map((name) => [`${name.toLowerCase()}.mesh.mx`,
    `entity :${name}\n  attributes\n    uuid :id primary-key\n    string :label\n  actions auto=[:read, :destroy]\n    create :create\n      input\n        &label\n    update :edit\n      input\n        &label\n${extra[name] ?? ""}`]));
  const key = (name: string) => name[0]!.toLowerCase() + name.slice(1);

  test("they build, type-check strictly and run", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-index-names-"));
    roots.push(root);
    const config = configOf(root, ".mesh");
    const generatedFiles = await generateFiles({ document: documentOf(files), config });
    await writeGeneratedFiles(generatedFiles, config);
    await writeFile(resolve(root, ".mesh/schema.ts"), [
      ...names.map((name) => `export const ${key(name)}Table = {};`),
      `export const tables = { ${names.map((name) => `${key(name)}: ${key(name)}Table`).join(", ")} };`, ""].join("\n"));
    await writeFile(resolve(root, "mesh.config.ts"), descriptorConfig);
    expect(checkTypes(root, [...generatedFiles.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const rows: object[] = [];
    const bound = mesh.bind({ transaction: (run: (tx: object) => Promise<unknown>) => run({ insert: async (_t: object, row: object) => { rows.push(row); return row; } }), close: async () => {} });
    for (const name of names) expect((await bound[`create${name}`]({ label: name })).label).toBe(name);
    expect(typeof mesh.inFlight).toBe("function");
    expect(typeof mesh.defaultBinding).toBe("function");
    expect(rows).toHaveLength(names.length);
  });

  test.each(["Promise", "Partial", "ReturnType"])("an entity named %s, which would shadow a global type the generated code uses, is MESH_EMIT_NAME", (name) => {
    let error: unknown;
    try { actionsGenerator.views({ document: documentOf({ "x.mesh.mx": files["class.mesh.mx"]!.replace(":Class", `:${name}`) }), config: configOf("/project") }); }
    catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({ code: "MESH_EMIT_NAME", fix: "Rename the entity",
      message: `Entity :${name} would generate the type ${name}, which shadows the global ${name} the generated code uses` });
  });
});
