// PRJ-20 end to end: entities named after the globals generated code uses (`Promise`, `Partial`, `Date` with a
// `timestamp`, `Object`, `Record`, `Pick`, `Omit`, `Set`, `RegExp`, `Map`), built by the real `mesh` command on the
// SQLite adapter, type-checked by tsc under the strictest flags and run on SQLite in memory. The fixture
// (`fixtures/generated-names/domain/globals`) gives each one a create with a `match=` attribute and a belongs-to to the
// next one in a ring, a rename with a check, a computed field and two policies; `Object` imports `Promise` as `now`,
// `Record` imports `Date` as `structuredClone` and `Set` imports `Map` as `isSystem`, and each counts that entity's rows
// in a `set` step. Generated code reaches the globals it needs through `.mesh/$globals.ts` under `$` names, and a
// registered function or `structuredClone` is shadowed by an import of that name, as a JavaScript global would be.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForbiddenError, InvalidInputError } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/generated-names/domain");
const projects: string[] = [];

/** The ring, in the order the fixture links it: each entity belongs to the next one. */
const RING = ["Promise", "Partial", "Date", "Object", "Record", "Pick", "Omit", "Set", "RegExp", "Map"] as const;
/** Each entity's generated files are named after it in lower camel case: `regExp.actions.ts`. */
const FILES: Record<(typeof RING)[number], string> = {
  Promise: "promise", Partial: "partial", Date: "date", Object: "object", Record: "record",
  Pick: "pick", Omit: "omit", Set: "set", RegExp: "regExp", Map: "map",
};

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "generated-names", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};
/** Type-level checks through the specifiers: each entity's value and record type keep their names next to the globals. */
const CHECK = `import { Date, Object, Promise, Set, type DateLoadable, type PromiseLoadable } from "#mesh/domain/globals";

export const at: globalThis.Date = null as unknown as Date["at"];
export const next: DateLoadable["next"] = null as unknown as Object;
export const shout: PromiseLoadable["shout"] = "";
export const counted: Object["counted"] | Set["counted"] = null;
export const values: [typeof Date, typeof Promise] = [Date, Promise];
// @ts-expect-error an entity's record is not the global it is named after
export const notGlobal: Date = new globalThis.Date();
`;

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh-generated-names-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await writeFile(join(root, "check.ts"), CHECK);
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

