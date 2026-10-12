// PRJ-22 end to end: Mesh's own functions are members of `Mesh`, which an entity file and application code import from
// meshfw. The fixture (`fixtures/mesh-namespace/domain/work`) calls `Mesh.now()`, `Mesh.today()` and
// `Mesh.isSystem(context)` in computed fields, a check, a set value and a policy, `Mesh.privileged(Note)` in a step's body,
// and `Note` imports `Mesh` under an alias (`M`). The project is built by the real `mesh` command on the SQLite adapter,
// type-checked by tsc under the strictest flags with an application module that imports `Mesh` from meshfw, and run on
// SQLite in memory with a pinned clock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForbiddenError, FrameworkError, InvalidInputError } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/mesh-namespace/domain");
const projects: string[] = [];

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "mesh-namespace", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};
/** Application code: `Mesh` from meshfw, as the application imports it, next to the entity values. */
const APP = `import { Mesh } from "meshfw";
import { transaction } from "#mesh";
import { Task } from "#mesh/domain/work";

/** How many tasks are overdue, read with no policy: \`Mesh.privileged\` from application code. */
export async function overdue(): Promise<number> {
  return transaction(async () => (await Mesh.privileged(Task).read({ load: ["overdue"] })).filter((task) => task.overdue === true).length);
}
/** The running action's instant is not reachable from application code yet: this throws. */
export function appNow(): Date {
  return Mesh.now();
}
export const internal = (context: unknown): boolean => Mesh.isSystem(context);
/** What the types refuse; never called. */
export function refused(): void {
  // @ts-expect-error Mesh holds Mesh's functions alone
  Mesh.tomorrow();
  // @ts-expect-error Mesh.privileged takes an entity value
  Mesh.privileged({});
}
`;

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh-namespace-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await writeFile(join(root, "app.ts"), APP);
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

async function rejection<E>(call: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(type);
  return error as E;
}

const OUTSIDE = "Mesh.now() was called outside an entity file's expression: application code cannot find the running action's instant yet. In a function of the entity file (a step or a check), pass Mesh.now() or the file's Mesh to the helper; elsewhere, take the time from the application's own clock";

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

const generated = (path: string) => readFile(join(root, ".mesh", path), "utf8");

describe("Mesh's own functions through the Mesh import (PRJ-22)", () => {
  test("translated code calls the run-time functions; a plain body binds the evaluation's Mesh under the file's name for it", async () => {
    const task = await generated("domain/work/task.expressions.ts");
    expect(task).toContain("$.lt($s.self.dueAt, $.now($s))");
    expect(task).toContain("$.isSystem($s.context)");
    expect(task).toContain("const Mesh = $mesh($s);");
    expect(task).toContain("await Mesh.privileged(Note).read({})");
    expect(task).toMatch(/meshIn as \$mesh,/);
    const note = await generated("domain/work/note.expressions.ts");
    expect(note).toContain("const M = $mesh($s);");
    expect(note).not.toMatch(/const Mesh\b/);
    // #mesh holds no Mesh function: the application imports Mesh from meshfw.
    const index = await generated("index.ts");
    expect(index).toContain('export type { Privileged } from "@meshfw/runtime";');
    expect(index).not.toMatch(/export \{[^}]*\bprivileged\b/);
  });

  test("tsc type-checks the generated tree and the application module under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "app.ts", "domain/work/clock.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  test("on SQLite every function reads the action's one instant, and application code reads with Mesh.privileged", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { work } = await import(join(root, ".mesh/domain/index.ts"));
    const application = await import(join(root, "app.ts"));
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const DAY = 86_400_000;
    const instant = new Date(DAY * 400 + 3_600_000);
    const anyone = { actor: { id: "someone" } };
    const owner = { actor: { id: "owner" } };
    try {
      await app.bind(layer, { clock: () => new Date(instant) }).run(async () => {
        // The check reads Mesh.today() and Mesh.isSystem(context).
        const past = new Date(DAY * 399);
        const refused = await rejection(work.Task.open({ title: "Late", dueAt: past }, anyone), InvalidInputError);
        expect(refused.issues.map((issue) => issue.code)).toEqual(["past"]);
        const late = await work.Task.open({ title: "Late", dueAt: past }, { ...anyone, system: true });
        const soon = await work.Task.open({ title: "Soon", dueAt: new Date(DAY * 402) }, anyone);

        // The computed fields read Mesh.now() (translated) and Mesh.today() (plain code).
        const read = await work.Task.read({ load: ["overdue", "daysLeft"] }, anyone);
        expect(read.map((task: { title: string; overdue: boolean; daysLeft: number }) => [task.title, task.overdue, task.daysLeft]).sort())
          .toEqual([["Late", true, -1], ["Soon", false, 2]]);
        expect(await application.overdue()).toBe(1);

        // The policy reads Mesh.isSystem(context); the set value and the step's body read the same instant as Mesh.now().
        await rejection(work.Task.close({ id: soon.id }, anyone), ForbiddenError);
        await work.Task.close({ id: late.id }, { ...anyone, system: true });
        expect(await work.Task.close({ id: soon.id }, owner)).toMatchObject({ closedAt: instant });
        const notes = await work.Note.read({ load: ["stamp"] }, anyone);
        expect(notes.map((note: { text: string }) => note.text).sort()).toEqual([
          `Late closed at ${instant.toISOString()} after 0 notes`,
          `Soon closed at ${instant.toISOString()} after 1 notes`,
        ]);
        // `Note` imports Mesh as M: its set value and its plain computed field read the same instant.
        for (const note of notes) expect(note).toMatchObject({ at: instant, stamp: instant.toISOString() });

        // Application code reads Mesh.privileged and Mesh.isSystem as an entity file does.
        expect((await app.transaction(() => Mesh.privileged(work.Note).read({}))).length).toBe(2);
        expect(application.internal({ system: true })).toBe(true);
        expect(application.internal({ system: "yes" })).toBe(false);

        // Mesh.now() in application code throws, inside an action (a helper the entity file calls) as outside one.
        const inside = await rejection(work.Task.touch({ id: soon.id }, owner), FrameworkError);
        expect(inside.message).toBe(OUTSIDE);
      });
      expect(() => application.appNow()).toThrow(new FrameworkError(OUTSIDE));
    } finally {
      await layer.close();
    }
  }, 30_000);
});
