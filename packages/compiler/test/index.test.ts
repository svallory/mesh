import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { FrameworkError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { actionsGenerator } from "../src/typescript/emitters/actions.ts";
import { bindingView } from "../src/typescript/views/binding.ts";
import { indexView } from "../src/typescript/views/index.ts";
import { moduleViews } from "../src/typescript/views/module.ts";
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
  policies
    policy :open
      authorize-if=() => true
`;
const tag = "entity :Tag\n  attributes\n    uuid :id primary-key\n";

function documentOf(files: Record<string, string> = { "notes/note.mesh.mx": note, "tag.mesh.mx": tag }): ModelDocument {
  const built = buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics).toEqual([]);
  return built.document!;
}

describe("binding, module and index views", () => {
  test("the binding view names the config and the root barrel, which `bind` walks; it lists no entity or action", () => {
    expect(bindingView({ document: documentOf(), config: configOf("/project", ".mesh") }))
      .toEqual({ configFromLiteral: '"../mesh.config"', domainFromLiteral: '"./domain/index"' });
  });

  test("the config import is relative to a nested output folder", () => {
    expect(bindingView({ document: documentOf(), config: configOf("/project", "src/generated") }).configFromLiteral).toBe('"../../mesh.config"');
  });

  test("one barrel per folder, the domain root first: each entity's value and types, and a namespace per subfolder", () => {
    const views = moduleViews({ document: documentOf(), config: configOf("/project", ".mesh") });
    expect(views.map(({ path }) => path)).toEqual(["domain/index.ts", "domain/notes/index.ts"]);
    const [root, notes] = views.map(({ view }) => view);
    expect(root).toEqual({
      module: "", specifier: "#mesh/domain", description: "the domain root",
      entities: [{ name: "Tag", actionsFromLiteral: '"./tag.actions"', types: [], hasTypes: false, typesFromLiteral: '"./tag.types"' }],
      loaders: [], loadFromLiteral: null, namespaces: [{ name: "notes", fromLiteral: '"./notes/index"' }] });
    expect(notes).toEqual({
      module: "notes", specifier: "#mesh/domain/notes", description: 'module "notes"',
      entities: [{ name: "Note", actionsFromLiteral: '"./note.actions"', hasTypes: true, typesFromLiteral: '"./note.types"',
        types: ["CreateNoteInput", "EditNoteInput", "ReadNoteInput", "DestroyNoteInput", "NoteFilter", "NoteSort"] }],
      loaders: [], loadFromLiteral: null, namespaces: [] });
  });

  test("the index view names every module's specifier and nothing of an entity", () => {
    expect(indexView({ document: documentOf(), config: configOf("/project", ".mesh") })).toEqual({ modules: ["#mesh/domain", "#mesh/domain/notes"] });
  });

  test("an action whose handle in `actions` spells a table handle (`noteTable`) builds: #mesh re-exports no table handle, only `tables`", async () => {
    // Before the module indexes, `#mesh` re-exported `noteTable` from the schema and this was MESH_EMIT_NAME.
    const table = "entity :Table\n  attributes\n    uuid :id primary-key\n  actions\n    read :note\n";
    const files = await generateFiles({ document: documentOf({ "a/note.mesh.mx": note, "b/table.mesh.mx": table }), config: configOf("/project", ".mesh") });
    expect(files.find((file) => file.path === ".mesh/domain/b/index.ts")!.contents).toContain('export { Table } from "./table.actions";');
    expect(files.find((file) => file.path === ".mesh/domain/b/table.actions.ts")!.contents).toContain("  note(input: NoteTableInput, ...context: $ContextArgument): Promise<Table[]> {");
    expect(files.find((file) => file.path === ".mesh/index.ts")!.contents).not.toContain("noteTable");
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
  refuseIfFailed: () => false,
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
    "export const tables = { notes: {}, tag: {} };\n");
  await writeFile(resolve(root, "mesh.config.ts"), config);
  return { root, files };
}

