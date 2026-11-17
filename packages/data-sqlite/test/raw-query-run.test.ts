// `query` of the generated `#mesh` (ADR-0087), end to end: a project built, generated with data-sqlite's real manifest
// (so `rawSql` is true and `binding.ts` exports `query`), and run on a `:memory:` layer. The helpers import `query` from
// the generated index, so the import cycle helper -> index -> binding -> domain -> entity -> helper is exercised, and the
// entity file reaches a raw query only through them: a check, a computed field, a read policy and a write policy each
// call one, and so do the seams and the two kinds of handler.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, InvalidInputError, Mesh, type EventsModule } from "@meshfw/runtime";
import { testBus } from "@meshfw/runtime/testing";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const task = `import { Mesh } from "meshfw"
import { TaskAdded } from "./task-added.mesh.mx"
import { depthProbe, mayMove, mayRead, underItself } from "./task-helpers"

entity :Task table="tasks"
  attributes
    uuid :id primary-key
    string :title
    string :parentId nullable
  computed
    integer :depth() { return depthProbe(&title) }
  actions auto=[:read]
    create :add
      input
        &title
        &parentId
      do
        publish=({ self }) => new TaskAdded({ id: self.id })
    update :move
      input
        &parentId
      validate
        check :noCycle that=async ({ input }) => !(await underItself(&id, input.parentId ?? null)) code="task.cycle" message="a task cannot move under itself or its descendant"
  policies
    policy :adders actions=[&add]
      authorize-if=() => true
    policy :movers actions=[&move]
      authorize-if=async ({ actor }) => await mayMove(actor.id)
    policy :readers actions=[&read]
      authorize-if=({ actor }) => mayRead(actor.id)
`;

const added = `event :taskAdded
  string :id
`;

const helpers = `import { query } from "../../.mesh/index.ts";

/** True when \`task\` is \`newParent\` or one of its ancestors: a move under it would make a cycle. */
export async function underItself(task: string, newParent: string | null): Promise<boolean> {
  if (newParent === null) return false;
  const rows = await query\`
    with recursive up(id) as (
      select \${newParent}
      union
      select t."parentId" from tasks t join up on t.id = up.id
    )
    select 1 as hit from up where id = \${task} limit 1\`;
  return rows.length > 0;
}

export const hooks: { checks: unknown[]; caught: unknown[] } = { checks: [], caught: [] };

/** The write policy of \`move\`: "broken" runs a statement the database rejects and catches it; anyone else reads and passes. */
export async function mayMove(actor: string | undefined): Promise<boolean> {
  if (actor === "broken") {
    try { await query\`select * from no_such_table\`; } catch (error) { hooks.caught.push(error); }
    return false;
  }
  hooks.checks.push(await query\`select count(*) as n from tasks\`);
  return true;
}

/** A read policy's helper: for "probe" it makes a raw query, which throws while the policy is evaluated. */
export function mayRead(actor: string | undefined): boolean {
  if (actor === "probe") void query\`select 1\`;
  return true;
}

/** A computed field's helper: for a task titled "probe" it makes a raw query, which throws while the field is evaluated. */
export function depthProbe(title: string): number {
  if (title === "probe") void query\`select 1\`;
  return 0;
}
`;

const SQLITE: ResolvedConfig["data"] = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: { file: ":memory:" } };

let dir: string;
let mesh: any;
let Task: any;
let TaskAdded: any;
let hooks: { checks: unknown[]; caught: unknown[] };
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".scratch-raw-query-run-"));
  await Bun.write(join(dir, "src/domain/task-helpers.ts"), helpers);
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: [
    { file: "src/domain/task.mesh.mx", source: task },
    { file: "src/domain/task-added.mesh.mx", source: added },
  ] });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  // `binding.ts` imports the project's config: one whose layer is made per test through `connect()`.
  await Bun.write(join(dir, "mesh.config.ts"), [
    'import { sqlite } from "@meshfw/data-sqlite";',
    'import { testBus } from "@meshfw/runtime/testing";',
    'export default { data: sqlite({ file: ":memory:" }), events: { bus: testBus(), load: async () => ({}) } };',
    "",
  ].join("\n"));
  mesh = await import(join(dir, ".mesh/index.ts"));
  ({ Task, TaskAdded } = await import(join(dir, ".mesh/domain/index.ts")));
  ({ hooks } = await import(join(dir, "src/domain/task-helpers.ts")));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** `Mesh.can`, untyped: the generated project is imported untyped, as `check-policies.test.ts` does. */
