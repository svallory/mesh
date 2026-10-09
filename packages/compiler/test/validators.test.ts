import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ATTRIBUTE_TYPES } from "@meshfw/model";
import { buildModel, BUILTIN_OBJECT_PROPERTY_NAMES } from "../src/build.ts";
import {
  generateFiles,
  generatedImportDiagnostics,
  writeGeneratedFiles,
} from "../src/emit.ts";
import { VALIDATOR_TYPES } from "../src/views/validators.ts";
interface StandardSchemaV1 {
  "~standard": {
    validate(
      input: unknown,
    ):
      | { value?: unknown; issues?: readonly { message: string }[] }
      | Promise<{ value?: unknown; issues?: readonly { message: string }[] }>;
  };
}
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const source = `entity :Post
  attributes
    uuid :id primary-key
    string :title min=1 max=20 match=/^[A-Z]/
    string :body nullable
    integer :count default=0 min=0 max=100
    float :ratio nullable
    decimal :amount default=0
    boolean :flag default=false
    enum :state values=[:draft, :published] default=:draft
    date :day nullable
    datetime :when nullable
    timestamp :createdAt on=:create
  actions
    create :create
      input
        &title
        &body
        &count
        &ratio
        &amount
        &flag
        &state
        &day
        &when
    update :update
      input
        &title
        &body
    destroy :destroy
`;
async function emitted(text = source) {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-validators-"));
  roots.push(root);
  const built = buildModel({
    root,
    files: [{ file: "blog/post.mesh.mx", source: text }],
  });
  expect(built.diagnostics).toEqual([]);
  const config = {
    root,
    output: resolve(root, "generated"),
    configFile: resolve(root, "mesh.config.ts"),
    entityFiles: [],
    domainRoot: root,
    data: { kind: "data-adapter" as const, name: "sqlite", build: "@meshfw/data-sqlite/build", options: { file: ":memory:" } },
  };
  const files = await generateFiles({ document: built.document!, config });
  await writeGeneratedFiles(files, config);
  const validator = files.find((file) => file.path.endsWith(".validators.ts"))!;
  const schemas = (await import(resolve(root, validator.path))) as Record<
    string,
    StandardSchemaV1
  >;
  return { root, files, validator, schemas };
}
function check(root: string, files: string[]) {
  const child = Bun.spawnSync(
    [
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2022",
      "--skipLibCheck",
      "--noUnusedLocals",
      "--noUnusedParameters",
      "--exactOptionalPropertyTypes",
      "--verbatimModuleSyntax",
      "--isolatedModules",
      // The generated actions import @meshfw/runtime, whose sources import with `.ts`.
      "--allowImportingTsExtensions",
      ...files,
    ],
    { cwd: root },
  );
  return {
    code: child.exitCode,
    output: child.stdout.toString() + child.stderr.toString(),
  };
}

test("v4 validators enforce member types, enum values and string/numeric rules through Standard Schema", async () => {
  const { schemas } = await emitted();
  const validate = (input: unknown) =>
    schemas.createPostInput!["~standard"].validate(input);
  expect(await validate({ title: "Hello" })).toEqual({
    value: { title: "Hello" },
  });
  const valid = {
    title: "Hello",
    body: null,
    count: 1,
    ratio: 1.5,
    amount: 10.5,
    flag: true,
    state: "draft",
    day: new Date(),
    when: new Date(),
  };
  expect((await validate(valid)).issues).toBeUndefined();
  for (const input of [
    {},
    { title: 1 },
    { title: null },
    { title: "" },
    { title: "bad" },
    { title: "A".repeat(21) },
    { ...valid, count: 1.5 },
    { ...valid, count: -1 },
    { ...valid, count: 101 },
    { ...valid, ratio: "1" },
    { ...valid, flag: 1 },
    { ...valid, amount: "1" },
    { ...valid, state: "other" },
    { ...valid, day: "2026-10-04" },
    { ...valid, when: "2026-10-04" },
    { ...valid, typo: true },
  ])
    expect((await validate(input)).issues).toBeDefined();
});

