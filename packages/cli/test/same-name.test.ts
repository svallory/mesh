// End to end: two modules each declare `entity :List`, built by the real `mesh` command on the SQLite adapter and
// run on SQLite in memory. The fixture (`fixtures/same-name/domain`) holds `a/list.mesh.mx`, which imports b's List as
// `BList` and belongs to it, and `b/list.mesh.mx`, which sets `table="b_list"`. Each declares an `archive` action and a
// policy that denies it to all but its own keeper. Nothing in the generated tree may be named after the bare entity name
// next to the other entity's: the build, tsc, the run and `mesh inspect` all tell the two apart by FQN.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ForbiddenError } from "@meshfw/runtime";
import { mesh, project as sharedProject, repo, removeProjects } from "./project.ts";

const fixture = join(import.meta.dir, "fixtures/same-name/domain");

/** The project's `src/context.ts`: `context` and `actor` are typed by it, so a function reads only what it declares. */
const CONTEXT = `import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}
`;
/** Type-level checks through the specifiers: each module's List is its own, and a.List's `mirror` is b's record. */
const CHECK = `import { List, loadListFields, type ListLoadable } from "#mesh/domain/a";
import { List as BList } from "#mesh/domain/b";
import * as domain from "#mesh/domain";

export const same: [typeof List, typeof BList] = [domain.a.List, domain.b.List];
export type Mirror = ListLoadable["mirror"];
export const mirror: Mirror = null as unknown as BList;
// @ts-expect-error a.List's record is not b.List's: it has a mirrorId
export const notA: List = null as unknown as BList;
export const loader: typeof loadListFields = loadListFields;
`;

const project = () => sharedProject({ prefix: "mesh-same-name-", name: "same-name", domain: fixture, files: { "context.ts": CONTEXT, "check.ts": CHECK } });

async function denial(call: Promise<unknown>): Promise<ForbiddenError> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ForbiddenError);
  return error as ForbiddenError;
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(removeProjects);

