import { afterAll, beforeAll, expect, test } from "bun:test";
import { lowerSource, routeDialect, discoverDialects } from "@mxlang/core";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MESH_EXTENSIONS } from "../src/front-end/extensions.ts";
import contracts from "../src/front-end/contracts.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

// `meshfw` registers Mesh's dialect for MX tooling (`mx.dialect` in its package.json, MX 0.1.0-alpha.17):
// a project that lists `meshfw` as a direct dependency gets its `.mesh.mx` files routed to the `mesh`
// dialect, which MX loads from `meshfw`'s built `dist/dialect.js`. The projects live under
// `~/tmp/mx-alpha-16/`, never `/tmp`.
const cli = resolve(import.meta.dir, "../../cli");
const base = join(homedir(), "tmp", "mx-alpha-16");
let work = "";

/** A project with the given direct dependencies; `meshfw` is a symlink to the workspace package. */
function project(name: string, dependencies: Record<string, string>): string {
  const root = join(work, name);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, private: true, type: "module", dependencies }));
  if (dependencies.meshfw) symlinkSync(cli, join(root, "node_modules/meshfw"), "dir");
  mkdirSync(join(root, "domain"));
  writeFileSync(join(root, "domain/todo.mesh.mx"), "input\n  string :title\n");
  writeFileSync(join(root, "domain/page.mx"), "<div/>\n");
  return root;
}

beforeAll(() => {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: cli, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`meshfw build failed: ${build.stdout}${build.stderr}`);
  mkdirSync(base, { recursive: true });
  work = mkdtempSync(join(base, "registration-"));
}, 30_000);
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  // `~/tmp/mx-alpha-16/` itself goes too, but only while it is empty: it is not ours to empty.
  try {
    rmdirSync(base);
  } catch {}
});

test("a project that depends on meshfw routes .mesh.mx files to the mesh dialect, and only those", () => {
  const root = project("with-meshfw", { meshfw: "*" });
  const manifest = routeDialect(join(root, "domain/todo.mesh.mx"));
  expect(manifest).toMatchObject({ id: "mesh", name: "Mesh", extensions: [...MESH_EXTENSIONS], packageName: "meshfw" });
  expect(manifest?.module).toBe("./dist/dialect.js");
  expect(routeDialect(join(root, "domain/page.mx"))).toBeUndefined();
  expect(discoverDialects(join(root, "package.json")).map((d) => d.id)).toEqual(["mesh"]);
});

test("a project without meshfw gets no dialect", () => {
  const root = project("without-meshfw", {});
  expect(routeDialect(join(root, "domain/todo.mesh.mx"))).toBeUndefined();
  expect(discoverDialects(join(root, "package.json"))).toEqual([]);
});

test("MX loads the registered module: with no options, the vocabulary, tag rules and strictness are the dialect's", () => {
  const root = project("lowered", { meshfw: "*" });
  const file = join(root, "domain/todo.mesh.mx");
  // Under MX's default `html` rules `input` is void and cannot hold children; `&title` needs Mesh's row; the file is
  // checked against Mesh's contracts (the module's `contracts`), with no `customTags` passed.
  const source = "entity :Todo\n  attributes\n    string :title\n  actions\n    create :open\n      input\n        &title\n";
  const registered = lowerSource(source, file, {});
  expect(registered.diagnostics).toEqual([]);
  const [node] = registered.ir!.body;
  if (node?.kind !== "DelegatedTag") throw new Error(String(node?.kind));
  expect(node.tag.name).toBe("entity");
  // The module carries the vocabulary: a tag outside it is refused with the dialect named, and a top-level input is misplaced.
  expect(lowerSource("bogus :x\n", file, {}).diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["MESH_UNKNOWN_TAG", "`bogus` is not a known tag in the `mesh` dialect"],
  ]);
  // The same file under a project that does not register Mesh is plain MX, which rejects `:title` as a line.
  const plain = join(project("plain", {}), "domain/todo.mesh.mx");
  expect(lowerSource(source, plain, {}).diagnostics.length).toBeGreaterThan(0);
});

