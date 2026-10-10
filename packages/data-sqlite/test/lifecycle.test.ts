// M5, part 1: the action lifecycle. A domain is built, generated, pushed to SQLite and called through the generated
// functions: cast, checks collected together, steps, loads, and what each of them writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, InvalidInputError, NotFoundError, type Issue } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const member = `import { Task } from "./task.mesh.mx"
entity :Member table="members"
  attributes
    uuid :id primary-key
    string :name min=1
    enum :plan values=[:free, :paid] default=:free
  relationships
    has-many :tasks entity=Task via=:owner
  computed
    count :taskCount of="tasks"
  actions auto=[:read]
    create :join
      input
        &name
        &plan
`;

const task = `import { Member } from "./member.mesh.mx"
entity :Task table="tasks"
  attributes
    uuid :id primary-key
    string :title min=1 max=50
    string :note nullable
    integer :version default=1
    integer :priority default=0 min=0 max=9
    enum :state values=[:open, :doing, :done] default=:open
    timestamp :openedAt
    timestamp :doneAt nullable
    json :meta nullable
    timestamp :createdAt on=:create
    timestamp :touchedAt on=:update
  relationships
    belongs-to :owner entity=Member
    belongs-to :creator entity=Member nullable
    belongs-to :reviewer entity=Member
  computed
    boolean :urgent() { return &priority >= 7 }
    boolean :bad({ self }) { if (self.title === "boom") throw new Error("bad computed"); return false }
  actions auto=[:read]
    always types=[:create, :update]
      validate
        check :titleNotShouting [
          that=() => &title !== "STOP"
          code="task.shouting"
          message="do not shout"
        ]
    create :open
      input
        &title
        &owner
        &priority
        &reviewer
      validate
        check :underQuota [
          that=() => &owner.taskCount < 2
          when=() => &owner.plan === :free
          code="task.quota"
          message="free members have 2 tasks"
          details=() => ({ limit: 2 })
        ]
      do
        set
          &openedAt=() => now()
          &creator=({ actor }) => actor.id
    create :openAs
      input
        &title
        &owner
      do
        set
          &openedAt=() => now()
          &reviewer=({ actor }) => actor.id
    update :rename
      input
        &title
        integer :expectedVersion
      validate
        check :expectedVersion [
          that=({ input }) => input.expectedVersion === &version
          code="expected-version"
          message="the task changed since it was read"
          details=({ before }) => ({ currentVersion: before.version })
        ]
        check :titleChanged [
          that=({ before }) => &title !== before.title
          code="task.unchanged"
          message="the title is the same"
        ]
      do
        set
          &version=() => &version + 1
    update :annotate
      input
        string :note nullable
        &priority
      do
        set
          &note=({ input }) => input.note
          &priority=({ input }) => input.priority
    update :start
      validate
        check :openOnly [
          that=() => &state === :open
          code="task.open"
          message="only an open task can start"
        ]
      do
        set
          &state=:doing
    update :vet
      validate
        check :openOnly [
          that=() => &state === :open
          code="task.open"
          message="only an open task can start"
        ]
        check :noteLong [
          that=() => &note?.length > 3
          code="task.note"
          message="the note must be longer than 3"
        ]
        check :priorityHigh [
          that=() => &priority > 100
          code="task.priority"
          message="priority is too low"
        ]
    update :finish
      input
        integer :score nullable
      validate
        check :started that=() => &state === :doing code="task.started" message="start it first"
      do
        set
          &state=:done
        when=() => &priority >= 5
          set
            &doneAt=() => now()
          when=() => &priority >= 9
            set
              &note="critical"
    update :ping
      do
        run({ self, actor, context }) {
          context.log.push(\`ping \${self.title} by \${actor?.id ?? "nobody"} (state \${self.state})\`);
        }
    update :show
      do
        load=[&owner, &urgent]
    update :boom
      do
        set
          &state=:done
        run() {
          throw new Error("boom");
        }
    update :renameLoud
      input
        &title
      do
        load=[&bad]
    update :wantOwner
      input
        boolean :want
      do
        when=({ input }) => input.want
          load=[&owner]
    create :openMutate
      input
        &title
        &owner
        &reviewer
        &meta
        &doneAt
        string :what
      do
        set
          &openedAt=() => now()
        run({ self, input }) {
          const target: any = self;
          if (input.what === "json" && target.meta) target.meta.injected = true;
          if (input.what === "array" && target.meta) target.meta.list.push(9);
          if (input.what === "date" && target.doneAt) target.doneAt.setUTCFullYear(2000);
        }
    update :editMutate
      input
        &meta
        &doneAt
        string :what
      validate
        check :ownerNamed that=() => &owner.name !== "" code="task.owner" message="the owner needs a name"
      do
        run({ self, before, input }) {
          const target: any = self;
          const stored: any = before;
          if (input.what === "json" && target.meta) target.meta.injected = true;
          if (input.what === "array" && target.meta) target.meta.list.push(9);
          if (input.what === "date" && target.doneAt) target.doneAt.setUTCFullYear(2000);
          if (input.what === "related") target.owner.name = "hacked";
          if (input.what === "before") stored.title = "hacked";
          if (input.what === "beforeJson") stored.meta.injected = true;
        }
    update :peek
      do
        run({ before, context }) {
          context.log.push(String((before as any).owner));
        }
    update :scribble
      do
        run({ self }) {
          (self as any).title = "changed by run";
        }
    destroy :remove
      input
        string :reason
      validate
        check :reasoned [
          that=({ input }) => input.reason.length > 0
          code="task.reason"
          message="say why"
        ]
      do
        run({ self, context }) {
          context.log.push(\`removing \${self.title}\`);
        }
    destroy :wipe
`;

let dir: string;
let app: any;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".lifecycle-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" } },
  };
  const files = { member, task };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(files).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  app = await import(join(dir, ".mesh/index.ts"));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("the generated files", () => {
  test("type-check under the strictest flags a consuming project might use", async () => {
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    expect(files.length).toBeGreaterThan(8);
    // `index.ts` imports the project's config, which is not part of this fixture.
    await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", ...files,
    ], { cwd: dir });
    expect(relative(dir, dir) + (child.stdout.toString() + child.stderr.toString())).toBe("");
    expect(child.exitCode).toBe(0);
  });

  test("a load nested in when is typed as possibly absent; a top-level load as present", async () => {
    await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
    await Bun.write(join(dir, "check-types.ts"), [
      'import type { bind } from "./.mesh/index.ts";',
      "type Mesh = ReturnType<typeof bind>;",
      'declare const maybe: Awaited<ReturnType<Mesh["wantOwnerTask"]>>;',
      'declare const always: Awaited<ReturnType<Mesh["showTask"]>>;',
      "// @ts-expect-error owner may be absent, because its load is under a when",
      "export const a: string = maybe.owner.name;",
      "export const b: string | undefined = maybe.owner?.name;",
      "export const c: string = always.owner.name;",
      "",
    ].join("\n"));
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--allowImportingTsExtensions", "mesh.config.ts", "check-types.ts", ...files,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
  });
});

