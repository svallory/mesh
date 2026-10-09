import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { keyed } from "./v4.ts";
const data = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", options: { file: "app.db" } } as const;
const adapter = JSON.stringify(data);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(config?: string) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-config-"));
  roots.push(root);
  await mkdir(resolve(root, "src/domain/blog"), { recursive: true });
  await writeFile(resolve(root, "src/domain/blog/todo.mesh.mx"), keyed);
  await writeFile(resolve(root, "src/domain/blog/list.mesh.mx"), keyed.replace(":Todo", ":List"));
  await writeFile(resolve(root, "src/domain/blog/old.mx"), "not discovered");
  await writeFile(resolve(root, "src/domain/blog/post.pending.mesh.mx.txt"), "not discovered");
  if (config !== undefined) await writeFile(resolve(root, "mesh.config.ts"), config);
  return root;
}
const configSource = (domain: string | string[] = "src/domain") => `export default ${JSON.stringify({ domain, output: ".mesh", data })}`;

test("defineConfig is an identity", () => {
  const config = { domain: "src/domain", output: ".mesh", data };
  expect(defineConfig(config)).toBe(config);
});
test("missing config is positioned with a fix", async () => {
  expect((await loadConfig(await project())).diagnostics[0]).toMatchObject({
    code: "MESH_CONFIG_READ", position: { file: "mesh.config.ts", line: 1, column: 0 },
    fix: "Create mesh.config.ts with domain, output and data",
  });
});
test("domain discovers only .mesh.mx, deterministically, and records only adapter identity", async () => {
  const root = await project(configSource());
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.entityFiles).toEqual([
    resolve(root, "src/domain/blog/list.mesh.mx"), resolve(root, "src/domain/blog/todo.mesh.mx"),
  ]);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document!.entities.map((e) => e.name)).toEqual(["List", "Todo"]);
  expect(built.document!.data).toEqual({ name: "sqlite" });
  expect(JSON.stringify(built.document)).not.toContain("app.db");
});
test("explicit list deduplicates and config reload reflects edits", async () => {
  const root = await project(configSource(["src/domain/blog/todo.mesh.mx", "src/domain/blog/todo.mesh.mx"]));
  const first = (await loadConfig(root)).config!;
  expect(first.entityFiles).toHaveLength(1);
  expect(first.output).toBe(resolve(root, ".mesh"));
  await writeFile(
    resolve(root, "mesh.config.ts"),
    `export default ${JSON.stringify({ domain: "src/domain/**/*.mesh.mx", output: "output", data })}`,
  );
  const reloaded = (await loadConfig(root)).config!;
  expect(reloaded.entityFiles).toHaveLength(2);
  expect(reloaded.output).toBe(resolve(root, "output"));
});
test.each([
  "export default null", "export default []",
  `export default {output:".mesh", data:${adapter}}`,
  ...[
    { domain: [] }, { domain: 12 }, { output: false }, { extra: 1 },
    { domain: ["src/domain/blog/old.mx"] }, { domain: "nope/*.mesh.mx" },
    { domain: ["missing.mesh.mx"] }, { domain: ["src/domain"] },
    { output: ".." }, { output: "." }, { domain: ["../outside.mesh.mx"] },
  ].map((fields) => `export default ${JSON.stringify({ domain: "src/domain", output: ".mesh", data, ...fields })}`),
  'throw new Error("broken config");',
])("rejects malformed/escaping config %s", async (source) => {
  const root = await project(source);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics.every((d) => d.position.file === "mesh.config.ts")).toBe(true);
  expect(JSON.stringify(result.diagnostics)).not.toContain(root);
});
test("the removed resources key has its exact rename hint", async () => {
  const root = await project(`export default { resources: "src/domain", domain: "src/domain", output: ".mesh", data: ${adapter} }`);
  expect((await loadConfig(root)).diagnostics).toMatchObject([{
    code: "MESH_CONFIG", message: 'Unknown configuration field "resources"',
    fix: "`resources` was renamed `domain`", position: { line: 1, column: 17 },
  }]);
});
test.each(["undefined", "null", "false", "[]", '"sqlite"', "{}", '{kind:"wrong",name:"sqlite",options:{}}', '{kind:"data-adapter",name:"",options:{}}', '{kind:"data-adapter",name:"sqlite",build:"@meshfw/data-sqlite/build",options:[]}', '{kind:"data-adapter",name:"sqlite",options:{}}', '{kind:"data-adapter",name:"sqlite",build:"",options:{}}', '{kind:"data-adapter",name:"sqlite",build:3,options:{}}']) (
  "invalid data %s names its positioned key and adapter import hint", async (value) => {
    const root = await project(`export default {\n  domain: "src/domain", output: ".mesh",\n  data: ${value}\n}`);
    expect((await loadConfig(root)).diagnostics).toMatchObject([{
      code: "MESH_CONFIG", position: { file: "mesh.config.ts", line: 3, column: 2 },
      message: "Configuration field `data` must be a data adapter descriptor",
      fix: 'Import `sqlite` from `@meshfw/data-sqlite` and set data: sqlite({ file: "app.db" })',
    }]);
  },
);
test("missing data is a configuration error", async () => {
  const loaded = await loadConfig(await project('export default {domain:"src/domain",output:".mesh"}'));
  expect(loaded.diagnostics[0]?.message).toContain("`data`");
  expect(loaded.config).toBeNull();
});
test("collects independent field errors", async () => {
  const loaded = await loadConfig(await project("export default {domain:false,output:10,extra:true}"));
  expect(loaded.diagnostics).toHaveLength(4);
});
test("collects read and parse errors without throwing", async () => {
  const root = await project(configSource());
  const loaded = await loadConfig(root);
  await rm(resolve(root, "src/domain/blog/list.mesh.mx"));
  await writeFile(resolve(root, "src/domain/blog/todo.mesh.mx"), "enttiy :Todo\n");
  const built = await loadProject(loaded.config!);
  expect(built.document).toBeNull();
  expect(built.diagnostics.map((d) => d.code)).toEqual(["MESH_ENTITY_READ", "MESH_SYNTAX"]);
});

