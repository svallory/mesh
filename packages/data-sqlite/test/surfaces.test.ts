// A surface's generated manifest at run time (`notes/architecture/surfaces-design.md`, PR 2, section 8 "Run time"; ruling
// D41): built, generated and run against an in-memory SQLite database. A listed action runs the entity's own action with
// the caller's context (R19: its policies, checks and `always` blocks), returns only the listed fields (R14, R15), and a
// listed read refuses a filter, sort or load outside them before anything runs (R14a, OD11, OD12); an action the line
// does not list has no entry (R18).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { ForbiddenError, FrameworkError, InvalidInputError } from "@meshfw/runtime";
import { SCRATCH } from "./domain/harness.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

const task = `import { Step } from "./step.mesh.mx"
entity :Task table="tasks"
  attributes
    uuid :id primary-key
    string :title min=1
    string :tenant
    string :notes nullable
  relationships
    has-many :steps entity=Step
  computed
    string :summary() { return &notes ?? &title }
    integer :noteLength() { return (&notes ?? "").length }
  actions auto=[:read]
    create :create
      input
        &title
        &tenant
    always types=[:update]
      validate
        check :titleOk that=({ input }) => (input.title ?? "") !== "bad" code="bad_title" message="a title cannot be bad"
    update :complete
      do
        set
          &notes="done"
        load=[&summary, &steps]
    update :rename
      input
        &title
  policies
    policy :tenantRows types=[:read]
      authorize-if=({ actor }) => &tenant === actor.id
    policy :writes types=[:create, :update]
      authorize-if=({ actor }) => actor.id !== "nobody"
      forbid-if=() => (&notes ?? "") === "locked"
`;
const step = `import { Task } from "./task.mesh.mx"
entity :Step table="steps"
  attributes
    uuid :id primary-key
  relationships
    belongs-to :task entity=Task
  actions auto=[:read]
  policies
    policy :anyone
      authorize-if=() => true
`;
const consoleSurface = `import { Task } from "../../domain/work/task.mesh.mx"

surface :console
  expose :tasks entity=Task label="Tasks" fields=[:id, :title, :summary]
    action :read
    action :complete
    action :rename
`;

