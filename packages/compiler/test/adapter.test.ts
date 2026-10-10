import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { RESERVED_COMMAND_WORDS, buildEmitters, generateFiles, generatedImportDiagnostics, loadAdapterBuild, loadConfig, loadProject, loadTemplates, type ResolvedConfig } from "../src/index.ts";
import { keyed } from "./v4.ts";

const fakeAdapter = resolve(import.meta.dir, "fixtures/fake-adapter");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project whose data adapter's build half is `build`, with the fake adapter installed unless `install` is false. */
async function project(build: string, install = true): Promise<ResolvedConfig> {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-adapter-"));
  roots.push(root);
  await mkdir(resolve(root, "domain"));
  await writeFile(resolve(root, "domain/todo.mesh.mx"), keyed);
  await writeFile(resolve(root, "mesh.config.ts"),
    `export default { domain: "domain", output: ".mesh", data: { kind: "data-adapter", name: "fake", build: ${JSON.stringify(build)}, capabilities: { adapter: "fake", capabilities: [] }, options: {} } };\n`);
  if (install) {
    await mkdir(resolve(root, "node_modules"));
    await symlink(fakeAdapter, resolve(root, "node_modules/fake-mesh-adapter"), "dir");
  }
  const loaded = await loadConfig(root);
  expect(loaded.diagnostics).toEqual([]);
  return loaded.config!;
}

const at = { file: "mesh.config.ts", line: 1, column: 0, offset: 0 };

test("an installed build half is loaded and its generator runs after the core ones, with its own template", async () => {
  const config = await project("fake-mesh-adapter/build");
  const { build, diagnostics } = await loadAdapterBuild(config);
  expect(diagnostics).toEqual([]);
  expect(build!.generators.map((generator) => generator.name)).toEqual(["fake-tables"]);
  expect(Object.keys(build!.commands ?? {})).toEqual(["db push"]);
  expect(buildEmitters(build).map((emitter) => emitter.name)).toEqual(["model-json", "types", "validators", "expressions", "load", "actions", "index", "fake-tables"]);
  const { document } = await loadProject(config);
  const files = await generateFiles({ config, document: document! }, build);
  expect(files.map((file) => file.path)).toEqual([".mesh/fake.ts", ".mesh/index.ts", ".mesh/model.json", ".mesh/todo.actions.ts", ".mesh/todo.types.ts", ".mesh/todo.validators.ts"]);
  expect(files[0]!.contents).toBe('// Written by the fake adapter.\nexport const names = ["Todo"];\n');
  // Without the adapter, the core tree is unchanged.
  expect((await generateFiles({ config, document: document! })).map((file) => file.path)).toEqual(files.slice(1).map((file) => file.path));
});

test("a project's .mesh-generators/<template> overrides an adapter template too", async () => {
  const config = await project("fake-mesh-adapter/build");
  const { build } = await loadAdapterBuild(config);
  await mkdir(resolve(config.root, ".mesh-generators"));
  await writeFile(resolve(config.root, ".mesh-generators/fake.ts.jig"), "export const count = {{ names.length }};\n");
  const templates = await loadTemplates(build!.generators, config.root);
  expect(templates.get("fake.ts.jig")!.path).toBe(".mesh-generators/fake.ts.jig");
  const { document } = await loadProject(config);
  const files = await generateFiles({ config, document: document! }, build);
  expect(files.find((file) => file.path === ".mesh/fake.ts")!.contents).toBe("export const count = 1;\n");
});

test("without an override the adapter template is read from the generator's templateDir", async () => {
  const config = await project("fake-mesh-adapter/build");
  const { build } = await loadAdapterBuild(config);
  const templates = await loadTemplates(build!.generators, config.root);
  expect(templates.get("fake.ts.jig")!.path).toBe(resolve(fakeAdapter, "templates/fake.ts.jig"));
});

test("an adapter generator writing a core path is the existing ownership error", async () => {
  const config = await project("fake-mesh-adapter/clash");
  const { build, diagnostics } = await loadAdapterBuild(config);
  expect(diagnostics).toEqual([]);
  const { document } = await loadProject(config);
  await expect(generateFiles({ config, document: document! }, build)).rejects.toThrow('Emitters "model-json" and "clashing" both write ".mesh/model.json"');
});

test("adapter generators' requires join the generated-import preflight", async () => {
  const config = await project("fake-mesh-adapter/build");
  const { build } = await loadAdapterBuild(config);
  const generator = { ...build!.generators[0]!, requires: ["not-installed-anywhere"] };
  expect(generatedImportDiagnostics(config.root, buildEmitters({ generators: [generator] })).map((d) => d.message)).toContain(
    'generated code imports "not-installed-anywhere", which is not installed in this project. Run: bun add not-installed-anywhere');
});

const unresolved = (specifier: string, pkg: string) =>
  `the data adapter's build entry "${specifier}" cannot be resolved from this project: either ${pkg} is not installed, or the installed version does not export "${specifier}". Run: bun add ${pkg}`;