test.each(["folder", "glob", "list"])("%s domain derives root-level and nested modules", async (mode) => {
  const paths = ["src/domain/root.mesh.mx", "src/domain/sales/billing/invoice.mesh.mx"];
  const domain = mode === "folder" ? "src/domain" : mode === "glob" ? "src/domain/**/*.mesh.mx" : paths;
  const root = await project(configSource(domain));
  await mkdir(resolve(root, "src/domain/sales/billing"), { recursive: true });
  for (const file of paths) await writeFile(resolve(root, file), keyed);
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.domainRoot).toBe(resolve(root, "src/domain"));
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document!.entities.filter((e) => paths.some((p) => p === e.file)).map((e) => e.module)).toEqual(["", "sales/billing"]);
});
test("duplicate entity names within a module name the first file on the second entity line", async () => {
  const root = await project(configSource());
  await writeFile(resolve(root, "src/domain/blog/list.mesh.mx"), keyed);
  const built = await loadProject((await loadConfig(root)).config!);
  expect(built.diagnostics).toMatchObject([{
    code: "MESH_DUPLICATE_ENTITY", position: { file: "src/domain/blog/todo.mesh.mx", line: 1, column: 0 },
    message: 'Duplicate entity :Todo in module "blog"; first declared in src/domain/blog/list.mesh.mx',
  }]);
});
test("duplicate root-level entities name the domain root rather than an empty module", async () => {
  const root = await project(configSource());
  for (const name of ["a", "b"]) await writeFile(resolve(root, `src/domain/${name}.mesh.mx`), keyed);
  const built = await loadProject((await loadConfig(root)).config!);
  expect(built.diagnostics).toMatchObject([{
    code: "MESH_DUPLICATE_ENTITY", position: { file: "src/domain/b.mesh.mx", line: 1, column: 0 },
    message: "Duplicate entity :Todo at the domain root; first declared in src/domain/a.mesh.mx",
  }]);
});
test("invalid module segment is positioned on the entity line", async () => {
  const root = await project(configSource());
  await mkdir(resolve(root, "src/domain/bad.name"));
  await writeFile(resolve(root, "src/domain/bad.name/todo.mesh.mx"), keyed);
  const built = await loadProject((await loadConfig(root)).config!);
  expect(built.diagnostics).toMatchObject([{
    code: "MESH_MODULE_NAME", position: { file: "src/domain/bad.name/todo.mesh.mx", line: 1, column: 0 },
    message: 'Module segment "bad.name" must contain only letters, digits, - or _',
  }]);
});
