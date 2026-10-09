import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { keyed } from "./v4.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function project(config?: string) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-config-"));
  roots.push(root);
  await mkdir(resolve(root, "resources/blog"), { recursive: true });
  await writeFile(resolve(root, "resources/blog/todo.mesh.mx"), keyed);
  await writeFile(
    resolve(root, "resources/blog/list.mesh.mx"),
    keyed.replace(":Todo", ":List"),
  );
  await writeFile(resolve(root, "resources/blog/old.mx"), "not discovered");
  await writeFile(
    resolve(root, "resources/blog/post.pending.mesh.mx.txt"),
    "not discovered",
  );
  if (config !== undefined)
    await writeFile(resolve(root, "mesh.config.ts"), config);
  return root;
}
test("defineConfig is an identity", () => {
  const config = { resources: "resources", output: "generated" };
  expect(defineConfig(config)).toBe(config);
  expect(
    defineConfig({ domain: "resources", output: "generated" }).domain,
  ).toBe("resources");
});
test("missing config is positioned with a fix", async () => {
  expect((await loadConfig(await project())).diagnostics[0]).toMatchObject({
    code: "MESH_CONFIG_READ",
    position: { file: "mesh.config.ts", line: 1, column: 0 },
    fix: "Create mesh.config.ts with resources and output",
  });
});
test.each(["resources", "domain"])(
  "%s discovers only .mesh.mx, deterministically",
  async (key) => {
    const root = await project(
      `export default { ${key}: "resources", output: "generated" }`,
    );
    const loaded = await loadConfig(root);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config!.resourceFiles).toEqual([
      resolve(root, "resources/blog/list.mesh.mx"),
      resolve(root, "resources/blog/todo.mesh.mx"),
    ]);
    const built = await loadProject(loaded.config!);
    expect(built.diagnostics).toEqual([]);
    expect(built.document!.entities.map((e) => e.name)).toEqual([
      "List",
      "Todo",
    ]);
  },
);
test("explicit list deduplicates and config reload reflects edits", async () => {
  const root = await project(
    'export default { resources: ["resources/blog/todo.mesh.mx", "resources/blog/todo.mesh.mx"], output: "generated" }',
  );
  expect((await loadConfig(root)).config!.resourceFiles).toHaveLength(1);
  await writeFile(
    resolve(root, "mesh.config.ts"),
    'export default { domain: "resources/**/*.mesh.mx", output: "output" }',
  );
  const loaded = await loadConfig(root);
  expect(loaded.config!.resourceFiles).toHaveLength(2);
  expect(loaded.config!.output).toBe(resolve(root, "output"));
});
test.each([
  "export default null",
  "export default []",
  'export default {output:"generated"}',
  'export default {resources:[],output:"generated"}',
  'export default {resources:12,output:"generated"}',
  'export default {resources:"resources",output:false}',
  'export default {resources:"resources",output:"generated",extra:1}',
  'export default {resources:"resources",domain:"resources",output:"generated"}',
  'export default {resources:["resources/blog/old.mx"],output:"generated"}',
  'export default {resources:"nope/*.mesh.mx",output:"generated"}',
  'export default {resources:["missing.mesh.mx"],output:"generated"}',
  'export default {resources:["resources"],output:"generated"}',
  'export default {resources:"resources",output:".."}',
  'export default {resources:"resources",output:"."}',
  'export default {resources:["../outside.mesh.mx"],output:"generated"}',
  'throw new Error("broken config");',
])("rejects malformed/escaping config %s", async (source) => {
  const root = await project(source);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(
    result.diagnostics.every((d) => d.position.file === "mesh.config.ts"),
  ).toBe(true);
  expect(JSON.stringify(result.diagnostics)).not.toContain(root);
});
test("collects independent field errors", async () => {
  expect(
    (
      await loadConfig(
        await project("export default {resources:false,output:10,extra:true}"),
      )
    ).diagnostics,
  ).toHaveLength(3);
});
test("collects read and parse errors without throwing", async () => {
  const root = await project(
    'export default {resources:"resources",output:"generated"}',
  );
  const loaded = await loadConfig(root);
  await rm(resolve(root, "resources/blog/list.mesh.mx"));
  await writeFile(
    resolve(root, "resources/blog/todo.mesh.mx"),
    "enttiy :Todo\n",
  );
  const built = await loadProject(loaded.config!);
  expect(built.document).toBeNull();
  expect(built.diagnostics.map((d) => d.code)).toEqual([
    "MESH_RESOURCE_READ",
    "MESH_SYNTAX",
  ]);
});
