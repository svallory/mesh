// End to end: entities named after the globals generated code uses (`Promise`, `Partial`, `Date` with a
// `timestamp`, `Object`, `Record`, `Pick`, `Omit`, `Set`, `RegExp`, `Map`, `Boolean`), built by the real `mesh` command
// on the SQLite adapter, type-checked by tsc under the strictest flags and run on SQLite in memory. The fixture
// (`fixtures/generated-names/domain/globals`) gives each one a create with a `match=` attribute and a belongs-to to the
// next one in a ring, a rename with a check, a computed field and two policies; `Object` imports `Promise` as `now`,
// `Record` imports `Date` as `structuredClone` and `Set` imports `Map` as `isSystem`, and each counts that entity's rows
// in a `set` step. Generated code reaches the globals it needs through `.mesh/$globals.ts` under `$` names,
// `structuredClone` is shadowed by an import of that name, as a JavaScript global would be, and an import named like one of
// Mesh's functions is only that import: Mesh's functions are members of `Mesh`, which `Date` imports from meshfw.
// `Boolean` imports `Map` as `context` and a helper named `input`: inside its functions the scope roots
// shadow both, as parameters would, and its `when` step, which holds an after-write `run`, keeps its condition in a flag.
// Its computed field names two helpers only in types (`Count`, `typeof tally`), which the expressions file imports as types.
// Its `typed` check imports a helper under an alias (`shout as loudly`), reads the root `input` only in a type (`typeof
// input.name`, not the helper) and names Promise only as a type (`Promise | null`, the entity's record, not the global).
//
// The same project holds `fixtures/generated-names/domain/casing`: `entity :todo` and `entity :invoice_line`, names written in
// another casing than the one Mesh generates. Each is converted (`Todo`, `InvoiceLine`), and the converted name is its FQN, its
// table's source (`todo`, `invoice_line`), its files (`invoiceLine.actions.ts`), its barrel export, the name the other file
// imports and the name its own file relates to itself and calls itself by.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ForbiddenError, InvalidInputError } from "@meshfw/runtime";
import { freeGlobals } from "../../compiler/test/free-globals.ts";
import { closeTypeServer } from "../../compiler/test/type-server.ts";
import { mesh, project as sharedProject, repo, removeProjects } from "./project.ts";

afterAll(closeTypeServer);

const fixture = join(import.meta.dir, "fixtures/generated-names/domain");

/** The ring, in the order the fixture links it: each entity belongs to the next one. */
const RING = ["Promise", "Partial", "Date", "Object", "Record", "Pick", "Omit", "Set", "RegExp", "Map", "Boolean"] as const;
/** Each entity's generated files are named after it in lower camel case: `regExp.actions.ts`. */
const FILES: Record<(typeof RING)[number], string> = {
  Promise: "promise", Partial: "partial", Date: "date", Object: "object", Record: "record",
  Pick: "pick", Omit: "omit", Set: "set", RegExp: "regExp", Map: "map", Boolean: "boolean",
};
/** The module `casing`: each entity's converted name, to the name it is written with and the files and table that follow from the converted one. */
const CASING = {
  Todo: { written: "todo", files: "todo", table: "todo" },
  InvoiceLine: { written: "invoice_line", files: "invoiceLine", table: "invoice_line" },
} as const;
const CASED = Object.keys(CASING) as (keyof typeof CASING)[];