const can = Mesh.can as (action: unknown, input: unknown, context: unknown) => Promise<boolean>;
const alice = { actor: { id: "alice" } };
const ROLLED_BACK = "A call joined to this transaction failed, so the transaction is rolled back even though its callback caught the error";
const marked = (mark: string) =>
  `query was called while ${mark} is evaluated: a computed field and a read policy read the record and what it loads, and run no raw query. Run it from a step, a check or a write policy, through a helper`;

/** A fresh `:memory:` layer with the schema, bound with `options`; closed after `run`. */
async function withBinding(run: (binding: any, layer: ReturnType<typeof sqlite>) => Promise<void>, options: object = {}) {
  const layer = sqlite({ file: ":memory:" });
  try {
    await createSchema(layer, mesh.tables);
    const binding = mesh.bind(layer, options);
    await run(binding, layer);
  } finally { await layer.close(); }
}

/** a <- b <- c: c's parent is b, b's parent is a. */
async function chain(binding: any) {
  return binding.run(async () => {
    const a = await Task.add({ title: "a", parentId: null }, alice);
    const b = await Task.add({ title: "b", parentId: a.id }, alice);
    const c = await Task.add({ title: "c", parentId: b.id }, alice);
    return { a, b, c };
  });
}

describe("the generated #mesh exports query", () => {
  test("the cycle check: a move under a descendant is refused, a legal move passes (a check's helper joins the action)", async () => {
    await withBinding(async (binding) => {
      const { a, b, c } = await chain(binding);
      const refused = await binding.run(() => Task.move({ id: a.id, parentId: c.id }, alice)).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(InvalidInputError);
      expect((refused as InvalidInputError).issues.map((issue) => issue.code)).toEqual(["task.cycle"]);
      expect((await binding.run(() => Task.move({ id: c.id, parentId: a.id }, alice))).parentId).toBe(a.id);
      expect((await binding.run(() => Task.move({ id: b.id, parentId: null }, alice))).parentId).toBeNull();
    });
  });

  test("the walk over stored rows that already hold a cycle ends and answers", async () => {
    await withBinding(async (binding, layer) => {
      const { a, b, c } = await chain(binding);
      // a's parent is c, written directly: a <- b <- c <- a. `union` drops the row it already produced, so the walk ends.
      await layer.transaction((tx) => tx.updateByKey(mesh.tables.tasks, { id: a.id }, { parentId: c.id }));
      const refused = await binding.run(() => Task.move({ id: b.id, parentId: a.id }, alice)).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(InvalidInputError);
    });
  });

  test("a raw query inside an application transaction sees a row inserted earlier in it", async () => {
    await withBinding(async (binding) => {
      const rows = await binding.transaction(async () => {
        await Task.add({ title: "fresh", parentId: null }, alice);
        return mesh.query`select title from tasks`;
      });
      expect(rows).toEqual([{ title: "fresh" }]);
      expect(Object.isFrozen(rows) && Object.isFrozen(rows[0])).toBe(true);
    });
  });

  test("a raw query that fails inside an action, caught by the code that made it, still rolls the action back", async () => {
    await withBinding(async (binding) => {
      const error = await binding.transaction(async () => {
        await Task.add({ title: "lost", parentId: null }, alice);
        await mesh.query`select * from no_such_table`.catch(() => undefined);
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe(ROLLED_BACK);
      expect(((error as Error).cause as Error).message).toBe("The raw query failed in the database: no such table: no_such_table");
      expect(await binding.run(() => mesh.query`select count(*) as n from tasks`)).toEqual([{ n: 0 }]);
    });
  });

  test("outside any transaction, after connect(), it runs in a transaction of its own; before connect() it rejects", async () => {
    await expect(mesh.query`select 1`).rejects.toThrow(new FrameworkError("query was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
    await mesh.connect({ deliver: false });
    try {
      expect(await mesh.query`select ${2} + 3 as n, ${true} as b, ${new Date(5)} as d`).toEqual([{ n: 5, b: 1, d: 5 }]);
    } finally { await mesh.disconnect(); }
  });

  test("loading a computed field whose helper makes a raw query throws, naming the field", async () => {
    await withBinding(async (binding) => {
      await binding.run(() => Task.add({ title: "probe", parentId: null }, alice));
      const error = await binding.run(() => Task.read({ load: ["depth"] }, alice)).catch((caught: unknown) => caught);
      expect(error).toEqual(new FrameworkError(marked("computed :depth of Task")));
    });
  });

  test("a read policy whose helper makes a raw query throws, naming the policy", async () => {
    await withBinding(async (binding) => {
      const error = await binding.run(() => Task.read({}, { actor: { id: "probe" } })).catch((caught: unknown) => caught);
      expect(error).toEqual(new FrameworkError(marked("policy :readers of Task")));
    });
  });

  test("Mesh.can whose write policy's helper makes a raw query answers, writes nothing, and its failure does not fail the caller's transaction", async () => {
    await withBinding(async (binding) => {
      const { a, b } = await chain(binding);
      hooks.checks.length = 0;
      expect(await binding.run(() => can(Task.move, { id: b.id, parentId: null }, alice))).toBe(true);
      expect(hooks.checks).toEqual([[{ n: 3 }]]);
      expect((await binding.run(() => Task.read({ filter: { id: { eq: b.id } } }, alice)))[0].parentId).toBe(a.id);
      hooks.caught.length = 0;
      const answer = await binding.transaction(async () => {
        const allowed = await can(Task.move, { id: b.id, parentId: null }, { actor: { id: "broken" } });
        await Task.add({ title: "after the question", parentId: null }, alice);
        return allowed;
      });
      expect(answer).toBe(false);
      expect((hooks.caught[0] as Error).message).toBe("The raw query failed in the database: no such table: no_such_table");
      expect(await binding.run(() => mesh.query`select title from tasks where title = ${"after the question"}`)).toEqual([{ title: "after the question" }]);
    });
  });

  test("the beforeTransaction and afterCommit seams each run a raw query in a transaction of its own", async () => {
    const seen: unknown[] = [];
    const seams = {
      beforeTransaction: async () => { seen.push(["before", await mesh.query`select count(*) as n from tasks`]); },
      afterCommit: async () => { seen.push(["after", await mesh.query`select count(*) as n from tasks`]); },
    };
    await withBinding(async (binding) => {
      await binding.run(() => Task.add({ title: "seamed", parentId: null }, alice));
      expect(seen).toEqual([["before", [{ n: 0 }]], ["after", [{ n: 1 }]]]);
    }, { seams });
  });

  test("a process handler's raw query joins the handler's transaction; a listen handler's opens its own", async () => {
    const seen: unknown[] = [];
    const module: EventsModule = { handlers: {
      process: { counted: { events: [TaskAdded], run: async () => {
        // On SQLite's one queued connection, a query that opened a transaction of its own here would wait for the
        // handler's to end, which waits for it: answering at all shows that it joined.
        seen.push(["process", await mesh.query`select count(*) as n from tasks`]);
      } } },
      listen: { heard: { events: [TaskAdded], run: async () => { seen.push(["listen", await mesh.query`select title from tasks`]); } } },
    } };
    await withBinding(async (binding) => {
      // the first round registers the handlers, which start at the highest position
      await binding.deliver();
      await binding.run(() => Task.add({ title: "heard", parentId: null }, alice));
      await binding.deliver();
      expect(seen).toContainEqual(["process", [{ n: 1 }]]);
      expect(seen).toContainEqual(["listen", [{ title: "heard" }]]);
    }, { events: { bus: testBus({ retryDelays: [0, 0] }), load: async () => module } });
  });
});
