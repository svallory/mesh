import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { buildModel, moduleOfFolder } from "../src/front-end/build.ts";
import { loadConfig, loadProject } from "../src/index.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { configOf } from "./generated.ts";
import { keyed } from "./v4.ts";

const entity = (name: string, extra = "") => `entity :${name}\n  attributes\n    uuid :id primary-key\n${extra}`;
const build = (files: Record<string, string>) =>
  buildModel({
    root: "/project",
    domainRoot: "src/domain",
    files: Object.entries(files).map(([file, source]) => ({ file, source })),
  });
const modules = (files: Record<string, string>) => {
  const result = build(files);
  expect(result.diagnostics).toEqual([]);
  return Object.fromEntries(result.document!.entities.map((e) => [e.name, e.module]));
};
const D = "src/domain";

test.each([
  ["", "", false],
  ["tasks", "tasks", false],
  ["tasks/_services", "tasks", false],
  ["_x", "", false],
  ["tasks/services", "tasks/services", false],
  ["tasks/services/_x", "tasks/services", false],
  ["_a/tasks/_b/services/_c", "tasks/services", false],
  ["tasks/__private", "tasks", false],
  ["tasks/_", "tasks", true],
  ["_/tasks", "tasks", true],
])("moduleOfFolder(%j) is %j (bare underscore: %j)", (folder, module, bareUnderscore) => {
  expect(moduleOfFolder(folder)).toEqual({ module, bareUnderscore });
});

test("a group folder is not part of the module", () => {
  expect(modules({ [`${D}/tasks/_services/scheduling.mesh.mx`]: entity("Scheduling") })).toEqual({ Scheduling: "tasks" });
});
test("a group directly under the domain folder belongs to the domain root", () => {
  expect(modules({ [`${D}/_x/a.mesh.mx`]: entity("A"), [`${D}/b.mesh.mx`]: entity("B") })).toEqual({ A: "", B: "" });
});
test("a plain nested folder is a submodule", () => {
  expect(modules({ [`${D}/tasks/services/x.mesh.mx`]: entity("X"), [`${D}/tasks/y.mesh.mx`]: entity("Y") })).toEqual({ X: "tasks/services", Y: "tasks" });
});
test("a group inside a submodule stays in the submodule", () => {
  expect(modules({ [`${D}/tasks/services/_x/a.mesh.mx`]: entity("A") })).toEqual({ A: "tasks/services" });
});
test("groups nest, and the stripped segment need not be first or last", () => {
  expect(modules({ [`${D}/_a/tasks/_b/_c/x.mesh.mx`]: entity("X") })).toEqual({ X: "tasks" });
});
test("the same entity name across a group is a duplicate", () => {
  const result = build({
    [`${D}/tasks/task.mesh.mx`]: entity("Task"),
    [`${D}/tasks/_x/task.mesh.mx`]: entity("Task"),
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_DUPLICATE_ENTITY" });
  expect(result.diagnostics[0]!.message).toContain('in module "tasks"');
  expect(result.diagnostics[0]!.message).toContain(`${D}/tasks/task.mesh.mx`);
});
test("the same name in a submodule and its parent is not a duplicate", () => {
  expect(modules({ [`${D}/tasks/a.mesh.mx`]: entity("Task"), [`${D}/tasks/services/a.mesh.mx`]: entity("Task") })).toEqual({ Task: "tasks/services" });
});
test("two groups in the root module collide at the root", () => {
  const result = build({ [`${D}/_a/t.mesh.mx`]: entity("T"), [`${D}/_b/t.mesh.mx`]: entity("T") });
  expect(result.diagnostics[0]!.message).toContain("at the domain root");
});
test("a segment that is only an underscore is an error with a clear message", () => {
  const result = build({ [`${D}/tasks/_/a.mesh.mx`]: entity("A") });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_GROUP_NAME" });
  expect(result.diagnostics[0]!.message).toContain('"_"');
  expect(result.diagnostics[0]!.position.file).toBe(`${D}/tasks/_/a.mesh.mx`);
});
test("relative imports keep using real paths through a group", () => {
  const result = build({
    [`${D}/tasks/_x/a.mesh.mx`]: `import { B } from "../b.mesh.mx"\nentity :A\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :b entity=B\n`,
    [`${D}/tasks/b.mesh.mx`]: entity("B"),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities.map((e) => e.module)).toEqual(["tasks", "tasks"]);
});
test("generated paths follow the stripped module", async () => {
  const result = build({
    [`${D}/tasks/_services/scheduling.mesh.mx`]: entity("Scheduling"),
    [`${D}/tasks/services/_x/runner.mesh.mx`]: entity("Runner"),
    [`${D}/_y/top.mesh.mx`]: entity("Top"),
  });
  expect(result.diagnostics).toEqual([]);
  const paths = (await generateFiles({ document: result.document!, config: configOf("/project", ".mesh") })).map((f) => f.path);
  expect(paths).toContain(".mesh/tasks/scheduling.types.ts");
  expect(paths).toContain(".mesh/tasks/services/runner.types.ts");
  expect(paths).toContain(".mesh/top.types.ts");
  expect(paths.some((p) => p.includes("_services") || p.includes("/_x") || p.includes("_y"))).toBe(false);
});

// --- ignore -----------------------------------------------------------------

const adapter = JSON.stringify({ kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: "app.db" } });
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(config: Record<string, unknown>, files: Record<string, string>) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-group-"));
  roots.push(root);
  await writeFile(resolve(root, "mesh.config.ts"), `export default ${JSON.stringify({ domain: "src/domain", output: ".mesh", data: "@@", ...config }).replace('"@@"', adapter)}`);
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await writeFile(resolve(root, file), source);
  }
  return root;
}
const broken = "entity :Broken\n  attributes\n    nonsense :id\n";

