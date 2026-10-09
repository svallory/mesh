import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { isProjectRelativePath } from "@meshfw/model";
import { buildModel, loadConfig, loadProject } from "../src/index.ts";
import { keyed } from "./v4.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function project(
  domain: string | string[] = ["domain/todo.mesh.mx"],
  output = "generated",
) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-review-"));
  roots.push(root);
  await mkdir(resolve(root, "domain"));
  await writeFile(resolve(root, "domain/todo.mesh.mx"), keyed);
  await writeFile(
    resolve(root, "mesh.config.ts"),
    `export default {domain:${JSON.stringify(domain)},output:${JSON.stringify(output)},data:{kind:"data-adapter",name:"sqlite",build: "@meshfw/data-sqlite/build", options:{file:":memory:"}}}`,
  );
  return root;
}
test.each([
  "../outside.mesh.mx",
  "/outside.mesh.mx",
  String.raw`C:\outside\todo.mesh.mx`,
  String.raw`\\server\share\todo.mesh.mx`,
])("builder rejects escaping path %s", (file) => {
  const result = buildModel({
    root: "/project",
    files: [{ file, source: keyed }],
  });
  expect(result.document).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({
    code: "MESH_ENTITY_PATH",
    position: { file: "mesh.config.ts" },
  });
});
test.each([String.raw`domain\todo.mesh.mx`, "/project/domain/todo.mesh.mx"])(
  "builder normalizes inside path %s",
  (file) => {
    expect(
      buildModel({ root: "/project", files: [{ file, source: keyed }] })
        .document!.entities[0]!.file,
    ).toBe("domain/todo.mesh.mx");
  },
);
test("config normalizes portable separators", async () => {
  const root = await project(
    [String.raw`domain\todo.mesh.mx`],
    String.raw`generated\nested`,
  );
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.entityFiles).toEqual([
    resolve(root, "domain/todo.mesh.mx"),
  ]);
  expect(loaded.config!.output).toBe(resolve(root, "generated/nested"));
});
test.each([
  String.raw`C:\outside`,
  String.raw`\\server\share`,
  String.raw`..\outside`,
  ".",
])("rejects output %s", async (output) => {
  expect(
    (await loadConfig(await project(undefined, output))).config,
  ).toBeNull();
});
test.each([
  String.raw`..\outside\*.mesh.mx`,
  "{domain,../outside}/*.mesh.mx",
  "domain/../../*.mesh.mx",
])("rejects escaping glob %s", async (glob) => {
  expect(
    (await loadConfig(await project(glob))).diagnostics[0]?.message,
  ).toContain("must stay inside");
});
test.each([
  "/outside.mesh.mx",
  String.raw`C:\outside.mesh.mx`,
  String.raw`\\server\share\outside.mesh.mx`,
])("rejects absolute list item %s", async (file) => {
  expect((await loadConfig(await project([file]))).config).toBeNull();
});
test.each(["input", "output", "future-output"])(
  "rejects outside symlink: %s",
  async (kind) => {
    const root = await project(
      kind === "input" ? ["external/domain/todo.mesh.mx"] : undefined,
      kind === "output"
        ? "external"
        : kind === "future-output"
          ? "external/new/nested"
          : "generated",
    );
    const outside = await project();
    await symlink(outside, resolve(root, "external"));
    const loaded = await loadConfig(root);
    expect(loaded.config).toBeNull();
    expect(JSON.stringify(loaded.diagnostics)).not.toContain(outside);
    expect(
      loaded.diagnostics.every((d) => isProjectRelativePath(d.position.file)),
    ).toBe(true);
  },
);
test("in-project links and symlinked project root remain valid", async () => {
  const root = await project(["alias/todo.mesh.mx"], "alias/new/output");
  await symlink(resolve(root, "domain"), resolve(root, "alias"));
  const link = `${root}-link`;
  roots.push(link);
  await symlink(root, link);
  const loaded = await loadConfig(link);
  expect(loaded.diagnostics).toEqual([]);
  expect((await loadProject(loaded.config!)).diagnostics).toEqual([]);
});
test("dangling output ancestor is not a future ordinary directory", async () => {
  const root = await project(undefined, "external/new/nested");
  await symlink(`${root}-missing`, resolve(root, "external"));
  expect((await loadConfig(root)).config).toBeNull();
});
test("missing root and removed entity file are diagnosed", async () => {
  const root = await project();
  const loaded = await loadConfig(root);
  await rm(resolve(root, "domain/todo.mesh.mx"));
  expect((await loadProject(loaded.config!)).diagnostics[0]?.code).toBe(
    "MESH_ENTITY_READ",
  );
  expect(
    (await loadConfig(resolve(root, "missing"))).diagnostics[0]?.code,
  ).toBe("MESH_CONFIG_ROOT");
});
test.each([
  String.raw`Cannot open \\server\share\secret.txt`,
  "Cannot open ../todo.mesh.mx",
  "Cannot open /absolute/file",
])("config exception text remains verbatim: %s", async (message) => {
  const root = await project();
  await writeFile(
    resolve(root, "mesh.config.ts"),
    `throw new TypeError(${JSON.stringify(message)})`,
  );
  expect((await loadConfig(root)).diagnostics[0]).toMatchObject({
    code: "MESH_CONFIG_LOAD",
    message: `Cannot load mesh.config.ts: TypeError: ${message}`,
    position: { file: "mesh.config.ts" },
  });
});
test("imports cannot escape physically or lexically", async () => {
  const root = await project();
  const outside = await project();
  await symlink(outside, resolve(root, "external"));
  for (const from of [
    "../../missing.mesh.mx",
    "../external/domain/todo.mesh.mx",
  ]) {
    const source = `import { List } from ${JSON.stringify(from)}\n${keyed}`;
    const result = buildModel({
      root,
      files: [{ file: "domain/todo.mesh.mx", source }],
    });
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "MESH_UNKNOWN_IMPORT",
    );
  }
});
