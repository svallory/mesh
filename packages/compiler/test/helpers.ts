import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IrDiagnostic } from "@mxlang/core";
import { parseEntitySource } from "../src/front-end/build.ts";
import type { ProjectDescription } from "../src/model/index.ts";

export const fixtureDir = new URL("./fixtures/", import.meta.url).pathname;

export function fixture(name: string): { source: string; file: string } {
  const file = `${fixtureDir}${name}`;
  return { source: readFileSync(file, "utf8"), file };
}

/** The compiler's own parse: contracts, `MESH_DIALECT`, structural and unknown-tag rejection on. */
export function parse(source: string, file = "todo/todo.mesh.mx") {
  return parseEntitySource(source, file);
}

export function parseFixture(name: string) {
  const { source, file } = fixture(name);
  return parse(source, file);
}

export type Diag = Pick<IrDiagnostic, "severity" | "line" | "column">;

/**
 * A project on disk whose `package.json` depends on `meshfw` (a symlink to the workspace package), so MX routes its
 * `.mesh.mx` files to Mesh's dialect and scans its `concepts` folders (concepts need files on disk: the scan reads
 * directories). `files` are project-relative; `project` lists every `.mesh.mx` file under `domain` (default
 * `src/domain`) as `buildModel` takes it, minus the paths in `ignored`. The projects live under `~/tmp/mesh-concepts/`,
 * never `/tmp` or the checkout; `dispose` removes one. Call `buildDialect()` first: MX runs the hook of the built
 * `dist/dialect.js`.
 */
export function conceptProject(
  files: Record<string, string>,
  options: { domain?: string; ignored?: readonly string[] } = {},
): { root: string; project: ProjectDescription; dispose: () => void } {
  mkdirSync(join(homedir(), "tmp", "mesh-concepts"), { recursive: true });
  const root = mkdtempSync(join(homedir(), "tmp", "mesh-concepts", "project-"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "concepts", private: true, type: "module", dependencies: { meshfw: "*" } }));
  symlinkSync(CLI, join(root, "node_modules/meshfw"), "dir");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const domain = options.domain ?? "src/domain";
  const ignored = new Set(options.ignored ?? []);
  const listed = Object.keys(files).filter((path) => path.startsWith(`${domain}/`) && path.endsWith(".mesh.mx") && !ignored.has(path)).sort();
  return {
    root,
    project: {
      root,
      domainRoot: domain,
      files: listed.map((file) => ({ file, source: files[file]! })),
      ignored: [...ignored].map((file) => ({ file, pattern: file })),
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const CLI = resolve(import.meta.dir, "../../cli");
let dialectBuilt = false;
/** Builds `meshfw`'s `dist/dialect.js`, which carries the concept hook MX runs, once per test process. */
export function buildDialect(): void {
  if (dialectBuilt) return;
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: CLI, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`meshfw build failed: ${build.stdout}${build.stderr}`);
  dialectBuilt = true;
}