describe("the generated index", () => {
  test("typechecks with strict unused-name and exact-optional flags", async () => {
    const { root, files } = await generated(descriptorConfig);
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
  }, 30_000);

  test("connect, call, duplicate connect, disconnect, calls after it, no-op disconnect, reconnect", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const notes = await import(resolve(root, ".mesh/domain/notes/index.ts"));
    const { closes } = await import(resolve(root, "mesh.config.ts"));
    await expect(notes.Note.create({ text: "a" })).rejects.toThrow(
      new FrameworkError("notes.Note#create was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
    await mesh.disconnect();
    expect(closes.count).toBe(0);
    await mesh.connect();
    await expect(mesh.connect()).rejects.toThrow("connect() was called while connected; call disconnect() first");
    const created = await notes.Note.create({ text: "a" });
    expect((await notes.Note.edit({ id: created.id, text: "b" })).text).toBe("b");
    expect(await notes.Note.read({})).toHaveLength(1);
    await mesh.disconnect();
    expect(closes.count).toBe(1);
    await expect(notes.Note.read({})).rejects.toBeInstanceOf(FrameworkError);
    await mesh.disconnect();
    expect(closes.count).toBe(1);
    await mesh.connect();
    await notes.Note.destroy({ id: created.id });
    await expect(notes.Note.destroy({ id: created.id })).rejects.toBeInstanceOf(NotFoundError);
    await mesh.disconnect();
  });

  test("disconnect waits for calls already made, refuses new ones at once, then closes", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const notes = await import(resolve(root, ".mesh/domain/notes/index.ts"));
    const { events } = await import(resolve(root, "mesh.config.ts"));
    await mesh.connect();
    const pending = notes.Note.create({ text: "in flight" });
    const failing = notes.Note.create({ text: 42 }).then(() => null, (error: unknown) => error);
    const closing = mesh.disconnect();
    await expect(notes.Note.read({})).rejects.toBeInstanceOf(FrameworkError);
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
    const notes = await import(resolve(root, ".mesh/domain/notes/index.ts"));
    const { closes, failClose } = await import(resolve(root, "mesh.config.ts"));
    await mesh.connect();
    failClose.next = true;
    await expect(mesh.disconnect()).rejects.toThrow("close failed");
    expect(await notes.Note.read({})).toEqual([]);
    await expect(mesh.connect()).rejects.toThrow("connect() was called while connected; call disconnect() first");
    await mesh.disconnect();
    expect(closes.count).toBe(1);
    await expect(notes.Note.read({})).rejects.toBeInstanceOf(FrameworkError);
  });

  test("an index for a domain without actions type-checks strictly", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-index-empty-"));
    roots.push(root);
    const config = configOf(root, ".mesh");
    const files = await generateFiles({ document: documentOf({ "tag.mesh.mx": tag }), config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, ".mesh/schema.ts"), "export const tables = { tag: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), descriptorConfig);
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    // With no action, the binding is still `run` and `transaction`, whose callback is handed nothing (TXN-20).
    const bound = mesh.bind({ transaction: async (run: (tx: object) => Promise<unknown>) => run({}), refuseIfFailed: () => false, close: async () => {} });
    expect(Object.keys(bound)).toEqual(["run", "transaction"]);
    expect(await bound.run(async () => "ran")).toBe("ran");
    expect(await bound.transaction(async (...args: unknown[]) => args.length)).toBe(0);
  }, 30_000);

  test("bind returns a frozen binding, `run` and `transaction`, over a caller's layer, and disconnect never closes it", async () => {
    const { root } = await generated();
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const notes = await import(resolve(root, ".mesh/domain/notes/index.ts"));
    let closed = 0;
    const rows: unknown[] = [];
    const layer = {
      transaction: (run: (tx: object) => Promise<unknown>) => run({ insert: async (_t: object, row: object) => { rows.push(row); return row; } }),
      refuseIfFailed: () => false,
      close: async () => { closed++; },
    };
    const bound = mesh.bind(layer);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.keys(bound)).toEqual(["run", "transaction"]);
    await bound.run(() => notes.Note.create({ text: "x" }));
    expect(rows).toHaveLength(1);
    await mesh.connect();
    await mesh.disconnect();
    expect(closed).toBe(0);
  });

  test("a configured adapter without a run-time half is a FrameworkError at connect", async () => {
    const { root } = await generated(descriptorConfig);
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const notes = await import(resolve(root, ".mesh/domain/notes/index.ts"));
    await expect(mesh.connect()).rejects.toThrow(new FrameworkError(
      'The data adapter "remote" configured in mesh.config.ts has no run-time half: connect() needs a data layer with transaction(), refuseIfFailed() and close()'));
    await expect(notes.Note.read({})).rejects.toBeInstanceOf(FrameworkError);
  });
});