test("the module is built JavaScript Node can load, and no TypeScript ships beside it", async () => {
  const dist = join(cli, "dist");
  expect(readdirSync(dist)).toEqual(["dialect.js"]);
  const load = Bun.spawnSync(
    ["node", "--input-type=module", "-e", `const m = await import(${JSON.stringify(join(dist, "dialect.js"))}); console.log(JSON.stringify([m.default.id, m.default.name, m.default.tagRules, m.default.table.valueTriggers[0].id, Object.keys(m.default.nodeTypes)]))`],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(load.stderr.toString()).toBe("");
  expect(JSON.parse(load.stdout.toString())).toEqual(["mesh", "Mesh", "none", "atom-value", ["Atom", "Member"]]);
  // The tarball: the dialect build and the sources, but never the dialect's TypeScript entry.
  const pack = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: cli, stdout: "pipe", stderr: "pipe" });
  const packed = (pack.stdout.toString() + pack.stderr.toString()).split("\n").filter((line) => line.startsWith("packed "));
  expect(packed.some((line) => line.endsWith(" dist/dialect.js"))).toBe(true);
  expect(packed.filter((line) => /dialect/.test(line) && /\.(?:ts|mts|cts|tsx)$/.test(line))).toEqual([]);
  expect(packed.filter((line) => line.includes("dist/") && !line.endsWith(".js"))).toEqual([]);
}, 30_000);

