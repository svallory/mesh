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
  policies
    policy :open
      authorize-if=() => true
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
    expect(view.methods.map((m) => [m.name, m.labelLiteral, m.inputType, m.validator, m.returnType])).toEqual([
      ["create", '"blog.Article#create"', "CreateArticleInput", "createArticleInputSchema", "Article"],
      ["rename", '"blog.Article#rename"', "RenameArticleInput", "renameArticleInputSchema", "Article"],
      ["publish", '"blog.Article#publish"', "PublishArticleInput", "publishArticleInputSchema", 'ArticleWith<"author">'],
      ["purge", '"blog.Article#purge"', "PurgeArticleInput", "purgeArticleInputSchema", "void"],
      ["live", '"blog.Article#live"', '$Omit<LiveArticleInput, "load"> & ArticleLoadArg<L>', "liveArticleInputSchema", "(L extends unknown ? ArticleWith<ArticleLoadNames<L>>[] : never)"],
      ["load", '"blog.Article#load"', '$Omit<LoadArticleInput, "load"> & ArticleLoadArg<L>', "loadArticleInputSchema", "(L extends unknown ? ArticleWith<ArticleLoadNames<L>>[] : never)"],
      ["read", '"blog.Article#read"', '$Omit<ReadArticleInput, "load"> & ArticleLoadArg<L>', "readArticleInputSchema", "(L extends unknown ? ArticleWith<ArticleLoadNames<L>>[] : never)"],
      ["destroy", '"blog.Article#destroy"', "DestroyArticleInput", "destroyArticleInputSchema", "void"],
    ]);
    expect(view.runtimeValues).toEqual([
      "FrameworkError as $FrameworkError", "InvalidInputError as $InvalidInputError", "NO_FRAME as $NO_FRAME", "NotFoundError as $NotFoundError", "authorizer as $authorizer", "castInput as $castInput", "checkScope as $checkScope",
      "checkUnchanged as $checkUnchanged", "entity as $entity", "failJoined as $failJoined", "guarded as $guarded", "loadRows as $loadRows",
      "noteWrite as $noteWrite", "pinClock as $pinClock", "readOnlyRecord as $readOnlyRecord", "recordWrite as $recordWrite", "runAction as $runAction", "runCheck as $runCheck", "scope as $scope", "uuidv7 as $uuidv7", "wantsChanges as $wantsChanges", "writeCount as $writeCount"]);
    expect(view.runtimeTypes).toEqual(["CastOutput as $CastOutput", "DataOperations as $DataOperations", "Issue as $Issue", "LoadOptions as $LoadOptions"]);
    expect(view.typesFromLiteral).toBe('"./article.types"');
    expect(view.validatorsFromLiteral).toBe('"./article.validators"');
    expect(view.schemaFromLiteral).toBe('"../../schema"');
  });

  test("create builds the new instance in declared order (key, defaults, stamps, null), then applies the input; a set step runs after it", () => {
    const create = viewOf("Article").methods[0]!;
    expect(create.statements.slice(1)).toEqual([
      "const $now = $clock();",
      "// plan: a create is one insert; nothing is read first",
      // typed with the record's own columns, so a column named `toString` is that column, not the inherited method
      "const $changes: $Omit<$Record, \"title\" | \"authorId\"> & { title: $Record[\"title\"] | null; authorId: $Record[\"authorId\"] | null } = {",
      // the uuid key is filled when the instance is built, not by the data layer at the write
      "id: $uuidv7(),",
      "body: null,",
      "views: 0,",
      'state: "draft",',
      "pinned: false,",
      "insertedAt: $now,",
      "updatedAt: $now,",
      "editorId: null,",
      // what the input fills is null on the instance the checks see and in the row until the input is applied
      "title: null,",
      "authorId: null,",
      "};",
      "const $record: $Omit<$Record, \"title\" | \"authorId\"> & { title: $Record[\"title\"] | null; authorId: $Record[\"authorId\"] | null } = { ...$changes };",
      "// the input: the member inputs the caller sent, applied now that the checks have passed",
      'if ($Object.hasOwn(parsed, "title") && parsed.title !== undefined) $changes.title = $record.title = parsed.title;',
      'if ($Object.hasOwn(parsed, "body") && parsed.body !== undefined) $changes.body = $record.body = parsed.body;',
      'if ($Object.hasOwn(parsed, "views") && parsed.views !== undefined) $changes.views = $record.views = parsed.views;',
      'if ($Object.hasOwn(parsed, "author") && parsed.author !== undefined) $changes.authorId = $record.authorId = parsed.author;',
      "// do: the steps run in written order, each seeing the record as the ones before it left it",
      "$changes.pinned = $record.pinned = true;",
      "// data layer",
      "const $stored = await tx.insert(tables.articles, $changes);",
      "$noteWrite(tx);",
      "// seam: afterWrite runs here, inside the transaction, before the steps marked after=:write; application code, so what it calls resolves with plain values",
      'await frame.plain(() => $recordWrite(tx, options.seams, { entity: "blog.Article", action: "create" }, null, $stored, parsed, context));',
      "return $stored as Article;",
    ]);
    expect(create.notRun).toBe("Not run in this version: on:load load");
    // M8: the policies run before the transaction (the context and the clock are read there, once, for the whole call).
    expect(create.preCheck).toEqual([
      expect.stringMatching(/^\/\/ pre-check: /),
      "const $context = (context ?? {}) as unknown as { [key: string]: unknown };",
      "const $actor = $context.actor;",
      "const $clock = frame.clock(options.clock);",
      'const $policies = $authorizer("blog.Article", "create", [{ name: "everyone", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: $expressions["policy.everyone.authorize-if.0"] }] }]);',
      'await $policies.before(layer, $scope({ input: $readOnlyRecord(parsed, "blog.Article#create"), actor: $actor, context: $context }, { clock: $clock }));',
    ]);
  });

  test("update reads the row under the lock, runs the checks, then applies the accepted input and writes only what changed", () => {
    const [, rename, publish] = viewOf("Article").methods;
    const text = rename!.statements.join("\n");
    expect(text).toContain("const $before = (await tx.selectByKeyForUpdate(tables.articles, $key)) as $Record | undefined;");
    expect(text).toContain('if ($before === undefined) throw new $NotFoundError("blog.Article", $key);');
    expect(text).toContain('if ($Object.hasOwn(parsed, "title") && parsed.title !== undefined) $changes.title = $record.title = parsed.title;');
    expect(text).toContain('if ($Object.hasOwn(parsed, "editor") && parsed.editor !== undefined) $changes.editorId = $record.editorId = parsed.editor;');
    // the checks see the stored record; the input is applied after them, before the steps and the write
    const at = (line: string) => rename!.statements.findIndex((statement) => statement.startsWith(line));
    expect(at("await $runCheck")).toBeGreaterThan(at("const $record: $Record = { ...$before };"));
    expect(at('if ($Object.hasOwn(parsed, "title") && parsed.title !== undefined)')).toBeGreaterThan(at("if ($issues.length > 0)"));
    expect(at("const $stored = await tx.updateByKey")).toBeGreaterThan(at('if ($Object.hasOwn(parsed, "editor") && parsed.editor !== undefined)'));
    expect(text).toContain("$changes.updatedAt = $now;");
    expect(text).toContain("const $stored = await tx.updateByKey(tables.articles, $key, $changes);");
    // always types=[:update]: its check runs on every update, before the action's own
    expect(rename!.statements.filter((line) => line.startsWith("await $runCheck"))).toHaveLength(1);
    expect(publish!.statements.filter((line) => line.startsWith("await $runCheck")).map((line) => /label: "(\w+)"/.exec(line)![1])).toEqual(["fresh", "titled"]);
    expect(publish!.returnType).toBe('ArticleWith<"author">');
    expect(rename!.notRun).toBe("Not run in this version: on:load load");
    expect(publish!.notRun).toBe("Not run in this version: on:load load");
    expect(rename!.preCheck.find((line) => line.startsWith("const $policies"))).toContain('[{ name: "editors", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: $expressions["policy.editors.authorize-if.0"] }] }, { name: "everyone"');
    // No policy reads the record: nothing runs inside the transaction for them.
    expect(text).not.toContain("$policies.inside");
  });

  test("a read selects every row; a read with filter or sort validates, then throws naming M10", () => {
    const view = viewOf("Article");
    // The body lives in the reads table (`bindArticleReads`), which `tx` uses; the method evaluates the read's policies, then calls it.
    expect(view.readsBindName).toBe("bindArticleReads");
    const live = view.reads.find((m) => m.name === "live")!;
    expect(live.unsupported).toBe('"blog.Article#live cannot run in this version: its filter is evaluated by the SQL evaluator, which arrives in M10"');
    expect(live.statements).toEqual([]);
    const read = view.reads.find((m) => m.name === "read")!;
    expect(read).toMatchObject({ unsupported: null, usesParsed: true, statements: [
      "const $rows = (await tx.select(tables.articles, { filter: parsed.filter, sort: parsed.sort, limit: parsed.limit, offset: parsed.offset })) as Article[];",
      // Through `tx` no policy runs, so the author is always there: the body is typed with `ArticleTxWith`.
      "if (!parsed.load?.length) return $rows as unknown as (L extends unknown ? ArticleTxWith<ArticleLoadNames<L>>[] : never);",
      "const $context = (context ?? {}) as unknown as { [key: string]: unknown };",
      'const $clock = clock ?? $pinClock(options.clock);',
      'return (await $loadRows($loadPlan, "blog.Article", tx, $rows, parsed.load, { actor: $context.actor, context: $context, clock: $clock, policies, frame })) as unknown as (L extends unknown ? ArticleTxWith<ArticleLoadNames<L>>[] : never);'],
      generics: "<const L extends readonly (keyof ArticleLoadable)[] = readonly []>",
      // The read action casts its input once, for its policies, and hands it over as `cast` (R2-N4); a `privileged` read casts it in the body.
      contextParam: ", context?: unknown, clock?: () => $Date, policies?: boolean, cast?: $CastOutput<typeof readArticleInputSchema>" });
    // The read action asks for the load's policies (`true`); a caller's result is typed with `ArticleWith`, where the author may be null.
    expect(view.methods.filter((m) => m.isRead).map((m) => [m.name, m.readsCall, m.statements])).toEqual([
      ["live", "$reads.live(input, context)", []],
      ["load", "(await $reads.load(input, context, $clock, true, $parsed)) as unknown as (L extends unknown ? ArticleWith<ArticleLoadNames<L>>[] : never)", []],
      ["read", "(await $reads.read(input, context, $clock, true, $parsed)) as unknown as (L extends unknown ? ArticleWith<ArticleLoadNames<L>>[] : never)", []]]);
    expect(view.methods.find((m) => m.name === "read")!.txReturnType).toBe("(L extends unknown ? ArticleTxWith<ArticleLoadNames<L>>[] : never)");
    // A read's policies are a filter; the read the SQL evaluator must run fails in its body whatever they say.
    expect(view.methods.find((m) => m.name === "live")!.preCheck).toEqual([]);
    const readMethod = view.methods.find((m) => m.name === "read")!;
    // The checks see the cast input, as a write's do (N2 of the review); an invalid input is reported as one, denied or not.
    expect(readMethod.preCheck.slice(4)).toEqual([
      "const $parsed = await $castInput(layer, readArticleInputSchema, input);",
      'if (!(await $authorizer("blog.Article", "read", [{ name: "everyone", when: null, checks: [{ kind: "authorize-if", check: "() => true", record: false, run: $expressions["policy.everyone.authorize-if.0"] }] }], frame).filter(layer, $scope({ input: $readOnlyRecord($parsed as never, "blog.Article#read"), actor: $actor, context: $context }, { clock: $clock })))) return [] as unknown as (L extends unknown ? ArticleWith<ArticleLoadNames<L>>[] : never);',
    ]);
  });

  test("a destroy whose body cannot see the record deletes by key and turns a missing row into NotFoundError", () => {
    const destroy = viewOf("Article").methods.find((m) => m.name === "destroy")!;
    expect(destroy.statements.slice(2)).toEqual([
      "const $key = { id: parsed.id };",
      // a seam that wants the changes reads the row first, so `before` is never null on a destroy (M6 ruling 4)
      "const $before = $wantsChanges(options.seams) ? await tx.selectByKeyForUpdate(tables.articles, $key) : undefined;",
      'if ($wantsChanges(options.seams) && $before === undefined) throw new $NotFoundError("blog.Article", $key);',
      "// data layer",
      'if (!(await tx.deleteByKey(tables.articles, $key))) throw new $NotFoundError("blog.Article", $key);',
      "$noteWrite(tx);",
      "// seam: afterWrite runs here, inside the transaction, before the steps marked after=:write; application code, so what it calls resolves with plain values",
      'await frame.plain(() => $recordWrite(tx, options.seams, { entity: "blog.Article", action: "destroy" }, $before ?? null, null, parsed, context));',
    ]);
    expect(destroy.notRun).toBeNull();
  });

  test("an entity without actions binds an empty object and imports only what defines its entity value", () => {
    const view = viewOf("Lone", inputOf(documentOf({ "lone.mesh.mx": "entity :Lone\n  attributes\n    uuid :id primary-key\n" })));
    expect(view).toMatchObject({
      hasActions: false, methods: [], runtimeValues: ["entity as $entity"], typeImports: [], validatorImports: [], schemaFromLiteral: '"../schema"',
      entityName: "Lone", fqnLiteral: '"Lone"', readsBindValue: "null",
    });
  });
});

