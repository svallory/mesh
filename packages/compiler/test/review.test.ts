import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { isProjectRelativePath, type Diagnostic } from "@mesh/model";
import { buildModel, loadConfig, loadProject } from "../src/index.ts";
import { positionOf } from "../../model/test/source.ts";
import { parse } from "./helpers.ts";

const keyed = 'resource="post"\n  attributes\n    uuid-primary-key="id"\n';
const build = (source: string, file = "post.mx") => buildModel({ root: "/project", files: [{ file, source }] });
function exact(d: Diagnostic | undefined, code: string, message: string, source: string, file: string, token: string, nth = 0) {
  expect(d).toMatchObject({ code, message, position: positionOf(source, file, token, nth) });
}
function relativeDiagnostics(diagnostics: Diagnostic[], root: string) {
  expect(JSON.stringify(diagnostics)).not.toContain(root);
  for (const d of diagnostics) expect(isProjectRelativePath(d.position.file)).toBe(true);
}

test.each(['["a"]', 'null', '[{}]'])("H1: duplicate one_of key rejects overwritten %s at the second key", (first) => {
  const source = keyed + `    attribute="x" type="atom" constraints={one_of:${first},one_of:["b"]} default="b"\n`;
  const result = build(source);
  expect(result.document).toBeNull();
  exact(result.diagnostics[0], "MX", '`<attribute>`: `constraints` has a duplicate key "one_of"', source, "post.mx", "one_of", 1);
});

test("M1: MX failure, unsupported Mesh failure and clean resource still run all parsed checks", () => {
  const bad = 'resourse="bad"\n';
  const mesh = 'resource="post"\n  attributes\n  relationships\n  actions\n    create="save" accept=["missing"]\n';
  const result = buildModel({ root: "/project", files: [{ file: "syntax.mx", source: bad }, { file: "mesh.mx", source: mesh }, { file: "clean.mx", source: keyed }] });
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => d.code)).toEqual(["MX", "MESH_NOT_IMPLEMENTED", "MESH_PRIMARY_KEY", "MESH_UNKNOWN_ACCEPT", "MESH_DUPLICATE_RESOURCE"]);
  exact(result.diagnostics[1], "MESH_NOT_IMPLEMENTED", "Tag `relationships` is not implemented; it will be implemented in M7", mesh, "mesh.mx", "relationships");
  exact(result.diagnostics[2], "MESH_PRIMARY_KEY", "Resource must declare a primary key; declare `uuid-primary-key`", mesh, "mesh.mx", '"post"');
  exact(result.diagnostics[3], "MESH_UNKNOWN_ACCEPT", 'Unknown attribute "missing" in `accept`', mesh, "mesh.mx", '"missing"');
  exact(result.diagnostics[4], "MESH_DUPLICATE_RESOURCE", 'Duplicate resource name "post"', keyed, "clean.mx", '"post"');
});

