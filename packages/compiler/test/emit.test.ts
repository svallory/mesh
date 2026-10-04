import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelDocument } from "@mesh/model";
import { buildModel, type ResourceFile } from "../src/build.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/emit.ts";
import { FORMATTER_OPTIONS } from "../src/format.ts";
import { fixture } from "./helpers.ts";

/** The repository's own tsc: the emitted files are checked with the real compiler. */
const tsc = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const expected = (name: string) => fileURLToPath(new URL(`./expected/${name}`, import.meta.url));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-emit-"));
  roots.push(root);
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

/** The one types file of a single-resource project; the path depends on the domain. */
const typesFile = (files: { path: string; contents: string }[]) => {
  const found = files.filter((file) => file.path.endsWith(".types.ts"));
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** Type-check emitted files with the real compiler; returns its diagnostics text. */
function typeCheck(cwd: string, files: string[]): { code: number; output: string } {
  const proc = Bun.spawnSync(
    [
      tsc, "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--target", "es2022",
      "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck",
      ...files.map((file) => resolve(cwd, file)),
    ],
    { cwd },
  );
  const output = new TextDecoder().decode(proc.stderr) + new TextDecoder().decode(proc.stdout);
  return { code: proc.exitCode, output };
}

test("M1 test 1: the reduced post emits the expected types file and it type-checks", async () => {
  const input = post();
  const document = documentOf([input]);
  const root = await project();
  const files = await generateFiles({ document, config: configOf(root) });
  expect(files.map((file) => file.path)).toEqual(["generated/blog/post.types.ts", "generated/model.json"]);

  const types = typesFile(files);
  expect(types.contents).toBe(await readFile(expected("reduced-post.types.ts"), "utf8"));
  // The generated code stands alone: no import of the model, the compiler or model.json.
  expect(types.contents).not.toContain("import");
  expect(types.contents).not.toContain("model.json");
  expect(types.contents).not.toContain("@mesh/");

  const out = await project();
  await writeGeneratedFiles(files, configOf(out));
  expect(await readFile(resolve(out, "generated/blog/post.types.ts"), "utf8")).toBe(types.contents);
  const check = typeCheck(out, ["generated/blog/post.types.ts"]);
  expect({ code: check.code, output: check.output }).toEqual({ code: 0, output: "" });
});

test("M1 test 1: emitted types for names that are not TypeScript identifiers type-check too", async () => {
  const document = documentOf([odd()]);
  const root = await project();
  const files = await generateFiles({ document, config: configOf(root) });
  expect(typesFile(files).contents).toContain('"my-attr": string;');
  expect(typesFile(files).contents).toContain("class: string | null;");
  await writeGeneratedFiles(files, configOf(root));
  const check = typeCheck(root, ["generated/blog/blog-post.types.ts"]);
  expect({ code: check.code, output: check.output }).toEqual({ code: 0, output: "" });
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
  const document = documentOf([post()]);
  const here = await project();
  const there = await project();
  const hereFiles = await generateFiles({ document, config: configOf(here) });
  const thereFiles = await generateFiles({ document, config: configOf(there) });
  expect(thereFiles).toEqual(hereFiles);
  for (const file of hereFiles) {
    expect(file.contents).not.toContain(here);
    expect(file.contents).not.toContain(there);
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
  const domained = await generateFiles({ document: documentOf([post()]), config: configOf(root) });
  expect(typesFile(domained).path).toBe("generated/blog/post.types.ts");
});

test("a create input is required only for an accepted attribute that allows no nil and has no default", async () => {
  const source = [
    'resource="note"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="title" type="string" allow-nil=false',
    '    attribute="body" type="string"',
    '    attribute="views" type="integer" default=0',
    '    attribute="due" type="datetime" allow-nil=false',
    "  actions",
    '    create="create" accept=["title", "body", "views", "due"]',
    '    update="edit" accept=["title", "body"]',
    '    destroy="remove" accept=["title"]',
    "",
  ].join("\n");
  const files = await generateFiles({ document: documentOf([{ file: "note.mx", source }]), config: configOf("/project") });
  const contents = typesFile(files).contents;
  expect(contents).toContain("export type CreateNoteInput = {\n  title: string;\n  body?: string | null;\n  views?: number | null;\n  due: Date;\n};");
  expect(contents).toContain("export type EditNoteInput = {\n  title?: string;\n  body?: string | null;\n};");
  expect(contents).toContain("export type RemoveNoteInput = {\n  title?: string;\n};");
  expect(contents).not.toContain("PublishedNoteInput");
});

test("an atom with one_of is the union of its allowed values, nullable when it allows nil", async () => {
  const files = await generateFiles({ document: documentOf([post()]), config: configOf("/project") });
  const contents = typesFile(files).contents;
  expect(contents).toContain('state: "draft" | "published" | null;');
  expect(contents).toContain('export type PublishPostInput = {\n  state?: "draft" | "published" | null;\n};');
  const strict = [
    'resource="stateful"',
    "  attributes",
    '    uuid-primary-key="id"',
    '    attribute="state" type="atom" constraints={ one_of: ["a", "b"] } allow-nil=false',
    "  actions",
    '    create="create" accept=["state"]',
    "",
  ].join("\n");
  const strictFiles = await generateFiles({ document: documentOf([{ file: "stateful.mx", source: strict }]), config: configOf("/project") });
  expect(typesFile(strictFiles).contents).toContain('state: "a" | "b";');
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
  const files = await generateFiles({ document: documentOf([{ file: "note.mx", source }]), config: configOf("/project") });
  const contents = typesFile(files).contents;
  expect(contents).toContain("export type Note = {\n  id: string;\n  insertedAt: Date;\n  updatedAt: Date;\n  title: string;\n};");
  expect(contents).toContain("export type CreateNoteInput = {\n  title: string;\n};");
  expect(contents).toContain("export type EditNoteInput = {\n  title?: string;\n};");
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
  const again = await generateFiles({ document: parsed, config });
  expect(again).toEqual(files);
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
    fix: "Rename the resource so it starts with a letter or an underscore",
  });
  expect(error.message).toBe('resources/post.mx:1:10: Resource "1post" does not become a valid TypeScript type name ("1post")');
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
    message: 'Actions "publish-post" and "publishPost" of resource "post" both generate the input type "PublishPostPostInput"',
    position: { file: "resources/post.mx", line: 7, column: 11, offset: 171 },
    fix: "Rename one action so their generated input type names differ",
  });
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
  expect(await generateFiles({ document, config: configOf(plain) })).toEqual(
    await generateFiles({ document, config: configOf(withConfig) }),
  );
  expect(Object.isFrozen(FORMATTER_OPTIONS)).toBe(true);
  expect(FORMATTER_OPTIONS.endOfLine).toBe("lf");
});

