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
test("M7: folder discovery includes dotfiles, dot-directories and node_modules in deterministic order", async () => {
  const root = await project();
  await mkdir(resolve(root, "resources/.hidden"));
  await mkdir(resolve(root, "resources/node_modules/pkg"), { recursive: true });
  await writeFile(resolve(root, "resources/.secret.mx"), resource("secret"));
  await writeFile(resolve(root, "resources/.hidden/inside.mx"), resource("inside"));
  await writeFile(resolve(root, "resources/node_modules/pkg/dep.mx"), resource("dep"));
  const expected = [".hidden/inside.mx", ".secret.mx", "nested/a.mx", "node_modules/pkg/dep.mx", "z.mx"].map((file) => resolve(root, "resources", file));
  const first = await loadConfig(root);
  expect(first.diagnostics).toEqual([]);
  expect(first.config!.resourceFiles).toEqual(expected);
  expect((await loadConfig(root)).config!.resourceFiles).toEqual(expected);
  const model = await loadProject(first.config!);
  expect(model.diagnostics).toEqual([]);
  expect(model.document!.resources.map((r) => r.name.value)).toEqual(["inside", "secret", "a", "dep", "z"]);
});
test("M7: a folder containing only hidden resources is not treated as empty", async () => {
  const root = await project();
  await rm(resolve(root, "resources"), { recursive: true });
  await mkdir(resolve(root, "resources/.hidden"), { recursive: true });
  await writeFile(resolve(root, "resources/.secret.mx"), resource("secret"));
  await writeFile(resolve(root, "resources/.hidden/inside.mx"), resource("inside"));
  const result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
  expect(result.config!.resourceFiles).toEqual([resolve(root, "resources/.hidden/inside.mx"), resolve(root, "resources/.secret.mx")]);
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
test.each(["null", "undefined"])("M6: opaque data %s stays untouched with a valid empty extensions array", async (literal) => {
  const result = await loadConfig(await project(`export default { resources: "resources", output: "generated", data: ${literal}, extensions: [] }`));
  expect(result.diagnostics).toEqual([]);
  expect(result.config!.data).toBe(literal === "null" ? null : undefined);
  expect(Object.hasOwn(result.config!, "data")).toBe(true);
  expect(result.config!.extensions).toEqual([]);
});
test.each(['"opaque"', "false", "123", "{}", "null", "undefined"])("M6: present non-array extensions %s is a positioned configuration error", async (literal) => {
  const source = `export default {\n  resources: "resources",\n  output: "generated",\n  extensions: ${literal}\n}`;
  const result = await loadConfig(await project(source));
  expect(result.config).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG", message: "Configuration field `extensions` must be an array", position: positionOf(source, "mesh.config.ts", "extensions"), fix: "Fix the extensions field in mesh.config.ts" });
});
test("M6: valid extension array references and opaque elements are preserved without execution", async () => {
  const extensions = [{ future: true }, () => { throw new Error("do not call"); }, Symbol("opaque"), null, undefined];
  const key = `meshSpecExtensions_${crypto.randomUUID()}`;
  Object.defineProperty(globalThis, key, { value: extensions, configurable: true });
  try {
    const source = `export default { resources: "resources", output: "generated", extensions: globalThis[${JSON.stringify(key)}] }`;
    const result = await loadConfig(await project(source));
    expect(result.diagnostics).toEqual([]);
    expect(result.config!.extensions).toBe(extensions);
  } finally { Reflect.deleteProperty(globalThis, key); }
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
test("DX spec: defineConfig accepts output, opaque data and an array of opaque extension elements", () => {
  const config = { resources: "resources", output: "generated", data: { later: true }, extensions: ["opaque"] };
  expect(defineConfig(config)).toBe(config);
});
