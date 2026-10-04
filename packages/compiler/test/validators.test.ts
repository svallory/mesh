import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ATTRIBUTE_TYPES } from "@mesh/model";
interface StandardSchemaV1 {
  "~standard": { validate(input: unknown): { value?: unknown; issues?: readonly { message: string }[] } | Promise<{ value?: unknown; issues?: readonly { message: string }[] }> };
}
import { buildModel } from "../src/build.ts";
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
  const child = Bun.spawnSync([resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", ...files], { cwd: root });
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

test("M2 test 2: validator drift checks reject type, optionality and nullability changes in both directions", async () => {
  const out = await emitted(fixture("reduced-post.mx").source);
  for (const [from, to] of [['title: z.string()', 'title: z.number()'], ['title: z.string()', 'title: z.string().optional()'], ['title: z.string()', 'title: z.string().nullable()'], ['body: z.string().nullable().optional()', 'body: z.string().nullable()'], ['body: z.string().nullable().optional()', 'body: z.string().optional()']] as const) {
    expect(out.validator.contents).toContain(from);
    await writeFile(resolve(out.root, out.validator.path), out.validator.contents.replace(from, to));
    const result = check(out.root, out.files.filter((file) => file.path.endsWith(".ts")).map((file) => file.path));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("TS2322");
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
    expect(result.diagnostics[0]).toMatchObject({ message: `\`accept\` names "${name}", which is not an attribute of todo.${tail}`, position: { file: "todo.mx", line: 6, column: 28 } });
  }
});