describe("entities named after the globals generated code uses", () => {
  test("build writes every entity's files and $globals.ts, and the barrel exports each entity under its own name", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).sort();
    const perEntity = RING.flatMap((name) => ["actions", "expressions", "types", "validators"].map((kind) => `domain/globals/${FILES[name]}.${kind}.ts`));
    expect(files).toEqual(
      ["$globals.ts", "binding.ts", "domain/globals/index.ts", ...perEntity, "domain/index.ts", "index.ts", "load.ts", "schema.ts"].sort(),
    );
    const barrel = await generated("domain/globals/index.ts");
    for (const name of RING) expect(barrel).toContain(`export { ${name}, load${name}Fields } from "./${FILES[name]}.actions";`);
    expect(await generated("$globals.ts")).toContain("export const $Date = Date;\nexport type $Date = Date;\n");
  });

  test("a generated file names a global only through its $ alias", async () => {
    const date = await generated("domain/globals/date.types.ts");
    expect(date).toContain('import type { $Date, $Pick } from "../../$globals";');
    expect(date).toMatch(/\bat: \$Date;/);
    const actions = await generated("domain/globals/date.actions.ts");
    expect(actions).toContain('from "../../$globals";');
    expect(actions).toContain("$Object.freeze(");
    expect(actions).not.toMatch(/(?<![\w$.])(Object|Promise|Omit|Partial|Pick)\.|(?<![\w$.])(Promise|Omit|Partial|Pick)</);
    const validators = await generated("domain/globals/regExp.validators.ts");
    expect(validators).toContain("new $RegExp(");
    expect(validators).not.toMatch(/(?<![\w$.])new RegExp\(/);
    const binding = await generated("binding.ts");
    expect(binding).toContain('import type { $Partial, $Promise } from "./$globals";');
  });

  test("an import named like a registered function or structuredClone is the entity it imports", async () => {
    // Object imports Promise as `now`: its expressions bind `now` to Promise's value, never to the clock.
    const object = await generated("domain/globals/object.expressions.ts");
    expect(object).toContain("const now: $globals$Promise$ReadOnly = $globals$Promise$value;");
    expect(object).not.toContain("$.now(");
    // Record imports Date as `structuredClone`: no copy function is bound under that name.
    const record = await generated("domain/globals/record.expressions.ts");
    expect(record).toContain("const structuredClone: $globals$Date$ReadOnly = $globals$Date$value;");
    expect(record).not.toContain("$cloneValue");
    // Set imports Map as `isSystem`.
    const set = await generated("domain/globals/set.expressions.ts");
    expect(set).toContain("const isSystem: $globals$Map$ReadOnly = $globals$Map$value;");
    expect(set).not.toContain("$.isSystem");
    // Date has no such import, so its computed field's `now()` is the clock.
    expect(await generated("domain/globals/date.expressions.ts")).toContain("$.now(");
  });

  test("tsc type-checks the generated tree and the specifiers under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "check.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  test("on SQLite every entity creates, validates, renames under its policies, loads and counts", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { globals } = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const anyone = { actor: { id: "someone" } };
    const intruder = { actor: { id: "intruder" } };
    try {
      await app.bind(layer).run(async () => {
        // Each entity is created after the one it belongs to, so Map's link back to Promise stays null.
        const rows = new Map<string, Record<string, unknown> & { id: string }>();
        let next: string | null = null;
        for (const name of [...RING].reverse()) {
          const row: Record<string, unknown> & { id: string } = await globals[name].create({ name: `${name} one`, next }, anyone);
          expect(row).toMatchObject({ name: `${name} one`, nextId: next });
          rows.set(name, row);
          next = row.id;
        }
        expect(rows.get("Date")!.at).toBeInstanceOf(globalThis.Date);

        for (const name of RING) {
          // The `match=/^[A-Z]/` validator runs through `$RegExp`.
          const invalid = await rejection(globals[name].create({ name: "lower", next: null }, anyone), InvalidInputError);
          expect(invalid.message).toContain("name");

          const id = rows.get(name)!.id;
          const denied = await rejection(globals[name].rename({ id, name: `${name} two` }, intruder), ForbiddenError);
          expect(denied).toMatchObject({ entity: `globals.${name}`, action: "rename", policies: ["keeper"] });
          await rejection(globals[name].rename({ id, name: "Ab" }, anyone), InvalidInputError);
          expect(await globals[name].rename({ id, name: `${name} two` }, anyone)).toMatchObject({ id, name: `${name} two` });
        }

        // Each belongs-to loads the next entity's record, through a read's load; Map, created first, links to nothing.
        for (const name of RING) {
          const [read] = await globals[name].read({ load: ["next"] }, anyone);
          const target = RING[RING.indexOf(name) + 1];
          expect(read.next).toEqual(target === undefined ? null : { ...rows.get(target)!, name: `${target} two` });
        }

        // Each entity's computed field, through a read's load.
        const computed = { Promise: ["shout", "PROMISE TWO"], Partial: ["size", 11], Date: ["past", true], Object: ["initial", "O"], Record: ["size", 10], Pick: ["named", true], Omit: ["shout", "OMIT TWO"], Set: ["size", 7], RegExp: ["matches", true], Map: ["initial", "M"] } as const;
        for (const name of RING) {
          const [field, value] = computed[name];
          const [read] = await globals[name].read({ load: [field] }, anyone);
          expect(read[field]).toBe(value);
        }

        // Rows the three aliased entities count: two more Maps, one more Date.
        await globals.Map.create({ name: "Map two", next: null }, anyone);
        await globals.Map.create({ name: "Map three", next: null }, anyone);
        await globals.Date.create({ name: "Date two", next: null }, anyone);
        expect((await globals.Object.count({ id: rows.get("Object")!.id }, anyone)).counted).toBe(1);
        expect((await globals.Record.count({ id: rows.get("Record")!.id }, anyone)).counted).toBe(2);
        expect((await globals.Set.count({ id: rows.get("Set")!.id }, anyone)).counted).toBe(3);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
