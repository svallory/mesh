import { afterAll, beforeAll, expect, test } from "bun:test";
import { lowerSource, routeDialect, discoverDialects } from "@mxlang/core";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MESH_EXTENSIONS } from "../src/front-end/extensions.ts";
import contracts from "../src/front-end/contracts.ts";

// `meshfw` registers Mesh's dialect for MX tooling (`mx.dialect` in its package.json, MX 0.1.0-alpha.16):
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
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

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

test("MX loads the registered module: with no dialect option, tag rules are none and the member sigil lowers", () => {
  const root = project("lowered", { meshfw: "*" });
  const file = join(root, "domain/todo.mesh.mx");
  // Under MX's default `html` rules `input` is void and cannot hold children; `&title` needs Mesh's row.
  const registered = lowerSource("input\n  string :title\n  &title=1\n", file, { customTags: undefined });
  expect(registered.diagnostics).toEqual([]);
  const [node] = registered.ir!.body;
  if (node?.kind !== "DelegatedTag") throw new Error(String(node?.kind));
  expect(node.tag.name).toBe("input");
  expect(node.tag.children.length).toBeGreaterThan(0);
  // The same file under a project that does not register Mesh is plain MX, which rejects `:title` as a line.
  const plain = join(project("plain", {}), "domain/todo.mesh.mx");
  expect(lowerSource("input\n  string :title\n", plain, {}).diagnostics.length).toBeGreaterThan(0);
});

test("the module is built JavaScript Node can load, and no TypeScript ships beside it", async () => {
  const dist = join(cli, "dist");
  expect(readdirSync(dist)).toEqual(["dialect.js"]);
  const load = Bun.spawnSync(
    ["node", "--input-type=module", "-e", `const m = await import(${JSON.stringify(join(dist, "dialect.js"))}); console.log(JSON.stringify([m.default.id, m.default.name, m.default.tagRules, m.default.table.valueTriggers[0].id, Object.keys(m.default.nodeTypes)]))`],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(load.stderr.toString()).toBe("");
  expect(JSON.parse(load.stdout.toString())).toEqual(["mesh", "Mesh", "none", "atom-value", ["Atom"]]);
  // The tarball: the dialect build and the sources, but never the dialect's TypeScript entry.
  const pack = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: cli, stdout: "pipe", stderr: "pipe" });
  const packed = (pack.stdout.toString() + pack.stderr.toString()).split("\n").filter((line) => line.startsWith("packed "));
  expect(packed.some((line) => line.endsWith(" dist/dialect.js"))).toBe(true);
  expect(packed.filter((line) => /dialect/.test(line) && /\.(?:ts|mts|cts|tsx)$/.test(line))).toEqual([]);
  expect(packed.filter((line) => line.includes("dist/") && !line.endsWith(".js"))).toEqual([]);
});

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
});

test("mx.contracts stays on @meshfw/compiler and is the only mx key there", async () => {
  const compiler = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(compiler.mx).toEqual({ contracts: "./src/front-end/contracts.ts" });
  expect(contracts).toBeDefined();
});
