import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { positionOf } from "../../model/test/source.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project(config?: string) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-config-")); roots.push(root);
  await mkdir(resolve(root, "resources"));
  await writeFile(resolve(root, "resources/post.mx"), 'resource="post"\n  attributes\n    uuid-primary-key="id"\n');
  await writeFile(resolve(root, "resources/user.mx"), 'resource="user"\n  attributes\n    uuid-primary-key="id"\n');
  if (config !== undefined) await writeFile(resolve(root, "mesh.config.ts"), config);
  return root;
}

test("defineConfig preserves the explicit required configuration", () => {
  const config = { resources: ["resources/post.mx"], output: "generated" };
  expect(defineConfig(config)).toBe(config);
});
test("missing mesh.config.ts produces a positioned diagnostic with a fix", async () => {
  const result = await loadConfig(await project());
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG_READ", message: "Cannot read mesh.config.ts (ENOENT)", position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 }, fix: "Create mesh.config.ts with resources and output" });
});
test.each([
  ['export default { output: "generated" }', "Configuration field `resources` must be a non-empty relative folder, glob or list of relative file paths", 1, 0],
  ['export default { resources: 12, output: "generated" }', "Configuration field `resources` must be a non-empty relative folder, glob or list of relative file paths", 1, 17],
  ['export default { resources: "resources/*.mx" }', "Configuration field `output` must be a non-empty relative directory path", 1, 0],
  ['export default {\n  resources: "resources/*.mx",\n  output: false\n}', "Configuration field `output` must be a non-empty relative directory path", 3, 2],
  ['export default {\n  resources: "resources/*.mx",\n  output: "generated",\n  extra: []\n}', 'Unknown configuration field "extra"', 4, 2],
])("invalid required or unknown field: %s", async (source, message, line, column) => {
  const result = await loadConfig(await project(source));
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ message, position: { file: "mesh.config.ts", line, column } });
});
test("glob paths resolve relative to config, sort deterministically and load to a model", async () => {
  const root = await project('export default { resources: "resources/*.mx", output: "generated" }');
  const result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
  expect(result.config).toEqual({ root, configFile: resolve(root, "mesh.config.ts"), resourceFiles: [resolve(root, "resources/post.mx"), resolve(root, "resources/user.mx")], output: resolve(root, "generated") });
  const built = await loadProject(result.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document!.resources.map((r) => r.name.value)).toEqual(["post", "user"]);
});
test("explicit list deduplicates paths and config reload reflects edits", async () => {
  const root = await project('export default { resources: ["resources/user.mx", "resources/post.mx", "resources/user.mx"], output: "generated" }');
  expect((await loadConfig(root)).config!.resourceFiles).toHaveLength(2);
  await writeFile(resolve(root, "mesh.config.ts"), 'export default { resources: ["resources/post.mx"], output: "output" }');
  const second = await loadConfig(root);
  expect(second.config!.resourceFiles).toEqual([resolve(root, "resources/post.mx")]);
  expect(second.config!.output).toBe(resolve(root, "output"));
});
test.each([
  ['export default null', "mesh.config.ts must default-export a configuration object", "default"],
  ['export default []', "mesh.config.ts must default-export a configuration object", "default"],
  ['export default { resources: [], output: "generated" }', "Configuration field `resources` must be a non-empty relative folder, glob or list of relative file paths", "resources"],
  ['export default { resources: "resources/nope*.mx", output: "generated" }', "Configuration field `resources` matches no files", "resources"],
  ['export default { resources: ["missing.mx"], output: "generated" }', 'Cannot read resource file "missing.mx" (ENOENT)', "resources"],
  ['export default { resources: ["resources"], output: "generated" }', 'Resource path "resources" is not a file', "resources"],
  ['export default { resources: "resources/*.mx", output: ".." }', "Configuration field `output` must name a directory inside the project, not the project root", "output"],
  ['export default { resources: "resources/*.mx", output: "." }', "Configuration field `output` must name a directory inside the project, not the project root", "output"],
  ['export default { resources: ["../outside.mx"], output: "generated" }', "Resource file path must resolve inside the project", "resources"],
  ['throw new Error("broken config");', "Cannot load mesh.config.ts: Error: broken config", "module"],
])("config rejects malformed, unreadable and escaping paths: %s", async (source, message, field) => {
  const root = await project(source);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  const position = field === "default" || field === "module" ? { file: "mesh.config.ts", line: 1, column: 0, offset: 0 } : positionOf(source, "mesh.config.ts", field);
  expect(result.diagnostics[0]).toMatchObject({ message, position, fix: field === "module" ? "Fix the config module and export default defineConfig({...})" : `Fix the ${field} field in mesh.config.ts` });
  expect(JSON.stringify(result.diagnostics)).not.toContain(root);
});
test("config reports all field errors together", async () => {
  const result = await loadConfig(await project('export default { resources: false, output: 10, extra: true }'));
  expect(result.diagnostics).toHaveLength(3);
});
test("loadProject collects read failures and parse failures without throwing", async () => {
  const root = await project('export default { resources: "resources/*.mx", output: "generated" }');
  const result = await loadConfig(root);
  await rm(resolve(root, "resources/post.mx"));
  await writeFile(resolve(root, "resources/user.mx"), 'resourse="user"\n');
  const built = await loadProject(result.config!);
  expect(built.document).toBeNull();
  expect(built.diagnostics.map((d) => d.code)).toEqual(["MESH_RESOURCE_READ", "MX"]);
});
