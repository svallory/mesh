// The `lock` step end to end (ADR-0100). The fixture (`fixtures/lock-step/domain/notes/note.mesh.mx`) locks an update, an
// update whose lock is `optional` and a destroy on `version`. The project is built by the real `mesh` command on the
// SQLite adapter, type-checked by tsc under the strictest flags, and run on SQLite in memory: a call that sends the stored
// version writes and bumps it, a stale one is one `expected-version` issue, after the not-found answer and the policies
// that read the record, and before any check.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/lock-step/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "lock-step", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lock-step-"));
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
  // The adapter's own dependencies (its query library and zod), as a project that installs it has them: the generated
  // schema and validators import them from the project.
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

interface Row { id: string; body: string | null; sealed: boolean; version: number }
type Call = (input: Record<string, unknown>, context: object) => Promise<Row>;
interface Issue { label: string | null; code: string; path: unknown[]; message: string; source: { file: string; line: number } | null; details: unknown }

/** The error a call rejects with; fails the test when it resolves. */
async function failureOf(call: Promise<unknown>): Promise<{ name: string; issues?: Issue[]; retryable?: boolean }> {
  const error = await call.then(() => undefined, (e: unknown) => e);
  expect(error).toBeDefined();
  return error as { name: string; issues?: Issue[]; retryable?: boolean };
}

describe("the lock step", () => {
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

  test("on SQLite the lock compares and bumps the version", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const binding = app.bind(layer);
    const anyone = {};
    const { Note } = domain.notes as { Note: { make: Call; edit: Call; touch: Call; seal: Call; drop: Call; read: (input: object, context: object) => Promise<Row[]> } };
    const stale = (expectedVersion: unknown, actualVersion: number) => ({
      label: "lock", code: "expected-version", path: ["expectedVersion"],
      message: `the record changed since it was read: version is ${actualVersion}, and the call expected ${expectedVersion}`,
      source: { file: "domain/notes/note.mesh.mx", line: 17, column: 9 }, details: { expectedVersion, actualVersion },
    });
    try {
      await binding.run(async () => {
        const note = await Note.make({ body: "a" }, anyone);
        expect(note.version).toBe(1);
        // The stored version: written, and bumped.
        expect(await Note.edit({ id: note.id, body: "b", expectedVersion: 1 }, anyone)).toMatchObject({ body: "b", version: 2 });
        // A stale version: one issue, not retryable, the row unchanged.
        const refused = await failureOf(Note.edit({ id: note.id, body: "c", expectedVersion: 1 }, anyone));
        expect(refused.name).toBe("InvalidInputError");
        expect(refused.retryable).toBe(false);
        expect(refused.issues).toEqual([stale(1, 2)]);
        expect((await Note.read({}, anyone)).map((row) => [row.body, row.version])).toEqual([["b", 2]]);
        // A stale call is told only that it is stale: the check its input fails does not run.
        expect((await failureOf(Note.edit({ id: note.id, body: null, expectedVersion: 1 }, anyone))).issues).toEqual([stale(1, 2)]);
        expect((await failureOf(Note.edit({ id: note.id, body: null, expectedVersion: 2 }, anyone))).issues?.map((issue) => issue.code)).toEqual(["body"]);
        // The field is required, so the cast refuses a call without it.
        expect((await failureOf(Note.edit({ id: note.id, body: "c" }, anyone))).issues?.map((issue) => issue.path)).toEqual([["expectedVersion"]]);
        // A missing row is not found before any comparison.
        expect((await failureOf(Note.edit({ id: "0190a3a0-0000-7000-8000-000000000000", body: "c", expectedVersion: 9 }, anyone))).name).toBe("NotFoundError");
        // `optional`: a call without the field writes and bumps; a stale one is refused.
        expect(await Note.touch({ id: note.id, body: "t" }, anyone)).toMatchObject({ body: "t", version: 3 });
        expect(await Note.touch({ id: note.id, body: "u", expectedVersion: null }, anyone)).toMatchObject({ version: 4 });
        expect((await failureOf(Note.touch({ id: note.id, expectedVersion: 3 }, anyone))).issues?.map((issue) => issue.details)).toEqual([{ expectedVersion: 3, actualVersion: 4 }]);
        // A destroy compares and writes no version: stale refused, the stored one deletes.
        expect((await failureOf(Note.drop({ id: note.id, expectedVersion: 1 }, anyone))).issues?.map((issue) => issue.code)).toEqual(["expected-version"]);
        await Note.drop({ id: note.id, expectedVersion: 4 }, anyone);
        expect(await Note.read({}, anyone)).toEqual([]);
        // A policy that reads the record runs before the comparison: a sealed note is forbidden, stale or not.
        const sealed = await Note.make({ body: "s" }, anyone);
        await Note.seal({ id: sealed.id }, anyone);
        expect((await failureOf(Note.edit({ id: sealed.id, body: "x", expectedVersion: 99 }, anyone))).name).toBe("ForbiddenError");
      });
      // Two calls that read the same version: one writes, the other is stale.
      const shared = await binding.run(() => Note.make({ body: "a" }, anyone));
      const results: PromiseSettledResult<Row>[] = await binding.run(() => Promise.allSettled([1, 2].map((n) => Note.edit({ id: shared.id, body: `w${n}`, expectedVersion: 1 }, anyone))));
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.issues).toEqual([stale(1, 2)]);
    } finally {
      await layer.close();
    }
  }, 30_000);
});
