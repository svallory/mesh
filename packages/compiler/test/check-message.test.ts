import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { checkTypes, configOf } from "./generated.ts";

// ACT-30: a check's `message=` is fixed text or a function of the arguments `that=` gets.
const entity = (message: string) => `entity :Task
  attributes
    uuid :id primary-key
    string :title
  actions auto=[:read]
    update :go
      validate
        check :ok [
          that=() => true
          code="task.ok"
          ${message}
        ]
`;
const built = (message: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: entity(message) }] });
const checkOf = (message: string) => built(message).document?.entities[0]?.actions.find((a) => a.name === "go")?.validate[0];
const errors = (message: string) => built(message).diagnostics.filter((d) => d.severity === "error");

test("text stays text in the model", () => {
  expect(errors('message="the title is taken"')).toEqual([]);
  expect(checkOf('message="the title is taken"')?.message).toBe("the title is taken");
});

test("a function is an expression with its source, parameters and position", () => {
  const source = "({ self }) => `title ${self.title}`";
  expect(errors(`message=${source}`)).toEqual([]);
  const message = checkOf(`message=${source}`)?.message;
  expect(typeof message).toBe("object");
  expect(message).toMatchObject({ source, params: ["self"], position: { file: "task.mesh.mx", line: 11 } });
});

test("a function may read a relationship or a member, and be async", () => {
  expect(errors("message=() => `title ${&title}`")).toEqual([]);
  expect(errors("message=async ({ self }) => await Promise.resolve(self.title)")).toEqual([]);
});

test("`message` is required", () => {
  expect(errors("").length).toBeGreaterThan(0);
});

const where = (message: string) => errors(message).map((d) => [d.code, d.position.line, d.position.column]);

test.each([
  ["a number", "message=42"], ["a negative number", "message=-1"], ["null", "message=null"], ["a boolean", "message=true"],
  ["a list", "message=[1]"], ["a bare template", "message=`text`"], ["a member path", "message=Foo.bar"], ["a member reference", "message=&title"],
])("%s is MESH_ATTRIBUTE_VALUE at the attribute, not MESH_MODEL_SHAPE at the entity", (_name, message) => {
  expect(where(message)).toEqual([["MESH_ATTRIBUTE_VALUE", 11, 10]]);
});

test("an atom is MESH_ATTRIBUTE_VALUE at the attribute", () => {
  expect(where("message=:oops").map(([code, line]) => [code, line])).toEqual([["MESH_ATTRIBUTE_VALUE", 11]]);
});

test.each([['""'], ['"   "'], ['"\t"']])("blank text %s is MESH_TEXT at the attribute", (text) => {
  expect(where(`message=${text}`)).toEqual([["MESH_TEXT", 11, 10]]);
});

test("a refused value is not a model-shape failure of the whole entity", () => {
  const result = built("message=42");
  expect(result.diagnostics.map((d) => d.code)).not.toContain("MESH_MODEL_SHAPE");
});

test("a message function that reads `before` is refused like `that=` (`before` is gone from validate)", () => {
  const found = errors("message=({ before }) => before.title");
  expect(found.map((d) => d.code)).toContain("MESH_VALIDATE_BEFORE");
});

// The generated code type-checks the function's result: a number, or a field that can be null, is a compile error,
// where the run time would fail the check with a FrameworkError.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function typeCheck(message: string) {
  const source = `entity :Task
  attributes
    uuid :id primary-key
    string :title
    string :subtitle nullable
  relationships
    belongs-to :owner entity=Task nullable
  actions auto=[:read]
    update :go
      validate
        check :ok [
          that=() => false
          code="task.ok"
          ${message}
        ]
`;
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-message-"));
  roots.push(root);
  const result = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const config = configOf(root);
  await writeGeneratedFiles(await generateFiles({ document: result.document!, config }), config);
  await writeFile(resolve(root, "generated/schema.ts"), "export const tables: any = {};\n");
  return checkTypes(root, ["generated/domain/task.actions.ts"]);
}

test("the generated code type-checks with a message that is text or returns a string", async () => {
  expect(await typeCheck('message="fixed"')).toEqual({ code: 0, output: "" });
  expect(await typeCheck("message=({ self }) => `title ${self.title}`")).toEqual({ code: 0, output: "" });
  expect(await typeCheck("message=async ({ self }) => await Promise.resolve(self.title)")).toEqual({ code: 0, output: "" });
});

test.each([["a number", "message=() => 42"], ["a nullable field", "message=({ self }) => self.subtitle"]])(
  "the generated code does not type-check with %s as the message",
  async (_name, message) => {
    const result = await typeCheck(message);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("task.actions.ts");
    expect(result.output).toContain("TS2322");
    expect(result.output).toContain("string | PromiseLike<string>");
  },
);
