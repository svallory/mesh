// What a generated expressions file imports and binds follows from the model and from what the printer wrote, never
// from a search of the printed text (the PR #98 finding). An author's string, comment or template that spells `$.` or
// `$s` must not make the file import the runtime's `expr` it never calls (TS6133) or name a parameter the function never
// reads (TS6133). The fixture (`fixtures/decided-imports/domain/shop`) spells both in a translated check and policy and
// in plain computed fields; the project is built by the real `mesh` command, type-checked by tsc under the strictest flags
// and run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/decided-imports/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "decided-imports", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "decided-imports-"));
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
  const built = mesh(root, "build");
  expect({ code: built.code, stdout: built.stdout, stderr: built.stderr }).toEqual({ code: 0, stdout: "", stderr: expect.not.stringContaining(" error ") });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("author text never decides what generated code imports or binds", () => {
  test("the expressions file imports no `expr` it never calls, and every function names its scope parameter by whether it reads it", async () => {
    const note = await readFile(join(root, ".mesh/domain/shop/note.expressions.ts"), "utf8");
    expect(note).not.toMatch(/\bexpr\b/);
    // The author's text is kept as written, and no function reads the scope.
    expect(note).toContain('"$."');
    expect(note).toContain("/* $. and $s */");
    expect(note).not.toMatch(/\(\$s: /);
    expect(note).toMatch(/\(_\$s: /);
    // A translated check and policy that do call the runtime import it, and still name their unread parameter `_$s`.
    const tag = await readFile(join(root, ".mesh/domain/shop/tag.expressions.ts"), "utf8");
    expect(tag).toMatch(/expr as \$,/);
    expect(tag).toContain('$.ne("$.", "$s")');
    expect(tag).not.toMatch(/\(\$s: /);
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

  test("on SQLite the computed fields return the authored strings and the action runs", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { shop } = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    try {
      await app.bind(layer, {}).run(async () => {
        await shop.Tag.add({ text: "hello" }, { actor: { id: "someone" } });
        await shop.Note.add({ text: "hello" }, { actor: { id: "someone" } });
        const [read] = await shop.Note.read({ load: ["dollar", "scope", "comment", "template", "single"] }, { actor: { id: "someone" } });
        expect(read).toMatchObject({ dollar: "$.", scope: "$s", comment: "c", template: "$.t $s", single: "$s $." });
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