test("nullable, omitted and explicit undefined inputs preserve v4 requiredness", async () => {
  const { schemas } = await emitted();
  for (const input of [
    { title: "Hello" },
    { title: "Hello", body: undefined },
    { title: "Hello", body: null },
  ])
    expect(await schemas.createPostInput!["~standard"].validate(input)).toEqual(
      { value: input },
    );
  for (const name of ["updatePostInput", "destroyPostInput"]) {
    const valid = { id: "00000000-0000-4000-8000-000000000001" };
    expect(
      (await schemas[name]!["~standard"].validate(valid)).issues,
    ).toBeUndefined();
    expect(
      (await schemas[name]!["~standard"].validate({})).issues,
    ).toBeDefined();
    expect(
      (await schemas[name]!["~standard"].validate({ id: "bad" })).issues,
    ).toBeDefined();
  }
});

test("generated validators and all ten scalar mappings typecheck with exact optional flags", async () => {
  const out = await emitted();
  // The data adapter writes schema.ts; a stub stands in for it with the same `tables` key.
  await writeFile(resolve(out.root, "generated/schema.ts"), "export const tables = { post: {} };\n");
  expect(
    check(
      out.root,
      [...out.files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), "generated/schema.ts"],
    ),
  ).toEqual({ code: 0, output: "" });
  expect(Object.keys(VALIDATOR_TYPES).sort()).toEqual(
    ATTRIBUTE_TYPES.map((entry) => entry.name).sort(),
  );
});

test("validator drift tripwires catch keys, requiredness, nullability and scalar width", async () => {
  const out = await emitted();
  const title =
    'title: z.string().min(1).max(20).regex(new RegExp("^[A-Z]", ""))';
  const body = "body: z.string().nullable().optional(),";
  // Use an unconstrained title for stable one-line formatting in this mutation test.
  const plain = await emitted(
    source.replace(" min=1 max=20 match=/^[A-Z]/", ""),
  );
  for (const [from, to] of [
    ["title: z.string()", "title: z.number()"],
    ["title: z.string()", "title: z.union([z.string(), z.number()])"],
    ["title: z.string()", 'title: z.literal("only")'],
    ["title: z.string()", "title: z.string().optional()"],
    [body, "body: z.string().nullable(),"],
    ["title: z.string()", "title: z.string().nullable()"],
    [body, "body: z.string().optional(),"],
    [body, `${body}\nextra: z.string().optional(),`],
    [body, ""],
  ]) {
    expect(plain.validator.contents).toContain(from!);
    await writeFile(
      resolve(plain.root, plain.validator.path),
      plain.validator.contents.replace(from!, to!),
    );
    const result = check(
      plain.root,
      plain.files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path),
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("TS2344");
  }
  expect(out.validator.contents.replaceAll(/\s+/g, "")).toContain(
    title.replaceAll(/\s+/g, ""),
  );
}, 60_000);

test.each([...BUILTIN_OBJECT_PROPERTY_NAMES])(
  "built-in property %s is rejected before schema emission",
  (name) => {
    const text = `entity :Named\n  attributes\n    uuid :id primary-key\n    string :${name}\n`;
    const built = buildModel({
      root: "/project",
      files: [{ file: "named.mesh.mx", source: text }],
    });
    expect(built.document).toBeNull();
    expect(built.diagnostics[0]).toMatchObject({
      code: "MESH_ATTRIBUTE_NAME",
      position: { file: "named.mesh.mx", line: 4, column: 4 },
    });
  },
);

test("strict object validators reject own inherited-method names and all unknown keys", async () => {
  const { schemas } = await emitted();
  expect(
    (
      await schemas.createPostInput!["~standard"].validate({
        title: "Hello",
        constructor: "own",
      })
    ).issues,
  ).toBeDefined();
});

test("generated import preflight reports all missing packages once at mesh.config.ts:1:1", () => {
  const diagnostics = generatedImportDiagnostics(import.meta.dir, [
    {
      name: "fixture",
      requires: ["mesh-missing-a", "mesh-missing-b", "mesh-missing-a"],
      async emit() {
        return [];
      },
    },
  ]);
  expect(diagnostics.map((item) => item.message)).toEqual(
    ["a", "b"].map(
      (suffix) =>
        `generated code imports "mesh-missing-${suffix}", which is not installed in this project. Run: bun add mesh-missing-${suffix}`,
    ),
  );
  for (const item of diagnostics)
    expect(item.position).toEqual({
      file: "mesh.config.ts",
      line: 1,
      column: 0,
      offset: 0,
    });
});