describe("two entities named List in modules a and b", () => {
  test("build writes one set of files per module, and each barrel exports its own List", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).sort();
    expect(files).toEqual([
      "$globals.ts", "binding.ts", "domain/a/index.ts", "domain/a/list.actions.ts", "domain/a/list.expressions.ts", "domain/a/list.types.ts",
      "domain/a/list.validators.ts", "domain/b/index.ts", "domain/b/list.actions.ts", "domain/b/list.expressions.ts",
      "domain/b/list.types.ts", "domain/b/list.validators.ts", "domain/index.ts", "index.ts", "load.ts", "schema.ts",
    ]);
    // b.List has nothing to load, so it has no load function.
    expect(await readFile(join(root, ".mesh/domain/a/index.ts"), "utf8")).toContain('export { List, loadListFields } from "./list.actions";');
    expect(await readFile(join(root, ".mesh/domain/b/index.ts"), "utf8")).toContain('export { List } from "./list.actions";');
    // load.ts holds one registry keyed by FQN and imports each entity's expressions under a local derived from it.
    const load = await readFile(join(root, ".mesh/load.ts"), "utf8");
    expect(load).toContain('import { $expressions as $a$List$expressions } from "./domain/a/list.expressions";');
    expect(load).toContain('import { $expressions as $b$List$expressions } from "./domain/b/list.expressions";');
    expect(load).toContain('"a.List": {');
    expect(load).toContain('"b.List": {');
    // a's types file names b's List by its FQN-derived local, not by the alias a/list.mesh.mx gives it.
    const aTypes = await readFile(join(root, ".mesh/domain/a/list.types.ts"), "utf8");
    expect(aTypes).toContain('import type { List as $b$List$Record } from "../b/list.types";');
    expect(aTypes).not.toContain("BList");
  });

  test("tsc type-checks the generated tree and the specifiers under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "context.ts", "check.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 30_000);

  test("mesh inspect tells a.List from b.List, and List alone is ambiguous", () => {
    const a = mesh(root, "inspect", "a.List");
    const b = mesh(root, "inspect", "b.List");
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(JSON.parse(a.stdout)).toMatchObject({ name: "List", fqn: "a.List", module: "a", file: "domain/a/list.mesh.mx" });
    expect(JSON.parse(b.stdout)).toMatchObject({ name: "List", fqn: "b.List", module: "b", file: "domain/b/list.mesh.mx", table: "b_list" });
    expect(a.stdout).not.toBe(b.stdout);
    expect(mesh(root, "inspect", "List")).toEqual({
      code: 1, stdout: "", stderr: 'mesh.config.ts:1:1 error MESH_CLI Entity name "List" is ambiguous. Did you mean a.List or b.List?\n1 error, 0 warnings\n',
    });
  }, 30_000);

  test("on SQLite each List writes its own table, runs its own policy and reaches seams and load by its FQN", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { loadListFields } = await import(join(root, ".mesh/domain/a/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const seen: string[] = [];
    const binding = app.bind(layer, { seams: { beforeTransaction: (event: { entity: string; action: string }) => { seen.push(`${event.entity}#${event.action}`); } } });
    const anyone = { actor: { id: "someone" } };
    try {
      await binding.run(async () => {
        const target = await domain.b.List.create({ title: "b" }, anyone);
        const list = await domain.a.List.create({ title: "a", mirror: target.id }, anyone);
        expect(list).toMatchObject({ title: "a", archived: false, mirrorId: target.id });

        // Each create wrote its own table: a.List the default `list`, b.List its `table="b_list"`.
        const rows = await layer.transaction(async (tx: any) => [await tx.select(app.tables.list), await tx.select(app.tables.b_list)]);
        expect(rows).toEqual([[list], [target]]);

        // Each archive runs its own entity's policy, and the denial names its own FQN.
        const deniedA = await denial(domain.a.List.archive({ id: list.id }, { actor: { id: "b-keeper" } }));
        expect(deniedA).toMatchObject({ entity: "a.List", action: "archive", policies: ["aKeeper"] });
        expect(deniedA.message).toBe("a.List#archive is forbidden by policy :aKeeper");
        const deniedB = await denial(domain.b.List.archive({ id: target.id }, { actor: { id: "a-keeper" } }));
        expect(deniedB).toMatchObject({ entity: "b.List", action: "archive", policies: ["bKeeper"] });
        expect(deniedB.message).toBe("b.List#archive is forbidden by policy :bKeeper");
        expect((await domain.a.List.archive({ id: list.id }, { actor: { id: "a-keeper" } })).archived).toBe(true);
        expect((await domain.b.List.archive({ id: target.id }, { actor: { id: "b-keeper" } })).archived).toBe(true);

        // A seam sees each call by its entity's FQN.
        expect(seen).toEqual(["b.List#create", "a.List#create", "a.List#archive", "b.List#archive"]);

        // The belongs-to from a.List loads b.List's record, through the read's `load` and through loadListFields.
        const archivedTarget = { ...target, archived: true };
        const [read] = await domain.a.List.read({ load: ["mirror"] }, anyone);
        expect(read.mirror).toEqual(archivedTarget);
        const [loaded] = await layer.transaction(async (tx: any) => loadListFields(tx, await tx.select(app.tables.list), ["mirror"]));
        expect(loaded.mirror).toEqual(archivedTarget);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});

describe("without table= on b.List", () => {
  test("build fails naming both entities by FQN and the table they share, and writes nothing", async () => {
    const other = await project();
    const file = join(other, "domain/b/list.mesh.mx");
    await writeFile(file, (await readFile(file, "utf8")).replace(' table="b_list"', ""));
    expect(mesh(other, "build")).toEqual({ code: 1, stdout: "", stderr:
      'domain/b/list.mesh.mx:1:1 error MESH_SCHEMA_DUPLICATE_TABLE Entities a.List (domain/a/list.mesh.mx) and b.List (domain/b/list.mesh.mx) both use the SQLite table "list"\n'
      + '  fix: Set table="..." on one of the two entities\n1 error, 0 warnings\n' });
    expect(await Bun.file(join(other, ".mesh/model.json")).exists()).toBe(false);
  }, 30_000);
});