test("writeGeneratedFiles creates the folders it needs and refuses a path outside the output folder", async () => {
  const root = await project();
  const config = configOf(root);
  const files = await generateFiles({ document: documentOf([post()]), config });
  expect(await writeGeneratedFiles(files, config)).toEqual([
    resolve(root, "generated/blog/post.types.ts"),
    resolve(root, "generated/model.json"),
  ]);
  expect((await readdir(resolve(root, "generated/blog"))).sort()).toEqual(["post.types.ts"]);
  await expect(writeGeneratedFiles([{ path: "../escape.ts", contents: "x" }], config)).rejects.toThrow(
    'Cannot write the generated file "../escape.ts": it is not a project-relative path',
  );
  await expect(writeGeneratedFiles([{ path: "other/escape.ts", contents: "x" }], config)).rejects.toThrow(
    'Cannot write the generated file "other/escape.ts": it resolves outside the output directory "generated"',
  );
});

test("an emitter that cannot be serialised is reported, not written as a partial file", async () => {
  const document = documentOf([post()]);
  (document.resources[0]!.table as unknown as { value: number }).value = Number.POSITIVE_INFINITY;
  const promise = generateFiles({ document, config: configOf("/project") });
  await expect(promise).rejects.toThrow(
    "Cannot serialise $.resources[0].table.value; the model must be plain JSON data",
  );
});