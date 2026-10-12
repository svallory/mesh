// ENT-18 end to end: any member name but `__proto__`. Every name the build used to refuse (the members of
// Object.prototype and of a function) names an attribute, an action and a policy, built by the real `mesh` command on
// the SQLite adapter, type-checked by tsc under the strictest flags and run on SQLite in memory. The fixture
// (`fixtures/member-names/domain/names`) has four entities:
// - Fields: one attribute per name, a computed field reading them all, a create with a check, an update with a check
//   per name and an update whose `set` steps write every one of them;
// - Calls: one action per name (a create, two reads, a destroy, updates), and `_archive`, `archive_`, `__archive__`,
//   `_1st` and `__2`;
// - Guards: one policy per name, each denying the label that is its name;
// - Loads: a belongs-to named `constructor` and computed fields named `toString` and `valueOf`, loaded by a read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForbiddenError, InvalidInputError } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/member-names/domain");
const projects: string[] = [];

/** The names the build refused before ENT-18; each names an attribute of Fields, an action of Calls and a policy of Guards. */
const NAMES = [
  "constructor", "prototype", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString",
  "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
] as const;
/** Fields' attributes that are strings (`valueOf` is an integer), and the two of them that are required. */
const STRINGS = NAMES.filter((name) => name !== "valueOf");
const REQUIRED = { constructor: "c", toString: "t" };
/** Calls' updates, each of which writes its own name to `last`. */
const UPDATES = [
  "prototype", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__",
  "__defineSetter__", "__lookupGetter__", "_archive", "archive_", "__archive__", "_1st", "__2",
] as const;

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "member-names", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};
/** Type-level checks through the specifiers: each name is the member it declares, never the inherited one. */
const CHECK = `import { Calls, Fields, Loads, type EditFieldsInput, type FieldsFilter, type LoadsLoadable } from "#mesh/domain/names";

export const made: Fields["constructor"] = "";
export const text: string = null as unknown as Fields["toString"];
export const count: number | null = null as unknown as Fields["valueOf"];
export const shout: LoadsLoadable["toString"] = "";
export const linked: LoadsLoadable["constructor"] = null as unknown as Fields | null;
// Each action is a method of the entity value under its name as written.
export const methods = [Calls.constructor, Calls.toString, Calls.valueOf, Calls.__lookupSetter__, Calls.prototype, Calls._archive, Calls.archive_, Calls.__archive__, Calls._1st, Calls.__2, Fields.edit, Loads.read];
// TypeScript gives every object the members of its Object interface, so an input that leaves out an optional one of them
// is not assignable to the input type: the caller passes it, as undefined when it has no value.
export const edit: EditFieldsInput = {
  id: "", toString: "t", constructor: undefined, hasOwnProperty: undefined, isPrototypeOf: undefined,
  propertyIsEnumerable: undefined, toLocaleString: undefined, valueOf: undefined,
};
// @ts-expect-error \`constructor\`, left out, is read as the inherited Function
export const omitted: EditFieldsInput = { id: "", toString: "t" };
// A filter likewise: the columns named like members of the Object interface are given, as undefined when they compare
// nothing.
const unset = {
  constructor: undefined, toString: undefined, toLocaleString: undefined, valueOf: undefined, hasOwnProperty: undefined,
  isPrototypeOf: undefined, propertyIsEnumerable: undefined,
} as const;
export const byIdGiven: FieldsFilter = { ...unset, id: { eq: "x" } };
// @ts-expect-error \`constructor\`, left out, is read as the inherited Function
export const byId: FieldsFilter = { id: { eq: "x" } };
export const reads = () => [
  Fields.read({ filter: { ...unset, id: { eq: "x" } } }),
  Fields.read({ filter: { ...unset, toString: { eq: "t" } }, sort: ["-toString"] }),
  Fields.read({ filter: { or: [{ ...unset, toString: { eq: "t" } }, { ...unset, constructor: { eq: "c" } }] } }),
  // A filter of an entity with no such column leaves out what it does not compare.
  Calls.read({ filter: { last: { eq: "x" } } }),
];
`;

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh-member-names-"));
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