test.each(["../outside/post.mx", "/outside/post.mx", String.raw`C:\outside\post.mx`, String.raw`\\server\share\post.mx`])("M2: direct builder rejects outside/portable-absolute path %s", (file) => {
  const result = build(keyed, file);
  expect(result.document).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_RESOURCE_PATH", message: "Resource file path must resolve inside the project", position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 } });
  relativeDiagnostics(result.diagnostics, "/project");
});
test.each([String.raw`resources\post.mx`, "/project/resources/post.mx"])("M2: direct builder normalizes in-project path %s", (file) => {
  const result = build(keyed, file);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.resources[0]!.name.position.file).toBe("resources/post.mx");
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project(resources: string | string[] = ["resources/post.mx"], output = "generated") {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-review-")); roots.push(root);
  await mkdir(resolve(root, "resources"));
  await writeFile(resolve(root, "resources/post.mx"), keyed);
  const source = `export default {\n  resources: ${JSON.stringify(resources)},\n  output: ${JSON.stringify(output)}\n};\n`;
  await writeFile(resolve(root, "mesh.config.ts"), source);
  return { root, source };
}
test("M2: config normalizes backslash separators before file/glob/output resolution", async () => {
  const { root } = await project([String.raw`resources\post.mx`], String.raw`generated\nested`);
  let result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
  expect(result.config!.resourceFiles).toEqual([resolve(root, "resources/post.mx")]);
  expect(result.config!.output).toBe(resolve(root, "generated/nested"));
  await writeFile(resolve(root, "mesh.config.ts"), `export default { resources: ${JSON.stringify(String.raw`resources\*.mx`)}, output: "generated" }`);
  result = await loadConfig(root);
  expect(result.diagnostics).toEqual([]);
});
test.each([String.raw`C:\outside`, String.raw`\\server\share`, String.raw`..\outside`])("M2: config rejects portable escaping output %s", async (directory) => {
  const { root, source } = await project(undefined, directory);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  exact(result.diagnostics[0], "MESH_CONFIG", "Configuration field `output` must name a directory inside the project, not the project root", source, "mesh.config.ts", "output");
  relativeDiagnostics(result.diagnostics, root);
});
test.each([String.raw`..\outside\*.mx`, "{resources,../outside}/*.mx", "resources/../../outside/*.mx"])("M2: config rejects escaping resource glob %s", async (glob) => {
  const { root, source } = await project(glob);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  exact(result.diagnostics[0], "MESH_CONFIG", "Configuration field `resources` must stay inside the project", source, "mesh.config.ts", "resources");
});

test.each(["resource", "output", "missing-output-leaf"])("M3: config rejects outside symlink %s", async (target) => {
  const { root, source } = await project(target === "resource" ? ["external/resources/post.mx"] : undefined, target === "resource" ? "generated" : target === "output" ? "external" : "external/new/nested");
  const other = await mkdtemp(resolve(tmpdir(), "mesh-external-")); roots.push(other);
  await mkdir(resolve(other, "resources")); await writeFile(resolve(other, "resources/post.mx"), keyed);
  await symlink(other, resolve(root, "external"));
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  const field = target === "resource" ? "resources" : "output";
  const message = target === "resource" ? 'Resource path "external/resources/post.mx" resolves outside the project' : "Configuration field `output` resolves outside the project";
  if (target === "output") expect(result.diagnostics[0]).toEqual({
    code: "MESH_OUTPUT_SYMLINK", severity: "error", fix: null,
    message: "Symlink in the output tree; delete or move it and rebuild using real files and directories",
    position: { file: "external", line: 1, column: 0, offset: 0 },
  });
  else exact(result.diagnostics[0], "MESH_CONFIG", message, source, "mesh.config.ts", field);
  relativeDiagnostics(result.diagnostics, root);
});
test("M3: in-project symlinks and a symlinked project root remain valid", async () => {
  const { root } = await project(["alias/post.mx"], "alias/new/output");
  await symlink(resolve(root, "resources"), resolve(root, "alias"));
  const link = `${root}-link`; roots.push(link); await symlink(root, link);
  const result = await loadConfig(link);
  expect(result.diagnostics).toEqual([]);
  expect((await loadProject(result.config!)).diagnostics).toEqual([]);
});

test("M4: missing config has stable exact message with no absolute path", async () => {
  const { root } = await project(); await rm(resolve(root, "mesh.config.ts"));
  const result = await loadConfig(root);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG_READ", message: "Cannot read mesh.config.ts (ENOENT)", position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 } });
  relativeDiagnostics(result.diagnostics, root);
});
test("M4: missing listed resource is positioned at resources without absolute cause", async () => {
  const { root, source } = await project(["resources/missing.mx"]);
  const result = await loadConfig(root);
  exact(result.diagnostics[0], "MESH_CONFIG", 'Cannot read resource file "resources/missing.mx" (ENOENT)', source, "mesh.config.ts", "resources");
  relativeDiagnostics(result.diagnostics, root);
});
test("M4: resource removed after config loading has stable exact read diagnostic", async () => {
  const { root } = await project(); const loaded = await loadConfig(root);
  await rm(resolve(root, "resources/post.mx"));
  const result = await loadProject(loaded.config!);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_RESOURCE_READ", message: 'Cannot read resource file "resources/post.mx" (ENOENT)', position: { file: "resources/post.mx", line: 1, column: 0, offset: 0 } });
  relativeDiagnostics(result.diagnostics, root);
});
test("M4 round 3: config exceptions preserve POSIX path text with a relative diagnostic position", async () => {
  const { root } = await project();
  const message = `Cannot open ${root}/secret.txt`;
  await writeFile(resolve(root, "mesh.config.ts"), `throw new Error(${JSON.stringify(message)});`);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG_LOAD", message: `Cannot load mesh.config.ts: Error: ${message}`, position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 } });
  expect(isProjectRelativePath(result.diagnostics[0]!.position.file)).toBe(true);
});
test.each([
  String.raw`Cannot open \\server\share\secret.txt`,
  "Cannot open resources/post.mx",
  "Cannot open ../resources/post.mx",
])("M4 round 3: config exception message is verbatim: %s", async (message) => {
  const { root } = await project();
  await writeFile(resolve(root, "mesh.config.ts"), `throw new TypeError(${JSON.stringify(message)});`);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG_LOAD", message: `Cannot load mesh.config.ts: TypeError: ${message}`, position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 }, fix: "Fix the config module and export default defineConfig({...})" });
  expect(isProjectRelativePath(result.diagnostics[0]!.position.file)).toBe(true);
});

test.each(["/outside/post.mx", String.raw`C:\outside\post.mx`, String.raw`\\server\share\post.mx`])("M2: config rejects portable absolute resource list item %s", async (file) => {
  const { root, source } = await project([file]);
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  exact(result.diagnostics[0], "MESH_CONFIG", "Resource file path must resolve inside the project", source, "mesh.config.ts", "resources");
  relativeDiagnostics(result.diagnostics, root);
});
test("M3: dangling output symlink is not treated as a future ordinary directory", async () => {
  const { root, source } = await project(undefined, "external/new/nested");
  await symlink(`${root}-missing`, resolve(root, "external"));
  const result = await loadConfig(root);
  expect(result.config).toBeNull();
  exact(result.diagnostics[0], "MESH_CONFIG", "Cannot resolve generated directory (ENOENT)", source, "mesh.config.ts", "output");
  relativeDiagnostics(result.diagnostics, root);
});
test("M4: missing project root is a relative configuration diagnostic", async () => {
  const { root } = await project();
  const result = await loadConfig(resolve(root, "missing"));
  expect(result.config).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG_ROOT", message: "Cannot resolve project root (ENOENT)", position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 } });
  relativeDiagnostics(result.diagnostics, root);
});

test("M5: each non-finite default points at its own token, including later files", () => {
  const source = keyed + '    attribute="x" type="float" default=1e999\n';
  const result = buildModel({ root: "/project", files: [{ file: "a.mx", source: keyed }, { file: "b.mx", source: source.replace('"post"', '"b"') }, { file: "c.mx", source: source.replace('"post"', '"c"') }] });
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(2);
  ["b", "c"].forEach((name, i) => exact(result.diagnostics[i], "MESH_NON_JSON", `Model is not JSON-compatible: $.resources[${i + 1}].attributes[1].default.value`, source.replace('"post"', `"${name}"`), `${name}.mx`, "1e999"));
});