test.each([
  // Not installed at all, unscoped and scoped.
  ["fake-mesh-adapter/build", false, "fake-mesh-adapter"],
  ["@acme/mesh-data/build", false, "@acme/mesh-data"],
  // Installed, but this version has no such export.
  ["fake-mesh-adapter/missing-build", true, "fake-mesh-adapter"],
] as const)("MESH_ADAPTER_BUILD: %s cannot be resolved (installed: %s); the message names both causes", async (specifier, install, pkg) => {
  const config = await project(specifier, install);
  expect(await loadAdapterBuild(config)).toEqual({ build: null, diagnostics: [{
    severity: "error", code: "MESH_ADAPTER_BUILD", message: unresolved(specifier, pkg), position: at,
    fix: "Install the package of the data adapter that mesh.config.ts names, in a version that has this build entry",
  }] });
});

test.each([
  ["fake-mesh-adapter/no-default", "has no default export of an AdapterBuild object"],
  ["fake-mesh-adapter/not-generators", "default export has no `generators` array"],
  ["fake-mesh-adapter/throws", "cannot be loaded: Error: adapter exploded"],
])("MESH_ADAPTER_BUILD: %s is not a valid build half", async (specifier, problem) => {
  const config = await project(specifier);
  const { build, diagnostics } = await loadAdapterBuild(config);
  expect(build).toBeNull();
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "MESH_ADAPTER_BUILD", position: at, message: `the data adapter's build entry "${specifier}" ${problem}` });
});

const V = "views() { return []; }";
test.each([
  ["{ generators: [null] }", "generators[0] is not a generator object"],
  ['{ generators: [{ template: "x.ts.jig" }] }', "generators[0] has no `name` string"],
  [`{ generators: [{ name: "g", template: "sub/x.ts.jig", ${V}, templateDir: "/t" }] }`, 'generators[0] ("g") needs `template`, a file name without a folder'],
  ['{ generators: [{ name: "g", template: "x.ts.jig", templateDir: "/t" }] }', 'generators[0] ("g") has no `views` function'],
  [`{ generators: [{ name: "g", template: "x.ts.jig", ${V} }] }`, 'generators[0] ("g") needs `templateDir`, the absolute folder of its template'],
  [`{ generators: [{ name: "g", template: "x.ts.jig", ${V}, templateDir: "templates" }] }`, 'generators[0] ("g") needs `templateDir`, the absolute folder of its template'],
  [`{ generators: [{ name: "g", template: "types.ts.jig", ${V}, templateDir: "/t" }] }`, 'generators[0] ("g") reuses the template name "types.ts.jig"; each template has one .mesh-generators/ file'],
  [`{ generators: [{ name: "g", template: "x.ts.jig", ${V}, templateDir: "/t" }, { name: "h", template: "x.ts.jig", ${V}, templateDir: "/u" }] }`, 'generators[1] ("h") reuses the template name "x.ts.jig"; each template has one .mesh-generators/ file'],
  ["{ generators: [], commands: [] }", "`commands` is not an object"],
  ['{ generators: [], commands: { "db  push": async () => 0 } }', 'command "db  push" is not lowercase words separated by single spaces'],
  ['{ generators: [], commands: { "--force": async () => 0 } }', 'command "--force" is not lowercase words separated by single spaces'],
  ['{ generators: [], commands: { "db push": "push" } }', 'command "db push" is not a function'],
  ...RESERVED_COMMAND_WORDS.map((word) => [`{ generators: [], commands: { "${word} all": async () => 0 } }`, `command "${word} all" starts with "${word}", which the mesh command reserves`]),
  ['{ generators: [], commands: { "migrate": async () => 0 } }', 'command "migrate" starts with "migrate", which the mesh command reserves'],
])("MESH_ADAPTER_BUILD: shape %s", async (shape, problem) => {
  const config = await project("./adapter.ts", false);
  await writeFile(resolve(config.root, "adapter.ts"), `export default ${shape};\n`);
  const { diagnostics } = await loadAdapterBuild(config);
  expect(diagnostics.map((d) => d.message)).toEqual([`the data adapter's build entry "./adapter.ts" ${problem}`]);
});

test("the reserved words are the core commands and the scheduled ones", () => {
  expect([...RESERVED_COMMAND_WORDS].sort()).toEqual(["build", "explain", "export", "help", "init", "inspect", "migrate"]);
});

test("a valid inline build half with commands and no generators loads", async () => {
  const config = await project("./adapter.ts", false);
  await writeFile(resolve(config.root, "adapter.ts"), 'export default { generators: [], commands: { "db push": async () => 0, "db reset-all": async () => 0 } };\n');
  const { build, diagnostics } = await loadAdapterBuild(config);
  expect(diagnostics).toEqual([]);
  expect(Object.keys(build!.commands!)).toEqual(["db push", "db reset-all"]);
});
