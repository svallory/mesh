import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { keyed } from "./v4.ts";
const data = { kind: "data-adapter", name: "sqlite", options: { file: ":memory:" } } as const;
const adapter = JSON.stringify(data);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(source = `export default { domain: "src/domain", output: ".mesh", data: ${adapter} }`) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-spec-"));
  roots.push(root);
  for (const name of ["nested/a", ".hidden/b", ".secret", "node_modules/pkg/dep", "z"]) {
    const file = resolve(root, `src/domain/${name}.mesh.mx`);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, keyed.replace(":Todo", `:Name${name.replace(/[^A-Za-z0-9]/g, "")}`));
  }
  await writeFile(resolve(root, "src/domain/old.mx"), "ignored");
  await writeFile(resolve(root, "mesh.config.ts"), source);
  return root;
}
test("recursive discovery includes hidden paths and node_modules deterministically", async () => {
  const root = await project();
  const first = await loadConfig(root);
  expect(first.diagnostics).toEqual([]);
  expect(first.config!.entityFiles).toEqual(
    [".hidden/b", ".secret", "nested/a", "node_modules/pkg/dep", "z"].map((n) => resolve(root, `src/domain/${n}.mesh.mx`)),
  );
  expect((await loadConfig(root)).config!.entityFiles).toEqual(first.config!.entityFiles);
  // Discovery does not hide files; the builder explains an invalid module name.
  expect((await loadProject(first.config!)).diagnostics.map((d) => d.code)).toEqual(["MESH_MODULE_NAME"]);
});
test("a folder containing only hidden entity files is not empty", async () => {
  const root = await project();
  await rm(resolve(root, "src/domain"), { recursive: true });
  await mkdir(resolve(root, "src/domain"));
  await writeFile(resolve(root, "src/domain/.only.mesh.mx"), keyed);
  expect((await loadConfig(root)).config!.entityFiles).toHaveLength(1);
});
test("an ordinary .mx file does not satisfy discovery", async () => {
  const root = await project();
  await rm(resolve(root, "src/domain"), { recursive: true });
  await mkdir(resolve(root, "src/domain"));
  await writeFile(resolve(root, "src/domain/old.mx"), keyed);
  expect((await loadConfig(root)).diagnostics[0]?.message).toContain("matches no files");
});
test("absent extensions stay absent", async () => {
  const config = (await loadConfig(await project())).config!;
  expect(config.data).toEqual(data);
  expect(Object.hasOwn(config, "extensions")).toBe(false);
});
test.each(['"opaque"', "false", "123", "{}", "null", "undefined"])("non-array extensions %s fail", async (value) => {
  const result = await loadConfig(await project(`export default { domain:"src/domain", output:".mesh", data:${adapter}, extensions:${value} }`));
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG", message: "Configuration field `extensions` must be an array" });
});
test.each(["null", "undefined", '"opaque"', "42", "[]", "{}", "{name:42}", '(() => "extension")'])("invalid extension element %s fails", async (value) => {
  const result = await loadConfig(await project(`export default {domain:"src/domain",output:".mesh",data:${adapter},extensions:[${value}]}`));
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]?.message).toBe("Configuration field `extensions[0]` must be an object with a name string");
});
test("named extension objects remain identical and hooks unexecuted", async () => {
  const extensions = [{ name: "audit", hook() { throw new Error("do not call"); }, opaque: Symbol("opaque") }];
  const key = `meshSpec_${crypto.randomUUID()}`;
  Object.defineProperty(globalThis, key, { value: extensions, configurable: true });
  try {
    const result = await loadConfig(await project(`export default {domain:"src/domain",output:".mesh",data:${adapter},extensions:globalThis[${JSON.stringify(key)}]}`));
    expect(result.diagnostics).toEqual([]);
    expect(result.config!.extensions).toBe(extensions);
  } finally { Reflect.deleteProperty(globalThis, key); }
});
test("an empty escaping folder symlink is still rejected", async () => {
  const root = await project(`export default {domain:"external",output:".mesh",data:${adapter}}`);
  const outside = await mkdtemp(resolve(tmpdir(), "mesh-outside-"));
  roots.push(outside);
  await symlink(outside, resolve(root, "external"));
  expect((await loadConfig(root)).config).toBeNull();
});
test("configuration identity preserves adapter and opaque extension objects", () => {
  const config = { domain: "src/domain", output: ".mesh", data, extensions: [{ name: "audit", custom: true }] };
  expect(defineConfig(config)).toBe(config);
});
