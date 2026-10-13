// PRJ-22 and SYN-29 end to end: Mesh's own functions are members of `Mesh`, which an entity file and application code
// import from meshfw, and the instant is the current transaction's, `%.now` and `%.today`, which needs no import. The
// fixture (`fixtures/mesh-namespace/domain/work`) reads `%.now`, `%.today` and `Mesh.isSystem(context)` in computed fields,
// a check, a set value, a policy and a step's body, calls `Mesh.privileged(Note)` in a step's body, passes `%.now` and
// `%.today` to application helpers (`stampOf`, `dueIn`), and `Note` imports `Mesh` under an alias (`M`) for a plain check.
// The project is built by the real `mesh` command on the SQLite adapter, type-checked by tsc under the strictest flags with
// an application module that imports `Mesh` from meshfw, and run on SQLite in memory with a clock that advances on every
// read, so each test of one instant (ACT-29) sees two reads differ unless they share a transaction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForbiddenError, InvalidInputError } from "@meshfw/runtime";

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
export const internal = (context: unknown): boolean => Mesh.isSystem(context);
/** What the types refuse; never called. */
export function refused(): void {
  // @ts-expect-error Mesh holds Mesh's functions alone
  Mesh.tomorrow();
  // @ts-expect-error Mesh.privileged takes an entity value
  Mesh.privileged({});
  // @ts-expect-error the instant is not Mesh's (SYN-29): an entity file reads \`%.now\` and passes it as a parameter
  Mesh.now();
  // @ts-expect-error the date is not Mesh's either: an entity file reads \`%.today\`
  Mesh.today();
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

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

const generated = (path: string) => readFile(join(root, ".mesh", path), "utf8");

describe("Mesh's own functions through the Mesh import (PRJ-22), the instant through %.now (SYN-29)", () => {
  test("translated code calls the run-time functions, %.now in plain code included; a plain body reads Mesh as the file imports it", async () => {
    const task = await generated("domain/work/task.expressions.ts");
    expect(task).toContain("$.lt($s.self.dueAt, $.now($s))");
    expect(task).toContain("$.isSystem($s.context)");
    expect(task).toContain("(due.getTime() - $today().getTime())");
    expect(task).toContain("$.pure(dueIn($.today($s), 30), \"dueIn\")");
    expect(task).toContain("await Mesh.privileged(Note).read({ load: [\"stamp\"] })");
    expect(task).toContain("stampOf($now(), self.title)");
    expect(task).toMatch(/import \{[^}]*\bMesh,[^}]*\} from "@meshfw\/runtime";/);
    expect(task).not.toMatch(/%\.|const Mesh|meshIn|\$mesh/);
    const note = await generated("domain/work/note.expressions.ts");
    expect(note).toMatch(/import \{[^}]*\bMesh as M,[^}]*\} from "@meshfw\/runtime";/);
    expect(note).toContain("const at = $now();");
    expect(note).not.toMatch(/const M\b|const Mesh\b/);
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

  test("on SQLite every function reads the transaction's one instant, nested actions and privileged reads included (ACT-29), and application code reads with Mesh.privileged", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { work } = await import(join(root, ".mesh/domain/index.ts"));
    const application = await import(join(root, "app.ts"));
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const DAY = 86_400_000;
    // Every read of the clock is a second later than the last, all on day 400: two calls that pinned their own instants
    // never agree, and `%.today` is day 400 whichever second it reads.
    const start = DAY * 400 + 3_600_000;
    let reads = 0;
    const clock = () => new Date(start + 1_000 * ++reads);
    const anyone = { actor: { id: "someone" } };
    const owner = { actor: { id: "owner" } };
    const iso = (date: Date) => date.toISOString();
    try {
      await app.bind(layer, { clock }).run(async () => {
        // The check reads %.today and Mesh.isSystem(context).
        const past = new Date(DAY * 399);
        const refused = await rejection(work.Task.open({ title: "Late", dueAt: past }, anyone), InvalidInputError);
        expect(refused.issues.map((issue) => issue.code)).toEqual(["past"]);
        const late = await work.Task.open({ title: "Late", dueAt: past }, { ...anyone, system: true });
        const soon = await work.Task.open({ title: "Soon", dueAt: new Date(DAY * 402) }, anyone);

        // The computed fields read %.now (translated) and %.today (plain code).
        const read = await work.Task.read({ load: ["overdue", "daysLeft"] }, anyone);
        expect(read.map((task: { title: string; overdue: boolean; daysLeft: number }) => [task.title, task.overdue, task.daysLeft]).sort())
          .toEqual([["Late", true, -1], ["Soon", false, 2]]);
        expect(await application.overdue()).toBe(1);

        // The policy reads Mesh.isSystem(context). The set value and the step's body read the action's instant, and so do
        // the action the step calls (`Note.write`, whose `at` is its own `%.now`) and the privileged read the step makes
        // (the notes' computed `stamp`, `%.now` again): one transaction, one instant (ACT-29).
        await rejection(work.Task.close({ id: soon.id }, anyone), ForbiddenError);
        const lateClosed = await work.Task.close({ id: late.id }, { ...anyone, system: true });
        const soonClosed = await work.Task.close({ id: soon.id }, owner);
        // Two top-level calls pin two instants.
        expect(lateClosed.closedAt.getTime()).not.toBe(soonClosed.closedAt.getTime());
        const notes = await work.Note.read({ load: ["stamp"] }, anyone);
        const byText = (text: string) => notes.find((note: { text: string }) => note.text.startsWith(text));
        expect(byText("Late")).toMatchObject({ text: `Late closed at ${iso(lateClosed.closedAt)} after 0 notes stamped `, at: lateClosed.closedAt });
        expect(byText("Soon")).toMatchObject({ text: `Soon closed at ${iso(soonClosed.closedAt)} after 1 notes stamped ${iso(soonClosed.closedAt)}`, at: soonClosed.closedAt });
        // A top-level read pins its own instant: one for all its rows, and none an earlier call pinned.
        const stamps = new Set(notes.map((note: { stamp: string }) => note.stamp));
        expect(stamps.size).toBe(1);
        expect([iso(lateClosed.closedAt), iso(soonClosed.closedAt)]).not.toContain([...stamps][0]);

        // Two actions and a privileged read inside one application transaction share its instant.
        const [first, second, privileged] = await app.transaction(async () => [
          await work.Note.write({ text: "first" }, anyone),
          await work.Note.write({ text: "second" }, anyone),
          await Mesh.privileged(work.Note).read({ load: ["stamp"] }),
        ]);
        expect(second.at.getTime()).toBe(first.at.getTime());
        expect(new Set(privileged.map((note: { stamp: string }) => note.stamp))).toEqual(new Set([iso(first.at)]));
        // Outside it, two calls do not.
        const third = await work.Note.write({ text: "third" }, anyone);
        const fourth = await work.Note.write({ text: "fourth" }, anyone);
        expect(fourth.at.getTime()).toBeGreaterThan(third.at.getTime());
        expect(third.at.getTime()).toBeGreaterThan(second.at.getTime());

        // `Note` imports Mesh as M for a plain check.
        await rejection(work.Note.write({ text: "system: by hand" }, anyone), InvalidInputError);
        expect(await work.Note.write({ text: "system: rotated" }, { ...anyone, system: true })).toMatchObject({ text: "system: rotated" });

        // Application code reads Mesh.privileged and Mesh.isSystem as an entity file does.
        expect((await app.transaction(() => Mesh.privileged(work.Note).read({}))).length).toBe(7);
        expect(application.internal({ system: true })).toBe(true);
        expect(application.internal({ system: "yes" })).toBe(false);

        // A step's body reads Mesh.isSystem(context) and hands `%.now` to an application helper.
        await work.Task.mark({ id: soon.id }, owner);
        await work.Task.mark({ id: late.id }, { ...anyone, system: true });
        const marks = (await work.Note.read({}, anyone)).map((note: { text: string }) => note.text).filter((text: string) => text.includes("@")).sort();
        expect(marks).toEqual([expect.stringMatching(/^Late@\d{4}-\d\d-\d\dT[\d:.]+Z by the system$/), expect.stringMatching(/^Soon@\d{4}-\d\d-\d\dT[\d:.]+Z by a person$/)]);
        const marked = (await work.Note.read({}, anyone)).filter((note: { text: string }) => note.text.includes("@"));
        for (const note of marked) expect(note.text).toContain(`@${iso(note.at)} by`);

        // A set value hands `%.today` to an application helper: day 400 and 30 more.
        expect(await work.Task.touch({ id: soon.id }, owner)).toMatchObject({ dueAt: new Date(DAY * 430) });
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