describe("members named like members of Object.prototype or of a function (ENT-18)", () => {
  test("each action is a method under its name as written, with its own input type and validator", async () => {
    const actions = await generated("domain/names/calls.actions.ts");
    for (const [method, type, validator] of [
      ["constructor", "ConstructorCallsInput", "constructorCallsInputSchema"],
      ["__lookupSetter__", "__LookupSetterCallsInput", "__lookupSetterCallsInputSchema"],
      ["_archive", "_ArchiveCallsInput", "_archiveCallsInputSchema"],
      ["archive_", "ArchiveCallsInput", "archiveCallsInputSchema"],
      ["__archive__", "__ArchiveCallsInput", "__archiveCallsInputSchema"],
      // A digit has no lower case: the validator differs from the type by its suffix alone.
      ["_1st", "_1stCallsInput", "_1stCallsInputSchema"],
      ["__2", "__2CallsInput", "__2CallsInputSchema"],
    ]) {
      expect(actions).toMatch(new RegExp(`async ${method}\\(\\s*input: ${type},`));
      expect(actions).toContain(`$castInput(layer, ${validator}, input)`);
    }
    const validators = await generated("domain/names/calls.validators.ts");
    for (const name of ["_archiveCallsInputSchema", "archiveCallsInputSchema", "__archiveCallsInputSchema", "_1stCallsInputSchema", "__2CallsInputSchema", "callsFilterSchema", "callsSortSchema"])
      expect(validators).toMatch(new RegExp(`export const ${name}[: ]`));
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

  test("on SQLite every name works as an attribute, an action, a policy, a relationship and a computed field", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { names } = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const anyone = { actor: { id: "someone" } };
    try {
      await app.bind(layer).run(async () => {
        // ---- attributes ----------------------------------------------------------------------------------------
        // A create that sends only the required inputs: every other one, left out, is null, never the inherited member.
        const bare = await names.Fields.create({ ...REQUIRED }, anyone);
        expect(bare).toEqual({ id: bare.id, ...Object.fromEntries(NAMES.map((name) => [name, null])), ...REQUIRED });
        expect(Object.getPrototypeOf(bare)).toBe(Object.prototype);
        // JavaScript calls a record's `toString` to make it a string, and here that is the column (the cost ENT-18 accepts).
        expect(() => String(bare)).toThrow(TypeError);
        expect(() => `${bare}`).toThrow(TypeError);

        const full = Object.fromEntries(NAMES.map((name, index) => [name, name === "valueOf" ? index : name]));
        const all = await names.Fields.create(full, anyone);
        expect(all).toEqual({ id: all.id, ...full });

        // An update that sends one input changes that column only.
        let current: Record<string, unknown> = all;
        for (const name of NAMES) {
          const value = name === "valueOf" ? 99 : `new ${name}`.slice(0, 20);
          const edited = await names.Fields.edit({ id: all.id, [name]: value }, anyone);
          current = { ...current, [name]: value };
          expect(edited).toEqual(current);
        }

        // An input given as undefined is one left out, whatever its name: the column keeps its value.
        expect(await names.Fields.edit({ id: all.id, toString: undefined, constructor: undefined, valueOf: undefined }, anyone)).toEqual(current);

        // A `set` step writes each; `toString` and `valueOf` read the stored record's own column.
        const stamped = await names.Fields.stamp({ id: bare.id, mark: "m" }, anyone);
        expect(stamped).toEqual({ id: bare.id, ...Object.fromEntries(NAMES.map((name) => [name, "m"])), toString: "t!", valueOf: 1 });

        // A read filters and sorts by each, and the computed fields read them all.
        for (const name of NAMES) {
          const [found, ...rest] = await names.Fields.read({ filter: { [name]: { eq: current[name] } }, load: ["joined", "same"] }, anyone);
          expect(rest).toEqual([]);
          expect(found.id).toBe(all.id);
          expect(found.joined).toBe(NAMES.map((member) => current[member]).join("|"));
          expect(found.same).toBe(false);
          // The two rows differ in every column, so one order is the other reversed.
          const ids = async (sort: string) => (await names.Fields.read({ sort: [sort] }, anyone)).map((row: { id: string }) => row.id);
          const ascending = await ids(name);
          expect(ascending.toSorted()).toEqual([all.id, bare.id].toSorted());
          expect(await ids(`-${name}`)).toEqual(ascending.toReversed());
        }

        // A filter that gives a column as undefined leaves it out.
        const byId = await names.Fields.read({ filter: { id: { eq: all.id }, toString: undefined, constructor: undefined } }, anyone);
        expect(byId.map((row: { id: string }) => row.id)).toEqual([all.id]);
        const either = await names.Fields.read({ filter: { or: [{ toString: { eq: current.toString } }, { constructor: { eq: stamped.constructor }, valueOf: undefined }] }, sort: ["id"] }, anyone);
        expect(either.map((row: { id: string }) => row.id)).toEqual([all.id, bare.id].toSorted());

        // Validation: the attribute rules and the checks name the member.
        for (const name of STRINGS) {
          const invalid = await rejection(names.Fields.create({ ...REQUIRED, [name]: "x".repeat(21) }, anyone), InvalidInputError);
          expect(invalid.issues.map((issue) => issue.path)).toEqual([[name]]);
          const bad = await rejection(names.Fields.edit({ id: all.id, [name]: "bad" }, anyone), InvalidInputError);
          expect(bad.issues.map((issue) => [issue.label, issue.code])).toEqual([[`not_bad_${name.replace(/^_/, "")}`, "bad"]]);
        }
        expect((await rejection(names.Fields.edit({ id: all.id, valueOf: 13 }, anyone), InvalidInputError)).issues.map((issue) => issue.label)).toEqual(["not_bad_valueOf"]);
        expect((await rejection(names.Fields.create({ ...REQUIRED, valueOf: -1 }, anyone), InvalidInputError)).issues.map((issue) => issue.path)).toEqual([["valueOf"]]);
        expect((await rejection(names.Fields.create({ constructor: "c" }, anyone), InvalidInputError)).issues.map((issue) => issue.path)).toEqual([["toString"]]);
        // A key the caller sends that names no input is refused, whatever its name.
        const sentProto = { ...REQUIRED, ...JSON.parse('{"__proto__": "x"}') };
        expect((await rejection(names.Fields.create(sentProto, anyone), InvalidInputError)).message).toContain("__proto__");
        expect((await rejection(names.Calls.constructor({ toString: "x" }, anyone), InvalidInputError)).message).toContain("toString");

        // A create given an optional input as undefined fills it as one left out (a third row: after the reads above).
        const given = await names.Fields.create({ ...REQUIRED, hasOwnProperty: undefined, valueOf: undefined }, anyone);
        expect(given).toEqual({ id: given.id, ...Object.fromEntries(NAMES.map((name) => [name, null])), ...REQUIRED });

        // ---- actions -------------------------------------------------------------------------------------------
        const made = await names.Calls.constructor({}, anyone);
        expect(made).toEqual({ id: made.id, last: null });
        for (const action of UPDATES) expect(await names.Calls[action]({ id: made.id }, anyone)).toEqual({ id: made.id, last: action });
        expect(await names.Calls.toString({}, anyone)).toEqual([{ id: made.id, last: "__2" }]);
        expect(await names.Calls.valueOf({ filter: { last: { eq: "__2" } } }, anyone)).toEqual([{ id: made.id, last: "__2" }]);
        expect(await app.privileged(names.Calls).toString({})).toEqual([{ id: made.id, last: "__2" }]);
        expect(await app.privileged(names.Calls).valueOf({})).toEqual([{ id: made.id, last: "__2" }]);
        expect(await names.Calls.__lookupSetter__({ id: made.id }, anyone)).toBeUndefined();
        expect(await names.Calls.read({}, anyone)).toEqual([]);

        // ---- policies ------------------------------------------------------------------------------------------
        // Even-numbered names guard the create (reading the input), odd-numbered ones the update (reading the record).
        for (const [index, name] of NAMES.entries()) {
          if (index % 2 === 0) {
            const denied = await rejection(names.Guards.create({ label: name }, anyone), ForbiddenError);
            expect(denied).toMatchObject({ entity: "names.Guards", action: "create", policies: [name] });
          } else {
            const guard = await names.Guards.create({ label: name }, anyone);
            const denied = await rejection(names.Guards.relabel({ id: guard.id, label: "other" }, anyone), ForbiddenError);
            expect(denied).toMatchObject({ entity: "names.Guards", action: "relabel", policies: [name] });
          }
        }
        const free = await names.Guards.create({ label: "free" }, anyone);
        expect(await names.Guards.relabel({ id: free.id, label: "constructor" }, anyone)).toEqual({ id: free.id, label: "constructor" });

        // ---- a relationship and computed fields ----------------------------------------------------------------
        const linked = await names.Loads.create({ label: "linked", constructor: all.id }, anyone);
        const alone = await names.Loads.create({ label: "alone" }, anyone);
        expect(alone).toEqual({ id: alone.id, label: "alone", constructorId: null });
        const loaded = await names.Loads.read({ sort: ["label"], load: ["constructor", "toString", "valueOf"] }, anyone);
        expect(loaded).toEqual([
          { ...alone, constructor: null, toString: "ALONE", valueOf: "ALONE:none" },
          { ...linked, constructor: current, toString: "LINKED", valueOf: `LINKED:${current.toString}` },
        ]);
        // Not loaded, none of them is on the record: the row's own members are its columns.
        const [plain] = await names.Loads.read({ filter: { id: { eq: alone.id } } }, anyone);
        expect(Object.keys(plain).sort()).toEqual(["constructorId", "id", "label"]);
      });
    } finally {
      await layer.close();
    }
  }, 60_000);
});