const NOW = new Date("2026-10-10T10:00:00.000Z");
let clockNow = NOW;
const alice = { id: "00000000-0000-4000-8000-0000000000a1" };

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  const log: string[] = [];
  const ctx = { actor: alice, log };
  const mesh = app.bind(db, { clock: () => clockNow });
  const member = await mesh.joinMember({ name: "Ada", plan: "paid" }, ctx);
  const owner = await mesh.joinMember({ name: "Bo" }, ctx);
  return { db, mesh, ctx, log, member, owner };
}
type World = Awaited<ReturnType<typeof fresh>>;

/** The error a call rejects with. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  try { await call; } catch (error) { return error; }
  throw new Error("expected the call to reject");
}
async function invalid(call: Promise<unknown>): Promise<InvalidInputError> {
  const error = await failure(call);
  expect(error).toBeInstanceOf(InvalidInputError);
  return error as InvalidInputError;
}
const summary = (error: InvalidInputError) => error.issues.map((issue: Issue) => [issue.label, issue.code]);

async function openTask(world: World, extra: Record<string, unknown> = {}) {
  return world.mesh.openTask({ title: "write", owner: world.member.id, reviewer: world.member.id, ...extra }, world.ctx);
}

describe("create", () => {
  test("a required attribute is filled from a set whose value is not constant (D04), and the relationship set stores the actor's key (G30)", async () => {
    const world = await fresh();
    try {
      const created = await openTask(world);
      expect(created.openedAt).toEqual(NOW);
      expect(created.creatorId).toBe(alice.id);
      expect(created).toMatchObject({ title: "write", state: "open", version: 1, ownerId: world.member.id, reviewerId: world.member.id, note: null });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.touchedAt).toBeInstanceOf(Date);
    } finally { await world.db.close(); }
  });

  test("a set on a relationship with no actor stores null on a nullable one", async () => {
    const world = await fresh();
    try {
      const created = await world.mesh.openTask({ title: "x", owner: world.member.id, reviewer: world.member.id }, {});
      expect(created.creatorId).toBeNull();
    } finally { await world.db.close(); }
  });

  test("a set on a required relationship with no actor names the step and writes nothing", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.openAsTask({ title: "x", owner: world.member.id }, {}));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toMatch(/^set &reviewer \(src\/domain\/task\.mesh\.mx:\d+:\d+\) produced no value, and the relationship reviewer is required$/);
      expect(await world.mesh.readTask({}, world.ctx)).toEqual([]);
      const ok = await world.mesh.openAsTask({ title: "x", owner: world.member.id }, world.ctx);
      expect(ok.reviewerId).toBe(alice.id);
    } finally { await world.db.close(); }
  });

  test("a check reads a related record through the transaction: the quota counts the owner's tasks, and `when` limits it to the free plan", async () => {
    const world = await fresh();
    try {
      await world.mesh.openTask({ title: "1", owner: world.owner.id, reviewer: world.owner.id }, world.ctx);
      await world.mesh.openTask({ title: "2", owner: world.owner.id, reviewer: world.owner.id }, world.ctx);
      const error = await invalid(world.mesh.openTask({ title: "3", owner: world.owner.id, reviewer: world.owner.id }, world.ctx));
      expect(summary(error)).toEqual([["underQuota", "task.quota"]]);
      expect(error.issues[0]).toMatchObject({ message: "free members have 2 tasks", details: { limit: 2 }, path: [] });
      expect(await world.mesh.readTask({}, world.ctx)).toHaveLength(2);
      // The paid member is not under the quota: `when` is false, so the check does not apply.
      for (const n of [1, 2, 3]) await world.mesh.openTask({ title: String(n), owner: world.member.id, reviewer: world.member.id }, world.ctx);
      expect(await world.mesh.readTask({}, world.ctx)).toHaveLength(5);
    } finally { await world.db.close(); }
  });

  test("an always check runs on a create, and the issue carries the position of its line", async () => {
    const world = await fresh();
    try {
      const error = await invalid(openTask(world, { title: "STOP" }));
      expect(error.code).toBe("invalid_input");
      expect(error.issues).toEqual([{
        label: "titleNotShouting", code: "task.shouting", path: [], message: "do not shout", details: null,
        source: { file: "src/domain/task.mesh.mx", line: 25, column: 9 },
      }]);
      expect(error.message).toBe("titleNotShouting: do not shout");
    } finally { await world.db.close(); }
  });

  test("cast failures come first and are reported alone: the checks do not run on input that does not fit", async () => {
    const world = await fresh();
    try {
      const error = await invalid(world.mesh.openTask({ title: "", owner: world.member.id, reviewer: world.member.id, priority: 12 }, world.ctx));
      expect(error.issues.every((issue: Issue) => issue.label === null && issue.source === null && issue.details === null)).toBe(true);
      expect(error.issues.map((issue: Issue) => issue.path[0]).sort()).toEqual(["priority", "title"]);
    } finally { await world.db.close(); }
  });
});

describe("update", () => {
  test("every update reads the row under the lock first: a missing row is NotFoundError before any check", async () => {
    const world = await fresh();
    try {
      const error = await failure(world.mesh.startTask({ id: "00000000-0000-4000-8000-000000000999" }, world.ctx));
      expect(error).toBeInstanceOf(NotFoundError);
    } finally { await world.db.close(); }
  });

  test("every failed check is reported together, in the order written; an unknown result fails (acceptance 4, D1)", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      const error = await invalid(world.mesh.vetTask({ id: row.id }, world.ctx));
      // note is null, so `&note?.length > 3` is unknown, and an unknown result fails (ADR-0012, D1); state is open, so openOnly passes.
      expect(summary(error)).toEqual([["noteLong", "task.note"], ["priorityHigh", "task.priority"]]);
      expect(error.message).toBe("noteLong: the note must be longer than 3\npriorityHigh: priority is too low");
      expect((await world.mesh.readTask({}, world.ctx))[0]).toMatchObject({ id: row.id, state: "open" });
    } finally { await world.db.close(); }
  });

  test("the always check and the action's checks fail together", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      const error = await invalid(world.mesh.renameTask({ id: row.id, title: "STOP", expectedVersion: 7 }, world.ctx));
      expect(summary(error)).toEqual([["titleNotShouting", "task.shouting"], ["expectedVersion", "expected-version"]]);
    } finally { await world.db.close(); }
  });

  test("details run only for a failed check, with `before`, and ride on the issue (G22)", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      const error = await invalid(world.mesh.renameTask({ id: row.id, title: "new", expectedVersion: 9 }, world.ctx));
      expect(error.issues).toHaveLength(1);
      expect(error.issues[0]).toMatchObject({ label: "expectedVersion", code: "expected-version", details: { currentVersion: 1 } });
      const passed = await world.mesh.renameTask({ id: row.id, title: "new", expectedVersion: 1 }, world.ctx);
      expect(passed.title).toBe("new");
    } finally { await world.db.close(); }
  });

  test("before is the stored record and self the record with the input applied: a check can compare them", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { title: "same" });
      const error = await invalid(world.mesh.renameTask({ id: row.id, title: "same", expectedVersion: 1 }, world.ctx));
      expect(summary(error)).toEqual([["titleChanged", "task.unchanged"]]);
    } finally { await world.db.close(); }
  });

  test("version bump and expected-version, a check and a set (G02, acceptance 8): a stale update changes nothing", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { title: "v1" });
      const second = await world.mesh.renameTask({ id: row.id, title: "v2", expectedVersion: 1 }, world.ctx);
      expect(second.version).toBe(2);
      const stale = await invalid(world.mesh.renameTask({ id: row.id, title: "v3", expectedVersion: 1 }, world.ctx));
      expect(summary(stale)).toEqual([["expectedVersion", "expected-version"]]);
      expect(stale.issues[0]!.details).toEqual({ currentVersion: 2 });
      const [stored] = await world.mesh.readTask({}, world.ctx);
      expect(stored).toMatchObject({ title: "v2", version: 2 });
      const third = await world.mesh.renameTask({ id: row.id, title: "v3", expectedVersion: 2 }, world.ctx);
      expect(third).toMatchObject({ title: "v3", version: 3 });
    } finally { await world.db.close(); }
  });

  test("an update that omits an optional input leaves the stored value, and a set from the same input name is skipped (ADR-0012)", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { priority: 4 });
      const noted = await world.mesh.annotateTask({ id: row.id, note: "hello" }, world.ctx);
      expect(noted).toMatchObject({ note: "hello", priority: 4 });
      const omitted = await world.mesh.annotateTask({ id: row.id }, world.ctx);
      expect(omitted).toMatchObject({ note: "hello", priority: 4 });
      const changed = await world.mesh.annotateTask({ id: row.id, priority: 6 }, world.ctx);
      expect(changed).toMatchObject({ note: "hello", priority: 6 });
      const cleared = await world.mesh.annotateTask({ id: row.id, note: null }, world.ctx);
      expect(cleared.note).toBeNull();
    } finally { await world.db.close(); }
  });

  test("a state transition is a check and a set: start works once, and the second start is refused with its code", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      const started = await world.mesh.startTask({ id: row.id }, world.ctx);
      expect(started.state).toBe("doing");
      const error = await invalid(world.mesh.startTask({ id: row.id }, world.ctx));
      expect(summary(error)).toEqual([["openOnly", "task.open"]]);
    } finally { await world.db.close(); }
  });

  test("when and a when nested inside it run only when their conditions hold, each seeing the earlier steps' writes", async () => {
    const world = await fresh();
    try {
      const done = async (priority: number) => {
        const row = await openTask(world, { title: `p${priority}`, priority, owner: world.member.id });
        await world.mesh.startTask({ id: row.id }, world.ctx);
        return world.mesh.finishTask({ id: row.id }, world.ctx);
      };
      const low = await done(1);
      const mid = await done(5);
      const top = await done(9);
      expect([low, mid, top].map((t) => t.state)).toEqual(["done", "done", "done"]);
      expect([low, mid, top].map((t) => t.doneAt?.getTime() ?? null)).toEqual([null, NOW.getTime(), NOW.getTime()]);
      expect([low, mid, top].map((t) => t.note)).toEqual([null, null, "critical"]);
      const notStarted = await openTask(world, { title: "late", owner: world.member.id });
      expect(summary(await invalid(world.mesh.finishTask({ id: notStarted.id }, world.ctx)))).toEqual([["started", "task.started"]]);
    } finally { await world.db.close(); }
  });

  test("a run step gets { self, input, actor, context } and runs between the checks and the write", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { title: "ping me" });
      await world.mesh.pingTask({ id: row.id }, world.ctx);
      await world.mesh.pingTask({ id: row.id }, { log: world.log });
      expect(world.log).toEqual([`ping ping me by ${alice.id} (state open)`, "ping ping me by nobody (state open)"]);
    } finally { await world.db.close(); }
  });

  test("a throw in a step rolls back what the steps set", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      const error = await failure(world.mesh.boomTask({ id: row.id }, world.ctx));
      expect((error as Error).message).toBe("boom");
      expect((await world.mesh.readTask({}, world.ctx))[0]).toMatchObject({ state: "open", version: 1 });
    } finally { await world.db.close(); }
  });

  test("a failure after the write (while the result is loaded) rolls the write back", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { title: "fine" });
      const error = await failure(world.mesh.renameLoudTask({ id: row.id, title: "boom" }, world.ctx));
      expect((error as Error).message).toContain("bad computed");
      expect((await world.mesh.readTask({}, world.ctx))[0]).toMatchObject({ title: "fine" });
      expect((await world.mesh.renameLoudTask({ id: row.id, title: "ok" }, world.ctx)).title).toBe("ok");
    } finally { await world.db.close(); }
  });

  test("a load nested in when loads only when the condition holds", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      expect((await world.mesh.wantOwnerTask({ id: row.id, want: true }, world.ctx)).owner).toMatchObject({ name: "Ada" });
      expect((await world.mesh.wantOwnerTask({ id: row.id, want: false }, world.ctx) as any).owner).toBeUndefined();
    } finally { await world.db.close(); }
  });

  test("a load step loads onto the returned record, and nothing else is written", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { priority: 8 });
      const shown = await world.mesh.showTask({ id: row.id }, world.ctx);
      expect(shown.owner).toMatchObject({ id: world.member.id, name: "Ada" });
      expect(shown.urgent).toBe(true);
      expect(shown.version).toBe(1);
    } finally { await world.db.close(); }
  });

  test("the on=:update timestamp is stamped by every update", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      clockNow = new Date(NOW.getTime() + 5000);
      const touched = await world.mesh.showTask({ id: row.id }, world.ctx);
      expect(touched.touchedAt.getTime()).toBeGreaterThan(row.touchedAt.getTime());
    } finally { clockNow = NOW; await world.db.close(); }
  });
});

describe("a function cannot reach past what it was given", () => {
  test("a plain function that reads a relationship on `before` throws, naming the field, instead of reading undefined", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      const error = await failure(world.mesh.peekTask({ id: row.id }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toContain("Task.owner");
      expect((error as Error).message).toContain("not loaded");
    } finally { await world.db.close(); }
  });

  test("a run that assigns to self throws a FrameworkError that points at `set`, and nothing is stored", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { title: "keep" });
      const error = await failure(world.mesh.scribbleTask({ id: row.id }, world.ctx));
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toContain("Task.scribble");
      expect((error as Error).message).toContain("`set`");
      expect((await world.mesh.readTask({}, world.ctx))[0]).toMatchObject({ title: "keep" });
    } finally { await world.db.close(); }
  });
});

describe("a change made inside a run is never stored, and a guarded path throws", () => {
  const DONE = new Date("2026-01-01T00:00:00.000Z");
  const stored = async (world: World, id: string) => (await world.mesh.readTask({ filter: { id: { eq: id } } }, world.ctx))[0];

  for (const what of ["json", "array", "date"]) {
    test(`create: changing ${what} in place throws when the caller sent the field, and nothing is stored either way`, async () => {
      const world = await fresh();
      try {
        const sent = { meta: { a: 1, list: [1] }, doneAt: DONE };
        const error = await failure(world.mesh.openMutateTask({ title: "m", owner: world.member.id, reviewer: world.member.id, what, ...sent }, world.ctx));
        expect(error).toBeInstanceOf(FrameworkError);
        expect(await world.mesh.readTask({}, world.ctx)).toEqual([]);
        const omitted = await world.mesh.openMutateTask({ title: "m", owner: world.member.id, reviewer: world.member.id, what }, world.ctx);
        expect(omitted).toMatchObject({ meta: null, doneAt: null });
      } finally { await world.db.close(); }
    });

    test(`update: changing ${what} in place throws when the caller sent the field and is a no-op when it did not; the stored value never changes`, async () => {
      const world = await fresh();
      try {
        const row = await world.mesh.openMutateTask({ title: "m", owner: world.member.id, reviewer: world.member.id, what: "none", meta: { a: 1, list: [1] }, doneAt: DONE }, world.ctx);
        const error = await failure(world.mesh.editMutateTask({ id: row.id, what, meta: { b: 2, list: [2] }, doneAt: DONE }, world.ctx));
        expect(error).toBeInstanceOf(FrameworkError);
        expect(await stored(world, row.id)).toMatchObject({ meta: { a: 1, list: [1] }, doneAt: DONE });
        await world.mesh.editMutateTask({ id: row.id, what }, world.ctx).then(() => undefined, (e: unknown) => expect(e).toBeInstanceOf(FrameworkError));
        expect(await stored(world, row.id)).toMatchObject({ meta: { a: 1, list: [1] }, doneAt: DONE });
      } finally { await world.db.close(); }
    });
  }

  test("a write to a loaded related record and to before throws, and the stored values stay", async () => {
    const world = await fresh();
    try {
      const row = await world.mesh.openMutateTask({ title: "m", owner: world.member.id, reviewer: world.member.id, what: "none", meta: { a: 1, list: [1] } }, world.ctx);
      for (const what of ["related", "before", "beforeJson"]) {
        const error = await failure(world.mesh.editMutateTask({ id: row.id, what }, world.ctx));
        expect(error, what).toBeInstanceOf(FrameworkError);
        expect((error as Error).message, what).toContain("cannot change the record");
      }
      expect(await stored(world, row.id)).toMatchObject({ title: "m", meta: { a: 1, list: [1] } });
      expect((await world.mesh.readMember({}, world.ctx)).map((m: { name: string }) => m.name).sort()).toEqual(["Ada", "Bo"]);
    } finally { await world.db.close(); }
  });
});

describe("destroy", () => {
  test("a destroy accepts input (D05); its checks and run see the stored record, and a failed check deletes nothing", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world, { title: "gone" });
      const error = await invalid(world.mesh.removeTask({ id: row.id, reason: "" }, world.ctx));
      expect(summary(error)).toEqual([["reasoned", "task.reason"]]);
      expect(await world.mesh.readTask({}, world.ctx)).toHaveLength(1);
      expect(await world.mesh.removeTask({ id: row.id, reason: "done with it" }, world.ctx)).toBeUndefined();
      expect(world.log).toEqual(["removing gone"]);
      expect(await world.mesh.readTask({}, world.ctx)).toEqual([]);
      expect(await failure(world.mesh.removeTask({ id: row.id, reason: "again" }, world.ctx))).toBeInstanceOf(NotFoundError);
    } finally { await world.db.close(); }
  });

  test("a destroy without checks deletes by key without reading the row", async () => {
    const world = await fresh();
    try {
      const row = await openTask(world);
      await world.mesh.wipeTask({ id: row.id }, world.ctx);
      expect(await failure(world.mesh.wipeTask({ id: row.id }, world.ctx))).toBeInstanceOf(NotFoundError);
    } finally { await world.db.close(); }
  });
});
