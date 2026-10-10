import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { FrameworkError, InvalidInputError, NotFoundError, type DataLayer, type DataOperations, type Row, type TableHandle } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles, type EmitInput } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { actionsGenerator } from "../src/typescript/emitters/actions.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { checkTypes, configOf } from "./generated.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const author = `entity :Author table="authors"
  attributes
    uuid :id primary-key
    string :name
  actions auto=[:read]
    create :create
      input
        &name
`;
const article = `import { Author } from "./author.mesh.mx"

entity :Article table="articles"
  attributes
    uuid :id primary-key
    string :title min=1
    string :body nullable
    integer :views default=0
    enum :state values=[:draft, :live] default=:draft
    boolean :pinned default=false
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update
  relationships
    belongs-to :author entity=Author
    belongs-to :editor entity=Author nullable
  actions auto=[:read, :destroy] on:load=&load
    always types=[:update]
      validate
        check :fresh that=() => true code="stale" message="stale"
    create :create
      input
        &title
        &body
        &views
        &author
      do
        set
          &pinned=true
    update :rename
      input
        &title
        &editor
    update :publish
      validate
        check :titled that=() => &title.length > 0 code="t" message="t"
      do
        set
          &state=:live
        set
          &views=() => 1
        when=() => true
          run() { }
        load=[&author]
    destroy :purge
    read :live
      filter=() => &state === :live
    read :load
  policies
    policy :editors actions=[&rename]
      authorize-if=() => true
    policy :everyone
      authorize-if=() => true
`;

function documentOf(files: Record<string, string> = { "blog/author.mesh.mx": author, "blog/article.mesh.mx": article }): ModelDocument {
  const built = buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics).toEqual([]);
  return built.document!;
}
function inputOf(document = documentOf()): EmitInput {
  return { document, config: configOf("/project") };
}
function viewOf(name: string, input = inputOf()) {
  return actionsView(input, input.document.entities.find((entity) => entity.name === name)!);
}
function emitErrorOf(run: () => unknown): EmitError {
  try { run(); }
  catch (cause) { if (cause instanceof EmitError) return cause; throw cause; }
  throw new Error("expected an EmitError");
}

