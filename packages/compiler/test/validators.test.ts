import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ATTRIBUTE_TYPES } from "@meshfw/model";
import { buildModel, PROTOTYPE_SETTING_NAME } from "../src/front-end/build.ts";
import {
  generateFiles,
  generatedImportDiagnostics,
  writeGeneratedFiles,
} from "../src/typescript/emit.ts";
import { VALIDATOR_TYPES } from "../src/typescript/views/validators.ts";
// The repository's one copy of the compiler options: the `tsc` binary once (the CLI path), the shared in-memory server
// for the mutation loop.
import { checkTypes, checkTypesBinary } from "./generated.ts";
import { closeTypeServer } from "./type-server.ts";

afterAll(closeTypeServer);
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
  const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-validators-"));
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
    data: { kind: "data-adapter" as const, name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
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
test("v4 validators enforce member types, enum values and string/numeric rules through Standard Schema", async () => {
  const { schemas } = await emitted();
  const validate = (input: unknown) =>
    schemas.createPostInputSchema!["~standard"].validate(input);
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
    expect(await schemas.createPostInputSchema!["~standard"].validate(input)).toEqual(
      { value: input },
    );
  for (const name of ["updatePostInputSchema", "destroyPostInputSchema"]) {
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
  await writeFile(resolve(out.root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
  expect(
    checkTypesBinary(
      out.root,
      [...out.files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path), "generated/schema.ts", "mesh.config.ts"],
    ),
  ).toEqual({ code: 0, output: "" });
  expect(Object.keys(VALIDATOR_TYPES).sort()).toEqual(
    ATTRIBUTE_TYPES.map((entry) => entry.name).sort(),
  );
}, 30_000);

test("validator drift tripwires catch keys, requiredness, nullability and scalar width", async () => {
  const out = await emitted();
  const title =
    'title: z.string().min(1, "must be at least 1 character").max(20, "must be at most 20 characters").regex(new $RegExp("^[A-Z]", ""), "must match /^[A-Z]/")';
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
    const result = await checkTypes(
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

// any member name but `__proto__`. The names of Object.prototype's members and of a function's build.
const OBJECT_MEMBER_NAMES = [
  "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
  "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
];

test.each(OBJECT_MEMBER_NAMES)("an attribute named %s builds", (name) => {
  const text = `entity :Named\n  attributes\n    uuid :id primary-key\n    string :${name}\n`;
  const built = buildModel({ root: "/project", files: [{ file: "named.mesh.mx", source: text }] });
  expect(built.diagnostics).toEqual([]);
  expect(built.document?.entities[0]?.attributes.map((attribute) => attribute.name)).toEqual(["id", name]);
});

test("an attribute named __proto__ is refused before schema emission", () => {
  const text = `entity :Named\n  attributes\n    uuid :id primary-key\n    string :${PROTOTYPE_SETTING_NAME}\n`;
  const built = buildModel({ root: "/project", files: [{ file: "named.mesh.mx", source: text }] });
  expect(built.document).toBeNull();
  expect(built.diagnostics).toEqual([expect.objectContaining({
    code: "MESH_ATTRIBUTE_NAME",
    message: ":__proto__ cannot be a member name: __proto__ sets an object's prototype instead of adding a property. Choose another name.",
    position: expect.objectContaining({ file: "named.mesh.mx", line: 4, column: 4 }),
  })]);
});

test("strict object validators reject own inherited-method names and all unknown keys", async () => {
  const { schemas } = await emitted();
  const validate = schemas.createPostInputSchema!["~standard"].validate;
  const issues = async (input: object) => ((await validate(input)) as { issues?: readonly { path?: readonly PropertyKey[]; message: string }[] }).issues
    ?.map((issue) => [issue.path ?? [], issue.message]);
  expect(await issues({ title: "Hello" })).toBeUndefined();
  expect(await issues({ title: "Hello", constructor: "own" })).toEqual([[[], 'Unrecognized key: "constructor"']]);
  expect(await issues({ title: "Hello", toString: "own", extra: 1 })).toEqual([[[], 'Unrecognized keys: "toString", "extra"']]);
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

// Line rules at run time, through the generated schema: Zod's own checks with Mesh's message, and the `$ruled` wrapper
// that marks each rule's issue with `meshRule: { code, source }` for `@meshfw/runtime`'s `issueOf`.
const rulesSource = `entity :Rule
  attributes
    uuid :id primary-key
    string :title min=1 max=3 match=/^[a-z]/
    string :tag nullable max=1
    string :code nullable match=/^ab/gi
    integer :n nullable max=10
    float :ratio nullable min=0.5
    boolean :flag default=false
  actions
    create :create
      input
        &title
        &tag
        &code
        &n
        &ratio
        &flag
    update :update
      input
        &title
`;
type Marked = { message: string; path?: readonly unknown[]; meshRule?: { code: string; source: { file: string; line: number; column: number } } };
const at = (line: number) => ({ file: "blog/post.mesh.mx", line, column: 5 });

describe("line rules through the generated schema", () => {
  let validate: (name: string, input: unknown) => Promise<readonly Marked[] | undefined>;
  let generated: Awaited<ReturnType<typeof emitted>>;
  beforeAll(async () => {
    generated = await emitted(rulesSource);
    validate = async (name, input) => ((await generated.schemas[name]!["~standard"].validate(input)) as { issues?: readonly Marked[] }).issues;
  });
  const issues = async (input: Record<string, unknown>, name = "createRuleInputSchema") =>
    (await validate(name, input))?.map((issue) => ({ path: issue.path, message: issue.message, meshRule: issue.meshRule }));

  test("two broken rules on one value give two issues, min before match, each with Mesh's code, message and line", async () => {
    expect(await issues({ title: "" })).toEqual([
      { path: ["title"], message: "must be at least 1 character", meshRule: { code: "too_short", source: at(4) } },
      { path: ["title"], message: "must match /^[a-z]/", meshRule: { code: "no_match", source: at(4) } },
    ]);
    expect(await issues({ title: "abcd" })).toEqual([{ path: ["title"], message: "must be at most 3 characters", meshRule: { code: "too_long", source: at(4) } }]);
  });

  test("a type error, a missing field and an unknown key stay unmarked", async () => {
    for (const input of [{ title: 3 }, {}, { title: "a", typo: 1 }]) {
      const found = await issues(input);
      expect(found?.length).toBeGreaterThan(0);
      for (const issue of found!) expect(issue.meshRule).toBeUndefined();
    }
  });

  test("a string's length is what Zod counts, Unicode code points: one emoji fits max=1, two do not, nor e and a combining accent", async () => {
    expect(await issues({ title: "a", tag: "😀" })).toBeUndefined();
    expect(await issues({ title: "a", tag: "é" })).toBeUndefined();
    for (const tag of ["😀😀", "e\u0301"])
      expect(await issues({ title: "a", tag })).toEqual([{ path: ["tag"], message: "must be at most 1 character", meshRule: { code: "too_long", source: at(5) } }]);
  });

  test("a g flag carries no lastIndex from one value to the next, and i is kept", async () => {
    expect(await issues({ title: "a", code: "AB" })).toBeUndefined();
    expect(await issues({ title: "a", code: "AB" })).toBeUndefined();
    expect(await issues({ title: "a", code: "x" })).toEqual([{ path: ["code"], message: "must match /^ab/gi", meshRule: { code: "no_match", source: at(6) } }]);
  });

  test("numbers: too_big and too_small; z.int()'s safe-integer issue stays unmarked beside the line rule's", async () => {
    expect(await issues({ title: "a", n: 11 })).toEqual([{ path: ["n"], message: "must be at most 10", meshRule: { code: "too_big", source: at(7) } }]);
    expect(await issues({ title: "a", ratio: 0.4 })).toEqual([{ path: ["ratio"], message: "must be at least 0.5", meshRule: { code: "too_small", source: at(8) } }]);
    const huge = await issues({ title: "a", n: 2 ** 60 });
    expect(huge?.filter((issue) => issue.meshRule === undefined)).toHaveLength(1);
    expect(huge?.filter((issue) => issue.meshRule !== undefined)).toEqual([{ path: ["n"], message: "must be at most 10", meshRule: { code: "too_big", source: at(7) } }]);
  });

  test("null on a nullable field and an omitted optional update field give no issue; the update still checks a given value", async () => {
    expect(await issues({ title: "a", tag: null, code: null, n: null, ratio: null })).toBeUndefined();
    const id = "00000000-0000-4000-8000-000000000001";
    expect(await issues({ id }, "updateRuleInputSchema")).toBeUndefined();
    expect(await issues({ id, title: "" }, "updateRuleInputSchema")).toEqual([
      { path: ["title"], message: "must be at least 1 character", meshRule: { code: "too_short", source: at(4) } },
      { path: ["title"], message: "must match /^[a-z]/", meshRule: { code: "no_match", source: at(4) } },
    ]);
  });

  test("a valid value passes unchanged", async () => {
    expect(await generated.schemas.createRuleInputSchema!["~standard"].validate({ title: "ab", n: 10, ratio: 0.5 })).toEqual({ value: { title: "ab", n: 10, ratio: 0.5 } });
  });

  test("the bounds and the pattern stay visible to a schema converter", async () => {
    const schema = generated.schemas.createRuleInputSchema as unknown as z.ZodType;
    const properties = (z.toJSONSchema(schema) as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.title).toMatchObject({ type: "string", minLength: 1, maxLength: 3, pattern: "^[a-z]" });
    expect(JSON.stringify(properties.n)).toContain('"maximum":10');
    expect(JSON.stringify(properties.ratio)).toContain('"minimum":0.5');
  });

  test("a file with no line rule declares no $ruled helper and wraps no schema", async () => {
    const plain = await emitted("entity :Plain\n  attributes\n    uuid :id primary-key\n    string :title nullable\n  actions auto=[:create, :read]\n");
    expect(plain.validator.contents).not.toContain("$ruled");
    expect(generated.validator.contents).toContain("export const createRuleInputSchema = $ruled(");
  });
});
