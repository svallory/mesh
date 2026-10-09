import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { FrameworkError, NotFoundError } from "@meshfw/runtime";
import { buildModel } from "../src/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/emit.ts";
import { actionsGenerator } from "../src/emitters/actions.ts";
import { indexView } from "../src/views/index.ts";
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
      ["createNote", "note.create", "CreateNoteInput", "Note"],
      ["editNote", "note.edit", "EditNoteInput", "Note"],
      ["readNote", "note.read", "ReadNoteInput", "Note[]"],
      ["destroyNote", "note.destroy", "DestroyNoteInput", "void"],
    ]);
    expect(view.types).toEqual(["Note", "CreateNoteInput", "EditNoteInput", "ReadNoteInput", "DestroyNoteInput", "Tag"]);
    expect(view.schemaExports).toEqual(["tables", "noteTable", "tagTable"]);
    expect(view.entities.map((e) => [e.local, e.hasActions, e.actionsFromLiteral, e.typesFromLiteral])).toEqual([
      ["note", true, '"./notes/note.actions"', '"./notes/note.types"'],
      ["tag", false, '"./tag.actions"', '"./tag.types"'],
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
const ops = {
  async insert(_table, row) { rows.set(row.id, { ...row }); return { ...row }; },
  async selectByKey(_table, key) { return rows.get(key.id); },
  async selectAll() { return [...rows.values()]; },
  async updateByKey(_table, key, changes) {
    const row = rows.get(key.id);
    if (!row) return undefined;
    rows.set(key.id, { ...row, ...changes });
    return rows.get(key.id);
  },
  async deleteByKey(_table, key) { return rows.delete(key.id); },
};
export default { data: { kind: "data-adapter", name: "memory", build: "./none", options: {},
  transaction: (run) => run(ops), close: async () => { closes.count++; } } };
`;
const descriptorConfig = `export default { data: { kind: "data-adapter", name: "remote", build: "./none", options: {} } };\n`;

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