describe("actions view", () => {
  test("one method per effective action: declared in authored order, then auto", () => {
    const view = viewOf("Article");
    expect(view.bindName).toBe("bindArticle");
    expect(view.methods.map((m) => [m.name, m.functionName, m.inputType, m.validator, m.returnType])).toEqual([
      ["create", "createArticle", "CreateArticleInput", "createArticleInput", "Article"],
      ["rename", "renameArticle", "RenameArticleInput", "renameArticleInput", "Article"],
      ["publish", "publishArticle", "PublishArticleInput", "publishArticleInput", 'ArticleWith<"author">'],
      ["purge", "purgeArticle", "PurgeArticleInput", "purgeArticleInput", "void"],
      ["live", "liveArticle", "LiveArticleInput", "liveArticleInput", "Article[]"],
      ["load", "loadArticle", "LoadArticleInput", "loadArticleInput", "Article[]"],
      ["read", "readArticle", "ReadArticleInput", "readArticleInput", "Article[]"],
      ["destroy", "destroyArticle", "DestroyArticleInput", "destroyArticleInput", "void"],
    ]);
    expect(view.runtimeValues).toEqual([
      "FrameworkError as $FrameworkError", "InvalidInputError as $InvalidInputError", "NotFoundError as $NotFoundError", "guarded as $guarded",
      "loadRows as $loadRows", "parseInput", "readOnlyRecord as $readOnlyRecord", "runCheck as $runCheck", "scope as $scope"]);
    expect(view.runtimeTypes).toEqual(["Issue as $Issue", "Row as $Row"]);
    expect(view.typesFromLiteral).toBe('"./article.types"');
    expect(view.validatorsFromLiteral).toBe('"./article.validators"');
    expect(view.schemaFromLiteral).toBe('"../schema"');
  });

  test("create builds the proposed record in declared order by the five rules; a set step runs after it", () => {
    const create = viewOf("Article").methods[0]!;
    expect(create.statements.slice(1)).toEqual([
      "const $now = options.clock?.() ?? new Date();",
      "// plan: a create is one insert; nothing is read first",
      "const $changes: $Row = {",
      "title: parsed.title,",
      "body: parsed.body === undefined ? null : parsed.body,",
      "views: parsed.views === undefined ? 0 : parsed.views,",
      'state: "draft",',
      "pinned: false,",
      "insertedAt: $now,",
      "updatedAt: $now,",
      "authorId: parsed.author,",
      "editorId: null,",
      "};",
      "const $record: $Row = { ...$changes };",
      "// do: the steps run in written order, each seeing the record as the ones before it left it",
      "$changes.pinned = $record.pinned = true;",
      "// data layer",
      "const $stored = await tx.insert(tables.article, $changes);",
      "return $stored as Article;",
    ]);
    expect(create.notRun).toBe("Not run in this version: on:load load; policies everyone");
  });

  test("update reads the row under the lock, applies the accepted input, runs the checks and writes only what changed", () => {
    const [, rename, publish] = viewOf("Article").methods;
    const text = rename!.statements.join("\n");
    expect(text).toContain("const $before = await tx.selectByKeyForUpdate(tables.article, $key);");
    expect(text).toContain('if ($before === undefined) throw new $NotFoundError("Article", $key);');
    expect(text).toContain("if (parsed.title !== undefined) $changes.title = $record.title = parsed.title;");
    expect(text).toContain("if (parsed.editor !== undefined) $changes.editorId = $record.editorId = parsed.editor;");
    expect(text).toContain("$changes.updatedAt = $now;");
    expect(text).toContain("const $stored = await tx.updateByKey(tables.article, $key, $changes);");
    // always types=[:update]: its check runs on every update, before the action's own
    expect(rename!.statements.filter((line) => line.startsWith("await $runCheck"))).toHaveLength(1);
    expect(publish!.statements.filter((line) => line.startsWith("await $runCheck")).map((line) => /label: "(\w+)"/.exec(line)![1])).toEqual(["fresh", "titled"]);
    expect(publish!.returnType).toBe('ArticleWith<"author">');
    expect(rename!.notRun).toBe("Not run in this version: on:load load; policies editors, everyone");
    expect(publish!.notRun).toBe("Not run in this version: on:load load; policies everyone");
  });

  test("a read selects every row; a read with filter or sort validates, then throws naming M10", () => {
    const methods = viewOf("Article").methods;
    const live = methods.find((m) => m.name === "live")!;
    expect(live.unsupported).toBe('"liveArticle cannot run in this version: its filter is evaluated by the SQL evaluator, which arrives in M10"');
    expect(live.statements).toEqual([]);
    const read = methods.find((m) => m.name === "read")!;
    expect(read).toMatchObject({ unsupported: null, usesParsed: true, statements: [
      "return (await tx.select(tables.article, { filter: parsed.filter, sort: parsed.sort, limit: parsed.limit, offset: parsed.offset })) as Article[];"] });
  });

  test("a destroy whose body cannot see the record deletes by key and turns a missing row into NotFoundError", () => {
    const destroy = viewOf("Article").methods.find((m) => m.name === "destroy")!;
    expect(destroy.statements.slice(2)).toEqual([
      "const $key = { id: parsed.id };",
      "// data layer",
      'if (!(await tx.deleteByKey(tables.article, $key))) throw new $NotFoundError("Article", $key);',
    ]);
    expect(destroy.notRun).toBe("Not run in this version: policies everyone");
  });

  test("an entity without actions binds an empty object and imports nothing else", () => {
    const view = viewOf("Lone", inputOf(documentOf({ "lone.mesh.mx": "entity :Lone\n  attributes\n    uuid :id primary-key\n" })));
    expect(view).toMatchObject({ hasActions: false, methods: [], runtimeValues: [], typeImports: [], validatorImports: [], schemaFromLiteral: '"./schema"' });
  });
});