describe("build errors", () => {
  test("MESH_EMIT_UNFILLABLE names the action and the attribute, at the attribute", () => {
    const source = article.replace("        &title\n        &body\n        &views\n", "        &body\n");
    const error = emitErrorOf(() => viewOf("Article", inputOf(documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source }))));
    expect(error.diagnostic).toEqual({
      severity: "error",
      code: "MESH_EMIT_UNFILLABLE",
      message: "Create action :create of blog.Article cannot fill `title`: it is not accepted, has no default and is not nullable",
      position: expect.objectContaining({ file: "blog/article.mesh.mx", line: 6 }),
      fix: "Accept &title in the action's input, give it a default, make it nullable or fill it with a `set` step",
    });
  });

  test("MESH_EMIT_UNFILLABLE for a required belongs-to that is not accepted", () => {
    const source = article.replace("        &author\n      do", "      do");
    const error = emitErrorOf(() => viewOf("Article", inputOf(documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source }))));
    expect(error.diagnostic.message).toBe("Create action :create of blog.Article cannot fill `authorId`: it is not accepted, has no default and is not nullable");
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
    expect(purge.statements.join("\n")).toContain("tx.selectByKeyForUpdate(tables.articles, $key)");
    expect(purge.statements.join("\n")).toContain('label: "reasoned"');
  });

  test("two entities of one name in two modules build: each actions file declares its own bindAb and value", () => {
    // The whole case, built and run on SQLite, is the CLI's same-name fixture (packages/cli/test/same-name.test.ts).
    const a = "entity :Ab\n  attributes\n    uuid :id primary-key\n  actions\n    read :cd\n";
    const files = actionsGenerator.views(inputOf(documentOf({ "x/ab.mesh.mx": a, "y/ab.mesh.mx": a.replace("entity :Ab", "entity :Ab table=\"y_ab\"") })));
    expect(files.map((file) => [file.path, file.view.bindName, file.view.fqnLiteral])).toEqual([
      ["generated/domain/x/ab.actions.ts", "bindAb", '"x.Ab"'],
      ["generated/domain/y/ab.actions.ts", "bindAb", '"y.Ab"'],
    ]);
  });

  test("actions that one flat name would have spelled alike build: an action is called on its entity", () => {
    const one = "entity :Item\n  attributes\n    uuid :id primary-key\n  actions\n    read :forUser\n";
    const two = "entity :ForUserItem\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    const three = "entity :UserItem\n  attributes\n    uuid :id primary-key\n  actions\n    read :for\n";
    expect(actionsGenerator.views(inputOf(documentOf({ "a/item.mesh.mx": one, "b/user-item.mesh.mx": three, "c/x.mesh.mx": two }))).map((file) => file.path))
      .toEqual(["generated/domain/a/item.actions.ts", "generated/domain/b/userItem.actions.ts", "generated/domain/c/forUserItem.actions.ts"]);
  });

  test("negative: distinct names across entities build", () => {
    expect(actionsGenerator.views(inputOf()).map((file) => file.path)).toEqual(["generated/domain/blog/article.actions.ts", "generated/domain/blog/author.actions.ts"]);
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
  return { transaction: (run) => run(ops), refuseIfFailed: () => false, close: async () => {} };
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
      "export const tables = { articles: { rows: new Map() }, authors: { rows: new Map() } };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    return { root, files };
  }

  test("typechecks with strict unused-name and exact-optional flags", async () => {
    const { root, files } = await generated();
    expect(checkTypes(root, [...files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), "generated/schema.ts", "mesh.config.ts"]))
      .toEqual({ code: 0, output: "" });
  }, 30_000);

  test("runs create, update, read, destroy against a data layer", async () => {
    const { root } = await generated();
    const { bindArticle } = await import(resolve(root, "generated/domain/blog/article.actions.ts"));
    const { bindAuthor } = await import(resolve(root, "generated/domain/blog/author.actions.ts"));
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
      "blog.Article#publish (update)",
      "  strategy     read-then-write: every update reads the row under the write lock, checks it, changes it, then writes it",
      "  input        none",
      "  policies     :everyone",
      "                 authorize-if () => true: before the transaction, once",
      "               every policy above must pass; in one, any forbid-if that holds or is unknown forbids, and of its authorize-ifs one must hold",
      "  checks       always: fresh (stale)",
      "               titled (t)",
      "  steps        set &state = \"live\"",
      "               set &views = () => 1",
      "               when () => true",
      "                 run () { }",
      "               load &author",
      "  seams        beforeTransaction: before the transaction opens, for a top-level call only (a call from an action's own code or inside `transaction` joins one and runs none)",
      "               afterWrite: inside the transaction, right after the row is written, before the steps after the write",
      "               afterCommit: once, after the outermost transaction commits, with every change it made",
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
      // With nothing to see the record the read is conditional: only a seam that wants the changes asks for it.
      expect(code.includes("selectByKeyForUpdate")).toBe(true);
      expect(code.includes("$wantsChanges")).toBe(!reads);
      expect(explainAction(entity, "purge")![1]).toContain(reads ? "read-then-write" : "one delete by key");
    }
  });
  test("after-write steps are listed after the write, in their place; a when keeps its condition, read before the write", () => {
    const source = article.replace("    destroy :purge\n", "    destroy :purge\n      do\n        run [after=:write] ({ self }) { console.log(self.title) }\n        run () { }\n")
      .replace("    update :rename\n", "    update :rename\n      do\n        run [after=:write] ({ self }) { console.log(self.id) }\n        when=() => true\n          set\n            &views=2\n          run [after=:write] () { }\n        run () { }\n");
    const entity = documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source }).entities.find((e) => e.name === "Article")!;
    const rename = explainAction(entity, "rename")!;
    expect(rename.slice(rename.findIndex((line) => line.startsWith("  steps")), rename.findIndex((line) => line.startsWith("  seams")))).toEqual([
      "  steps        when () => true",
      "                 set &views = 2",
      "               run () { }",
      "  after write  self is the stored record",
      "               run ({ self }) { console.log(self.id) }",
      "               when () => true (as it held before the write)",
      "                 run () { }",
    ]);
    const purge = explainAction(entity, "purge")!;
    expect(purge[1]).toContain("read-then-write");
    expect(purge.slice(purge.findIndex((line) => line.startsWith("  after write")), purge.findIndex((line) => line.startsWith("  seams")))).toEqual([
      "  after write  self is the deleted row as it was",
      "               run ({ self }) { console.log(self.title) }",
    ]);
    // An action without one has no such section.
    expect(explainAction(article_(), "publish")!.some((line) => line.includes("after write"))).toBe(false);
  });
  test("a write is counted; an update with functions before its write checks the row first, and after-write steps re-read what it returns", () => {
    const source = article.replace("    destroy :purge\n", "    destroy :purge\n      do\n        run [after=:write] ({ self }) { console.log(self.title) }\n")
      .replace("    update :rename\n", "    update :rename\n      do\n        run () { }\n        run [after=:write] () { }\n");
    const doc = documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": source });
    const methods = viewOf("Article", inputOf(doc)).methods;
    const rename = methods.find((m) => m.name === "rename")!.statements;
    const at = (line: string) => rename.findIndex((statement) => statement.startsWith(line));
    // The count is taken after the locked read and before any function runs, and checked just before the write.
    expect(at("const $writes = $writeCount(tx);")).toBeGreaterThan(at("const $before = (await tx.selectByKeyForUpdate"));
    expect(at("const $writes = $writeCount(tx);")).toBeLessThan(at("const $self = "));
    expect(rename[at("const $stored = await tx.updateByKey(") - 1]).toBe('await $checkUnchanged(tx, $writes, tables.articles, $key, $before, "blog.Article#rename");');
    expect(rename[at("const $stored = ") + 2]).toBe("$noteWrite(tx);");
    // The row is read again after the after-write steps, and that is what the call returns.
    expect(at("const $result = await tx.selectByKey(tables.articles, ")).toBeGreaterThan(at("const $stored = "));
    expect(rename.at(-1)).toMatch(/^return \$result as /);
    // A destroy returns nothing, so it reads nothing again.
    expect(methods.find((m) => m.name === "purge")!.statements.some((line) => line.includes("$result"))).toBe(false);
    // An update whose functions all run after the write evaluates nothing before it, so it has no check.
    const lateSource = article.replace("    always types=[:update]\n      validate\n        check :fresh that=() => true code=\"stale\" message=\"stale\"\n", "")
      .replace("    update :rename\n", "    update :rename\n      do\n        run [after=:write] () { }\n");
    const late = viewOf("Article", inputOf(documentOf({ "blog/author.mesh.mx": author, "blog/article.mesh.mx": lateSource })));
    const plain = late.methods.find((m) => m.name === "rename")!.statements;
    expect(plain.some((line) => line.includes("$checkUnchanged") || line.includes("$writeCount"))).toBe(false);
    expect(plain.some((line) => line.startsWith("const $result = await tx.selectByKey("))).toBe(true);
  });
  test("an auto action is explained and an unknown action is undefined", () => {
    expect(explainAction(article_(), "destroy")![0]).toBe("blog.Article#destroy (destroy)");
    expect(explainAction(article_(), "nope")).toBeUndefined();
  });
});