/** The project's `src/context.ts`: `context` and `actor` are typed by it, so a function reads only what it declares. */
const CONTEXT = `import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}
`;
/** The program the TypeScript checker resolves the generated tree's names in (`freeGlobals`). */
const TSCONFIG = {
  compilerOptions: { noEmit: true, strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true, allowImportingTsExtensions: true, types: ["bun"] },
  include: [".mesh/**/*.ts", "mesh.config.ts", "context.ts"],
};
/** Type-level checks through the specifiers: each entity's value and record type keep their names next to the globals. */
const CHECK = `import { Boolean, Date, Object, Promise, Set, type DateLoadable, type PromiseLoadable } from "#mesh/domain/globals";

export const at: globalThis.Date = null as unknown as Date["at"];
export const next: DateLoadable["next"] = null as unknown as Object;
export const shout: PromiseLoadable["shout"] = "";
export const counted: Object["counted"] | Set["counted"] = null;
export const values: [typeof Date, typeof Promise] = [Date, Promise];
export const seen: Boolean["seen"] = null;
// @ts-expect-error an entity's record is not the global it is named after
export const notGlobal: Date = new globalThis.Date();
`;
/** The same for the module `casing`: its specifier exports each entity under the converted name, value and record type. */
const CASING_CHECK = `import { InvoiceLine, Todo, type InvoiceLineLoadable, type TodoLoadable } from "#mesh/domain/casing";

export const lines: TodoLoadable["lines"] = [] as InvoiceLine[];
export const owner: InvoiceLineLoadable["todo"] = null as unknown as Todo;
export const quantity: number = null as unknown as InvoiceLine["quantity"];
export const cased: [typeof Todo, typeof InvoiceLine] = [Todo, InvoiceLine];
`;

const project = () => sharedProject({ prefix: "mesh-generated-names-", name: "generated-names", domain: fixture, files: { "context.ts": CONTEXT, "check.ts": CHECK, "casing-check.ts": CASING_CHECK, "tsconfig.json": `${JSON.stringify(TSCONFIG, null, 2)}\n` } });

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
afterAll(removeProjects);

const generated = (path: string) => readFile(join(root, ".mesh", path), "utf8");

