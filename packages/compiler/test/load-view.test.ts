import { describe, expect, test } from "bun:test";
import type { ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, type EmitInput } from "../src/typescript/emit.ts";
import { loadGenerator } from "../src/typescript/emitters/load.ts";
import { loadView } from "../src/typescript/views/load.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { moduleViews } from "../src/typescript/views/module.ts";
import { queryColumns } from "../src/typescript/views/inputs.ts";
import { typesView } from "../src/typescript/views/types.ts";
import { checkTypes, configOf } from "./generated.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** The `load` generator's view, and the pieces of the types, module and read views that name what it generates (M7). */
const author = `import { Post } from "./post.mesh.mx"
entity :Author table="authors"
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :posts entity=Post
    has-many :orphans entity=Orphan
  computed
    count :postCount of=&posts
    max :lastPostedAt of=&posts.postedAt
    boolean :prolific() { return &postCount > 1 }
    enum :tier values=[:small, :large] value=() => &postCount > 5 ? :large : :small
    json :extra value=() => null
  actions auto=[:read]
`.replace('    has-many :orphans entity=Orphan\n', "");
const post = `import { Author } from "./author.mesh.mx"
entity :Post table="posts"
  attributes
    uuid :id primary-key
    timestamp :postedAt
  relationships
    belongs-to :author entity=Author
    belongs-to :replyTo entity=Post nullable
    has-many :replies entity=Post inverse=:replyTo
  actions auto=[:read]
`;
const lonely = "entity :Lonely table=\"lonelies\"\n  attributes\n    uuid :id primary-key\n";