test("the build refuses a manifest whose extensions drift from MESH_EXTENSIONS", async () => {
  const copy = join(work, "drifted-cli");
  mkdirSync(join(copy, "scripts"), { recursive: true });
  mkdirSync(join(copy, "src"));
  symlinkSync(join(cli, "node_modules"), join(copy, "node_modules"), "dir");
  for (const file of ["scripts/build-dialect.ts", "src/dialect.ts"]) writeFileSync(join(copy, file), await Bun.file(join(cli, file)).text());
  const manifest = await Bun.file(join(cli, "package.json")).json();
  manifest.mx.dialect.extensions = [...MESH_EXTENSIONS, ".mesh"];
  writeFileSync(join(copy, "package.json"), JSON.stringify(manifest));
  const build = Bun.spawnSync(["bun", "scripts/build-dialect.ts"], { cwd: copy, stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode).toBe(1);
  expect(build.stderr.toString()).toContain("mx.dialect.extensions");
  // The id is part of the contract too: the value row names the dialect `mesh`.
  manifest.mx.dialect.extensions = [...MESH_EXTENSIONS];
  manifest.mx.dialect.id = "other";
  writeFileSync(join(copy, "package.json"), JSON.stringify(manifest));
  const renamed = Bun.spawnSync(["bun", "scripts/build-dialect.ts"], { cwd: copy, stdout: "pipe", stderr: "pipe" });
  expect(renamed.exitCode).toBe(1);
  expect(renamed.stderr.toString()).toContain('mx.dialect.id must be "mesh"');
}, 30_000);

// The manifest closes Mesh files to the project (since MX 0.1.0-alpha.21): `mxConfigTags: false` takes `mx.tags` and
// `mx.contracts` away, `tagDirs: []` closes `tags/`, and `reservedTags` names the vocabulary so a project cannot redefine it.
// https://github.com/svallory/mx docs: apps/docs/docs/custom-tags/dialects.md ("mxConfigTags", "The manifest fields", "Reserved names").
const manifest = async () => (await Bun.file(join(cli, "package.json")).json()).mx.dialect;

test("the manifest reserves exactly the contracts' keys, closes the project's config and the tags/ directory", async () => {
  const dialect = await manifest();
  expect([...dialect.reservedTags].sort()).toEqual(Object.keys(contracts).sort());
  expect(new Set(dialect.reservedTags).size).toBe(dialect.reservedTags.length);
  expect(dialect.mxConfigTags).toBe(false);
  expect(dialect.tagDirs).toEqual([]);
  // The dialect module carries the same vocabulary.
  expect(Object.keys(MESH_DIALECT.contracts ?? {}).sort()).toEqual(Object.keys(contracts).sort());
});

/** A project whose `package.json` has the given `mx` key and whose extra files are written beside it. */
function configured(name: string, mx: unknown, files: Record<string, string>): string {
  const root = project(name, { meshfw: "*" });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, private: true, type: "module", dependencies: { meshfw: "*" }, mx }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const callCodes = (root: string, file: string, tag: string) =>
  lowerSource(`entity :T\n  ${tag} :x\n`, join(root, "domain", file), {}).diagnostics.map((d) => [d.code, d.message]);

test("a project's mx.tags, mx.contracts and tags/ directory do not reach a .mesh.mx file, and do reach a .mx file", () => {
  const root = configured(
    "closed",
    { tags: [{ dir: "shared" }], contracts: "./contracts.mjs" },
    {
      "shared/widget.mx": "<div/>\n",
      "tags/gadget.mx": "<div/>\n",
      "contracts.mjs": "export default { gizmo: {} };\n",
    },
  );
  for (const tag of ["widget", "gadget", "gizmo"]) {
    // Control: the project's own `.mx` file sees all three definitions (an open vocabulary, so no error at all).
    expect(callCodes(root, "page.mx", tag), `${tag} in .mx`).toEqual([]);
    expect(callCodes(root, "todo.mesh.mx", tag), `${tag} in .mesh.mx`).toEqual([
      ["MESH_UNKNOWN_TAG", `\`${tag}\` is not a known tag in the \`mesh\` dialect`],
    ]);
  }
});

test("a project definition named like a Mesh tag never replaces Mesh's contract", () => {
  const root = configured(
    "shadow",
    { tags: [{ dir: "shared" }], contracts: "./contracts.mjs" },
    { "shared/entity.mx": "<div/>\n", "contracts.mjs": "export default { sort: { attributes: { bogus: { type: 'boolean' } } } };\n" },
  );
  const source = "entity :T\n  attributes\n    string :title\n  actions\n    read :all\n      sort\n        asc &title\n";
  expect(lowerSource(source, join(root, "domain/todo.mesh.mx"), {}).diagnostics).toEqual([]);
});

// MX reports `MX_RESERVED_TAG` (`MESH_RESERVED_TAG` through the dialect's `diagnosticCodes`) for a project's `mx.tags` entry, tag file
// or `mx.contracts` key only in the tools' project scan (the language server, `checkDialectFile`), which this repository does not run. What the compiler's path reaches is a `customTags`
// entry handed to `lowerSource` for a file routed to the dialect: the one place in `packages/` that passes `customTags` on purpose.
test("a customTags entry that names a Mesh vocabulary key is MESH_RESERVED_TAG, naming the dialect", () => {
  const root = project("reserved", { meshfw: "*" });
  const file = join(root, "domain/todo.mesh.mx");
  for (const name of ["entity", "sort", "belongs-to"]) {
    const found = lowerSource("entity :T\n", file, { customTags: { [name]: {} } }).diagnostics;
    expect(found.map((d) => [d.code, d.message]), name).toEqual([["MESH_RESERVED_TAG", `\`<${name}>\` cannot be defined by \`customTags\`: Mesh reserves it`]]);
  }
  expect(lowerSource("entity :T\n", file, { customTags: { widget: {} } }).diagnostics.map((d) => d.code)).not.toContain("MESH_RESERVED_TAG");
});

test("lowering a .mesh.mx file with no options is as strict as the compiler was with its options spelled out", () => {
  const root = project("strict", { meshfw: "*" });
  const file = join(root, "domain/todo.mesh.mx");
  const spelled = { structural: "reject", unknownTags: "reject", imports: "pass" } as const;
  const sources: [string, string][] = [
    ["an unknown tag", "entity :T\n  bogus :x\n"],
    ["text", "<div>hello</div>\n"],
    ["an interpolation", "entity :T\n  ${x}\n"],
    ["an if", "<if=true>\n</if>\n"],
    ["a const", "<const/x=1/>\n"],
    ["an export", "export const x = 1\nentity :T\n"],
    ["an import", "import { x } from './x.ts'\nentity :T\n"],
    ["a valid entity", "entity :T\n  attributes\n    string :title\n"],
  ];
  for (const [label, source] of sources) {
    const bare = lowerSource(source, file, {}).diagnostics;
    expect(bare, label).toEqual(lowerSource(source, file, spelled).diagnostics);
    // The dialect passed directly (what the compiler does) says the same as the registered module.
    expect(lowerSource(source, file, { dialect: MESH_DIALECT }).diagnostics, label).toEqual(bare);
  }
  const messages = (source: string) => lowerSource(source, file, {}).diagnostics.map((d) => d.message);
  expect(messages("entity :T\n  bogus :x\n")).toEqual(["`bogus` is not a known tag in the `mesh` dialect"]);
  const static_ = (what: string) => ["Mesh files are static, so they do not evaluate " + what];
  expect(messages("<if=true>\n</if>\n")).toEqual(static_("`if`"));
  expect(messages("<const/x=1/>\n")).toEqual(static_("`const`"));
  expect(messages("export const x = 1\nentity :T\n")).toEqual(static_("`export`"));
  expect(messages("<div>hello</div>\n")).toHaveLength(2);
  expect(messages("entity :T\n  attributes\n    string :title\n")).toEqual([]);
  // `imports: "pass"`: an import is not refused for being an import, although `structural` rejects the rest.
  expect(messages("import { x } from './x.ts'\nentity :T\n")).toEqual([]);
});