describe("build errors", () => {
  test("MESH_EMIT_UNFILLABLE names the action and the attribute, at the attribute", () => {
    const source = article.replace("        &title\n        &body\n        &views\n", "        &body\n");
    const error = emitErrorOf(() => viewOf("Article", inputOf(documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source }))));
    expect(error.diagnostic).toEqual({
      severity: "error",
      code: "MESH_EMIT_UNFILLABLE",
      message: "Create action :create of :Article cannot fill `title`: it is not accepted, has no default and is not nullable",
      position: expect.objectContaining({ file: "blog/article.mesh.mx", line: 6 }),
      fix: "Accept &title in the action's input, give it a default, make it nullable or fill it with a `set` step",
    });
  });

  test("MESH_EMIT_UNFILLABLE for a required belongs-to that is not accepted", () => {
    const source = article.replace("        &author\n      do", "      do");
    const error = emitErrorOf(() => viewOf("Article", inputOf(documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source }))));
    expect(error.diagnostic.message).toBe("Create action :create of :Article cannot fill `authorId`: it is not accepted, has no default and is not nullable");
    expect(error.diagnostic.position.line).toBe(14);
  });

  test("negative: a create that accepts every required column builds", () => {
    expect(() => viewOf("Article")).not.toThrow();
  });

  test("a destroy action may accept input (D05): an argument reaches the checks as input", () => {
    const source = article.replace("    destroy :purge\n", "    destroy :purge\n      input\n        string :reason\n      validate\n        check :reasoned that=({ input }) => input.reason.length > 0 code=\"r\" message=\"r\"\n");
    const view = viewOf("Article", inputOf(documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source })));
    const purge = view.methods.find((m) => m.name === "purge")!;
    expect(purge.inputType).toBe("PurgeArticleInput");
    expect(purge.statements.join("\n")).toContain("tx.selectByKeyForUpdate(tables.article, $key)");
    expect(purge.statements.join("\n")).toContain('label: "reasoned"');
  });

  test("MESH_EMIT_NAME: two entities of one name in two modules, naming both positions", () => {
    const a = "entity :Ab\n  attributes\n    uuid :id primary-key\n  actions\n    read :cd\n";
    const twice = { "x/ab.mesh.mx": a, "y/ab.mesh.mx": a };
    const error = emitErrorOf(() => actionsGenerator.views(inputOf(documentOf(twice))));
    expect(error.diagnostic.code).toBe("MESH_EMIT_NAME");
    expect(error.diagnostic.message).toBe("Entity :Ab's binding and Entity :Ab's binding (x/ab.mesh.mx:1:1) both become the top-level name `bindAb`");
    expect(error.diagnostic.position.file).toBe("y/ab.mesh.mx");
  });

  test("MESH_EMIT_NAME: an action function colliding with another entity's", () => {
    const one = "entity :Item\n  attributes\n    uuid :id primary-key\n  actions\n    read :forUser\n";
    const two = "entity :ForUserItem\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    const three = "entity :UserItem\n  attributes\n    uuid :id primary-key\n  actions\n    read :for\n";
    const error = emitErrorOf(() => actionsGenerator.views(inputOf(documentOf({ "a/item.mesh.mx": one, "b/user-item.mesh.mx": three, "c/x.mesh.mx": two }))));
    expect(error.diagnostic.message).toBe("Action :for of :UserItem and Action :forUser of :Item (a/item.mesh.mx:5:5) both become the top-level name `forUserItem`");
    expect(error.diagnostic.position).toMatchObject({ file: "b/user-item.mesh.mx", line: 5 });
  });

  test("negative: distinct names across entities build", () => {
    expect(actionsGenerator.views(inputOf()).map((file) => file.path)).toEqual(["generated/blog/article.actions.ts", "generated/blog/author.actions.ts"]);
  });
});

/** A Map-backed data layer: each table handle is a Map from id to row. */
function memoryLayer(): DataLayer {
  const of = (table: TableHandle) => (table as { rows: Map<unknown, Row> }).rows;
  const ops: DataOperations = {
    // The data layer fills the key of a row that lacks one (the generated create no longer writes it).
    async insert(table, row) { const stored = { ...row, id: row.id ?? crypto.randomUUID() }; of(table).set(stored.id, stored); return { ...stored }; },
    async selectByKey(table, key) { return of(table).get(key.id); },
    async select(table) { return [...of(table).values()]; },
    async selectByKeyForUpdate(table, key) { return of(table).get(key.id); },
    async max() { throw new Error("not used"); },
    async count() { throw new Error("not used"); },
    async updateByKey(table, key, changes) {
      const row = of(table).get(key.id);
      if (!row) return undefined;
      const next = { ...row, ...changes };
      of(table).set(key.id, next);
      return next;
    },
    async deleteByKey(table, key) { return of(table).delete(key.id); },
  };
  return { transaction: (run) => run(ops), close: async () => {} };
}