describe("entities named after the globals generated code uses", () => {
  test("build writes every entity's files and $globals.ts, and the barrel exports each entity under its own name", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).sort();
    const perEntity = [
      ...RING.map((name) => `domain/globals/${FILES[name]}`),
      ...CASED.map((name) => `domain/casing/${CASING[name].files}`),
    ].flatMap((path) => ["actions", "expressions", "types", "validators"].map((kind) => `${path}.${kind}.ts`));
    expect(files).toEqual(
      ["$globals.ts", "binding.ts", "domain/casing/index.ts", "domain/globals/index.ts", ...perEntity, "domain/index.ts", "index.ts", "load.ts", "schema.ts"].sort(),
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

  test("an import named like one of Mesh's functions or structuredClone is the entity it imports", async () => {
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
    // Date's computed field reads `%.now`, the transaction's instant: the clock, as in a file that imports a helper `now`.
    expect(await generated("domain/globals/date.expressions.ts")).toContain("$.now(");
  });

  test("an import named like a scope root is the root inside a function, as a parameter of that name would be", async () => {
    // Boolean imports Map as `context` and a helper named `input`: its `set` step reads both roots, binds them from the
    // scope only, and the file imports neither Map's value nor the helper `input`, which no function names.
    const expressions = await generated("domain/globals/boolean.expressions.ts");
    expect(expressions).toContain("const { input, context } = $s;\n    return (() => `${input.loud}:${context.system ?? false}`)();");
    expect(expressions).not.toContain("const context:");
    expect(expressions).not.toContain("$globals$Map$value");
    expect(expressions).not.toMatch(/import [^;]*\binput\b[^;]*boolean\.helpers/);
    // The run step's block body reads `input` from the scope too, and names Promise, which it binds.
    expect(expressions).toContain("const { input } = $s;\n    const Promise: $globals$Promise$ReadOnly = $globals$Promise$value;");
    // Outside the functions the alias is the entity: `belongs-to :holder entity=context` is Map.
    expect(await generated("domain/globals/boolean.types.ts")).toMatch(/\bholder: \$globals\$Map\$/);
  });

  test("a helper a function names only in a type is imported as a type", async () => {
    // Boolean's computed `size` names `Count` and `typeof tally` and reads neither as a value: MX strips the types from
    // the node the front end reads, so the back end finds both in the printed function (the tsc run below checks it).
    const expressions = await generated("domain/globals/boolean.expressions.ts");
    expect(expressions).toContain('import type { Count, tally } from "../../../domain/globals/boolean.measure";');
    expect(expressions).toContain("const length: Count = $self.name.length;");
    expect(expressions).toContain("const same: typeof tally = (n) => n;");
  });

  test("an aliased helper keeps its alias, and a root or an entity named only in a type is bound (PR #94 review)", async () => {
    // Boolean's `typed` check. Before, the file imported `{ loudly }` (TS2305; Bun: "Export named 'loudly' not found"),
    // took `typeof input` for the helper and left `Promise` to the global (TS2314, since it is generic; the global check
    // below failed on it too).
    const expressions = await generated("domain/globals/boolean.expressions.ts");
    expect(expressions).toContain('import { shout as loudly } from "../../../domain/globals/boolean.helpers";');
    expect(expressions).toContain("type Promise as $globals$Promise$Record,");
    expect(expressions).toContain("const { input } = $s;\n    type Promise = $globals$Promise$Record;\n    return (() => {\n      const name: typeof input.name = loudly(\"x\");");
  });

  test("a when step that holds an after-write run keeps its condition without naming the global Boolean", async () => {
    const actions = await generated("domain/globals/boolean.actions.ts");
    expect(actions).toContain('$when0 = !!(await $expressions["flag.step.0.when"]($s));');
    expect(actions).not.toMatch(/(?<![\w$.])Boolean\(/);
  });

  test("no generated file but $globals.ts reads a global by its own name: the TypeScript checker resolves every name", async () => {
    // Object's `count` has a `when` step that holds an after-write `run`, so a flag written with the global `Boolean`
    // would resolve to it there (in Boolean's own files the name is the entity, which the tsc run below refuses).
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(root, ".mesh", name));
    expect(await freeGlobals(join(root, "tsconfig.json"), files)).toEqual([]);
  }, 60_000);

  test("tsc type-checks the generated tree and the specifiers under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "context.ts", "check.ts", "casing-check.ts", ...files,
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
        const computed = { Promise: ["shout", "PROMISE TWO"], Partial: ["size", 11], Date: ["past", true], Object: ["initial", "O"], Record: ["size", 10], Pick: ["named", true], Omit: ["shout", "OMIT TWO"], Set: ["size", 7], RegExp: ["matches", true], Map: ["initial", "M"], Boolean: ["size", 11] } as const;
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

        // Boolean's flag: the `set` step reads the roots `input` and `context` (not Map, imported as `context`), and the
        // after-write `run` reads the root `input` (not the helper named `input`) and creates a Promise.
        const boolean = rows.get("Boolean")!.id;
        const flagged = async () => (await globals.Promise.read({ filter: { name: { eq: "Promise flagged" } } }, anyone)).length;
        expect(await globals.Boolean.flag({ id: boolean, loud: false }, anyone)).toMatchObject({ seen: null });
        expect(await flagged()).toBe(0);
        expect(await globals.Boolean.flag({ id: boolean, loud: true }, anyone)).toMatchObject({ seen: "true:false" });
        expect(await globals.Boolean.flag({ id: boolean, loud: true }, { ...anyone, system: true })).toMatchObject({ seen: "true:true" });
        expect(await flagged()).toBe(2);
        // The alias is Map outside the functions: Boolean's holder is a Map.
        const map = rows.get("Map")!.id;
        expect(await globals.Boolean.hold({ id: boolean, holder: map }, anyone)).toMatchObject({ holderId: map });
        const [held] = await globals.Boolean.read({ filter: { id: { eq: boolean } }, load: ["holder"] }, anyone);
        expect(held.holder).toEqual({ ...rows.get("Map")!, name: "Map two" });
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});

describe("entities written in another casing: entity :todo and entity :invoice_line", () => {
  test("the model holds the converted name: the FQN and the table follow from it", async () => {
    const model = JSON.parse(await generated("model.json")) as { entities: { name: string; fqn: string; table: string; module: string; file: string }[] };
    const cased = model.entities.filter((entity) => entity.module === "casing").map(({ name, fqn, table, file }) => ({ name, fqn, table, file }));
    expect(cased.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "InvoiceLine", fqn: "casing.InvoiceLine", table: "invoice_line", file: "domain/casing/invoice-line.mesh.mx" },
      { name: "Todo", fqn: "casing.Todo", table: "todo", file: "domain/casing/todo.mesh.mx" },
    ]);
  });

  test("the barrel exports each entity under its converted name, from files named after it", async () => {
    const barrel = await generated("domain/casing/index.ts");
    for (const name of CASED) expect(barrel).toContain(`export { ${name}, load${name}Fields } from "./${CASING[name].files}.actions";`);
    // The spelling the file wrote is exported nowhere.
    expect(barrel).not.toContain("invoice_line");
    expect(await generated("domain/index.ts")).toContain('export * as casing from "./casing/index";');
    const types = await generated("domain/casing/invoiceLine.types.ts");
    expect(types).toMatch(/\bexport (interface|type) InvoiceLine\b/);
    expect(types).toMatch(/\btodoId: string;/);
  });

  test("a function names its own entity and the one it imports by the converted names", async () => {
    // Todo's `count` reads both entity values, and its `typed` check names its own record type.
    const todo = await generated("domain/casing/todo.expressions.ts");
    expect(todo).toContain("const Todo: $casing$Todo$ReadOnly = $casing$Todo$value;");
    expect(todo).toContain("const InvoiceLine: $casing$InvoiceLine$ReadOnly = $casing$InvoiceLine$value;");
    expect(todo).toContain('from "./invoiceLine.actions";');
    const line = await generated("domain/casing/invoiceLine.expressions.ts");
    expect(line).toContain("const none: InvoiceLine | Todo | null = null;");
    expect(line).toContain('import type { Todo as $casing$Todo$Record } from "./todo.actions";');
    expect(line).toContain("type Todo = $casing$Todo$Record;");
    expect(line).toContain("type InvoiceLine = $casing$InvoiceLine$Record;");
  });

  test("on SQLite each is stored in the table of its converted name, and creates, validates, loads and counts", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { casing } = await import(join(root, ".mesh/domain/index.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    expect(Object.keys(casing).sort()).toEqual(expect.arrayContaining(CASED));
    for (const name of CASED) {
      expect(Object.keys(app.tables)).toContain(CASING[name].table);
      expect(Object.keys(casing)).not.toContain(CASING[name].written);
    }
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const anyone = { actor: { id: "someone" } };
    const intruder = { actor: { id: "intruder" } };
    try {
      await app.bind(layer).run(async () => {
        // Todo relates to itself by its converted name, with no import.
        const top = await casing.Todo.create({ title: "Top", parent: null }, anyone);
        const child = await casing.Todo.create({ title: "Child", parent: top.id }, anyone);
        expect(child).toMatchObject({ title: "Child", parentId: top.id });
        const line = await casing.InvoiceLine.create({ quantity: 12, todo: top.id }, anyone);
        expect(line).toMatchObject({ quantity: 12, todoId: top.id });
        await casing.InvoiceLine.create({ quantity: 1, todo: top.id }, anyone);

        // Errors name the entity by its FQN, which carries the converted name.
        const denied = await rejection(casing.InvoiceLine.restock({ id: line.id, quantity: 3 }, intruder), ForbiddenError);
        expect(denied).toMatchObject({ entity: "casing.InvoiceLine", action: "restock", policies: ["keeper"] });
        expect((await rejection(casing.InvoiceLine.restock({ id: line.id, quantity: 0 }, anyone), InvalidInputError)).message).toContain("quantity");
        expect(await casing.InvoiceLine.restock({ id: line.id, quantity: 20 }, anyone)).toMatchObject({ id: line.id, quantity: 20 });
        expect(await casing.Todo.rename({ id: top.id, title: "Top two" }, anyone)).toMatchObject({ id: top.id, title: "Top two" });

        // Each relationship loads the other entity's records, and the rollup counts them.
        const [loaded] = await casing.Todo.read({ filter: { id: { eq: top.id } }, load: ["children", "lines", "lineCount"] }, anyone);
        expect(loaded.children).toEqual([child]);
        expect(loaded.lines.map((row: { quantity: number }) => row.quantity).sort((a: number, b: number) => a - b)).toEqual([1, 20]);
        expect(loaded.lineCount).toBe(2);
        const [read] = await casing.InvoiceLine.read({ filter: { id: { eq: line.id } }, load: ["todo", "bulk"] }, anyone);
        expect(read.todo).toEqual({ ...top, title: "Top two" });
        expect(read.bulk).toBe(true);

        // Todo's `set` step calls both entity values: two todos and two lines.
        expect((await casing.Todo.count({ id: top.id }, anyone)).counted).toBe(4);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});
