// A read takes `load` (M7): the generated read functions, the `tx` reads of an entity file and the application
// transaction all load relationships, computed fields and rollups by name, typed to exactly the names passed. The
// domain is built, generated, pushed to SQLite, type-checked under the strictest flags and called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { openPolicies } from "./open-policy.ts";
import { FrameworkError, InvalidInputError, type DataOperations } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const project = `import { Task } from "./task.mesh.mx"
entity :Project table="projects"
  attributes
    uuid :id primary-key
    string :name
    integer :rank default=0
  relationships
    has-many :tasks entity=Task
  computed
    string :label() { return &name.toUpperCase() }
    count :taskCount of="tasks"
    max :topPriority of="tasks.priority"
    boolean :busy() { return &taskCount > 1 }
    string :viewer({ actor }) { return actor.id }
  actions auto=[:read]
    create :open
      input
        &name
        &rank
`;
const task = `import { Project } from "./project.mesh.mx"
entity :Task table="tasks"
  attributes
    uuid :id primary-key
    string :title
    integer :priority default=0
  relationships
    belongs-to :project entity=Project
  computed
    string :shout() { return &title.toUpperCase() }
  actions auto=[:read]
    create :add
      input
        &title
        &priority
        &project
      validate
        check :roomInProject that=async ({ input, tx }) => ((await tx.readProject({ filter: { id: { eq: input.project } }, load: ["taskCount"] }))[0]?.taskCount ?? 0) < 3 code="project_full" message="a project holds three tasks"
        check :projectNotBanned that=async ({ input, tx }) => (await tx.readProject({ filter: { id: { eq: input.project } }, load: ["label", "viewer"] }))[0]?.label !== "BANNED" code="banned" message="that project is banned"
        check :viewerIsKnown that=async ({ input, tx }) => (await tx.readProject({ filter: { id: { eq: input.project } }, load: ["viewer"] }))[0]?.viewer === "alice" code="not_alice" message="only alice adds tasks"
    create :addBlind
      input
        &title
        &project
`;

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};

async function generate(prefix: string, sources: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, prefix));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies(Object.entries(sources).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source }))) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string };\n  }\n}\nexport {};\n');
  return dir;
}

async function typeCheck(dir: string, extra: string[] = []): Promise<string> {
  const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
  const child = Bun.spawnSync([
    resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
    "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "context.ts", ...extra, ...files,
  ], { cwd: dir });
  return child.stdout.toString() + child.stderr.toString();
}

