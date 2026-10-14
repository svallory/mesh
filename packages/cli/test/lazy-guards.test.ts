// Lazy guards (EXP-03, operator 2026-10-14), end to end. The fixture (`fixtures/lazy-guards/domain/gate`) calls an imported
// helper behind `&&`, `||`, `??` and `?:` in translated `set` expressions. The helper counts its calls and throws when it
// should have been kept from running. The project is built by the real `mesh` command, type-checked by tsc under the
// strictest flags, and run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/lazy-guards/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "lazy-guards", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lazy-guards-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite"]) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  await symlink(await realpath(join(repo, "node_modules/@types/bun")), join(root, "node_modules/@types/bun"));
  return root;
}

function mesh(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Row = Record<string, unknown>;
type Call = (input: Record<string, unknown>, context: object) => Promise<Row>;

describe("a helper behind a guard runs only when the guard lets it", () => {
  test("the generated expressions print the right side as a thunk", async () => {
    // The generated file is formatted, so compare with the whitespace folded.
    const text = (await readFile(join(root, ".mesh/domain/gate/gate.expressions.ts"), "utf8")).replace(/\s+/g, " ");
    expect(text).toContain('$.and($.eq($s.input?.flag, true), () => $.asBool($.pure(hit("and", true, true), "hit")))');
    expect(text).toContain('$.coalesce($s.input?.n, () => $.pure(hit("coalesce", true, 1), "hit"))');
    expect(text).toContain('$.cond( $s.input?.flag, () => $.pure(hit("cond-then", true, 1), "hit"), () => 2, )');
    // The guard is not a thunk, and a thunk nests inside a thunk.
    expect(text).toContain('$.and($.eq($s.input?.flag, true), () => $.or($.gt($s.input?.n, 1), () => $.asBool($.pure(hit("nested", true, true), "hit"))), )');
  });

  test("tsc type-checks the generated tree under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 30_000);

  test("on SQLite: a false &&, a true ||, a non-null ??, the branch not taken and a nested guard never run the helper; a null guard does", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { calls } = await import(join(root, "domain/gate/probe.ts")) as { calls: string[] };
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const binding = app.bind(layer);
    const anyone = { actor: { id: "someone" } };
    const Gate = domain.gate.Gate as { blocked: Call; unknown: Call };
    try {
      await binding.run(async () => {
        // flag false, n = 5: every throwing helper is behind a guard that rules it out. `isBig(5)` is the one call, the
        // guard of `helperGuardOut`, which is itself a helper.
        const blocked = await Gate.blocked({ n: 5, flag: false }, anyone);
        expect(calls.splice(0)).toEqual(["isBig"]);
        expect(blocked).toMatchObject({ andOut: false, orOut: true, coalesceOut: 5, condOut: 2, nestedOut: false, nestedCondOut: 5, helperGuardOut: false });

        // n not sent: an unknown guard runs the right side (as SQL would), and the results are the three-valued ones.
        const unknown = await Gate.unknown({ flag: false }, anyone);
        expect(calls.splice(0)).toEqual(["and-null", "or-null", "coalesce-null", "cond-null"]);
        expect(unknown).toMatchObject({ andOut: null, orOut: null, coalesceOut: 9, condOut: 2 });
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
