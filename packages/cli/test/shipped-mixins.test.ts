// Mesh's shipped mixins end to end (`notes/architecture/mixins-design.md`, ruling D37 OD1). The fixture
// (`fixtures/shipped-mixins/domain/notes/note.mesh.mx`) uses `Timestamps` and `Versioned` from "meshfw/mixins" and keeps
// its own expected-version check, as the docs' recipe does. The project is built by the real `mesh` command on the
// SQLite adapter, type-checked by tsc under the strictest flags, and run on SQLite in memory: a create stores version 1
// and both stamps, each update adds 1 and moves `updatedAt` only, and a stale update is refused before the bump, so it
// leaves the version as it was.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { mesh, project, removeProjects, repo } from "./project.ts";

let root: string;
beforeAll(async () => {
  root = await project({ prefix: "shipped-mixins-", name: "shipped-mixins", domain: join(import.meta.dir, "fixtures/shipped-mixins/domain") });
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(removeProjects);

interface Note { id: string; body: string; version: number; insertedAt: Date; updatedAt: Date }
type Call = (input: Record<string, unknown>, context?: object) => Promise<Note>;
interface Issue { label: string | null; code: string | null; details: unknown }

describe("Timestamps and Versioned", () => {
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

  test("on SQLite: the stamps and the version an update bumps, and a stale update that leaves them", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    let now = Date.UTC(2026, 0, 1);
    const binding = app.bind(layer, { clock: () => new Date(now) });
    const { Note } = domain.notes as { Note: { make: Call; edit: Call; read: (input: object) => Promise<Note[]> } };
    const stored = async (id: string) => (await binding.run(() => Note.read({ filter: { id: { eq: id } } })))[0]!;

    const made = await binding.run(() => Note.make({ body: "a" }));
    expect(made.version).toBe(1);
    expect(made.insertedAt.getTime()).toBe(now);
    const created = now;

    now += 1_000;
    expect((await binding.run(() => Note.edit({ id: made.id, body: "b", expectedVersion: 1 }))).version).toBe(2);
    now += 1_000;
    const twice = await binding.run(() => Note.edit({ id: made.id, body: "c" }));
    expect([twice.version, twice.insertedAt.getTime(), twice.updatedAt.getTime()]).toEqual([3, created, now]);

    // The check reads the stored version, before the block's bump: 1 is stale, and the refusal leaves the row.
    now += 1_000;
    const refused: { name: string; issues: Issue[] } | undefined = await binding.run(() => Note.edit({ id: made.id, body: "d", expectedVersion: 1 })).then(() => undefined, (error: unknown) => error as { name: string; issues: Issue[] });
    expect(refused?.name).toBe("InvalidInputError");
    expect(refused?.issues.map((issue) => [issue.label, issue.code, issue.details])).toEqual([["versionMatches", "expected-version", { expectedVersion: 1, actualVersion: 3 }]]);
    const after = await stored(made.id);
    expect([after.body, after.version, after.updatedAt.getTime()]).toEqual(["c", 3, now - 1_000]);
    expect((await binding.run(() => Note.edit({ id: made.id, body: "e", expectedVersion: 3 }))).version).toBe(4);
  });
});
