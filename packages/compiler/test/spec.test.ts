import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { positionOf } from "../../model/test/source.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const resource = (name: string) => `resource="${name}"\n  attributes\n    uuid-primary-key="id"\n`;
async function project(source = 'export default { resources: "resources", output: "generated" }') {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-spec-")); roots.push(root);
  await mkdir(resolve(root, "resources/nested"), { recursive: true });
  await writeFile(resolve(root, "resources/z.mx"), resource("z"));
  await writeFile(resolve(root, "resources/nested/a.mx"), resource("a"));
  await writeFile(resolve(root, "resources/readme.txt"), "not a resource");
  await writeFile(resolve(root, "mesh.config.ts"), source);
  return root;
}
test("DX spec: resource folder recursively discovers only .mx files in sorted order", async () => {
  const root = await project();
  const result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
  expect(result.config).toEqual({ root, configFile: resolve(root, "mesh.config.ts"), resourceFiles: [resolve(root, "resources/nested/a.mx"), resolve(root, "resources/z.mx")], output: resolve(root, "generated") });
  const model = await loadProject(result.config!);
  expect(model.diagnostics).toEqual([]);
  expect(model.document!.resources.map((r) => r.name.value)).toEqual(["a", "z"]);
});
test("DX spec: output replaces the old generatedDir key, which is unknown", async () => {
  const source = 'export default { resources: "resources", output: "generated", generatedDir: "old" }';
  const result = await loadConfig(await project(source));
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ message: 'Unknown configuration field "generatedDir"', position: positionOf(source, "mesh.config.ts", "generatedDir") });
});
test("DX spec: M1 preserves opaque data and extensions without interpreting them", async () => {
  const root = await project('export default { resources: "resources", output: "generated", data: () => { throw new Error("do not call"); }, extensions: [Symbol.for("opaque"), { future: true }] }');
  const result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
  expect(typeof result.config!.data).toBe("function");
  expect(result.config!.extensions).toEqual([Symbol.for("opaque"), { future: true }]);
  expect((await loadProject(result.config!)).diagnostics).toEqual([]);
});
test("DX spec: data is not required in M1 and absent opaque keys stay absent", async () => {
  const result = await loadConfig(await project());
  expect(result.diagnostics).toEqual([]);
  expect(Object.hasOwn(result.config!, "data")).toBe(false);
  expect(Object.hasOwn(result.config!, "extensions")).toBe(false);
});
test("DX spec: explicit opaque null and undefined values stay untouched", async () => {
  const result = await loadConfig(await project('export default { resources: "resources", output: "generated", data: null, extensions: undefined }'));
  expect(result.diagnostics).toEqual([]);
  expect(result.config!.data).toBeNull();
  expect(result.config!.extensions).toBeUndefined();
  expect(Object.hasOwn(result.config!, "extensions")).toBe(true);
});
test("DX spec: resource folder with no .mx files is a positioned configuration error", async () => {
  const root = await project();
  await rm(resolve(root, "resources"), { recursive: true });
  await mkdir(resolve(root, "resources"));
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ message: "Configuration field `resources` matches no files", position: { file: "mesh.config.ts", line: 1, column: 17, offset: 17 }, fix: "Fix the resources field in mesh.config.ts" });
});
test("DX spec: resource folder symlink cannot escape even when it has no .mx files", async () => {
  const root = await project('export default { resources: "external", output: "generated" }');
  const outside = await mkdtemp(resolve(tmpdir(), "mesh-spec-outside-")); roots.push(outside);
  await symlink(outside, resolve(root, "external"));
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ message: 'Resource path "external" resolves outside the project', position: { file: "mesh.config.ts", line: 1, column: 17, offset: 17 } });
  expect(JSON.stringify(result.diagnostics)).not.toContain(outside);
});
test("DX spec: defineConfig accepts output and optional opaque spec keys", () => {
  const config = { resources: "resources", output: "generated", data: { later: true }, extensions: "opaque" };
  expect(defineConfig(config)).toBe(config);
});