let dir: string;
let app: any;
beforeAll(async () => {
  dir = await generate(".reads-load-", { project, task });
  app = await import(join(dir, ".mesh/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const alice = { id: "alice" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  return { db, mesh: app.bind(db) };
}

/** Two projects. Ada's holds t1 (priority 5), t2 (9), t3 (2), inserted out of key order; Bo's holds nothing. */
async function seed(tx: DataOperations) {
  await tx.insert(app.tables.projects, { id: id(1), name: "ada", rank: 2 });
  await tx.insert(app.tables.projects, { id: id(2), name: "bo", rank: 1 });
  await tx.insert(app.tables.tasks, { id: id(32), title: "t3", priority: 2, projectId: id(1) });
  await tx.insert(app.tables.tasks, { id: id(31), title: "t2", priority: 9, projectId: id(1) });
  await tx.insert(app.tables.tasks, { id: id(30), title: "t1", priority: 5, projectId: id(1) });
}
async function seeded() {
  const world = await fresh();
  await world.db.transaction(seed);
  return world;
}

describe("the generated files", () => {
  test("type-check under the strictest flags, with the generic reads in `actions`, `tx` and the composition types", async () => {
    expect(await typeCheck(dir)).toBe("");
  }, 30_000);

  test("the result of a read is typed to the names passed: a loaded field is readable, an unloaded one is a type error", async () => {
    await Bun.write(join(dir, "check-load.ts"), [
      'import { bind } from "./.mesh/index.ts";',
      'import { readProject, type ProjectWith, type ReadProjectInput } from "./.mesh/domain/index.ts";',
      "const mesh = bind(null as never);",
      "const context = { actor: { id: 'a' } };",
      "export async function calls(): Promise<void> {",
      "  // No load: the bare record, whose relationships and computed fields are not members.",
      "  const [bare] = await mesh.readProject({}, context);",
      "  const name: string = bare!.name;",
      "  // @ts-expect-error an unloaded relationship is not readable",
      "  void bare!.tasks;",
      "  // @ts-expect-error an unloaded computed field is not readable",
      "  void bare!.label;",
      "  // A relationship, a computed field and a rollup, with no `as const`.",
      "  const [loaded] = await mesh.readProject({ load: ['tasks', 'label', 'taskCount'] }, context);",
      "  const tasks: readonly { title: string }[] = loaded!.tasks;",
      "  const label: string = loaded!.label;",
      "  const count: number = loaded!.taskCount;",
      "  // @ts-expect-error a field not in the list is still not loaded",
      "  void loaded!.busy;",
      "  // @ts-expect-error a name that is not loadable is a type error",
      "  await mesh.readProject({ load: ['nope'] }, context);",
      "  // @ts-expect-error an attribute is already there and is not a loadable name",
      "  await mesh.readProject({ load: ['name'] }, context);",
      "  // The module's function is typed the same way.",
      "  const [viaModule] = await readProject({ load: ['label'] }, context);",
      "  const same: ProjectWith<'label'> = viaModule!;",
      "  // The input type names what it lists.",
      "  const input: ReadProjectInput<'label'> = { load: ['label'], limit: 1 };",
      "  // @ts-expect-error a name the input type was not given",
      "  const wrong: ReadProjectInput<'label'> = { load: ['busy'] };",
      "  // The application's transaction hands out the same typing, through `tx` and through `actions`.",
      "  await mesh.transaction(async ({ tx, actions }) => {",
      "    const [a] = await tx.readProject({ load: ['label'] });",
      "    const label: string = a!.label;",
      "    // @ts-expect-error not loaded",
      "    void a!.taskCount;",
      "    const [b] = await actions.readProject({ load: ['taskCount'] });",
      "    const count: number = b!.taskCount;",
      "    // @ts-expect-error not a loadable name",
      "    await tx.readProject({ load: ['nope'] });",
      "    void label; void count;",
      "  }, context);",
      "  // An entity with a relationship and nothing else takes `load` too; Task has both.",
      "  const [t] = await mesh.readTask({ load: ['project', 'shout'] }, context);",
      "  // A caller's load runs Project's read policies, so the project can be null (POL-17); through tx it cannot.",
      "  // @ts-expect-error a caller's belongs-to can be null",
      "  void t!.project.name;",
      "  const projectName: string | undefined = t!.project?.name;",
      "  await mesh.transaction(async ({ tx }) => { const [inside] = await tx.readTask({ load: ['project'] }); const sure: string = inside!.project.name; void sure; }, context);",
      "  void name; void tasks; void label; void count; void same; void input; void wrong; void projectName;",
      "}",
      "",
    ].join("\n"));
    try {
      expect(await typeCheck(dir, ["check-load.ts"])).toBe("");
    } finally { await rm(join(dir, "check-load.ts")); }
  }, 30_000);

  test("a load that does not name its fields as a tuple claims nothing: a widened list and an input type give the bare record, and a union of tuples gives a union of results", async () => {
    await Bun.write(join(dir, "check-tuple.ts"), [
      'import { bind } from "./.mesh/index.ts";',
      'import type { ReadProjectInput } from "./.mesh/domain/index.ts";',
      "const mesh = bind(null as never);",
      "const context = { actor: { id: 'a' } };",
      "export async function calls(flag: boolean): Promise<void> {",
      "  const names: ('label' | 'taskCount')[] = [];",
      "  const [widened] = await mesh.readProject({ load: names }, context);",
      "  // @ts-expect-error a list that does not say which names it holds loads none, as far as the type knows",
      "  void widened!.label;",
      "  const input: ReadProjectInput<'label'> = { limit: 1 };",
      "  const [fromInput] = await mesh.readProject(input, context);",
      "  // @ts-expect-error an input typed for a name says nothing about what the value loads",
      "  void fromInput!.label;",
      "  // @ts-expect-error an explicit tuple that lists a name needs the load that lists it",
      "  await mesh.readProject<readonly ['label']>({}, context);",
      "  const [explicit] = await mesh.readProject<readonly ['label']>({ load: ['label'] }, context);",
      "  const label: string = explicit!.label;",
      "  // A union of tuples gives a union of results: only what every arm loads is readable, the rest is narrowed.",
      "  const [conditional] = await mesh.readProject({ load: flag ? ['label'] : [] }, context);",
      "  // @ts-expect-error a conditional load may not have loaded the label",
      "  void conditional!.label;",
      "  if ('label' in conditional!) { const narrowed: string = conditional.label; void narrowed; }",
      "  const either: readonly ['label'] | readonly ['taskCount'] = flag ? ['label'] : ['taskCount'];",
      "  const [fromVariable] = await mesh.readProject({ load: either }, context);",
      "  // @ts-expect-error a variable of a union-of-tuples type loads one list or the other",
      "  void fromVariable!.label;",
      "  // @ts-expect-error nor the other",
      "  void fromVariable!.taskCount;",
      "  const [fromArgument] = await mesh.readProject<readonly ['label'] | readonly []>({ load: [] }, context);",
      "  // @ts-expect-error a union type argument is a union of results",
      "  void fromArgument!.label;",
      "  const [both] = await mesh.readProject({ load: ['label', 'taskCount'] }, context);",
      "  void both!.label; void both!.taskCount;",
      "  const [empty] = await mesh.readProject({ load: [] }, context);",
      "  // @ts-expect-error an empty list loads nothing",
      "  void empty!.label;",
      "  const [undef] = await mesh.readProject({ load: undefined, limit: 1 }, context);",
      "  void undef!.name; void label;",
      "}",
      "",
    ].join("\n"));
    try {
      expect(await typeCheck(dir, ["check-tuple.ts"])).toBe("");
    } finally { await rm(join(dir, "check-tuple.ts")); }
  }, 30_000);

  test("the read-only types keep what is loaded and what is not: `Reads` and `Actions` are assignable to them, `tx` of an entity file and a helper typed with them are checked", async () => {
    await Bun.write(join(dir, "check-readonly.ts"), [
      'import type { Actions, ReadOnlyActions, ReadOnlyReads, Reads } from "./.mesh/index.ts";',
      "declare const plain: Reads;",
      "declare const plainActions: Actions;",
      "// A function that takes the read-only reads, as a Hyper helper does, accepts the plain ones: no cast.",
      "const ro: ReadOnlyReads = plain;",
      "const roa: ReadOnlyActions = plainActions;",
      "async function helper(tx: ReadOnlyReads): Promise<number> {",
      "  const [p] = await tx.readProject({ load: ['label'] });",
      "  const label: string = p!.label;",
      "  // @ts-expect-error not loaded through the read-only reads either",
      "  void p!.taskCount;",
      "  const [bare] = await tx.readProject({});",
      "  // @ts-expect-error nothing loaded, nothing readable",
      "  void bare!.label;",
      "  // @ts-expect-error a record read through them is read-only",
      "  p!.name = 'x';",
      "  // @ts-expect-error and so is a loaded list",
      "  (await tx.readProject({ load: ['tasks'] }))[0]!.tasks.push((await tx.readTask({}))[0]!);",
      "  const [t] = await roa.readTask({ load: ['project'] });",
      "  // A caller's belongs-to can be null; the read-only reads keep the tx typing, where it cannot.",
      "  // @ts-expect-error a caller's belongs-to can be null",
      "  void t!.project.name;",
      "  const projectName: string | undefined = t!.project?.name;",
      "  const [u] = await tx.readTask({ load: ['project'] });",
      "  const sure: string = u!.project.name;",
      "  void sure;",
      "  // @ts-expect-error a name that is not loadable",
      "  await tx.readProject({ load: ['nope'] });",
      "  void label; void projectName;",
      "  return 1;",
      "}",
      "export const run = (): Promise<number> => helper(ro);",
      "",
    ].join("\n"));
    try {
      expect(await typeCheck(dir, ["check-readonly.ts"])).toBe("");
    } finally { await rm(join(dir, "check-readonly.ts")); }
  }, 30_000);

  test("a check of an entity file that reads a field it did not load is a type error in the generated expressions file", async () => {
    const wrong = task.replace(
      '(await tx.readProject({ filter: { id: { eq: input.project } }, load: ["viewer"] }))[0]?.viewer === "alice"',
      '(await tx.readProject({ filter: { id: { eq: input.project } }, load: ["viewer"] }))[0]?.taskCount === 1',
    );
    expect(wrong).not.toBe(task);
    const broken = await generate(".reads-load-unloaded-", { project, task: wrong });
    try {
      const output = await typeCheck(broken);
      expect(output).toContain("task.expressions.ts");
      expect(output).toContain("TS2339");
      expect(output).toContain("taskCount");
    } finally { await rm(broken, { recursive: true, force: true }); }
  }, 30_000);

  test("an entity with nothing to load has no `load`", async () => {
    const plain = await generate(".reads-load-plain-", { note: 'entity :Note table="notes"\n  attributes\n    uuid :id primary-key\n    string :text\n  actions auto=[:read]\n' });
    try {
      await Bun.write(join(plain, "check.ts"), [
        'import { bind } from "./.mesh/index.ts";',
        "const mesh = bind(null as never);",
        "export async function calls(): Promise<void> {",
        "  const [note] = await mesh.readNote({ limit: 1 }, { actor: { id: 'a' } });",
        "  const text: string = note!.text;",
        "  // @ts-expect-error nothing to load",
        "  await mesh.readNote({ load: [] }, { actor: { id: 'a' } });",
        "  void text;",
        "}",
        "",
      ].join("\n"));
      expect(await typeCheck(plain, ["check.ts"])).toBe("");
    } finally { await rm(plain, { recursive: true, force: true }); }
  }, 30_000);
});

describe("a caller's read with load", () => {
  test("loads a relationship, a computed field and a rollup, and no more than it was asked", async () => {
    const { db, mesh } = await seeded();
    try {
      const [ada, bo] = await mesh.readProject({ load: ["tasks", "label", "taskCount"], sort: ["rank"] }, { actor: alice }).then((rows: any[]) => [rows.find((r) => r.name === "ada"), rows.find((r) => r.name === "bo")]);
      expect(ada.label).toBe("ADA");
      expect(ada.taskCount).toBe(3);
      expect(ada.tasks.map((t: any) => t.title)).toEqual(["t1", "t2", "t3"]);
      expect(bo).toMatchObject({ label: "BO", taskCount: 0, tasks: [] });
      expect("busy" in ada).toBe(false);
      expect("topPriority" in ada).toBe(false);
      const [plain] = await mesh.readProject({ limit: 1 }, { actor: alice });
      expect(Object.keys(plain).sort()).toEqual(["id", "name", "rank"]);
    } finally { await db.close(); }
  });

  test("a computed field that reads a rollup, and a max rollup", async () => {
    const { db, mesh } = await seeded();
    try {
      const rows = await mesh.readProject({ load: ["busy", "topPriority"], sort: ["-rank"] }, { actor: alice });
      expect(rows.map((r: any) => [r.name, r.busy, r.topPriority])).toEqual([["ada", true, 9], ["bo", false, null]]);
    } finally { await db.close(); }
  });

  test("a belongs-to loads the record it points at", async () => {
    const { db, mesh } = await seeded();
    try {
      const rows = await mesh.readTask({ load: ["project", "shout"], sort: ["title"] }, { actor: alice });
      expect(rows.map((t: any) => [t.title, t.project.name, t.shout])).toEqual([["t1", "ada", "T1"], ["t2", "ada", "T2"], ["t3", "ada", "T3"]]);
    } finally { await db.close(); }
  });

  test("a loaded has-many comes back in primary-key order, whatever order the rows were inserted in", async () => {
    const { db, mesh } = await seeded();
    try {
      const [ada] = await mesh.readProject({ filter: { name: { eq: "ada" } }, load: ["tasks"] }, { actor: alice });
      expect(ada.tasks.map((t: any) => t.id)).toEqual([id(30), id(31), id(32)]);
    } finally { await db.close(); }
  });

  test("load works with filter, sort, limit and offset: they pick the rows, load decorates them", async () => {
    const { db, mesh } = await seeded();
    try {
      await db.transaction(async (tx) => {
        for (let n = 3; n <= 6; n++) await tx.insert(app.tables.projects, { id: id(n), name: `p${n}`, rank: n * 10 });
        await tx.insert(app.tables.tasks, { id: id(40), title: "u1", priority: 1, projectId: id(5) });
      });
      const page = await mesh.readProject({ filter: { rank: { gte: 10 } }, sort: ["-rank"], limit: 2, offset: 1, load: ["taskCount", "tasks", "label"] }, { actor: alice });
      // ranks 60, 50, 40, 30 after the filter, newest first: the offset skips p6 and the limit keeps p5 and p4.
      expect(page.map((p: any) => [p.name, p.label, p.taskCount, p.tasks.length])).toEqual([["p5", "P5", 1, 1], ["p4", "P4", 0, 0]]);
      const none = await mesh.readProject({ filter: { rank: { gt: 1000 } }, load: ["tasks", "taskCount"] }, { actor: alice });
      expect(none).toEqual([]);
    } finally { await db.close(); }
  });

  test("an empty load reads like no load", async () => {
    const { db, mesh } = await seeded();
    try {
      expect(await mesh.readProject({ load: [], sort: ["rank"] }, { actor: alice })).toEqual(await mesh.readProject({ sort: ["rank"] }, { actor: alice }));
    } finally { await db.close(); }
  });

  test("a computed field reads the caller's context: the actor of the call", async () => {
    const { db, mesh } = await seeded();
    try {
      const [row] = await mesh.readProject({ limit: 1, load: ["viewer"] }, { actor: { id: "carol" } });
      expect(row.viewer).toBe("carol");
    } finally { await db.close(); }
  });

  test("a name that cannot be loaded is an InvalidInputError before any query, whether it is a typo or an attribute", async () => {
    const { db, mesh } = await seeded();
    try {
      for (const bad of [["nope"], ["name"], ["tasks", "nope"], [1], "label", null]) {
        const error = await mesh.readProject({ load: bad }, { actor: alice }).then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(InvalidInputError);
      }
      // Before any query: a layer that fails on the first query is never reached.
      const layer = { ...db, transaction: () => { throw new Error("a query was made"); }, refuseIfFailed: () => false, close: async () => undefined };
      const unqueried = app.bind(layer);
      await expect(unqueried.readProject({ load: ["nope"] }, { actor: alice })).rejects.toBeInstanceOf(InvalidInputError);
      await expect(unqueried.readProject({ load: ["label"] }, { actor: alice })).rejects.toThrow("a query was made");
    } finally { await db.close(); }
  });

  test("a load that cannot be served is an error, never skipped", async () => {
    const { db, mesh } = await seeded();
    try {
      // A row whose key points at a project that does not exist: the belongs-to cannot be served.
      await db.transaction(async (tx) => { await tx.insert(app.tables.tasks, { id: id(50), title: "lost", priority: 0, projectId: id(99) }); });
      await expect(mesh.readTask({ load: ["project"] }, { actor: alice })).rejects.toBeInstanceOf(FrameworkError);
    } finally { await db.close(); }
  });

  test("the rows loaded are a new list: the stored rows are not changed", async () => {
    const { db, mesh } = await seeded();
    try {
      const loaded = await mesh.readProject({ load: ["tasks"] }, { actor: alice });
      const again = await mesh.readProject({}, { actor: alice });
      expect(loaded.length).toBe(again.length);
      expect(again.every((row: any) => !("tasks" in row))).toBe(true);
    } finally { await db.close(); }
  });
});

describe("a read through `tx` with load", () => {
  test("the application's transaction loads through `tx` and `actions`, with the context the transaction carries", async () => {
    const { db, mesh } = await seeded();
    try {
      await mesh.transaction(async ({ tx, actions }: any) => {
        const [viaTx] = await tx.readProject({ filter: { name: { eq: "ada" } }, load: ["taskCount", "viewer"] });
        expect(viaTx).toMatchObject({ taskCount: 3, viewer: "dora" });
        const [viaActions] = await actions.readProject({ filter: { name: { eq: "ada" } }, load: ["label"] });
        expect(viaActions.label).toBe("ADA");
        const [other] = await actions.readProject({ filter: { name: { eq: "ada" } }, load: ["viewer"] }, { actor: { id: "erin" } });
        expect(other.viewer).toBe("erin");
      }, { actor: { id: "dora" } });
    } finally { await db.close(); }
  });

  test("a create's check reads a computed field and a rollup through tx, in the action's transaction", async () => {
    const { db, mesh } = await fresh();
    try {
      const ada = await mesh.openProject({ name: "ada" }, { actor: alice });
      for (const title of ["a", "b", "c"]) await mesh.addTask({ title, priority: 1, project: ada.id }, { actor: alice });
      // The fourth is refused by `roomInProject`, which reads `taskCount` of the project through `tx`.
      const full = await mesh.addTask({ title: "d", priority: 1, project: ada.id }, { actor: alice }).then(() => undefined, (e: unknown) => e) as InvalidInputError;
      expect(full).toBeInstanceOf(InvalidInputError);
      expect(full.issues.map((issue) => issue.code)).toEqual(["project_full"]);
      expect(await mesh.readTask({}, { actor: alice })).toHaveLength(3);
      // The label and the viewer come through the check's own `tx`, with the call's actor.
      const banned = await mesh.openProject({ name: "banned" }, { actor: alice });
      const refused = await mesh.addTask({ title: "x", priority: 1, project: banned.id }, { actor: alice }).then(() => undefined, (e: unknown) => e) as InvalidInputError;
      expect(refused.issues.map((issue) => issue.code)).toEqual(["banned"]);
      const stranger = await mesh.addTask({ title: "x", priority: 1, project: ada.id }, { actor: { id: "mallory" } }).then(() => undefined, (e: unknown) => e) as InvalidInputError;
      expect(stranger.issues.map((issue) => issue.code).sort()).toEqual(["not_alice", "project_full"]);
    } finally { await db.close(); }
  });

  test("a failed load in a joined call fails the transaction like any failed read", async () => {
    const { db, mesh } = await seeded();
    try {
      const error = await mesh.transaction(async ({ tx }: any) => {
        try { await tx.readProject({ load: ["nope"] }); } catch { /* caught, and the transaction is failed all the same */ }
      }, { actor: alice }).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(FrameworkError);
    } finally { await db.close(); }
  });
});

describe("the clock", () => {
  test("a computed field that reads now() reads the binding's clock, through a caller's read and through tx", async () => {
    const source = {
      stamp: 'entity :Stamp table="stamps"\n  attributes\n    uuid :id primary-key\n    timestamp :at\n  computed\n    boolean :past() { return &at < now() }\n  actions auto=[:read]\n',
    };
    const clockDir = await generate(".reads-load-clock-", source);
    try {
      const clock = await import(join(clockDir, ".mesh/index.ts"));
      const db = sqlite({ file: ":memory:" });
      await createSchema(db, clock.tables);
      await db.transaction(async (tx) => { await tx.insert(clock.tables.stamps, { id: id(1), at: new Date(5_000) }); });
      const early = clock.bind(db, { clock: () => new Date(1_000) });
      const late = clock.bind(db, { clock: () => new Date(9_000) });
      const ctx = { actor: alice };
      expect((await early.readStamp({ load: ["past"] }, ctx))[0].past).toBe(false);
      expect((await late.readStamp({ load: ["past"] }, ctx))[0].past).toBe(true);
      expect(await late.transaction(async ({ tx }: any) => (await tx.readStamp({ load: ["past"] }))[0].past, ctx)).toBe(true);
      expect(await early.transaction(async ({ tx }: any) => (await tx.readStamp({ load: ["past"] }))[0].past, ctx)).toBe(false);
      await db.close();
    } finally { await rm(clockDir, { recursive: true, force: true }); }
  });

  test("one instant per call: every row and field of a load, and a create's check and its tx read, see the same now()", async () => {
    const source = {
      stamp: 'entity :Stamp table="stamps"\n  attributes\n    uuid :id primary-key\n    timestamp :at\n  computed\n    boolean :past() { return &at < now() }\n    timestamp :seen() { return now() }\n  actions auto=[:read]\n    create :add\n      input\n        &at\n      validate\n        check :same that=async ({ tx }) => (await tx.readStamp({ load: ["seen", "past"] })).every((row) => row.seen.getTime() === now().getTime() && row.past === (row.at < now())) code="skewed" message="the load and the check read two instants"\n',
    };
    const clockDir = await generate(".reads-load-instant-", source);
    try {
      const clock = await import(join(clockDir, ".mesh/index.ts"));
      const db = sqlite({ file: ":memory:" });
      await createSchema(db, clock.tables);
      await db.transaction(async (tx) => {
        for (let n = 1; n <= 3; n++) await tx.insert(clock.tables.stamps, { id: id(n), at: new Date(n * 1_000 + 500) });
      });
      // An advancing clock: every read of it is one second later than the last.
      let ticks = 0;
      const mesh = clock.bind(db, { clock: () => new Date(1_000 * ++ticks) });
      const ctx = { actor: alice };
      // A top-level read takes one instant for all its rows and fields.
      ticks = 0;
      const rows = await mesh.readStamp({ load: ["seen", "past"] }, ctx);
      expect(new Set(rows.map((row: any) => row.seen.getTime())).size).toBe(1);
      expect(ticks).toBe(1);
      // The same through the application's transaction.
      ticks = 0;
      const viaTx = await mesh.transaction(async ({ tx }: any) => tx.readStamp({ load: ["seen"] }), ctx);
      expect(new Set(viaTx.map((row: any) => row.seen.getTime())).size).toBe(1);
      // A create's check: its `now()` and the field its `tx` read loaded are one instant, so the check passes
      // (it fails with `skewed` when the load takes a fresh reading of the clock).
      ticks = 0;
      await expect(mesh.addStamp({ at: new Date(2_500) }, ctx)).resolves.toBeDefined();
      await db.close();
    } finally { await rm(clockDir, { recursive: true, force: true }); }
  });
});
