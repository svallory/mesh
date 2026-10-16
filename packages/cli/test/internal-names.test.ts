// End to end, the PR #100 review: what Mesh's own edits read in plain code is bound under names the authored text
// does not spell, so no local or parameter of the author's hides it. `&name` is the record's member and `%.now` and
// `%.today` are the current transaction's instant and date whatever the author names a local: `$` or `$s` (the names
// generated code gives the run-time functions and the scope), `self` (the root `&name` once read), or an `any`-typed
// parameter, which would have handed a wrong value to code that type-checks. The fixture (`fixtures/internal-names/domain/
// shop`) holds each case in a computed field, a check whose arrow is plain code, and the steps of one action. The project is
// built by the real `mesh` command on the SQLite adapter, type-checked by tsc under the strictest flags and run on SQLite in
// memory. Two calls of `%.now` the review found escaping MESH_TRANSACTION_CALL (a tagged template, a sequence callee)
// fail the build instead of tsc.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InvalidInputError } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/internal-names/domain");
const projects: string[] = [];

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "internal-names", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "internal-names-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  // Bun's isolated linker keeps workspace dependencies at each package, so the project links what it imports.
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite"]) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
  // The adapter's own dependencies (its query library and zod), as a project that installs it has them.
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

/** What `fn` logs, each call's arguments. */
async function logs(fn: () => Promise<unknown>): Promise<unknown[][]> {
  const seen: unknown[][] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { seen.push(args); };
  try { await fn(); } finally { console.log = log; }
  return seen;
}

let root: string;
beforeAll(async () => {
  root = await project();
  // Three of the functions are plain only because of a computed member or a method call, which Mesh warns about.
  const built = mesh(root, "build");
  expect({ code: built.code, stdout: built.stdout }).toEqual({ code: 0, stdout: "" });
  expect(built.stderr.split("\n").filter((line) => line.includes(" warning ")).map((line) => line.split(" ")[0])).toEqual([
    "domain/shop/box.mesh.mx:10:32", "domain/shop/box.mesh.mx:12:33", "domain/shop/box.mesh.mx:19:34",
  ]);
  expect(built.stderr).toEndWith("0 errors, 3 warnings\n");
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("&name, %.now and %.today in plain code read Mesh's own names, which no local hides (PR #100 review)", () => {
  test("the printed functions bind the record and the instant under names the authored text does not spell, and never read `$` or `$s` in its text", async () => {
    const box = await readFile(join(root, ".mesh/domain/shop/box.expressions.ts"), "utf8");
    // The review's cases, each as printed.
    expect(box).toContain("return [1].map(($) => $now().getTime() + $)[0] ?? 0;");
    expect(box).toContain("const f = ($s: any) => $today().getTime() + ($s === 1 ? 1 : 0);");
    expect(box).toContain("return [1].map((self) => $self.n + self)[0] ?? 0;");
    expect(box).toContain("return (() => !$self.items.map(($) => $.dueAt !== null && $.dueAt < $now()).includes(true))();");
    expect(box).toContain("const $ = 5;\n      console.log(\"dollar\", $now().getTime(), $);");
    expect(box).toContain("const $s = 5;\n      console.log(\"scope\", $today().getTime(), $s);");
    expect(box).toContain("const self = { n: 99 };\n      console.log(\"self\", $self.n, self.n);");
    // Each function binds what it reads, in the wrapper, where `$` and `$s` are the run-time functions and the scope.
    expect(box.match(/const \$self = \$s\.self;/g)?.length).toBe(3);
    expect(box.match(/const \$now = \(\) => \$\.now\(\$s\);/g)?.length).toBe(5);
    expect(box.match(/const \$today = \(\) => \$\.today\(\$s\);/g)?.length).toBe(2);
    // No text of the author's reads the scope or the run-time functions, and `self` is never bound.
    expect(box).not.toMatch(/%\.|\$\.(now|today)\(\$s\)\.|const \{ self \}/);
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
  }, 60_000);

  test("on SQLite each function reads the record's member and the transaction's instant, whatever the author's locals are called", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { shop } = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const DAY = 86_400_000;
    const at = DAY * 400 + 3_600_000;
    const anyone = { actor: { id: "someone" } };
    try {
      await app.bind(layer, { clock: () => new Date(at) }).run(async () => {
        const box = await shop.Box.open({ n: 7 }, anyone);
        await shop.Item.add({ box: box.id, dueAt: new Date(DAY * 401) }, anyone);
        // A local `$`, a local `$s`, an `any`-typed parameter `$` or `$s` handed a look-alike, and a local `self`.
        expect(await logs(() => shop.Box.stamp({ id: box.id }, anyone))).toEqual([
          ["dollar", at, 5],
          ["scope", DAY * 400, 5],
          ["any", at],
          ["anyScope", at],
          ["self", 7, 99],
        ]);
        // The computed fields: a parameter `$`, an `any`-typed parameter `$s` and a parameter `self`.
        const [read] = await shop.Box.read({ load: ["mapped", "scoped", "selfish"] }, anyone);
        expect(read).toMatchObject({ mapped: at + 1, scoped: DAY * 400 + 1, selfish: 8 });
        // The check's arrow parameter `$` is the item: an overdue one fails the check.
        await shop.Item.add({ box: box.id, dueAt: new Date(DAY * 399) }, anyone);
        const refused = await shop.Box.stamp({ id: box.id }, anyone).then(() => undefined, (cause: unknown) => cause);
        expect(refused).toBeInstanceOf(InvalidInputError);
        expect((refused as InvalidInputError).issues.map((issue) => issue.code)).toEqual(["late"]);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);

  test("a tagged template and a sequence callee call %.now: the build reports MESH_TRANSACTION_CALL instead of tsc failing", async () => {
    const broken = await project();
    // An update action whose two steps call `%.now`, one as a template's tag and one through a sequence.
    const file = join(broken, "domain/shop/item.mesh.mx");
    const steps = ["    update :tag", "      do", "        run () { console.log(%.now`x`) }", "        run () { console.log((0, %.now)()) }", ""].join("\n");
    await writeFile(file, (await readFile(file, "utf8")).replace("  policies\n", `${steps}  policies\n`));
    const result = mesh(broken, "build");
    expect(result.code).toBe(1);
    // Each at its `%`: line 16 is the tagged template's step and line 17 the sequence's.
    const errors = result.stderr.split("\n").filter((line) => line.startsWith("domain/shop/item.mesh.mx"));
    expect(errors).toEqual([
      "domain/shop/item.mesh.mx:16:30 error MESH_TRANSACTION_CALL `%.now` is a value, not a function: it is the current transaction's instant",
      "domain/shop/item.mesh.mx:17:34 error MESH_TRANSACTION_CALL `%.now` is a value, not a function: it is the current transaction's instant",
    ]);
    expect(result.stderr).toContain("fix: write `%.now`, without the template after it\n");
    expect(result.stderr).toEndWith("2 errors, 3 warnings\n");
  }, 30_000);
});
