import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelDocument } from "@mesh/model";
import { buildModel, type ResourceFile } from "../src/build.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { EmitError, generateFiles, writeGeneratedFiles, type GeneratedFile } from "../src/emit.ts";
import { FORMATTER_OPTIONS } from "../src/format.ts";
import { fixture } from "./helpers.ts";

/** The repository's own tsc: the emitted files, and the consumers written against
 * them, are checked with the real compiler. */
const tsc = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const expected = (name: string) => fileURLToPath(new URL(`./expected/${name}`, import.meta.url));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(prefix = "mesh-emit-"): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function project(): Promise<string> {
  const root = await directory();
  await writeFile(
    resolve(root, "mesh.config.ts"),
    'import { defineConfig } from "@mesh/compiler"\nexport default defineConfig({ resources: "resources", output: "generated" })\n',
  );
  return root;
}

/** The config the loader would have returned; only root and output matter to an emitter. */
const configOf = (root: string, output = "generated"): ResolvedConfig => ({
  root,
  configFile: resolve(root, "mesh.config.ts"),
  resourceFiles: [],
  output: resolve(root, output),
});

function documentOf(files: ResourceFile[]): ModelDocument {
  const result = buildModel({ root: "/project", files });
  expect(result.diagnostics).toEqual([]);
  if (!result.document) throw new Error("expected a model document");
  return result.document;
}

const post = () => {
  const { source } = fixture("reduced-post.mx");
  return { file: "resources/post.mx", source };
};
const odd = () => {
  const { source } = fixture("emit/odd-names.mx");
  return { file: "resources/blog-post.mx", source };
};
const tag = () => {
  const { source } = fixture("emit/no-domain.mx");
  return { file: "resources/tag.mx", source };
};

/** Emit into a fresh project directory and write the tree. */
async function emitTo(
  document: ModelDocument,
  options: { output?: string; root?: string } = {},
): Promise<{ root: string; config: ResolvedConfig; files: GeneratedFile[] }> {
  const root = options.root ?? (await project());
  const config = configOf(root, options.output ?? "generated");
  const files = await generateFiles({ document, config });
  await writeGeneratedFiles(files, config);
  return { root, config, files };
}

