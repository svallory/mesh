import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkTypes, checkTypesBinary } from "./generated.ts";
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
