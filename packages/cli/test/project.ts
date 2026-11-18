// The temporary projects the CLI's end-to-end tests build: a directory outside the repo with a domain, a
// `mesh.config.ts`, a `package.json` and the workspace packages linked into its `node_modules`, and the real `mesh`
// command run in it. One copy, shared by every test file that builds such a project.
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const repo = resolve(import.meta.dir, "../../..");

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const SQLITE_CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;

/**
 * Bun's isolated linker keeps workspace dependencies at each package, not at the root, so a project outside the repo
 * links what it imports: `meshfw` (this package) and each named `@meshfw/*` package.
 */
export async function linkPackages(root: string, packages: readonly string[]): Promise<void> {
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of packages) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
}

export interface ProjectOptions {
  /** The `mkdtemp` prefix under the OS temp dir. */
  prefix: string;
  /** The `package.json` name. */
  name: string;
  /** The directory copied to the project's `domain/`. */
  domain: string;
  /** The `mesh.config.ts` source; the SQLite adapter in memory when left out. */
  config?: string;
  /** Further files, by path relative to the project root. */
  files?: Record<string, string>;
}

const projects: string[] = [];

/** A project outside the repo with the given domain, the SQLite adapter and the packages linked in. */
export async function project(options: ProjectOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), options.prefix));
  projects.push(root);
  await cp(options.domain, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), options.config ?? SQLITE_CONFIG);
  const manifest = {
    name: options.name, private: true, type: "module",
    imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of Object.entries(options.files ?? {})) await writeFile(join(root, path), text);
  await linkPackages(root, ["compiler", "model", "runtime", "data-sqlite"]);
  // The adapter's own dependencies (its query library and zod), as a project that installs it has them: the generated
  // schema and validators import them from the project.
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(await realpath(join(repo, "node_modules/@types/bun")), join(root, "node_modules/@types/bun"));
  return root;
}

/** Remove every project `project` made; a test file calls it in `afterAll`. */
export async function removeProjects(): Promise<void> {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** The real `mesh` command, in its own process, run in `root`. */
export function mesh(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}