function documentOf(files: Record<string, string> = { author, post, lonely }): ModelDocument {
  const built = buildModel({ root: "/project", files: Object.entries(files).map(([name, source]) => ({ file: `app/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.document!;
}
const config = configOf("/project", "generated");
const input = (document: ModelDocument): EmitInput => ({ document, config });

describe("the load view", () => {
  test("one plan entry per entity, in the fixed entity order; a loader, in the actions file, only for an entity with something to load", () => {
    const document = documentOf();
    const view = loadView(input(document), "generated/load.ts");
    expect(view.entities.map((entity) => entity.nameLiteral)).toEqual(['"app.Author"', '"app.Lonely"', '"app.Post"']);
    const loaderOf = (name: string) => actionsView(input(document), document.entities.find((entity) => entity.name === name)!).loader?.name ?? null;
    expect(["Author", "Lonely", "Post"].map(loaderOf)).toEqual(["loadAuthorFields", null, "loadPostFields"]);
    expect(view.entities[0]!.table).toBe("tables.authors");
    expect(view.entities[0]!.keyLiteral).toBe('"id"');
    expect(view.entities[1]).toMatchObject({ relations: [], computed: [] });
  });

  test("the table handle is read by the stored table name, quoted when it is not an identifier", () => {
    const view = loadView(input(documentOf({
      "late.mesh.mx": 'entity :LateResult table="late-result"\n  attributes\n    uuid :id primary-key\n',
      "claim.mesh.mx": 'entity :Claim table="claim"\n  attributes\n    uuid :id primary-key\n',
    })), "generated/load.ts");
    expect(view.entities.map((entity) => entity.table)).toEqual(["tables.claim", 'tables["late-result"]']);
  });

  test("a relationship plan names its kind, target and key column; a has-many follows the belongs-to of the target", () => {
    const [authorEntry, , postEntry] = loadView(input(documentOf()), "generated/load.ts").entities;
    expect(authorEntry!.relations).toEqual([{ key: "posts", plan: '{ kind: "has-many", target: "app.Post", column: "authorId" }' }]);
    expect(postEntry!.relations).toEqual([
      { key: "author", plan: '{ kind: "belongs-to", target: "app.Author", column: "authorId", nullable: false }' },
      { key: "replyTo", plan: '{ kind: "belongs-to", target: "app.Post", column: "replyToId", nullable: true }' },
      { key: "replies", plan: '{ kind: "has-many", target: "app.Post", column: "replyToId" }' },
    ]);
  });

  test("a rollup names its function and path; a body names what it needs and the expression it runs", () => {
    const entry = loadView(input(documentOf()), "generated/load.ts").entities[0]!;
    expect(entry.computed).toEqual([
      { key: "postCount", plan: '{ kind: "rollup", fn: "count", of: ["posts"] }' },
      { key: "lastPostedAt", plan: '{ kind: "rollup", fn: "max", of: ["posts","postedAt"] }' },
      { key: "prolific", plan: '{ kind: "body", needs: ["postCount"], evaluate: ($s: never) => $app$Author$expressions["computed.prolific"]($s) }' },
      { key: "tier", plan: '{ kind: "body", needs: ["postCount"], evaluate: ($s: never) => $app$Author$expressions["computed.tier"]($s) }' },
      { key: "extra", plan: '{ kind: "body", needs: [], evaluate: ($s: never) => $app$Author$expressions["computed.extra"]($s) }' },
    ]);
  });

  test("the expressions file is imported once, and only for an entity with a body", () => {
    const view = loadView(input(documentOf()), "generated/load.ts");
    expect(view.expressionImports).toEqual([{ local: "$app$Author$expressions", fromLiteral: '"./domain/app/author.expressions"' }]);
    expect(view.schemaFromLiteral).toBe('"./schema"');
  });

  test("the loader is typed from the actions file: a load through `privileged`, so Post's belongs-to is never null there", () => {
    const document = documentOf();
    const [authorView, postView] = ["Author", "Post"].map((name) => actionsView(input(document), document.entities.find((entity) => entity.name === name)!));
    expect(authorView!.loader).toEqual({ name: "loadAuthorFields", loadable: "AuthorLoadable", with: "AuthorWith", entityLiteral: '"app.Author"' });
    expect(postView!.loader).toEqual({ name: "loadPostFields", loadable: "PostLoadable", with: "PostTxWith", entityLiteral: '"app.Post"' });
    expect(postView!.typeImports).toEqual(expect.arrayContaining(["PostLoadable", "PostTxWith"]));
    expect(postView!.runtimeTypes).toEqual(expect.arrayContaining(["DataOperations as $DataOperations", "LoadOptions as $LoadOptions"]));
    expect(postView!.loadFromLiteral).toBe('"../../load"');
  });

  test("it is plain data", () => {
    const view = loadView(input(documentOf()), "generated/load.ts");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});

describe("the load generator", () => {
  test("a model with no relationship and no computed field writes no load.ts and no loader export", async () => {
    const document = documentOf({ lonely });
    expect(loadGenerator.views(input(document))).toEqual([]);
    // The domain root's barrel and the module's: neither has a loader.
    expect(moduleViews(input(document)).map(({ view }) => view.entities.map((entity) => entity.values))).toEqual([[], [["Lonely"]]]);
    const files = await generateFiles(input(document));
    expect(files.map((file) => file.path).some((path) => path.endsWith("/load.ts"))).toBe(false);
    for (const file of files.filter((entry) => entry.path.endsWith("/index.ts"))) expect(file.contents).not.toContain("/load");
  });

  test("a model with one writes load.ts and the module's index re-exports the loaders, from the actions files, and their types; #mesh does not", async () => {
    const document = documentOf();
    expect(loadGenerator.views(input(document)).map((entry) => entry.path)).toEqual(["generated/load.ts"]);
    // The domain root's barrel first: it holds no entity, so no loader.
    expect(moduleViews(input(document)).map(({ view }) => view.entities.map((entity) => entity.values)))
      .toEqual([[], [["Author", "loadAuthorFields"], ["Lonely"], ["Post", "loadPostFields"]]]);
    const files = await generateFiles(input(document));
    const module = files.find((file) => file.path === "generated/domain/app/index.ts")!.contents;
    expect(module).toContain('export { Author, loadAuthorFields } from "./author.actions";');
    expect(module).toContain('export { Post, loadPostFields } from "./post.actions";');
    // load.ts holds the plan only: it imports no actions file, so an import cycle through it never reaches an entity value.
    const load = files.find((file) => file.path === "generated/load.ts")!.contents;
    expect(load).not.toContain(".actions");
    expect(load).not.toContain("export async function");
    expect(module).toMatch(/AuthorLoadable,\s+AuthorWith,/);
    const index = files.find((file) => file.path === "generated/index.ts")!.contents;
    expect(index).not.toContain("load");
    expect(index).not.toContain("Author");
  });

  test("a loader named like another entity's action function builds: action functions live in their entity's file", async () => {
    // An action function is `<action><Entity>`: the action `load` of an entity called AuthorFields is `loadAuthorFields`,
    // the name of Author's load function too. With no project-wide `actions` and `tx` the two never meet.
    const fields = "entity :AuthorFields table=\"author_fields\"\n  attributes\n    uuid :id primary-key\n  actions\n    read :load\n";
    const document = documentOf({ author, post, lonely, "author-fields": fields });
    const files = await generateFiles(input(document));
    expect(files.find((file) => file.path === "generated/domain/app/author.actions.ts")!.contents).toContain("export async function loadAuthorFields");
    expect(files.find((file) => file.path === "generated/domain/app/authorFields.actions.ts")!.contents).toContain("async load(");
  });

  test("the generated load.ts and the files it imports type-check under the strictest flags", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-load-view-"));
    try {
      const document = documentOf();
      const emitted = configOf(root);
      const files = await generateFiles({ document, config: emitted });
      const { writeGeneratedFiles } = await import("../src/typescript/emit.ts");
      await writeGeneratedFiles(files, emitted);
      // The load file imports `./schema`, which the adapter writes; a stand-in with the same table names is enough here.
      await Bun.write(resolve(root, "generated/schema.ts"), "export const tables = { authors: {}, lonelies: {}, posts: {} };\n");
      const result = checkTypes(root, ["generated/load.ts", "generated/domain/app/author.expressions.ts", "generated/domain/app/post.types.ts",
        "generated/domain/app/author.actions.ts", "generated/domain/app/lonely.actions.ts", "generated/domain/app/post.actions.ts", "generated/domain/app/index.ts"]);
      expect(result.output).toBe("");
      expect(result.code).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("the types and the read views name what is loadable", () => {
  test("the record has no relationship or computed member; the loadable map has every one, typed", () => {
    const document = documentOf();
    const authorView = typesView(input(document), document.entities.find((e) => e.name === "Author")!);
    expect(authorView.record.members.map((m) => m.name)).toEqual(["id", "name"]);
    expect(authorView.loadable).toEqual({
      name: "AuthorLoadable", withName: "AuthorWith", tx: null, namesName: "AuthorLoadNames", argName: "AuthorLoadArg",
      members: [
        { name: "posts", optional: false, key: "posts", type: "$app$Post$Record[]" },
        { name: "postCount", optional: false, key: "postCount", type: "number" },
        { name: "lastPostedAt", optional: false, key: "lastPostedAt", type: "$Date | null" },
        { name: "prolific", optional: false, key: "prolific", type: "boolean" },
        { name: "tier", optional: false, key: "tier", type: '"small" | "large"' },
        { name: "extra", optional: false, key: "extra", type: "unknown" },
      ],
      // `self` in a function of the entity file: the same members, a related record typed as loaded too.
      loadedName: "AuthorLoaded",
      loadedMembers: [
        { name: "posts", optional: false, key: "posts", type: "$app$Post$Loaded[]" },
        { name: "postCount", optional: false, key: "postCount", type: "number" },
        { name: "lastPostedAt", optional: false, key: "lastPostedAt", type: "$Date | null" },
        { name: "prolific", optional: false, key: "prolific", type: "boolean" },
        { name: "tier", optional: false, key: "tier", type: '"small" | "large"' },
        { name: "extra", optional: false, key: "extra", type: "unknown" },
      ],
    });
    // Another entity's types come in under its FQN-derived locals, never its bare name.
    expect(authorView.imports).toEqual([{ name: "$app$Post$Record", names: "Post as $app$Post$Record, PostLoaded as $app$Post$Loaded", fromLiteral: '"./post.types"' }]);
  });

  test("a nullable belongs-to is nullable, a self-reference imports nothing for itself; a caller's belongs-to is nullable too", () => {
    const document = documentOf();
    const postView = typesView(input(document), document.entities.find((e) => e.name === "Post")!);
    // A caller's load runs the read policies of what it reaches: an author it may not read is null.
    expect(postView.loadable!.members.map((m) => [m.name, m.type])).toEqual([["author", "$app$Author$Record | null"], ["replyTo", "Post | null"], ["replies", "Post[]"]]);
    // Through `privileged` no policy runs, so the key always finds its author.
    expect(postView.loadable!.tx).toMatchObject({ name: "PostTxLoadable", withName: "PostTxWith" });
    expect(postView.loadable!.tx!.members.map((m) => [m.name, m.type])).toEqual([["author", "$app$Author$Record"], ["replyTo", "Post | null"], ["replies", "Post[]"]]);
    expect(postView.loadable!.loadedMembers.map((m) => [m.name, m.type])).toEqual([["author", "$app$Author$Loaded"], ["replyTo", "PostLoaded | null"], ["replies", "PostLoaded[]"]]);
    expect(postView.imports).toEqual([{ name: "$app$Author$Record", names: "Author as $app$Author$Record, AuthorLoaded as $app$Author$Loaded", fromLiteral: '"./author.types"' }]);
  });

  test("an entity with neither has no loadable declaration", () => {
    const document = documentOf();
    expect(typesView(input(document), document.entities.find((e) => e.name === "Lonely")!).loadable).toBeNull();
  });

  test("a computed enum with no values is a string", () => {
    const document = documentOf({ lonely: `${lonely}  computed\n    enum :phase() { return :early }\n    enum :maybe nullable() { return null }\n`.replace("    enum :maybe nullable() { return null }\n", "") });
    const view = typesView(input(document), document.entities[0]!);
    expect(view.loadable!.members).toEqual([{ name: "phase", optional: false, key: "phase", type: "string" }]);
    expect(queryColumns(document.entities[0]!).map((c) => c.name)).toEqual(["id"]);
  });

  test("a filter and sort may name a computed field of a queryable type, and not a json one", () => {
    const document = documentOf();
    expect(queryColumns(document.entities.find((e) => e.name === "Author")!).map((c) => c.name)).toEqual(["id", "name", "postCount", "lastPostedAt", "prolific", "tier"]);
  });
});