describe("the generated file", () => {
  async function generated() {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-actions-"));
    roots.push(root);
    const config = configOf(root);
    const files = await generateFiles({ document: documentOf(), config });
    await writeGeneratedFiles(files, config);
    // A schema stub in place of the data adapter's: each handle carries the rows the memory layer reads.
    await writeFile(resolve(root, "generated/schema.ts"),
      "export const articleTable = { rows: new Map() };\nexport const authorTable = { rows: new Map() };\nexport const tables = { article: articleTable, author: authorTable };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    return { root, files };
  }

  test("typechecks with strict unused-name and exact-optional flags", async () => {
    const { root, files } = await generated();
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), "generated/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
  });

  test("runs create, update, read, destroy against a data layer", async () => {
    const { root } = await generated();
    const { bindArticle } = await import(resolve(root, "generated/blog/article.actions.ts"));
    const { bindAuthor } = await import(resolve(root, "generated/blog/author.actions.ts"));
    const layer = memoryLayer();
    const articles = bindArticle(layer);
    const authors = bindAuthor(layer);
    expect(Object.isFrozen(articles)).toBe(true);
    const ada = await authors.create({ name: "Ada" });
    const created = await articles.create({ title: "Hello", author: ada.id });
    expect(created).toMatchObject({ title: "Hello", body: null, views: 0, state: "draft", pinned: true, authorId: ada.id, editorId: null });
    expect(created.insertedAt).toBeInstanceOf(Date);
    expect(created.insertedAt).toBe(created.updatedAt);
    const published = await articles.publish({ id: created.id });
    expect(published.state).toBe("live");
    expect(published.insertedAt).toBe(created.insertedAt);
    expect(published.updatedAt).not.toBe(created.updatedAt);
    expect(typeof created.id).toBe("string");
    expect(await articles.read({})).toHaveLength(1);
    await expect(articles.live({})).rejects.toBeInstanceOf(FrameworkError);
    await expect(articles.create({ title: "x", author: ada.id, typo: 1 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(articles.live({ typo: 1 })).rejects.toBeInstanceOf(InvalidInputError);
    await articles.destroy({ id: created.id });
    await expect(articles.destroy({ id: created.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(articles.rename({ id: created.id, title: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await articles.read({})).toEqual([]);
  });
});

describe("explain", () => {
  const article_ = () => documentOf().entities.find((entity) => entity.name === "Article")!;
  test("an update is a read then a write, and lists the always check, its checks and its steps in order", () => {
    expect(explainAction(article_(), "publish")!.join("\n")).toBe([
      "Article.publish (update)",
      "  strategy     read-then-write: every update reads the row under the write lock, checks it, changes it, then writes it",
      "  input        none",
      "  checks       always: fresh (stale)",
      "               titled (t)",
      "  steps        set &state = \"live\"",
      "               set &views = () => 1",
      "               when () => true",
      "                 run () { }",
      "               load &author",
      "  policy       everyone: declared, not run in this version (M8)",
    ].join("\n"));
  });
  test("an update with no check still reads first", () => {
    expect(explainAction(article_(), "rename")![1]).toContain("read-then-write");
  });
  test("a create is one insert; a destroy reads only when the body can see the record; a read is one query", () => {
    expect(explainAction(article_(), "create")![1]).toBe("  strategy     one insert; nothing is read first");
    expect(explainAction(article_(), "purge")![1]).toContain("one delete by key");
    expect(explainAction(article_(), "live")![1]).toContain("one query");
  });
  test("explain agrees with the generated code on whether a destroy reads the row", () => {
    const source = (body: string) => article.replace("    destroy :purge\n", `    destroy :purge\n${body}`);
    for (const [body, reads] of [["", false], ["      do\n        run({ self }) { console.log(self.title) }\n", true]] as const) {
      const files = { "blog/author.mesh.mx": author, "blog/article.mesh.mx": source(body) };
      const doc = documentOf(files);
      const entity = doc.entities.find((e) => e.name === "Article")!;
      const code = viewOf("Article", inputOf(doc)).methods.find((m) => m.name === "purge")!.statements.join("\n");
      expect(code.includes("selectByKeyForUpdate")).toBe(reads);
      expect(explainAction(entity, "purge")![1]).toContain(reads ? "read-then-write" : "one delete by key");
    }
  });
  test("an auto action is explained and an unknown action is undefined", () => {
    expect(explainAction(article_(), "destroy")![0]).toBe("Article.destroy (destroy)");
    expect(explainAction(article_(), "nope")).toBeUndefined();
  });
});
