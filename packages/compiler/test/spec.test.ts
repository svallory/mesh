import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { keyed } from "./v4.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function project(
  source = 'export default { resources: "resources", output: "generated" }',
) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-spec-"));
  roots.push(root);
  for (const name of [
    "nested/a",
    ".hidden/b",
    ".secret",
    "node_modules/pkg/dep",
    "z",
  ]) {
    const file = resolve(root, `resources/${name}.mesh.mx`);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(
      file,
      keyed.replace(":Todo", `:Name${name.replace(/\W/g, "")}`),
    );
  }
  await writeFile(resolve(root, "resources/old.mx"), "ignored");
  await writeFile(resolve(root, "mesh.config.ts"), source);
  return root;
}
test("recursive discovery includes hidden paths and node_modules deterministically", async () => {
  const root = await project();
  const first = await loadConfig(root);
  expect(first.diagnostics).toEqual([]);
  expect(first.config!.resourceFiles).toEqual(
    [".hidden/b", ".secret", "nested/a", "node_modules/pkg/dep", "z"].map((n) =>
      resolve(root, `resources/${n}.mesh.mx`),
    ),
  );
  expect((await loadConfig(root)).config!.resourceFiles).toEqual(
    first.config!.resourceFiles,
  );
  expect((await loadProject(first.config!)).diagnostics).toEqual([]);
});
test("a folder containing only hidden entity files is not empty", async () => {
  const root = await project();
  await rm(resolve(root, "resources"), { recursive: true });
  await mkdir(resolve(root, "resources"));
  await writeFile(resolve(root, "resources/.only.mesh.mx"), keyed);
  expect((await loadConfig(root)).config!.resourceFiles).toHaveLength(1);
});
test("an ordinary .mx file does not satisfy discovery", async () => {
  const root = await project();
  await rm(resolve(root, "resources"), { recursive: true });
  await mkdir(resolve(root, "resources"));
  await writeFile(resolve(root, "resources/old.mx"), keyed);
  expect((await loadConfig(root)).diagnostics[0]?.message).toContain(
    "matches no files",
  );
});
test("absent opaque fields stay absent", async () => {
  const config = (await loadConfig(await project())).config!;
  expect(Object.hasOwn(config, "data")).toBe(false);
  expect(Object.hasOwn(config, "extensions")).toBe(false);
});
test.each(["null", "undefined"])(
  "opaque data %s preserves presence",
  async (value) => {
    const result = await loadConfig(
      await project(
        `export default { resources:"resources", output:"generated", data:${value}, extensions:[] }`,
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(Object.hasOwn(result.config!, "data")).toBe(true);
    expect(result.config!.data).toBe(value === "null" ? null : undefined);
    expect(result.config!.extensions).toEqual([]);
  },
);
test.each(['"opaque"', "false", "123", "{}", "null", "undefined"])(
  "non-array extensions %s fail",
  async (value) => {
    const result = await loadConfig(
      await project(
        `export default { resources:"resources", output:"generated", extensions:${value} }`,
      ),
    );
    expect(result.config).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({
      code: "MESH_CONFIG",
      message: "Configuration field `extensions` must be an array",
    });
  },
);
test("opaque objects/functions/symbols remain identical and unexecuted", async () => {
  const extensions = [
    () => {
      throw new Error("do not call");
    },
    Symbol("opaque"),
    null,
    undefined,
  ];
  const key = `meshSpec_${crypto.randomUUID()}`;
  Object.defineProperty(globalThis, key, {
    value: extensions,
    configurable: true,
  });
  try {
    const result = await loadConfig(
      await project(
        `export default {resources:"resources",output:"generated",extensions:globalThis[${JSON.stringify(key)}]}`,
      ),
    );
    expect(result.config!.extensions).toBe(extensions);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});
test("an empty escaping folder symlink is still rejected", async () => {
  const root = await project(
    'export default {resources:"external",output:"generated"}',
  );
  const outside = await mkdtemp(resolve(tmpdir(), "mesh-outside-"));
  roots.push(outside);
  await symlink(outside, resolve(root, "external"));
  expect((await loadConfig(root)).config).toBeNull();
});
test("configuration identity preserves opaque data", () => {
  const config = {
    resources: "resources",
    output: "generated",
    data: { future: true },
    extensions: ["opaque"],
  };
  expect(defineConfig(config)).toBe(config);
});