let dir: string;
let app: any;
let surface: any;
beforeAll(async () => {
  dir = await mkdtemp(join(SCRATCH, ".scratch-surfaces-"));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: sqliteDomain.data(["conditions"]) };
  const built = buildModel({
    root: dir, domainRoot: join(dir, "src/domain"),
    files: [{ file: "src/domain/work/task.mesh.mx", source: task }, { file: "src/domain/work/step.mesh.mx", source: step }],
    surfaces: { root: "src/surfaces", files: [{ file: "src/surfaces/console/console.mesh.mx", source: consoleSurface }] },
  });
  expect(built.diagnostics).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, sqliteDomain.build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  app = await import(join(dir, ".mesh/index.ts"));
  ({ surface } = await import(join(dir, ".mesh/surfaces/console/index.ts")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const as = (actor: string) => ({ actor: { id: actor } });
const tasks = () => surface.expose.tasks.actions;

/** Two tasks of tenant "a" and one of tenant "b"; the second of "a" is locked. */
async function seeded() {
  const db = await sqliteDomain.layer(app.tables);
  await db.transaction(async (tx) => {
    await tx.insert(app.tables.tasks, { id: id(1), title: "one", tenant: "a", notes: null });
    await tx.insert(app.tables.tasks, { id: id(2), title: "two", tenant: "a", notes: "locked" });
    await tx.insert(app.tables.tasks, { id: id(3), title: "three", tenant: "b", notes: "secret" });
    await tx.insert(app.tables.steps, { id: id(10), taskId: id(1) });
  });
  return app.bind(db);
}
const rejection = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);

describe("the manifest", () => {
  test("lists the expose line as generated: FQN, label, the fields in declaration order, and only the listed actions", () => {
    expect(surface.name).toBe("console");
    expect(surface.expose.tasks.entity).toBe("work.Task");
    expect(surface.expose.tasks.label).toBe("Tasks");
    expect(surface.expose.tasks.fields).toEqual(["id", "title", "summary"]);
    expect(Object.keys(tasks())).toEqual(["read", "complete", "rename"]);
    expect(tasks().read.kind).toBe("read");
    expect(tasks().complete.kind).toBe("update");
    // `create` is generated for Task but not listed (R18).
    expect(tasks().create).toBeUndefined();
    expect(surface.publishes).toEqual([]);
    expect(Object.isFrozen(surface.expose.tasks.actions)).toBe(true);
  });
});

describe("a listed read", () => {
  test("returns only the listed fields, and a read policy that filters rows filters through the surface", async () => {
    const binding = await seeded();
    const rows = await binding.run(() => tasks().read.run({ sort: ["title"] }, as("a")));
    expect(rows).toEqual([{ id: id(1), title: "one" }, { id: id(2), title: "two" }]);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });
  test("a listed computed field leaves only when loaded", async () => {
    const binding = await seeded();
    expect(await binding.run(() => tasks().read.run({ filter: { id: { eq: id(1) } }, load: ["summary"] }, as("a")))).toEqual([{ id: id(1), title: "one", summary: "one" }]);
  });
  test("a filter or sort by an unlisted field and a load of a relationship or an unlisted computed field are refused before the action runs", async () => {
    // No binding at all: a call that reached the entity's action would reject as not connected.
    const refused = async (input: unknown) => {
      const error = await rejection(tasks().read.run(input, as("a")));
      expect(error).toBeInstanceOf(InvalidInputError);
      return (error as InvalidInputError).issues.map(({ path, code }) => [path, code]);
    };
    expect(await refused({ filter: { notes: { gte: "m" } } })).toEqual([[["filter", "notes"], "not_exposed"]]);
    expect(await refused({ filter: { or: [{ title: { eq: "one" } }, { tenant: { eq: "b" } }] } })).toEqual([[["filter", "or", 1, "tenant"], "not_exposed"]]);
    expect(await refused({ sort: ["-notes"] })).toEqual([[["sort", 0], "not_exposed"]]);
    expect(await refused({ load: ["steps", "noteLength"] })).toEqual([[["load", 0], "not_exposed"], [["load", 1], "not_exposed"]]);
    expect(await rejection(tasks().read.run({}, as("a")))).toBeInstanceOf(FrameworkError);
  });
});

describe("a listed write", () => {
  test("runs the entity's action and returns its result projected: a loaded relationship stays behind, a loaded computed field leaves", async () => {
    const binding = await seeded();
    const done = await binding.run(() => tasks().complete.run({ id: id(1) }, as("a")));
    expect(done).toEqual({ id: id(1), title: "one", summary: "done" });
    // The action ran: its `set` step wrote the row.
    expect((await binding.run(() => tasks().read.run({ filter: { id: { eq: id(1) } } }, as("a"))))).toEqual([{ id: id(1), title: "one" }]);
  });
  test("the entity's policies decide: a denying authorize-if and a forbid-if deny through the surface", async () => {
    const binding = await seeded();
    expect(await rejection(binding.run(() => tasks().complete.run({ id: id(1) }, as("nobody"))))).toBeInstanceOf(ForbiddenError);
    const locked = await rejection(binding.run(() => tasks().complete.run({ id: id(2) }, as("a"))));
    expect(locked).toBeInstanceOf(ForbiddenError);
    expect((locked as ForbiddenError).policies).toEqual(["writes"]);
  });
  test("an always block's check runs, and its InvalidInputError leaves as thrown, with the entity author's text", async () => {
    const binding = await seeded();
    const error = await rejection(binding.run(() => tasks().rename.run({ id: id(1), title: "bad" }, as("a"))));
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues.map(({ code, message }) => [code, message])).toEqual([["bad_title", "a title cannot be bad"]]);
    expect(await binding.run(() => tasks().rename.run({ id: id(1), title: "good" }, as("a")))).toEqual({ id: id(1), title: "good" });
  });
});
