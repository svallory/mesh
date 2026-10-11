import { describe, expect, test } from "bun:test";
import type { ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, type EmitInput } from "../src/typescript/emit.ts";
import { loadGenerator } from "../src/typescript/emitters/load.ts";
import { indexView } from "../src/typescript/views/index.ts";
import { loadView } from "../src/typescript/views/load.ts";
import { queryColumns } from "../src/typescript/views/inputs.ts";
import { typesView } from "../src/typescript/views/types.ts";
import { checkTypes, configOf } from "./generated.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** The `load` generator's view, and the pieces of the types, index and read views that name what it generates (M7). */
const author = `import { Post } from "./post.mesh.mx"
entity :Author table="authors"
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :posts entity=Post
    has-many :orphans entity=Orphan
  computed
    count :postCount of="posts"
    max :lastPostedAt of="posts.postedAt"
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
    has-many :replies entity=Post via=:replyTo
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
  test("one plan entry per entity, in the fixed entity order, and a loader only for an entity with something to load", () => {
    const view = loadView(input(documentOf()), "generated/load.ts");
    expect(view.entities.map((entity) => entity.nameLiteral)).toEqual(['"Author"', '"Lonely"', '"Post"']);
    expect(view.entities.map((entity) => entity.loader?.name ?? null)).toEqual(["loadAuthorFields", null, "loadPostFields"]);
    expect(view.entities[0]!.table).toBe("tables.author");
    expect(view.entities[0]!.keyLiteral).toBe('"id"');
    expect(view.entities[1]).toMatchObject({ relations: [], computed: [] });
  });

  test("a relationship plan names its kind, target and key column; a has-many follows the belongs-to of the target", () => {
    const [authorEntry, , postEntry] = loadView(input(documentOf()), "generated/load.ts").entities;
    expect(authorEntry!.relations).toEqual([{ key: "posts", plan: '{ kind: "has-many", target: "Post", column: "authorId" }' }]);
    expect(postEntry!.relations).toEqual([
      { key: "author", plan: '{ kind: "belongs-to", target: "Author", column: "authorId", nullable: false }' },
      { key: "replyTo", plan: '{ kind: "belongs-to", target: "Post", column: "replyToId", nullable: true }' },
      { key: "replies", plan: '{ kind: "has-many", target: "Post", column: "replyToId" }' },
    ]);
  });

  test("a has-many with no belongs-to back has a null column, which fails when it is loaded", () => {
    const orphaned = documentOf({ author: author.replace("    has-many :posts entity=Post\n", '    has-many :posts entity=Post\n    has-many :lonelies entity=Lonely\n').replace('import { Post }', 'import { Lonely } from "./lonely.mesh.mx"\nimport { Post }'), post, lonely });
    const entry = loadView(input(orphaned), "generated/load.ts").entities[0]!;
    expect(entry.relations[1]).toEqual({ key: "lonelies", plan: '{ kind: "has-many", target: "Lonely", column: null }' });
  });

  test("a rollup names its function and path; a body names what it needs and the expression it runs", () => {
    const entry = loadView(input(documentOf()), "generated/load.ts").entities[0]!;
    expect(entry.computed).toEqual([
      { key: "postCount", plan: '{ kind: "rollup", fn: "count", of: ["posts"] }' },
      { key: "lastPostedAt", plan: '{ kind: "rollup", fn: "max", of: ["posts","postedAt"] }' },
      { key: "prolific", plan: '{ kind: "body", needs: ["postCount"], evaluate: authorExpressions["computed.prolific"] }' },
      { key: "tier", plan: '{ kind: "body", needs: ["postCount"], evaluate: authorExpressions["computed.tier"] }' },
      { key: "extra", plan: '{ kind: "body", needs: [], evaluate: authorExpressions["computed.extra"] }' },
    ]);
  });

  test("the expressions file is imported once, and only for an entity with a body", () => {
    const view = loadView(input(documentOf()), "generated/load.ts");
    expect(view.expressionImports).toEqual([{ local: "authorExpressions", fromLiteral: '"./app/author.expressions"' }]);
    expect(view.typeImports.map((entry) => entry.names)).toEqual(["Author, AuthorLoadable, AuthorWith", "Post, PostLoadable, PostWith"]);
    expect(view.schemaFromLiteral).toBe('"./schema"');
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
    expect(indexView(input(document)).loaders).toEqual([]);
    const files = await generateFiles(input(document));
    expect(files.map((file) => file.path).some((path) => path.endsWith("/load.ts"))).toBe(false);
    expect(files.find((file) => file.path.endsWith("/index.ts"))!.contents).not.toContain("./load");
  });

  test("a model with one writes load.ts and the index re-exports the loaders and their types", async () => {
    const document = documentOf();
    expect(loadGenerator.views(input(document)).map((entry) => entry.path)).toEqual(["generated/load.ts"]);
    expect(indexView(input(document)).loaders).toEqual(["loadAuthorFields", "loadPostFields"]);
    const files = await generateFiles(input(document));
    const index = files.find((file) => file.path === "generated/index.ts")!.contents;
    expect(index).toContain('} from "./load";');
    expect(index).toContain('export { loadAuthorFields, loadPostFields } from "./load";');
    expect(index).toMatch(/AuthorLoadable,\s+AuthorWith,/);
  });

  test("a loader whose name an action function already has is an error that names both", async () => {
    // An action function is `<action><Entity>`: the action `load` of an entity called AuthorFields is `loadAuthorFields`.
    const fields = "entity :AuthorFields table=\"author_fields\"\n  attributes\n    uuid :id primary-key\n  actions\n    read :load\n";
    const document = documentOf({ author, post, lonely, "author-fields": fields });
    await expect(generateFiles(input(document))).rejects.toThrow(
      /Entity :Author's load function and Action :load of :AuthorFields .* both become the top-level name `loadAuthorFields`/);
    await expect(generateFiles(input(document))).rejects.toBeInstanceOf(EmitError);
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
      await Bun.write(resolve(root, "generated/schema.ts"), "export const tables = { author: {}, lonely: {}, post: {} };\n");
      const result = checkTypes(root, ["generated/load.ts", "generated/app/author.expressions.ts", "generated/app/post.types.ts"]);
      expect(result.output).toBe("");
      expect(result.code).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("the types and the read views name what is loadable", () => {
  test("the record has no relationship or computed member; the loadable map has every one, typed", () => {
    const document = documentOf();
    const authorView = typesView(input(document), document.entities.find((e) => e.name === "Author")!);
    expect(authorView.record.members.map((m) => m.name)).toEqual(["id", "name"]);
    expect(authorView.loadable).toEqual({
      name: "AuthorLoadable", withName: "AuthorWith",
      members: [
        { name: "posts", optional: false, key: "posts", type: "Post[]" },
        { name: "postCount", optional: false, key: "postCount", type: "number" },
        { name: "lastPostedAt", optional: false, key: "lastPostedAt", type: "Date | null" },
        { name: "prolific", optional: false, key: "prolific", type: "boolean" },
        { name: "tier", optional: false, key: "tier", type: '"small" | "large"' },
        { name: "extra", optional: false, key: "extra", type: "unknown" },
      ],
      // `self` in a function of the entity file: the same members, a related record typed as loaded too.
      loadedName: "AuthorLoaded",
      loadedMembers: [
        { name: "posts", optional: false, key: "posts", type: "PostLoaded[]" },
        { name: "postCount", optional: false, key: "postCount", type: "number" },
        { name: "lastPostedAt", optional: false, key: "lastPostedAt", type: "Date | null" },
        { name: "prolific", optional: false, key: "prolific", type: "boolean" },
        { name: "tier", optional: false, key: "tier", type: '"small" | "large"' },
        { name: "extra", optional: false, key: "extra", type: "unknown" },
      ],
    });
    expect(authorView.imports).toEqual([{ name: "Post", names: "Post, PostLoaded", fromLiteral: '"./post.types"' }]);
  });

  test("a nullable belongs-to is nullable, a self-reference imports nothing for itself", () => {
    const document = documentOf();
    const postView = typesView(input(document), document.entities.find((e) => e.name === "Post")!);
    expect(postView.loadable!.members.map((m) => [m.name, m.type])).toEqual([["author", "Author"], ["replyTo", "Post | null"], ["replies", "Post[]"]]);
    expect(postView.loadable!.loadedMembers.map((m) => [m.name, m.type])).toEqual([["author", "AuthorLoaded"], ["replyTo", "PostLoaded | null"], ["replies", "PostLoaded[]"]]);
    expect(postView.imports).toEqual([{ name: "Author", names: "Author, AuthorLoaded", fromLiteral: '"./author.types"' }]);
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
