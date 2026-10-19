import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkBatchedTypes, checkTypes, checkTypesBinary } from "./generated.ts";
import { closeTypeServer } from "./type-server.ts";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(import.meta.dir, "../mesh-type-server-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
afterAll(closeTypeServer);

test("the API reports imported implementation errors like tsc, and observes rewrites and deletion", async () => {
  const root = await fixture();
  await writeFile(resolve(root, "entry.ts"), 'export { value } from "./helper";\n');
  await writeFile(resolve(root, "helper.ts"), 'export const value: number = "wrong";\n');
  const binary = checkTypesBinary(root, ["entry.ts"]);
  const checked = await checkTypes(root, ["entry.ts"]);
  expect(checked.code).toBe(binary.code);
  expect(checked.code).toBe(1);
  expect(checked.output.trim()).toBe(binary.output.trim());
  expect(checked.output).toContain("helper.ts(1,14): error TS2322:");
  await writeFile(resolve(root, "helper.ts"), "export const value: number = 3;\n");
  expect(await checkTypes(root, ["entry.ts"])).toEqual({ code: 0, output: "" });
  await rm(resolve(root, "helper.ts"));
  const missing = await checkTypes(root, ["entry.ts"]);
  expect(missing.code).toBe(1);
  expect(missing.output).toContain("TS2307");
});

test("one fixture's global augmentation cannot make the next fixture pass", async () => {
  const first = await fixture();
  await writeFile(resolve(first, "entry.ts"), "declare global { var meshTypeServerProbe: string; }\nexport const value: string = meshTypeServerProbe;\n");
  expect(await checkTypes(first, ["entry.ts"])).toEqual({ code: 0, output: "" });
  const second = await fixture();
  await writeFile(resolve(second, "entry.ts"), "export const value: string = meshTypeServerProbe;\n");
  const checked = await checkTypes(second, ["entry.ts"]);
  expect(checked.code).toBe(1);
  expect(checked.output).toContain("TS2304");
  expect(checked.output.trim()).toBe(checkTypesBinary(second, ["entry.ts"]).output.trim());
});

test.each([
  ["script globals", 'var leakedGlobal: string = "x";\n', "no top-level import/export"],
  ["imports/exports in comments and strings", '/* export {} */\nvar fakeImport = \'import "x"\';\n', "no top-level import/export"],
  ["a local namespace alias", 'namespace Local {}\nimport Alias = Local;\nvar leakedGlobal: string = "x";\n', "no top-level import/export"],
  ["global augmentation", "export {};\ndeclare global { var leakedGlobal: string; }\n", "declare global / declare module"],
  ["module augmentation", 'export {};\ndeclare module "@meshfw/runtime" { interface ActionContext { leakedGlobal?: string } }\n', "declare global / declare module"],
] as const)("batching rejects %s with the captured file named", async (_name, source, reason) => {
  const root = await fixture();
  // Check captured helpers too, not just the entry explicitly named by the caller.
  await writeFile(resolve(root, "entry.ts"), 'export * from "./helper";\n');
  await writeFile(resolve(root, "helper.ts"), source);
  let error: unknown;
  try { await checkBatchedTypes(root, ["entry.ts"]); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(resolve(root, "helper.ts"));
  expect((error as Error).message).toContain(reason);
  // Rejection must happen before the shared program or overlay acquires the bad fixture.
  const next = await fixture();
  await writeFile(resolve(next, "entry.ts"), "export const value: string = leakedGlobal;\n");
  const checked = await checkBatchedTypes(next, ["entry.ts"]);
  expect(checked.code).toBe(1);
  expect(checked.output).toContain("TS2304");
});

test("later batched fixtures enter the program and report their own errors", async () => {
  const first = await fixture();
  await writeFile(resolve(first, "entry.ts"), "export const value = 1;\n");
  expect(await checkBatchedTypes(first, ["entry.ts"])).toEqual({ code: 0, output: "" });
  const second = await fixture();
  await writeFile(resolve(second, "entry.ts"), 'export { value } from "./helper";\n');
  await writeFile(resolve(second, "helper.ts"), 'export const value: number = "wrong";\n');
  const checked = await checkBatchedTypes(second, ["entry.ts"]);
  expect(checked.code).toBe(1);
  expect(checked.output).toContain("helper.ts(1,14): error TS2322:");
  expect(checked.output.trim()).toBe(checkTypesBinary(second, ["entry.ts"]).output.trim());
});

test("batching accepts declaration-like text in comments and strings in an actual module", async () => {
  const root = await fixture();
  await writeFile(resolve(root, "entry.ts"), '/* declare global { } */\nexport const text = \'declare module "x" { }\';\n');
  expect(await checkBatchedTypes(root, ["entry.ts"])).toEqual({ code: 0, output: "" });
});

test.each([
  ["multi-level message chains", 'const actual: { b: { c: string } } = { b: { c: "x" } };\nexport const expected: { b: { c: number } } = actual;\n', "The types of 'b.c'"],
  ["UTF-16 columns after non-ASCII text", 'const 标记 = "é😀漢"; export const broken: number = 标记;\n', "TS2322"],
] as const)("API diagnostic text matches tsc for %s", async (_name, source, expected) => {
  const root = await fixture();
  await writeFile(resolve(root, "entry.ts"), source);
  const checked = await checkTypes(root, ["entry.ts"]);
  const binary = checkTypesBinary(root, ["entry.ts"]);
  expect(checked.code).toBe(1);
  expect(checked.code).toBe(binary.code);
  expect(checked.output).toContain(expected);
  expect(checked.output.trim()).toBe(binary.output.trim());
});