describe("entity names never break the generated files", () => {
  // Reserved words, `bind`'s parameter, and the names of Mesh's own imports.
  // `Privileged` and `ReadOnly` spell the types each actions file declares as `$Privileged` and `$ReadOnly`.
  const names = ["Class", "Default", "Function", "Layer", "DataLayer", "ContextArgument", "FrameworkError", "NotFoundError", "Tables", "Flight", "Binding", "Privileged", "ReadOnly"];
  // And actions whose handles in `actions` spell names the binding once used: `:in` on Flight is `inFlight`,
  // `:default` on Binding is `defaultBinding`.
  const extra: Record<string, string> = { Flight: "    read :in\n", Binding: "    read :default\n" };
  const files = Object.fromEntries(names.map((name) => [`${name.toLowerCase()}.mesh.mx`,
    `entity :${name}\n  attributes\n    uuid :id primary-key\n    string :label\n  actions auto=[:read, :destroy]\n    create :create\n      input\n        &label\n    update :edit\n      input\n        &label\n${extra[name] ?? ""}  policies\n    policy :open\n      authorize-if=() => true\n`]));
  // The default table name: the entity name in snake_case.
  const table = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

  test("they build, type-check strictly and run", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-index-names-"));
    roots.push(root);
    const config = configOf(root, ".mesh");
    const generatedFiles = await generateFiles({ document: documentOf(files), config });
    await writeGeneratedFiles(generatedFiles, config);
    await writeFile(resolve(root, ".mesh/schema.ts"), [
      `export const tables = { ${names.map((name) => `${table(name)}: {}`).join(", ")} };`, ""].join("\n"));
    await writeFile(resolve(root, "mesh.config.ts"), descriptorConfig);
    expect(checkTypes(root, [...generatedFiles.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), ".mesh/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
    const mesh = await import(resolve(root, ".mesh/index.ts"));
    const domain = await import(resolve(root, ".mesh/domain/index.ts"));
    expect(Object.keys(mesh).sort()).toEqual(["bind", "connect", "disconnect", "privileged", "tables", "transaction"]);
    const rows: object[] = [];
    const bound = mesh.bind({ transaction: (run: (tx: object) => Promise<unknown>) => run({ insert: async (_t: object, row: object) => { rows.push(row); return row; } }), refuseIfFailed: () => false, close: async () => {} });
    for (const name of names) expect((await bound.run(() => domain[name].create({ label: name }))).label).toBe(name);
    expect(typeof domain.Flight.in).toBe("function");
    expect(typeof domain.Binding.default).toBe("function");
    expect(Object.keys(domain).sort()).toEqual([...names].sort());
    expect(rows).toHaveLength(names.length);
  }, 30_000);

  test("an action named toString or constructor never reaches an entity value: the build refuses it", () => {
    // The entity value has no prototype, so such an action would be a plain member (packages/runtime/test/entity.test.ts
    // shows it); the language refuses every built-in object property name as a member name first.
    const odd = "entity :Odd\n  attributes\n    uuid :id primary-key\n  actions\n    read :toString\n    read :constructor\n";
    const built = buildModel({ root: "/project", files: [{ file: "odd.mesh.mx", source: odd }] });
    expect(built.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["MESH_ATTRIBUTE_NAME", "toString is the name of a built-in object property. Choose another name."],
      ["MESH_ATTRIBUTE_NAME", "constructor is the name of a built-in object property. Choose another name."],
    ]);
  });

  test.each(["Promise", "Partial", "ReturnType"])("an entity named %s, which would shadow a global type the generated code uses, is MESH_EMIT_NAME", (name) => {
    let error: unknown;
    try { actionsGenerator.views({ document: documentOf({ "x.mesh.mx": files["class.mesh.mx"]!.replace(":Class", `:${name}`) }), config: configOf("/project") }); }
    catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({ code: "MESH_EMIT_NAME", fix: "Rename the entity",
      message: `Entity ${name} would generate the type ${name}, which shadows the global ${name} the generated code uses` });
  });
});
