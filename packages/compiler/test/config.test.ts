import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig, loadConfig, loadProject } from "../src/index.ts";
import { keyed } from "./v4.ts";
const data = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: "app.db" } } as const;
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
test("seams are accepted: the three seam names, each a function", async () => {
  const root = await project(`export default { domain: "src/domain", output: ".mesh", data: ${adapter}, seams: { beforeTransaction() {}, afterWrite: async () => {}, afterCommit: () => {} } }`);
  const result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
  expect(result.config).not.toBeNull();
  const none = await project(`export default { domain: "src/domain", output: ".mesh", data: ${adapter}, seams: {} }`);
  expect((await loadConfig(none)).diagnostics).toEqual([]);
});
test.each([
  ["a non-object", "seams: 1", "Configuration field `seams` must be an object of seam functions"],
  ["an array", "seams: []", "Configuration field `seams` must be an object of seam functions"],
  ["null", "seams: null", "Configuration field `seams` must be an object of seam functions"],
  ["a misspelled seam", "seams: { afterwrite() {} }", 'Unknown seam "afterwrite" in configuration field `seams`; the seams are beforeTransaction, afterWrite, afterCommit'],
  ["a seam that is not a function", "seams: { afterCommit: true }", "Seam `afterCommit` in configuration field `seams` must be a function"],
])("seams are rejected with MESH_CONFIG for %s", async (_label, field, message) => {
  const root = await project(`export default { domain: "src/domain", output: ".mesh", data: ${adapter}, ${field} }`);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toMatchObject([{ code: "MESH_CONFIG", message }]);
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
  expect(built.diagnostics.map((d) => d.code)).toEqual(["MESH_ENTITY_READ", "MESH_UNKNOWN_TAG"]);
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
    message: 'Duplicate entity blog.Todo; first declared in src/domain/blog/list.mesh.mx',
  }]);
});
test("duplicate root-level entities name the domain root rather than an empty module", async () => {
  const root = await project(configSource());
  for (const name of ["a", "b"]) await writeFile(resolve(root, `src/domain/${name}.mesh.mx`), keyed);
  const built = await loadProject((await loadConfig(root)).config!);
  expect(built.diagnostics).toMatchObject([{
    code: "MESH_DUPLICATE_ENTITY", position: { file: "src/domain/b.mesh.mx", line: 1, column: 0 },
    message: "Duplicate entity Todo; first declared in src/domain/a.mesh.mx",
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

// The `surfaces` key (`notes/architecture/surfaces-design.md`, PR 1, section 5 "Load"; ruling D41, OD1): a folder only,
// inside the project, scanned as a `domain` folder is; absent, nothing changes.
const surfacesConfig = (surfaces: unknown, extra: Record<string, unknown> = {}) =>
  `export default ${JSON.stringify({ domain: "src/domain", surfaces, output: ".mesh", data, ...extra })}`;
const ADMIN_SURFACE = 'import { Todo } from "../../domain/blog/todo.mesh.mx"\nsurface :admin\n  expose :todos entity=Todo fields=:all\n';
async function withSurface(config: string, file = "src/surfaces/admin/admin.mesh.mx") {
  const root = await project(config);
  await mkdir(resolve(root, file, ".."), { recursive: true });
  await writeFile(resolve(root, file), ADMIN_SURFACE);
  return root;
}
test("surfaces: absent gives no surfacesRoot and no surfaceFiles", async () => {
  const config = (await loadConfig(await project(configSource()))).config!;
  expect(Object.hasOwn(config, "surfacesRoot")).toBe(false);
  expect(Object.hasOwn(config, "surfaceFiles")).toBe(false);
});
test("surfaces: a folder is scanned, and loadProject builds its files into the model", async () => {
  const root = await withSurface(surfacesConfig("src/surfaces"));
  await writeFile(resolve(root, "src/surfaces/admin/notes.md"), "not a surface");
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config).toMatchObject({ surfacesRoot: resolve(root, "src/surfaces"), surfaceFiles: [resolve(root, "src/surfaces/admin/admin.mesh.mx")] });
  expect(loaded.config!.entityFiles).toHaveLength(2);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document!.surfaces).toMatchObject([{ name: "admin", file: "src/surfaces/admin/admin.mesh.mx", expose: [{ entity: "blog.Todo", fields: "all" }] }]);
});
test("surfaces: an empty folder is legal and adds nothing to the model", async () => {
  const root = await project(surfacesConfig("src/surfaces"));
  await mkdir(resolve(root, "src/surfaces"));
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.surfaceFiles).toEqual([]);
  expect(Object.hasOwn((await loadProject(loaded.config!)).document!, "surfaces")).toBe(false);
});
test.each([
  ["an empty string", "", "Configuration field `surfaces` must be a non-empty relative folder"],
  ["a number", 3, "Configuration field `surfaces` must be a non-empty relative folder"],
  ["a list", ["src/surfaces"], "Configuration field `surfaces` must be a non-empty relative folder"],
  ["an absolute path", "/tmp/surfaces", "Configuration field `surfaces` must be a relative folder inside the project"],
  ["a path out of the project", "../surfaces", "Configuration field `surfaces` must be a relative folder inside the project"],
  ["a glob", "src/surfaces/*", "Configuration field `surfaces` must be a relative folder inside the project"],
  ["a missing folder", "src/surfaces", "Configuration field `surfaces` names no folder: src/surfaces"],
  ["a file", "src/domain/blog/todo.mesh.mx", "Configuration field `surfaces` names no folder: src/domain/blog/todo.mesh.mx"],
])("surfaces: %s is MESH_CONFIG", async (_, surfaces, message) => {
  const result = await loadConfig(await project(surfacesConfig(surfaces)));
  expect(result.config).toBeNull();
  expect(result.diagnostics).toMatchObject([{ code: "MESH_CONFIG", message, position: { file: "mesh.config.ts" } }]);
});
test.each([
  ["a folder domain that holds the surfaces folder", { domain: "src" }, "src/surfaces/admin/admin.mesh.mx"],
  ["a glob domain that reaches it", { domain: "src/**/*.mesh.mx" }, "src/surfaces/admin/admin.mesh.mx"],
])("surfaces: %s overlaps", async (_, fields, shared) => {
  const result = await loadConfig(await withSurface(surfacesConfig("src/surfaces", fields)));
  expect(result.config).toBeNull();
  expect(result.diagnostics).toMatchObject([{ code: "MESH_CONFIG", message: `Configuration field \`surfaces\` overlaps \`domain\`: ${shared} is read by both`, fix: "Move the surfaces folder out of what `domain` reads, or narrow `domain`" }]);
});
test("surfaces: a domain folder inside the surfaces folder overlaps", async () => {
  const root = await project(surfacesConfig("src", { domain: "src/domain" }));
  const result = await loadConfig(root);
  expect(result.diagnostics).toMatchObject([{ code: "MESH_CONFIG", message: "Configuration field `surfaces` overlaps `domain`: src/domain/blog/list.mesh.mx is read by both" }]);
});
test("surfaces: a list domain whose common parent holds the surfaces folder does not overlap", async () => {
  // The design's case: `domain: ["src/a.mesh.mx"]` makes the domain root `src`, which holds `src/surfaces`; the overlap
  // is checked by file, and the one listed file is not under the surfaces folder.
  const root = await project(surfacesConfig("src/surfaces", { domain: ["src/a.mesh.mx"] }));
  await writeFile(resolve(root, "src/a.mesh.mx"), keyed);
  await mkdir(resolve(root, "src/surfaces/admin"), { recursive: true });
  await writeFile(resolve(root, "src/surfaces/admin/admin.mesh.mx"), 'import { Todo } from "../../a.mesh.mx"\nsurface :admin\n  expose :todos entity=Todo fields=:all\n');
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.domainRoot).toBe(resolve(root, "src"));
  expect(loaded.config!.surfaceFiles).toEqual([resolve(root, "src/surfaces/admin/admin.mesh.mx")]);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document!.surfaces).toMatchObject([{ name: "admin", file: "src/surfaces/admin/admin.mesh.mx", expose: [{ entity: "Todo", fields: "all" }] }]);
});
test("surfaces: a surfaces folder that is a link to a folder outside the project is MESH_CONFIG", async () => {
  const root = await project(surfacesConfig("src/surfaces"));
  const outside = await mkdtemp(resolve(tmpdir(), "mesh-outside-"));
  roots.push(outside);
  await symlink(outside, resolve(root, "src/surfaces"));
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toMatchObject([{ code: "MESH_CONFIG", message: "Configuration field `surfaces` resolves outside the project", position: { file: "mesh.config.ts" } }]);
});
test("surfaces: a surface file that is a link to a file outside the project is MESH_CONFIG", async () => {
  const root = await project(surfacesConfig("src/surfaces"));
  const outside = await mkdtemp(resolve(tmpdir(), "mesh-outside-"));
  roots.push(outside);
  await writeFile(resolve(outside, "admin.mesh.mx"), ADMIN_SURFACE);
  await mkdir(resolve(root, "src/surfaces/admin"), { recursive: true });
  await symlink(resolve(outside, "admin.mesh.mx"), resolve(root, "src/surfaces/admin/admin.mesh.mx"));
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toMatchObject([{ code: "MESH_CONFIG", message: 'Surface file "src/surfaces/admin/admin.mesh.mx" resolves outside the project', position: { file: "mesh.config.ts" } }]);
});
test("surfaces: undefined is treated as absent, as `ignore` is", async () => {
  const root = await project('export default { domain: "src/domain", surfaces: undefined, output: ".mesh", data: ' + adapter + " }");
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(Object.hasOwn(loaded.config!, "surfacesRoot")).toBe(false);
  expect(Object.hasOwn(loaded.config!, "surfaceFiles")).toBe(false);
});
test("surfaces: a surface file that cannot be read is named a surface file, with the surfaces fix", async () => {
  const root = await withSurface(surfacesConfig("src/surfaces"));
  const loaded = await loadConfig(root);
  await rm(resolve(root, "src/surfaces/admin/admin.mesh.mx"));
  const built = await loadProject(loaded.config!);
  expect(built.document).toBeNull();
  expect(built.diagnostics).toMatchObject([{
    code: "MESH_ENTITY_READ", message: 'Cannot read surface file "src/surfaces/admin/admin.mesh.mx" (ENOENT)',
    position: { file: "src/surfaces/admin/admin.mesh.mx", line: 1, column: 0 }, fix: "Restore the surface file or fix the surfaces folder",
  }]);
});
test("surfaces: a surface that imports a project file outside both folders is MESH_UNKNOWN_ENTITY", async () => {
  const root = await project(surfacesConfig("src/surfaces"));
  await mkdir(resolve(root, "src/other"), { recursive: true });
  await writeFile(resolve(root, "src/other/y.mesh.mx"), keyed.replace(":Todo", ":Y"));
  await mkdir(resolve(root, "src/surfaces/admin"), { recursive: true });
  await writeFile(resolve(root, "src/surfaces/admin/admin.mesh.mx"), 'import { Y } from "../../other/y.mesh.mx"\nsurface :admin\n  expose :ys entity=Y\n');
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message, d.fix])).toEqual([
    ["src/surfaces/admin/admin.mesh.mx", 1, 0, "MESH_UNKNOWN_ENTITY", "../../other/y.mesh.mx exists but is not under the configured entity directories", null],
  ]);
});
test("surfaces: a surface that imports a domain file `ignore` excludes is MESH_IGNORED_IMPORT", async () => {
  const root = await project(surfacesConfig("src/surfaces", { ignore: "**/list.mesh.mx" }));
  await mkdir(resolve(root, "src/surfaces/admin"), { recursive: true });
  await writeFile(resolve(root, "src/surfaces/admin/admin.mesh.mx"), 'import { List } from "../../domain/blog/list.mesh.mx"\nsurface :admin\n  expose :lists entity=List\n');
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message, d.fix])).toEqual([
    ["src/surfaces/admin/admin.mesh.mx", 1, 0, "MESH_IGNORED_IMPORT", 'src/surfaces/admin/admin.mesh.mx imports ../../domain/blog/list.mesh.mx, which `ignore` in mesh.config.ts excludes (pattern "**/list.mesh.mx"); import a file that is not ignored, or remove the pattern', null],
  ]);
});
test("surfaces: a publishes line naming an event of an ignored file reports the import only", async () => {
  const root = await project(surfacesConfig("src/surfaces", { ignore: "**/todo-done.mesh.mx" }));
  await writeFile(resolve(root, "src/domain/blog/todo-done.mesh.mx"), "event :TodoDone\n  uuid :todoId\n");
  await mkdir(resolve(root, "src/surfaces/admin"), { recursive: true });
  await writeFile(resolve(root, "src/surfaces/admin/admin.mesh.mx"), 'import { TodoDone } from "../../domain/blog/todo-done.mesh.mx"\nsurface :admin\n  publishes\n    TodoDone\n');
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message])).toEqual([
    ["src/surfaces/admin/admin.mesh.mx", 1, 0, "MESH_IGNORED_IMPORT", 'src/surfaces/admin/admin.mesh.mx imports ../../domain/blog/todo-done.mesh.mx, which `ignore` in mesh.config.ts excludes (pattern "**/todo-done.mesh.mx"); import a file that is not ignored, or remove the pattern'],
  ]);
});
test("surfaces: an ignore pattern that matches only a surface file is used and excludes it", async () => {
  const root = await withSurface(surfacesConfig("src/surfaces", { ignore: "src/surfaces/admin/**" }));
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.surfaceFiles).toEqual([]);
  expect(loaded.config!.ignoredFiles).toEqual([{ file: resolve(root, "src/surfaces/admin/admin.mesh.mx"), pattern: "src/surfaces/admin/**" }]);
});