/** The one types file of a single-resource project; the path depends on the domain. */
const typesFile = (files: readonly GeneratedFile[]) => {
  const found = files.filter((file) => file.path.endsWith(".types.ts"));
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** Run the real compiler over the given files; returns its exit code and its output. */
function typeCheck(cwd: string, files: string[]): { code: number; output: string } {
  const proc = Bun.spawnSync(
    [
      tsc, "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--target", "es2022",
      "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck",
      ...files.map((file) => resolve(cwd, file)),
    ],
    { cwd },
  );
  const decoder = new TextDecoder();
  return { code: proc.exitCode, output: decoder.decode(proc.stderr) + decoder.decode(proc.stdout) };
}

/** Emit the document into its own project and type-check a consumer against it.
 * A consumer that uses the types correctly gives `{ code: 0, output: "" }`. */
async function checkConsumer(
  document: ModelDocument,
  consumer: string,
  options: { output?: string } = {},
): Promise<{ code: number; output: string }> {
  const { root, files } = await emitTo(document, options);
  await writeFile(resolve(root, "consumer.ts"), consumer);
  return typeCheck(root, [...files.map((file) => file.path).filter((path) => path.endsWith(".ts")), "consumer.ts"]);
}

const clean = { code: 0, output: "" };

test("M1 test 1: the reduced post emits the expected types file and it type-checks", async () => {
  const document = documentOf([post()]);
  const root = await project();
  const files = await generateFiles({ document, config: configOf(root) });
  expect(files.map((file) => file.path)).toEqual(["generated/blog/post.types.ts", "generated/model.json"]);

  const types = typesFile(files);
  expect(types.contents).toBe(await readFile(expected("reduced-post.types.ts"), "utf8"));
  // The generated code stands alone: no import of the model, the compiler or model.json.
  expect(types.contents).not.toContain("import");
  expect(types.contents).not.toContain("model.json");
  expect(types.contents).not.toContain("@mesh/");

  const out = await emitTo(document);
  expect(await readFile(resolve(out.root, "generated/blog/post.types.ts"), "utf8")).toBe(types.contents);
  expect(typeCheck(out.root, ["generated/blog/post.types.ts"])).toEqual(clean);
});

test("M1 test 1: emitted types for names that are not TypeScript identifiers type-check too", async () => {
  const { root, files } = await emitTo(documentOf([odd()]));
  const contents = typesFile(files).contents;
  expect(contents).toContain('"my-attr": string;');
  expect(contents).toContain("class: string | null;");
  expect(typeCheck(root, ["generated/blog/blog-post.types.ts"])).toEqual(clean);
});

test("M1 test 2: two builds of the same model give byte-identical files", async () => {
  const document = documentOf([post()]);
  const first = await generateFiles({ document, config: configOf("/project") });
  const second = await generateFiles({ document, config: configOf("/project") });
  expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
  first.forEach((file, index) => {
    expect(Buffer.from(second[index]!.contents).equals(Buffer.from(file.contents))).toBe(true);
  });
});

test("M1 test 2: the order of the resource files does not change the emitted files", async () => {
  const config = configOf("/project");
  const forwards = await generateFiles({ document: documentOf([post(), tag()]), config });
  const backwards = await generateFiles({ document: documentOf([tag(), post()]), config });
  expect(forwards.map((file) => file.path)).toEqual([
    "generated/blog/post.types.ts",
    "generated/model.json",
    "generated/tag.types.ts",
  ]);
  expect(backwards).toEqual(forwards);
});

test("M1 test 2: nothing machine-specific reaches a generated file", async () => {
  const source = post();
  const here = await emitTo(documentOf([source]), { root: await directory("mesh-emit-here-") });
  const there = await emitTo(documentOf([source]), { root: await directory("mesh-emit-there-") });
  // Both projects are loaded, built and emitted from their own root.
  expect(there.files).toEqual(here.files);
  for (const file of here.files) {
    expect(file.contents).not.toContain(here.root);
    expect(file.contents).not.toContain(there.root);
    expect(file.contents).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }
});

test("the domain sets the output folder and the configured output folder holds the tree", async () => {
  const document = documentOf([tag()]);
  const root = await project();
  const plain = await generateFiles({ document, config: configOf(root) });
  expect(plain.map((file) => file.path)).toEqual(["generated/model.json", "generated/tag.types.ts"]);
  const nested = await generateFiles({ document, config: configOf(root, "src/generated") });
  expect(nested.map((file) => file.path)).toEqual(["src/generated/model.json", "src/generated/tag.types.ts"]);
  expect(typesFile(await generateFiles({ document: documentOf([post()]), config: configOf(root) })).path).toBe(
    "generated/blog/post.types.ts",
  );
});

test("a create input is required only for an accepted attribute that allows no nil and has no default", async () => {
  const source = [
    'resource="note"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="title" type="string" allow-nil=false',
    '    attribute="body" type="string"',
    '    attribute="views" type="integer" default=0',
    '    attribute="rating" type="float" allow-nil=false default=1.5',
    '    attribute="due" type="datetime" allow-nil=false',
    "  actions",
    '    create="create" accept=["title", "body", "views", "rating", "due"]',
    '    update="edit" accept=["title", "body"]',
    '    destroy="remove"',
    "",
  ].join("\n");
  const contents = typesFile(await generateFiles({ document: documentOf([{ file: "note.mx", source }]), config: configOf("/project") })).contents;
  // `views` and `rating` have defaults, so the runtime can supply either; only the
  // two that can arrive neither, `title` and `due`, are required.
  expect(contents).toContain(
    "export type CreateNoteInput = {\n  title: string;\n  body?: string | null;\n  views?: number | null;\n  rating?: number;\n  due: Date;\n};",
  );
  expect(contents).toContain("export type EditNoteInput = {\n  id: string;\n  title?: string;\n  body?: string | null;\n};");
  expect(contents).toContain("export type RemoveNoteInput = {\n  id: string;\n};");
  expect(contents).not.toContain("PublishedNoteInput");
});

test("an atom with one_of is the union of its allowed values, nullable when it allows nil", async () => {
  const contents = typesFile(await generateFiles({ document: documentOf([post()]), config: configOf("/project") })).contents;
  expect(contents).toContain('state: "draft" | "published" | null;');
  expect(contents).toContain('export type PublishPostInput = {\n  id: string;\n  state?: "draft" | "published" | null;\n};');
  const strict = [
    'resource="stateful"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="state" type="atom" constraints={ one_of: ["a", "b"] } allow-nil=false',
    "  actions",
    '    create="create" accept=["state"]',
    "",
  ].join("\n");
  const strictTypes = typesFile(await generateFiles({ document: documentOf([{ file: "stateful.mx", source: strict }]), config: configOf("/project") })).contents;
  expect(strictTypes).toContain('state: "a" | "b";');
});

test("atom values that need escaping are written as string literals, not as code", async () => {
  const source = [
    'resource="odd"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="label" type="atom" constraints={ one_of: ["say \\"hi\\"", "back\\\\slash", "two\\nlines", "astral \\u{1F600}", "tab\\there"] }',
    "  actions",
    '    create="create" accept=["label"]',
    "",
  ].join("\n");
  const document = documentOf([{ file: "odd.mx", source }]);
  const contents = typesFile(await generateFiles({ document, config: configOf("/project") })).contents;
  expect(contents).toContain("label?: 'say \"hi\"' | \"back\\\\slash\" | \"two\\nlines\" | \"astral \u{1F600}\" | \"tab\\there\" | null;");
  const consumer = `import type { CreateOddInput } from "./generated/odd.types";\nconst value: CreateOddInput = { label: "tab\\there" };\n`;
  expect(await checkConsumer(document, consumer)).toEqual(clean);
});

test("the key and the timestamps are in the record type and never in an input", async () => {
  const source = [
    'resource="note"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    create-timestamp="insertedAt"',
    '    update-timestamp="updatedAt"',
    '    attribute="title" type="string" allow-nil=false',
    "  actions",
    '    create="create" accept=["id", "insertedAt", "updatedAt", "title"]',
    '    update="edit" accept=["id", "insertedAt", "updatedAt", "title"]',
    "",
  ].join("\n");
  const contents = typesFile(await generateFiles({ document: documentOf([{ file: "note.mx", source }]), config: configOf("/project") })).contents;
  expect(contents).toContain("export type Note = {\n  id: string;\n  insertedAt: Date;\n  updatedAt: Date;\n  title: string;\n};");
  expect(contents).toContain("export type CreateNoteInput = {\n  title: string;\n};");
  expect(contents).toContain("export type EditNoteInput = {\n  id: string;\n  title?: string;\n};");
});

test("model.json round-trips to the same document and to the same bytes", async () => {
  const document = documentOf([post(), odd()]);
  const config = configOf("/project");
  const files = await generateFiles({ document, config });
  const json = files.find((file) => file.path.endsWith("model.json"))!;
  expect(json.contents.endsWith("}\n")).toBe(true);
  const parsed = JSON.parse(json.contents) as ModelDocument;
  // The emitted document holds the resources in name order, whatever order the
  // loader read the files in; nothing else about it has moved.
  expect(parsed).toEqual({
    resources: [...document.resources].sort((a, b) => (a.name.value < b.name.value ? -1 : 1)),
  });
  expect(await generateFiles({ document: parsed, config })).toEqual(files);
});

test("a negative zero default survives the model.json round trip", async () => {
  const source = [
    'resource="score"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="value" type="float" default=-0',
    "",
  ].join("\n");
  const files = await generateFiles({ document: documentOf([{ file: "score.mx", source }]), config: configOf("/project") });
  const json = files.find((file) => file.path.endsWith("model.json"))!;
  expect(json.contents).toContain('"value": -0\n');
  const parsed = JSON.parse(json.contents) as ModelDocument;
  const parsedDefault = parsed.resources[0]!.attributes[1]!.default;
  expect(Object.is(parsedDefault!.value, -0)).toBe(true);
});

test("a resource name that cannot become a type name is a positioned build error", async () => {
  const source = 'resource="1post"\n  attributes\n    uuid-primary-key="id"\n';
  const promise = generateFiles({ document: documentOf([{ file: "resources/post.mx", source }]), config: configOf("/project") });
  const error = (await promise.catch((cause: unknown) => cause)) as EmitError;
  expect(error).toBeInstanceOf(EmitError);
  expect(error.diagnostic).toEqual({
    severity: "error",
    code: "MESH_EMIT_NAME",
    message: 'Resource "1post" does not become a valid TypeScript type name ("1post")',
    position: { file: "resources/post.mx", line: 1, column: 9, offset: 9 },
    fix: "Rename the resource so it reads as an identifier, for example `post` or `_post`",
  });
  expect(error.message).toBe('resources/post.mx:1:10: Resource "1post" does not become a valid TypeScript type name ("1post")');
});

test("a leading underscore is kept, so `_post` is a usable name", async () => {
  const source = 'resource="_post"\n  attributes\n    uuid-primary-key="id"\n  actions\n    create="create" accept=[]\n';
  const contents = typesFile(await generateFiles({ document: documentOf([{ file: "resources/post.mx", source }]), config: configOf("/project") })).contents;
  expect(contents).toContain("export type _Post = {");
  expect(contents).toContain("export type Create_PostInput = {");
});

test("a resource name that captures a type the file uses is a positioned build error", async () => {
  const source = [
    'resource="date"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="when" type="datetime" allow-nil=false',
    "",
  ].join("\n");
  const promise = generateFiles({ document: documentOf([{ file: "resources/date.mx", source }]), config: configOf("/project") });
  const error = (await promise.catch((cause: unknown) => cause)) as EmitError;
  expect(error.diagnostic).toEqual({
    severity: "error",
    code: "MESH_EMIT_NAME",
    message: 'Resource "date" generates the type name "Date", which would capture the `Date` the attribute types use',
    position: { file: "resources/date.mx", line: 1, column: 9, offset: 9 },
    fix: "Rename it so the generated type name does not shadow `Date`",
  });
});

test("two resource names that read as one type name is a positioned build error", async () => {
  const bare = 'resource="%s" domain="blog"\n  attributes\n    uuid-primary-key="id"\n';
  const promise = generateFiles({
    document: documentOf([
      { file: "resources/a.mx", source: bare.replace("%s", "blog-post") },
      { file: "resources/b.mx", source: bare.replace("%s", "blog_post") },
    ]),
    config: configOf("/project"),
  });
  const error = (await promise.catch((cause: unknown) => cause)) as EmitError;
  expect(error.diagnostic).toMatchObject({
    code: "MESH_EMIT_NAME",
    message: 'Resources "blog-post" and "blog_post" both generate the type name "BlogPost"',
    position: { file: "resources/b.mx", line: 1, column: 9, offset: 9 },
    fix: "Rename one resource so their generated type names differ",
  });
});

test("two generated paths that differ only in letter case are a positioned build error", async () => {
  const bare = 'resource="%s"\n  attributes\n    uuid-primary-key="id"\n';
  const promise = generateFiles({
    document: documentOf([
      { file: "resources/a.mx", source: bare.replace("%s", "blogPost") },
      { file: "resources/b.mx", source: bare.replace("%s", "blogpost") },
    ]),
    config: configOf("/project"),
  });
  const error = (await promise.catch((cause: unknown) => cause)) as EmitError;
  expect(error.diagnostic).toMatchObject({
    code: "MESH_EMIT_PATH",
    message: 'Resources "blogPost" and "blogpost" write "generated/blogpost.types.ts", which differs from another generated path only in letter case',
    position: { file: "resources/b.mx", line: 1, column: 9, offset: 9 },
    fix: "Rename one resource so the two generated file names differ by more than case",
  });
});

test("two action names that read as one input type name is a positioned build error", async () => {
  const source = [
    'resource="post"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="title" type="string" allow-nil=false',
    "  actions",
    '    update="publish-post" accept=["title"]',
    '    update="publishPost" accept=["title"]',
    "",
  ].join("\n");
  const promise = generateFiles({ document: documentOf([{ file: "resources/post.mx", source }]), config: configOf("/project") });
  const error = (await promise.catch((cause: unknown) => cause)) as EmitError;
  expect(error.diagnostic).toMatchObject({
    code: "MESH_EMIT_NAME",
    message: 'Resource "post" generates the type name "PublishPostPostInput" twice, from "publish-post" and "publishPost"',
    position: { file: "resources/post.mx", line: 7, column: 11, offset: 171 },
    fix: "Rename one of them so the generated type names in this file differ",
  });
});

test("H2: a destroy takes the selector alone when it accepts nothing, and the selector with its accepted attributes when it does", async () => {
  const plain = documentOf([
    {
      file: "resources/post.mx",
      source: [
        'resource="post"',
        "  attributes",
        '    uuid-primary-key="id"',
        '    attribute="title" type="string" allow-nil=false',
        "  actions",
        '    destroy="remove" accept=[]',
        "",
      ].join("\n"),
    },
  ]);
  expect(typesFile(await generateFiles({ document: plain, config: configOf("/project") })).contents).toContain(
    "export type RemovePostInput = {\n  id: string;\n};",
  );
  const plainConsumer = ['import type { RemovePostInput } from "./generated/post.types";', 'const remove: RemovePostInput = { id: "a-uuid" };', ""].join("\n");
  expect(await checkConsumer(plain, plainConsumer)).toEqual(clean);

  // Ash's destroy accepts attributes, for example for a soft destroy; Mesh keeps
  // `accept` on it (mapping deviation D14), and the input carries them, optional.
  const soft = documentOf([
    {
      file: "resources/post.mx",
      source: [
        'resource="post"',
        "  attributes",
        '    uuid-primary-key="id"',
        '    attribute="archived" type="boolean"',
        '    attribute="reason" type="string" allow-nil=false',
        "  actions",
        '    destroy="remove" accept=["archived", "reason"]',
        "",
      ].join("\n"),
    },
  ]);
  expect(typesFile(await generateFiles({ document: soft, config: configOf("/project") })).contents).toContain(
    "export type RemovePostInput = {\n  id: string;\n  archived?: boolean | null;\n  reason?: string;\n};",
  );
  const softConsumer = [
    'import type { RemovePostInput } from "./generated/post.types";',
    'const full: RemovePostInput = { id: "a-uuid", archived: true, reason: "spam" };',
    'const partial: RemovePostInput = { id: "a-uuid" };',
    "",
  ].join("\n");
  expect(await checkConsumer(soft, softConsumer)).toEqual(clean);
});

test("a name that would escape the output folder is a positioned build error", async () => {
  const source = 'resource="blog/post"\n  attributes\n    uuid-primary-key="id"\n';
  const promise = generateFiles({ document: documentOf([{ file: "resources/post.mx", source }]), config: configOf("/project") });
  const error = (await promise.catch((cause: unknown) => cause)) as EmitError;
  expect(error.diagnostic).toMatchObject({
    code: "MESH_EMIT_PATH",
    message: 'Name "blog/post" cannot be used in a generated file path',
    position: { file: "resources/post.mx", line: 1, column: 9, offset: 9 },
  });
});

test("the formatter configuration is fixed in the emitter, not read from the project", async () => {
  const document = documentOf([post()]);
  const plain = await project();
  const withConfig = await project();
  await writeFile(resolve(withConfig, ".prettierrc"), JSON.stringify({ semi: false, singleQuote: true, tabWidth: 8, printWidth: 40 }));
  await writeFile(resolve(withConfig, "prettier.config.js"), "export default { semi: false };\n");
  await writeFile(resolve(withConfig, ".editorconfig"), "root = true\n[*]\nindent_size = 3\n");
  expect(await generateFiles({ document, config: configOf(plain) })).toEqual(
    await generateFiles({ document, config: configOf(withConfig) }),
  );
  expect(Object.isFrozen(FORMATTER_OPTIONS)).toBe(true);
  expect(FORMATTER_OPTIONS.endOfLine).toBe("lf");
});

test("an emitter that cannot be serialised is reported, not written as a partial file", async () => {
  const document = documentOf([post()]);
  (document.resources[0]!.table as unknown as { value: number }).value = Number.POSITIVE_INFINITY;
  const promise = generateFiles({ document, config: configOf("/project") });
  await expect(promise).rejects.toThrow("Cannot serialise $.resources[0].table.value; the model must be plain JSON data");
});

/** `create` takes the accepted attributes, `update` the selector plus them, `destroy`
 * the selector alone: the shapes of the live action spec. */
const mutations = () =>
  documentOf([
    {
      file: "resources/post.mx",
      source: [
        'resource="post"',
        "  attributes",
        '    uuid-primary-key="id"',
        '    attribute="title" type="string" allow-nil=false',
        '    attribute="views" type="integer"',
        "  actions",
        '    create="create" accept=["title"]',
'    update="edit" accept=["title", "views"]',
    '    destroy="remove"',
    "",
      ].join("\n"),
    },
  ]);

test("H2: an update with the selector type-checks and one without it does not", async () => {
  const document = mutations();
  const valid = [
    'import type { CreatePostInput, EditPostInput, RemovePostInput } from "./generated/post.types";',
    'const edit: EditPostInput = { id: "a-uuid", title: "new" };',
    'const remove: RemovePostInput = { id: "a-uuid" };',
    'const create: CreatePostInput = { title: "new" };',
    "",
  ].join("\n");
  expect(await checkConsumer(document, valid)).toEqual(clean);

  const missingSelector = ['import type { EditPostInput } from "./generated/post.types";', 'const edit: EditPostInput = { title: "new" };', ""].join("\n");
  const result = await checkConsumer(document, missingSelector);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("TS2741");
  expect(result.output).toContain("Property 'id' is missing");
});

test("H2: a create input still refuses a key write, and the selector is not one", async () => {
  const document = mutations();
  const withKey = ['import type { CreatePostInput } from "./generated/post.types";', 'const create: CreatePostInput = { id: "a-uuid", title: "new" };', ""].join("\n");
  const result = await checkConsumer(document, withKey);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("TS2353");
  expect(result.output).toContain("id");
});

test("M3: an input that accepts nothing takes no property and no primitive", async () => {
  const document = documentOf([
    {
      file: "resources/empty.mx",
      source: ['resource="empty"', "  attributes", '    uuid-primary-key="id"', "  actions", '    create="create" accept=[]', ""].join("\n"),
    },
  ]);
  const contents = typesFile(await generateFiles({ document, config: configOf("/project") })).contents;
  expect(contents).toContain("export type CreateEmptyInput = { [key: string]: never };");
  expect(await checkConsumer(document, ['import type { CreateEmptyInput } from "./generated/empty.types";', "const ok: CreateEmptyInput = {};", ""].join("\n"))).toEqual(clean);

  for (const [wrong, expected] of [
    ['const bad: CreateEmptyInput = { typo: true };', "not assignable to type 'never'"],
    ["const bad: CreateEmptyInput = 123;", "TS2322"],
  ] as const) {
    const result = await checkConsumer(document, ['import type { CreateEmptyInput } from "./generated/empty.types";', wrong, ""].join("\n"));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(expected);
  }
});

test("M1: an action asked for through defaults gets its input type, named after its kind", async () => {
  const document = documentOf([
    {
      file: "resources/post.mx",
      source: [
        'resource="post"',
        "  attributes",
        '    uuid-primary-key="id"',
        '    attribute="title" type="string" allow-nil=false',
        '  actions defaults=["create", "update", "destroy", "read"]',
        "",
      ].join("\n"),
    },
  ]);
  const contents = typesFile(await generateFiles({ document, config: configOf("/project") })).contents;
  // A default action accepts nothing, so the default create takes no property at all.
  expect(contents).toContain("export type CreatePostInput = { [key: string]: never };");
  expect(contents).toContain("export type UpdatePostInput = {\n  id: string;\n};");
  expect(contents).toContain("export type DestroyPostInput = {\n  id: string;\n};");
  expect(contents).not.toContain("ReadPostInput");
  const consumer = [
    'import type { CreatePostInput, UpdatePostInput, DestroyPostInput } from "./generated/post.types";',
    "const create: CreatePostInput = {};",
    'const update: UpdatePostInput = { id: "a-uuid" };',
    'const destroy: DestroyPostInput = { id: "a-uuid" };',
    "",
  ].join("\n");
  expect(await checkConsumer(document, consumer)).toEqual(clean);
});

test("M1: a declared action replaces the default action of the same kind", async () => {
  const document = documentOf([
    {
      file: "resources/post.mx",
      source: [
        'resource="post"',
        "  attributes",
        '    uuid-primary-key="id"',
        '    attribute="title" type="string" allow-nil=false',
        '  actions defaults=["create", "update"]',
        '    create="make" accept=["title"]',
        "",
      ].join("\n"),
    },
  ]);
  const contents = typesFile(await generateFiles({ document, config: configOf("/project") })).contents;
  expect(contents).toContain("export type MakePostInput = {\n  title: string;\n};");
  expect(contents).toContain("export type UpdatePostInput = {\n  id: string;\n};");
  expect(contents).not.toContain("CreatePostInput");
});

test("a resource with no actions emits only its record type", async () => {
  const document = documentOf([{ file: "resources/tag.mx", source: 'resource="tag"\n  attributes\n    uuid-primary-key="id"\n' }]);
  const files = await generateFiles({ document, config: configOf("/project") });
  expect(files.map((file) => file.path)).toEqual(["generated/model.json", "generated/tag.types.ts"]);
  expect(typesFile(files).contents).toBe(
    "// Do not edit this file by hand.\n// It is generated by `mesh build` from resources/tag.mx; change that file and rebuild.\n\nexport type Tag = {\n  id: string;\n};\n",
  );
});

test("H1: the writer refuses a symlinked file and leaves the file it points at untouched", async () => {
  const outside = await directory("mesh-outside-");
  const valuable = resolve(outside, "valuable.ts");
  await writeFile(valuable, "ORIGINAL OUTSIDE FILE\n");
  const root = await project();
  await mkdir(resolve(root, "generated"), { recursive: true });
  await symlink(valuable, resolve(root, "generated/tag.types.ts"));
  const config = configOf(root);
  const files = await generateFiles({ document: documentOf([tag()]), config });
  await expect(writeGeneratedFiles(files, config)).rejects.toThrow(
    'Cannot write the generated file "generated/tag.types.ts": writing it would follow a symlink to',
  );
  expect(await readFile(valuable, "utf8")).toBe("ORIGINAL OUTSIDE FILE\n");
  // The whole tree is refused before the first write, so no other file is left half-built.
  await expect(readdir(resolve(root, "generated"))).resolves.toEqual(["tag.types.ts"]);
});

test("H1: the writer refuses a symlinked directory inside the output folder", async () => {
  const outside = await directory("mesh-outside-");
  await mkdir(resolve(outside, "blog"));
  const root = await project();
  await mkdir(resolve(root, "generated"), { recursive: true });
  await symlink(resolve(outside, "blog"), resolve(root, "generated/blog"));
  const config = configOf(root);
  const files = await generateFiles({ document: documentOf([post()]), config });
  await expect(writeGeneratedFiles(files, config)).rejects.toThrow(
    'Cannot write the generated file "generated/blog/post.types.ts": writing it would follow a symlink to',
  );
  expect(await readdir(resolve(outside, "blog"))).toEqual([]);
  await expect(readdir(resolve(root, "generated"))).resolves.toEqual(["blog"]);
});

test("the writer leaves a file it was not given alone", async () => {
  const root = await project();
  const config = configOf(root);
  const files = await generateFiles({ document: documentOf([post()]), config });
  await writeGeneratedFiles(files, config);
  const hand = resolve(root, "generated/notes.ts");
  await writeFile(hand, "not generated\n");
  await writeGeneratedFiles(files, config);
  expect(await readFile(hand, "utf8")).toBe("not generated\n");
  expect((await readdir(resolve(root, "generated"))).sort()).toEqual(["blog", "model.json", "notes.ts"]);
});

test("L2: a source filename with a line terminator in it is spelled out in the header", async () => {
  for (const [raw, escaped] of [["\n", "\\n"], ["\r", "\\r"], ["\u2028", "\\u2028"], ["\u2029", "\\u2029"]] as const) {
    const file = `resources/line${raw}break.mx`;
    const document = documentOf([{ file, source: 'resource="tag"\n  attributes\n    uuid-primary-key="id"\n' }]);
    const contents = typesFile(await generateFiles({ document, config: configOf("/project") })).contents;
    // The name is still the exact project-relative source file, and the comment it
    // sits in still ends where it did: the terminator cannot leave the line.
    expect(contents.split("\n")[1]).toBe(
      "// It is generated by `mesh build` from resources/line" + escaped + "break.mx; change that file and rebuild.",
    );
    expect(contents.split("\n")).toHaveLength(7);
    expect(contents).toContain("export type Tag = {\n  id: string;\n};");
  }
});