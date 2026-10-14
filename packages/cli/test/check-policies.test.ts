// CMP-21 end to end: `Mesh.checkPolicies` and `Mesh.can`, imported from meshfw by application code, asked about the
// tutorial's todo domain. The fixture (`fixtures/check-policies/domain/todo`) is the tutorial's `List` and `Todo` with
// the policies this version builds: a read policy that reads the record is the SQL evaluator's (M10), so `List` and `Todo`
// are read by any signed-in caller; a todo is created by its list's owner (a create policy reads `input.list`, not `&list`,
// which is empty before the input is applied, POL-08); and `Todo.complete`, `rename` and `destroy` are the list owner's. The project is built
// by the real `mesh` command on the SQLite adapter, type-checked by tsc under the strictest flags with an application
// module that runs the two documented examples (using-your-domain.md, "Asking instead of calling", and testing.md), and
// run on SQLite in memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForbiddenError, FrameworkError, type Decision } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/check-policies/domain");
const projects: string[] = [];

// The adapter is imported by a computed specifier so that tsc does not type-check its sources under the project's
// stricter flags; the generated code reads only `data` and its `name`.
const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "check-policies", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};
/** The tutorial's `src/context.ts`: the actor is required. */
const CONTEXT = `import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
export const bob = { id: "00000000-0000-4000-8000-000000000002" };
`;
/** Application code: the two documented examples, with what they log or assert returned, and what the types refuse. */
const APP = `import type { DataLayer, Decision } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { bind, connect, disconnect } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
import { alice, bob } from "./context";

/** using-your-domain.md, "Asking instead of calling": what the example logs. */
export async function asking(): Promise<[boolean, Decision["breakdown"], boolean]> {
  await connect();
  try {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const todo = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });

    const answer = await Mesh.checkPolicies(Todo.complete, { id: todo.id }, { actor: bob });
    return [answer.allowed, answer.breakdown, await Mesh.can(Todo.complete, { id: todo.id }, { actor: bob })];
  } finally {
    await disconnect();
  }
}

/** testing.md, "another actor may not complete a todo": what the test asserts on. */
export async function testing(db: DataLayer): Promise<{ allowed: boolean; decisive: boolean | undefined; can: boolean }> {
  const app = bind(db);
  return app.run(async () => {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const milk = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });

    const answer = await Mesh.checkPolicies(Todo.complete, { id: milk.id }, { actor: bob });
    return { allowed: answer.allowed, decisive: answer.breakdown[0]?.decisive, can: await Mesh.can(Todo.complete, { id: milk.id }, { actor: bob }) };
  });
}

/** Each action's own input, typed as the call's: a read with its \`load\`, an update with its key. */
export async function typed(list: string, todo: string): Promise<boolean[]> {
  return [
    await Mesh.can(Todo.read, { load: ["label", "list"], limit: 1 }, { actor: bob }),
    await Mesh.can(Todo.rename, { id: todo, title: "Buy oat milk" }, { actor: bob }),
    await Mesh.can(List.destroy, { id: list }, { actor: alice }),
    (await Mesh.checkPolicies(Todo.create, { title: "Buy bread", list }, { actor: alice })).allowed,
  ];
}

/** What the types refuse; never called. */
export async function refused(id: string): Promise<void> {
  // @ts-expect-error a field the entity does not have cannot be loaded
  await Mesh.can(Todo.read, { load: ["nope"] }, { actor: bob });
  // @ts-expect-error the title is a string
  await Mesh.can(Todo.rename, { id, title: 1 }, { actor: alice });
  // @ts-expect-error complete takes no input but its key
  await Mesh.checkPolicies(Todo.complete, { id, done: true }, { actor: alice });
  // @ts-expect-error the project's context requires the actor
  await Mesh.can(Todo.complete, { id }, {});
  // @ts-expect-error the actor's id is a string
  await Mesh.can(Todo.complete, { id }, { actor: { id: 1 } });
  // @ts-expect-error the context is the call's: it is required
  await Mesh.checkPolicies(Todo.complete, { id });
  // @ts-expect-error an entity value is not an action
  await Mesh.can(Todo, { id }, { actor: alice });
}
`;

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-policies-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  await writeFile(join(root, "context.ts"), CONTEXT);
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

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
const outcome = (work: Promise<unknown>): Promise<Outcome> => work.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