test("an ignored file containing an error is not reported", async () => {
  const files = { "src/domain/tasks/task.mesh.mx": entity("Task"), "src/domain/tasks/_wip/broken.mesh.mx": broken };
  const without = await loadConfig(await project({}, files));
  const withoutBuilt = await loadProject(without.config!);
  expect(withoutBuilt.diagnostics.length).toBeGreaterThan(0);

  const root = await project({ ignore: "src/domain/**/_wip/**" }, files);
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.entityFiles).toEqual([resolve(root, "src/domain/tasks/task.mesh.mx")]);
  const built = await loadProject(loaded.config!);
  expect(built.diagnostics).toEqual([]);
  expect(built.document!.entities.map((e) => e.name)).toEqual(["Task"]);
});
test("ignore takes a list, and applies to a domain glob and to explicit lists", async () => {
  const files = { "src/domain/a.mesh.mx": entity("A"), "src/domain/b.mesh.mx": entity("B"), "src/domain/c.mesh.mx": entity("C") };
  for (const domain of ["src/domain", "src/domain/*.mesh.mx", ["src/domain/a.mesh.mx", "src/domain/b.mesh.mx", "src/domain/c.mesh.mx"]]) {
    const root = await project({ domain, ignore: ["**/a.mesh.mx", "./src/domain/b.*"] }, files);
    const loaded = await loadConfig(root);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config!.entityFiles).toEqual([resolve(root, "src/domain/c.mesh.mx")]);
  }
});
test.each([
  [42, "must be a glob or a list of globs"],
  [[""], "must be a glob or a list of globs"],
  [["../outside/**"], "must stay inside the project"],
  ["**", "excludes every entity file"],
])("invalid ignore %j is rejected", async (ignore, message) => {
  const root = await project({ ignore }, { "src/domain/a.mesh.mx": keyed });
  const loaded = await loadConfig(root);
  expect(loaded.config).toBeNull();
  expect(loaded.diagnostics[0]!.message).toContain(message);
});
test("a file imported by a kept file but ignored is reported with its own code, naming file, import and pattern", async () => {
  const root = await project({ ignore: "**/b.mesh.mx" }, {
    "src/domain/a.mesh.mx": `import { B } from "./b.mesh.mx"\nentity :A\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :b entity=B\n`,
    "src/domain/b.mesh.mx": entity("B"),
  });
  const built = await loadProject((await loadConfig(root)).config!);
  const issue = built.diagnostics.find((d) => d.code === "MESH_IGNORED_IMPORT")!;
  expect(issue).toBeDefined();
  expect(issue.message).toContain("src/domain/a.mesh.mx");
  expect(issue.message).toContain("./b.mesh.mx");
  expect(issue.message).toContain('"**/b.mesh.mx"');
  expect(built.diagnostics.some((d) => d.code === "MESH_UNKNOWN_ENTITY")).toBe(false);
});
test("list-form domain: an ignored file does not move the domain root of kept files", async () => {
  const root = await project(
    { domain: ["src/domain/tasks/t.mesh.mx", "src/legacy/l.mesh.mx"], ignore: "src/legacy/**" },
    { "src/domain/tasks/t.mesh.mx": entity("T"), "src/legacy/l.mesh.mx": entity("L") },
  );
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.config!.domainRoot).toBe(resolve(root, "src/domain/tasks"));
  const built = await loadProject(loaded.config!);
  expect(built.document!.entities.map((e) => [e.name, e.module])).toEqual([["T", ""]]);
});
test("an ignore pattern that matches nothing is a warning naming the pattern, not an error", async () => {
  const root = await project({ ignore: ["src/legacy", "**/b.mesh.mx"] }, { "src/domain/a.mesh.mx": entity("A"), "src/domain/b.mesh.mx": entity("B") });
  const loaded = await loadConfig(root);
  expect(loaded.config).not.toBeNull();
  expect(loaded.diagnostics).toHaveLength(1);
  expect(loaded.diagnostics[0]).toMatchObject({ severity: "warning", code: "MESH_IGNORE_UNUSED" });
  expect(loaded.diagnostics[0]!.message).toContain('"src/legacy"');
  expect(loaded.config!.entityFiles).toEqual([resolve(root, "src/domain/a.mesh.mx")]);
});
