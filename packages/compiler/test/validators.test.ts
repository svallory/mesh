import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ATTRIBUTE_TYPES, formatDiagnostic } from "@mesh/model";
interface StandardSchemaV1 {
  "~standard": { validate(input: unknown): { value?: unknown; issues?: readonly { message: string }[] } | Promise<{ value?: unknown; issues?: readonly { message: string }[] }> };
}
import { buildModel, BUILTIN_OBJECT_PROPERTY_NAMES } from "../src/build.ts";
import { generateFiles, generatedImportDiagnostics, writeGeneratedFiles } from "../src/emit.ts";
import { VALIDATOR_TYPES } from "../src/emitters/resource-validators.ts";
import { nearestName } from "../src/nearest-name.ts";
import { fixture } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function emitted(source: string) {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-validators-"));
  roots.push(root);
  const built = buildModel({ root, files: [{ file: "resource.mx", source }] });
  expect(built.diagnostics).toEqual([]);
  const config = { root, output: resolve(root, "generated"), configFile: resolve(root, "mesh.config.ts"), resourceFiles: [] };
  const files = await generateFiles({ document: built.document!, config });
  await writeGeneratedFiles(files, config);
  const validator = files.find((file) => file.path.endsWith(".validators.ts"))!;
  const schemas = await import(resolve(root, validator.path)) as Record<string, StandardSchemaV1>;
  return { root, files, validator, schemas };
}
function check(root: string, files: string[]) {
  const child = Bun.spawnSync([resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters", "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", ...files], { cwd: root });
  return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
}

test("M2 test 2: emitted example validators accept valid inputs and reject unaccepted fields and invalid values through Standard Schema", async () => {
  const { schemas } = await emitted(fixture("reduced-post.mx").source);
  const validate = (name: string, input: unknown) => schemas[name]!["~standard"].validate(input);
  expect(await validate("createPostInput", { title: "Hello" })).toEqual({ value: { title: "Hello" } });
  const extra = await validate("createPostInput", { title: "Hello", typo: true });
  expect(extra.issues?.some((issue) => issue.message.includes("typo"))).toBe(true);
  for (const input of [{}, { title: 1 }, { title: null }]) expect((await validate("createPostInput", input)).issues).toBeDefined();
  expect((await validate("publishPostInput", { id: "invalid", state: "draft" })).issues).toBeDefined();
  expect((await validate("publishPostInput", { id: "00000000-0000-4000-8000-000000000001", state: "bad" })).issues).toBeDefined();
  const source = 'resource="numeric"\n  attributes\n    uuid-primary-key="id"\n    attribute="count" type="integer" allow-nil=false\n    attribute="ratio" type="float" allow-nil=false\n    attribute="flag" type="boolean" allow-nil=false\n    attribute="when" type="datetime" allow-nil=false\n  actions\n    create="create" accept=["count", "ratio", "flag", "when"]\n';
  const numeric = (await emitted(source)).schemas.createNumericInput!;
  const valid = { count: 1, ratio: 1.5, flag: true, when: new Date() };
  expect((await numeric["~standard"].validate(valid)).issues).toBeUndefined();
  for (const patch of [{ count: 1.5 }, { ratio: "1" }, { flag: 1 }, { when: "2026-10-04" }]) expect((await numeric["~standard"].validate({ ...valid, ...patch })).issues).toBeDefined();
});

test("M2 test 2: emitted validators and types type-check for ordinary, empty and non-identifier names", async () => {
  for (const source of [fixture("reduced-post.mx").source, fixture("emit/odd-names.mx").source, 'resource="empty"\n  attributes\n    uuid-primary-key="id"\n  actions defaults=["create", "update", "destroy"]\n']) {
    const { root, files } = await emitted(source);
    expect(check(root, files.filter((file) => file.path.endsWith(".ts")).map((file) => file.path))).toEqual({ code: 0, output: "" });
  }
});

test("M2 test 2: validator drift checks reject changed keys, requiredness, nullability and scalar width with strict project flags", async () => {
  // This one runs `tsc` eleven times, so it needs more than bun's 5s default under load.
  const out = await emitted(fixture("reduced-post.mx").source);
  const title = "title: z.string()";
  const body = "body: z.string().nullable().optional(),";
  for (const [from, to] of [
    [title, "title: z.number()"],
    [title, 'title: z.union([z.string(), z.number()])'], // wider scalar
    [title, 'title: z.literal("only")'], // narrower scalar
    [title, "title: z.string().optional()"], // required -> optional
    [body, "body: z.string().nullable(),"], // optional -> required
    [title, "title: z.string().nullable()"], // non-nullable -> nullable
    [body, "body: z.string().optional(),"], // nullable -> non-nullable
    [body, `${body}\n  extra: z.string().optional(),`],
    [body, ""],
  ]) {
    expect(out.validator.contents).toContain(from!);
    await writeFile(resolve(out.root, out.validator.path), out.validator.contents.replace(from!, to!));
    const result = check(out.root, out.files.filter((file) => file.path.endsWith(".ts")).map((file) => file.path));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("TS2344");
  }
  const empty = await emitted('resource="empty"\n  attributes\n    uuid-primary-key="id"\n  actions\n    create="create" accept=[]\n');
  expect(check(empty.root, empty.files.filter((file) => file.path.endsWith(".ts")).map((file) => file.path))).toEqual({ code: 0, output: "" });
  expect(empty.validator.contents).toContain("z.strictObject({})");
  await writeFile(resolve(empty.root, empty.validator.path), empty.validator.contents.replace("z.strictObject({})", "z.strictObject({ extra: z.string().optional() })"));
  expect(check(empty.root, empty.files.filter((file) => file.path.endsWith(".ts")).map((file) => file.path)).output).toContain("TS2344");
}, 60_000);

test.each(BUILTIN_OBJECT_PROPERTY_NAMES.flatMap((name) => ["attribute", "uuid-primary-key", "create-timestamp", "update-timestamp"].map((tag) => [name, tag] as const)))("built-in object property %s is rejected for %s with exact name position", (name, tag) => {
  const source = `resource="named"\n  attributes\n${tag === "uuid-primary-key" ? "" : '    uuid-primary-key="id"\n'}    ${tag}="${name}"${tag === "attribute" ? ' type="string"' : ""}\n`;
  const offset = source.indexOf(JSON.stringify(name));
  const before = source.slice(0, offset);
  const result = buildModel({ root: "/project", files: [{ file: "named.mx", source }] });
  expect(result.document).toBeNull();
  expect(result.diagnostics).toEqual([{ severity: "error", code: "MESH_ATTRIBUTE_NAME",
    message: `attribute "${name}" cannot be used: it is the name of a built-in object property. Choose another name.`,
    position: { file: "named.mx", line: before.split("\n").length, column: offset - before.lastIndexOf("\n") - 1, offset }, fix: null }]);
});

test("M2 test 2: optional inherited-method fields are rejected before an emitted schema can run", async () => {
  const source = 'resource="named"\n  attributes\n    uuid-primary-key="id"\n    attribute="constructor" type="string"\n  actions\n    update="update" accept=["constructor"]\n';
  const built = buildModel({ root: "/project", files: [{ file: "named.mx", source }] });
  expect(built.document).toBeNull();
  expect(built.diagnostics[0]?.code).toBe("MESH_ATTRIBUTE_NAME");
  const { schemas } = await emitted(source.replaceAll("constructor", "ordinary"));
  const schema = schemas.updateNamedInput!;
  expect((await schema["~standard"].validate({ id: "00000000-0000-4000-8000-000000000001" })).issues).toBeUndefined();
  expect((await schema["~standard"].validate({ id: "00000000-0000-4000-8000-000000000001", constructor: "own" })).issues).toBeDefined();
});

test("M2 test 2: emitted optional inputs accept omission and own undefined as not provided, and nullable null", async () => {
  const { schemas } = await emitted(fixture("reduced-post.mx").source);
  for (const input of [{ title: "Hello" }, { title: "Hello", body: undefined }, { title: "Hello", body: null }]) {
    expect(await schemas.createPostInput!["~standard"].validate(input)).toEqual({ value: input });
  }
  const source = 'resource="defaults"\n  attributes\n    uuid-primary-key="id"\n    attribute="count" type="integer" allow-nil=false default=0\n  actions\n    create="create" accept=["count"]\n    update="update" accept=["count"]\n    destroy="destroy" accept=["count"]\n';
  const out = await emitted(source);
  expect(check(out.root, out.files.filter((file) => file.path.endsWith(".ts")).map((file) => file.path))).toEqual({ code: 0, output: "" });
  for (const [name, base] of [["createDefaultsInput", {}], ["updateDefaultsInput", { id: "00000000-0000-4000-8000-000000000001" }], ["destroyDefaultsInput", { id: "00000000-0000-4000-8000-000000000001" }]] as const) {
    for (const input of [base, { ...base, count: undefined }]) expect(await out.schemas[name]!["~standard"].validate(input)).toEqual({ value: input });
    expect((await out.schemas[name]!["~standard"].validate({ ...base, count: null })).issues).toBeDefined();
  }
});

test("M2 test 2: every registered attribute type has exactly one validator mapping", () => {
  expect(Object.keys(VALIDATOR_TYPES).sort()).toEqual(ATTRIBUTE_TYPES.map((entry) => entry.name).sort());
});

test("generated import preflight reports all missing packages once at mesh.config.ts:1:1", () => {
  const diagnostics = generatedImportDiagnostics(import.meta.dir, [{ name: "fixture", requires: ["mesh-missing-a", "mesh-missing-b", "mesh-missing-a"], async emit() { return []; } }]);
  expect(diagnostics.map((item) => item.message)).toEqual(["a", "b"].map((suffix) => `generated code imports "mesh-missing-${suffix}", which is not installed in this project. Run: bun add mesh-missing-${suffix}`));
  for (const item of diagnostics) expect(item.position).toEqual({ file: "mesh.config.ts", line: 1, column: 0, offset: 0 });
});

test("unknown accept suggests only a unique attribute within two edits with exact wording and position", () => {
  expect(nearestName("titel", ["title"])).toBe("title");
  expect(nearestName("cat", ["bat", "hat"])).toBeUndefined();
  expect(nearestName("unknown", ["title"])).toBeUndefined();
  for (const [name, tail] of [["titel", ' Did you mean "title"?'], ["unknown", ""]]) {
    const source = `resource="todo"\n  attributes\n    uuid-primary-key="id"\n    attribute="title" type="string"\n  actions\n    create="create" accept=["${name}"]\n`;
    const result = buildModel({ root: "/project", files: [{ file: "todo.mx", source }] });
    expect(result.diagnostics[0]).toMatchObject({ message: `\`accept\` names "${name}", which is not an attribute of todo.${tail}`, position: { file: "todo.mx", line: 6, column: 28 }, fix: null });
    expect(formatDiagnostic(result.diagnostics[0]!)).toBe(`todo.mx:6:29 error \`accept\` names "${name}", which is not an attribute of todo.${tail}`);
  }
});