let root: string;
beforeAll(async () => {
  root = await project();
  const built = mesh(root, "build");
  // The one warning is the tutorial's: its `label` concatenates strings, which runs as plain TypeScript.
  expect(built).toMatchObject({ code: 0, stdout: "" });
  expect(built.stderr).toStartWith("domain/todo/todo.mesh.mx:17:14 warning MESH_EXPR_PLAIN this expression runs as plain TypeScript");
  expect(built.stderr).toEndWith("\n0 errors, 1 warning\n");
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

const OWNER = "({ actor }) => &list.ownerId === actor.id";

describe("Mesh.checkPolicies and Mesh.can from application code (CMP-21)", () => {
  test("tsc type-checks the generated tree and the application module under the strictest flags", async () => {
    const files = (await readdir(join(root, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      join(repo, "node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "--types", "bun",
      "mesh.config.ts", "context.ts", "app.ts", ...files,
    ], { cwd: root });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }, 60_000);

  test("the example of using-your-domain.md gives what the page shows, on the layer connect() opens", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { default: config } = await import(join(root, "mesh.config.ts"));
    const { createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    // The page's program runs on a database that has its tables: here, the one in memory `mesh.config.ts` opens.
    await createSchema(config.data, app.tables);
    const application = await import(join(root, "app.ts"));
    expect(await application.asking()).toEqual([
      false,
      [{ policy: "owner", kind: "authorize-if", check: OWNER, result: false, decisive: true }],
      false,
    ]);
  });

  test("the example of testing.md asserts what the page asserts, and the answers hold against the calls", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const { todo } = await import(join(root, ".mesh/domain/index.ts"));
    const application = await import(join(root, "app.ts"));
    const { alice, bob } = await import(join(root, "context.ts"));
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, app.tables);
    try {
      expect(await application.testing(db)).toEqual({ allowed: false, decisive: true, can: false });

      await app.bind(db).run(async () => {
        const [list] = await todo.List.read({}, { actor: alice });
        const [milk] = await todo.Todo.read({}, { actor: alice });
        // Alice owns the list: the owner policy's authorize-if held, and decided.
        expect(await Mesh.checkPolicies(todo.Todo.complete, { id: milk.id }, { actor: alice }))
          .toEqual({ allowed: true, breakdown: [{ policy: "owner", kind: "authorize-if", check: OWNER, result: true, decisive: true }] });
        // Bob's call is denied with the breakdown the question gave. (The docs' NotFoundError is for an action that runs as
        // one statement, which arrives with the SQL evaluator, M10: today `complete` reads the row and is forbidden.)
        const answer: Decision = await Mesh.checkPolicies(todo.Todo.complete, { id: milk.id }, { actor: bob });
        const denied = await outcome(todo.Todo.complete({ id: milk.id }, { actor: bob }));
        expect(denied).toEqual({ ok: false, error: expect.any(ForbiddenError) });
        expect((denied as { error: ForbiddenError }).error.breakdown).toEqual(answer.breakdown);
        // The question changed nothing: the todo is still not done.
        expect((await todo.Todo.read({}, { actor: alice })).map((row: { done: boolean }) => row.done)).toEqual([false]);

        // A read: whether it is allowed at all.
        expect(await Mesh.can(todo.Todo.read, {}, { actor: bob })).toBe(true);
        expect(await todo.Todo.read({}, { actor: bob })).toHaveLength(1);
        expect(await application.typed(list.id, milk.id)).toEqual([true, false, true, true]);

        // `pending` has a filter and a sort, which the SQL evaluator runs (M10): the call fails before its policies, and
        // the question throws what the call throws.
        const asked = await outcome(Mesh.can(todo.Todo.pending, {}, { actor: bob }));
        const called = await outcome(todo.Todo.pending({}, { actor: bob }));
        expect(asked).toEqual({ ok: false, error: expect.any(FrameworkError) });
        expect(((asked as { error: Error }).error).message).toBe(((called as { error: Error }).error).message);
        expect(((asked as { error: Error }).error).message).toContain("M10");
      });
    } finally {
      await db.close();
    }
  });
});

// The todo's create policy (POL-08): a create has no stored list yet, so `Todo`'s `policy :ownerCreates` reads `input.list`
// and looks the list up. The owner policy keeps the writes on a todo that exists; read stays `signedIn` until M10.
describe("the todo's create policy reads the list from the input (POL-08)", () => {
  const MISSING = "00000000-0000-4000-8000-0000000000ff";

  /** Runs `work` on a fresh in-memory database that has alice's list "Groceries"; `todo` is the generated barrel. */
  async function withList(work: (todo: any, list: { id: string }, db: any) => Promise<void>): Promise<void> {
    const app = await import(join(root, ".mesh/index.ts"));
    const { todo } = await import(join(root, ".mesh/domain/index.ts"));
    const { alice } = await import(join(root, "context.ts"));
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, app.tables);
    try {
      await app.bind(db).run(async () => {
        const list = await todo.List.create({ name: "Groceries" }, { actor: alice });
        await work(todo, list, db);
      });
    } finally {
      await db.close();
    }
  }

  const forbiddenBy = (result: Outcome): ForbiddenError => {
    expect(result).toEqual({ ok: false, error: expect.any(ForbiddenError) });
    return (result as { error: ForbiddenError }).error;
  };

  test("the list's owner creates a todo", async () => {
    const { alice } = await import(join(root, "context.ts"));
    await withList(async (todo, list) => {
      const milk = await todo.Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });
      expect(milk).toMatchObject({ title: "Buy milk", listId: list.id });
      expect(await todo.Todo.read({}, { actor: alice })).toHaveLength(1);
    });
  });

  test("another actor is forbidden, the error names the policy, and nothing is written", async () => {
    const { alice, bob } = await import(join(root, "context.ts"));
    await withList(async (todo, list) => {
      const error = forbiddenBy(await outcome(todo.Todo.create({ title: "Buy milk", list: list.id }, { actor: bob })));
      expect(error).toMatchObject({ entity: "todo.Todo", action: "create", policies: ["ownerCreates"], reason: "failed" });
      expect(error.breakdown).toMatchObject([{ policy: "ownerCreates", kind: "authorize-if", result: false, decisive: true }]);
      expect(await todo.Todo.read({}, { actor: alice })).toEqual([]);
    });
  });

  test("an input.list that names no list is forbidden, even for an actor who owns other lists", async () => {
    const { alice } = await import(join(root, "context.ts"));
    await withList(async (todo) => {
      const error = forbiddenBy(await outcome(todo.Todo.create({ title: "Buy milk", list: MISSING }, { actor: alice })));
      expect(error).toMatchObject({ action: "create", policies: ["ownerCreates"] });
      expect(await todo.Todo.read({}, { actor: alice })).toEqual([]);
    });
  });

  test("Mesh.checkPolicies and Mesh.can give the same answers as the calls", async () => {
    const { alice, bob } = await import(join(root, "context.ts"));
    const { Mesh } = await import(Bun.resolveSync("meshfw", root));
    await withList(async (todo, list) => {
      const input = { title: "Buy milk", list: list.id };
      expect(await Mesh.can(todo.Todo.create, input, { actor: alice })).toBe(true);
      expect(await Mesh.can(todo.Todo.create, input, { actor: bob })).toBe(false);
      expect(await Mesh.can(todo.Todo.create, { ...input, list: MISSING }, { actor: alice })).toBe(false);
      const answer = await Mesh.checkPolicies(todo.Todo.create, input, { actor: bob });
      expect(answer).toMatchObject({ allowed: false, breakdown: [{ policy: "ownerCreates", result: false, decisive: true }] });
    });
  });

  test("the owner still reads, updates and destroys their todos, and another actor still cannot", async () => {
    const { alice, bob } = await import(join(root, "context.ts"));
    await withList(async (todo, list) => {
      const milk = await todo.Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });
      const bread = await todo.Todo.create({ title: "Buy bread", list: list.id }, { actor: alice });

      expect(await todo.Todo.read({}, { actor: alice })).toHaveLength(2);

      // Bob may not update or destroy: the owner policy covers both, and the todo is in alice's list.
      expect(forbiddenBy(await outcome(todo.Todo.rename({ id: milk.id, title: "Buy oat milk" }, { actor: bob }))).policies).toEqual(["owner"]);
      expect(forbiddenBy(await outcome(todo.Todo.complete({ id: milk.id }, { actor: bob }))).policies).toEqual(["owner"]);
      expect(forbiddenBy(await outcome(todo.Todo.destroy({ id: milk.id }, { actor: bob }))).policies).toEqual(["owner"]);
      expect((await todo.Todo.read({}, { actor: alice })).map((row: { title: string }) => row.title).sort()).toEqual(["Buy bread", "Buy milk"]);

      // Alice may.
      expect(await todo.Todo.rename({ id: milk.id, title: "Buy oat milk" }, { actor: alice })).toMatchObject({ title: "Buy oat milk" });
      expect(await todo.Todo.complete({ id: milk.id }, { actor: alice })).toMatchObject({ done: true });
      await todo.Todo.destroy({ id: bread.id }, { actor: alice });
      expect((await todo.Todo.read({}, { actor: alice })).map((row: { id: string }) => row.id)).toEqual([milk.id]);
    });
  });
});
