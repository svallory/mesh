// a function's scope roots are typed. `context` is the project's merged `ActionContext` and
// `actor` is its `actor` member, so a read of a member the project did not declare fails tsc with TS2339 instead of
// passing the build and failing at run time (`context.isStaff is not a function`, the PR #125 review, item 2); `self`,
// `input` and `before` keep their exact types too. The fixture (`fixtures/scope-roots-typing`) declares `actor` in
// `context.ts`, as the tutorial's `src/context.ts` does, and reads each root correctly; the project is built by the real
// `mesh` command on the SQLite adapter and type-checked by tsc under the strictest flags. A second project adds one wrong
// read per root, written in every form a function can take (translated, plain, a namespace import named `context`).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/scope-roots-typing");
const projects: string[] = [];
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "scope-roots-typing", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture, the SQLite adapter and the packages linked in; `entity` replaces the entity file. */
async function project(entity?: string, declared = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scope-roots-typing-"));
  projects.push(root);
  await cp(join(fixture, "domain"), join(root, "domain"), { recursive: true });
  if (declared) await cp(join(fixture, "context.ts"), join(root, "context.ts"));
  if (entity !== undefined) await writeFile(join(root, "domain/note/note.mesh.mx"), entity);
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

/** tsc under the strictest flags over the generated tree and `context.ts`: its output, one line per error. */
async function tsc(root: string): Promise<{ code: number | null; errors: string[] }> {
  const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
  const child = Bun.spawnSync([
    join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
    "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
    "mesh.config.ts", ...(existsSync(join(root, "context.ts")) ? ["context.ts"] : []), ...files,
  ], { cwd: root });
  const errors = (child.stdout.toString() + child.stderr.toString()).split("\n").filter((line) => /error TS\d+/.test(line));
  return { code: child.exitCode, errors };
}

/** The fixture's entity with `checks` added to the update's `validate` and `sets` to its `set`. */
async function entityWith(checks: string[], sets: string[], head = ""): Promise<string> {
  const source = await readFile(join(fixture, "domain/note/note.mesh.mx"), "utf8");
  return head + source
    .replace("        check :titled", `${checks.map((line) => `        ${line} code="no" message="no"\n`).join("")}        check :titled`)
    .replace("      do\n        set\n", `      do\n        set\n${sets.map((line) => `          ${line}\n`).join("")}`);
}

describe("a function's scope roots are typed", () => {
  test("the fixture reads each root correctly, builds and passes tsc under the strictest flags", async () => {
    const root = await project();
    expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
    expect(await tsc(root)).toEqual({ code: 0, errors: [] });
  }, 60_000);

  test("a read of a member the project's ActionContext lacks, an actor member, an attribute or an input it lacks, or a before member is TS2339", async () => {
    const root = await project(await entityWith(
      [
        // The review's shape: `context` is the scope root, not the helper module, so this reads `ActionContext.isStaff`.
        "check :helper that=({ actor, context }) => context.isStaff(actor)",
        "check :namespace that=({ actor }) => context.isStaff(actor)",
        "check :contextMember that=({ context }) => context.tenant !== undefined",
        "check :actorMember that=({ actor }) => actor.nick === \"x\"",
        "check :selfMember that=({ self }) => self.notAnAttribute === \"x\"",
        "check :inputMember that=({ input }) => input.notAnInput === \"x\"",
        "check :plainContext that=({ context }) => { return context.tenant === undefined }",
        "check :plainActor that=({ actor }) => { return actor.nick === undefined }",
      ],
      [
        "&memo2=({ before }) => before === null ? null : before.nope",
        "&memo=({ before }) => { return before === null ? null : before.nope2 }",
      ],
      'import * as context from "./staff"\n',
    ));
    const built = mesh(root, "build");
    expect(built.stderr).toMatch(/(^|\n)0 errors, \d+ warnings?\n$/);
    expect(built.code).toBe(0);
    const { code, errors } = await tsc(root);
    const messages = errors.map((line) => line.replace(/^.*error (TS\d+): /, "$1 "));
    expect(code).not.toBe(0);
    expect(messages.every((message) => message.startsWith("TS2339 "))).toBe(true);
    const named = (member: string) => messages.filter((message) => message.includes(`'${member}'`));
    // `isStaff` is read twice (as the helper's root and through the namespace import's name, which is the root too).
    expect(named("isStaff").map((message) => message.includes("'ActionContext'"))).toEqual([true, true]);
    expect(named("tenant").every((message) => message.includes("'ActionContext'"))).toBe(true);
    expect(named("tenant")).toHaveLength(2);
    expect(named("nick")).toHaveLength(2);
    expect(named("notAnAttribute")).toHaveLength(1);
    expect(named("notAnInput")).toHaveLength(1);
    expect(named("nope")).toHaveLength(1);
    expect(named("nope2")).toHaveLength(1);
    expect(messages).toHaveLength(10);
  }, 60_000);

  test("a project that declares no actor gets undefined: a read of it or its use as a string fails tsc", async () => {
    const root = await project(`import { takesString } from "./staff"

entity :Note
  attributes
    uuid :id primary-key
    string :title
    string :memo nullable

  actions auto=[:read]
    create :make
      input
        &title
    update :rename
      input
        &title
      validate
        check :member that=({ actor }) => actor.id !== null code="no" message="no"
        check :asString that=({ actor }) => takesString(actor) code="no" message="no"
        check :plainMember that=({ actor }) => { return actor.id !== null } code="no" message="no"
      do
        set
          &memo=({ actor }) => { const name: string = actor; return name }

  policies
    policy :open types=[:create, :read, :update]
      authorize-if=() => true
`, false);
    await writeFile(join(root, "domain/note/staff.ts"), "export const takesString = (s: string): boolean => s.length > 0;\n");
    const built = mesh(root, "build");
    expect(built.stderr).toMatch(/(^|\n)0 errors, \d+ warnings?\n$/);
    const { code, errors } = await tsc(root);
    const messages = errors.map((line) => line.replace(/^.*error (TS\d+): /, "$1 "));
    expect(code).not.toBe(0);
    // A translated read of `actor.id` narrows `undefined` away first, so tsc reports the member on `never` (TS2339); the
    // plain function reads it as written (TS18048); `actor` as a string argument is TS2345 and in a `string` local TS2322.
    expect(messages.sort()).toEqual([
      "TS18048 'actor' is possibly 'undefined'.",
      "TS2322 Type 'undefined' is not assignable to type 'string'.",
      "TS2339 Property 'id' does not exist on type 'never'.",
      "TS2345 Argument of type 'undefined' is not assignable to parameter of type 'string'.",
    ]);
    expect(messages).toHaveLength(4);
  }, 60_000);
});
