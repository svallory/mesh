// A service's generated code at run time (`notes/architecture/services-design.md`, PR 3, sections 5.2 and 7; ruling
// D42): built, generated and run against an in-memory SQLite database. The generated method casts the input with the
// operation's schema, runs the service's policies (fail closed), runs the body in one transaction whose entity calls each
// run their own policies, refuses a call its `uses` lines do not list and rolls everything back, and resolves with what
// the body returns. The run-time rules themselves are pinned on hand-written values in `packages/runtime/test/service.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { ForbiddenError, FrameworkError, InvalidInputError } from "@meshfw/runtime";
import { SCRATCH } from "./domain/harness.ts";
import { sqliteDomain } from "./domain/sqlite.ts";

const open = "  policies\n    policy :anyone\n      authorize-if=() => true\n";
const task = `entity :Task table="tasks"
  attributes
    uuid :id primary-key
    string :title
    enum :state values=[:open, :done] default=:open
    string :assignee nullable
  actions auto=[:read]
    create :create
      input
        &title
    update :complete
      do
        set
          &state=:done
    update :reassign
      input
        &assignee
${open}`;
const claim = `import { Task } from "./task.mesh.mx"
entity :Claim table="claims"
  attributes
    uuid :id primary-key
    boolean :ended default=false
  relationships
    belongs-to :task entity=Task
  actions auto=[:read]
    create :create
      input
        &task
    update :end
      do
        set
          &ended=true
${open}`;
const work = `import { Mesh } from "meshfw"
import { Task } from "./task.mesh.mx"
import { Claim } from "./claim.mesh.mx"

service :Work
  operation :handOver
    uses entity=Task actions=[:reassign]
    uses entity=Claim actions=[:read, :end]
    input
      uuid :task
      string :to
    run({ input, context }) {
      for (const claim of await Mesh.privileged(Claim).read({ filter: { taskId: { eq: input.task } } }))
        await Claim.end({ id: claim.id }, context)
      return Task.reassign({ id: input.task, assignee: input.to }, context)
    }
  operation :sneaky
    uses entity=Task actions=[:read]
    uses entity=Claim actions=[:read, :end]
    input
      uuid :task
    run({ input, context }) {
      for (const claim of await Mesh.privileged(Claim).read({ filter: { taskId: { eq: input.task } } }))
        await Claim.end({ id: claim.id }, context)
      try {
        await Task.complete({ id: input.task }, context)
      } catch {
        return "caught"
      }
      return "completed"
    }
  operation :stamp
    uses entity=Task actions=[:read]
    uses entity=Claim actions=[:read]
    run() {
      return { at: %.now, actor: actor }
    }
  operation :ungoverned
    uses entity=Task actions=[:read]
    uses entity=Claim actions=[:read]
    run() {
      return 1
    }
  policies
    policy :members actions=[&handOver, &sneaky, &stamp]
      authorize-if=({ actor }) => actor != null
`;

let dir: string;
let app: any;
let Work: any;
beforeAll(async () => {
  dir = await mkdtemp(join(SCRATCH, ".scratch-services-"));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: sqliteDomain.data([]) };
  const built = buildModel({
    root: dir, domainRoot: join(dir, "src/domain"),
    files: [{ file: "src/domain/work/task.mesh.mx", source: task }, { file: "src/domain/work/claim.mesh.mx", source: claim }, { file: "src/domain/work/work.mesh.mx", source: work }],
  });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, sqliteDomain.build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  app = await import(join(dir, ".mesh/index.ts"));
  ({ Work } = await import(join(dir, ".mesh/domain/work/index.ts")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const member = { actor: { id: "a" } };
const rejection = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);

/** One task with two claims, bound at a fixed instant. */
async function seeded() {
  const db = await sqliteDomain.layer(app.tables);
  await db.transaction(async (tx) => {
    await tx.insert(app.tables.tasks, { id: id(1), title: "one", state: "open", assignee: null });
    await tx.insert(app.tables.claims, { id: id(2), taskId: id(1), ended: false });
    await tx.insert(app.tables.claims, { id: id(3), taskId: id(1), ended: false });
  });
  const binding = app.bind(db, { clock: () => new Date("2026-11-17T12:00:00.000Z") });
  const state = () => db.transaction(async (tx) => ({ tasks: await tx.select(app.tables.tasks, {}), claims: (await tx.select(app.tables.claims, {})).map((row) => row.ended) }));
  return { binding, state };
}

describe("a generated operation", () => {
  test("the value has one method per operation and nothing else", () => {
    expect(Object.keys(Work)).toEqual(["handOver", "sneaky", "stamp", "ungoverned"]);
    expect(Object.isFrozen(Work)).toBe(true);
  });

  test("runs its body in one transaction and resolves with what the body returns", async () => {
    const { binding, state } = await seeded();
    const moved = await binding.run(() => Work.handOver({ task: id(1), to: "b" }, member));
    expect(moved).toMatchObject({ id: id(1), assignee: "b" });
    expect(await state()).toMatchObject({ tasks: [{ assignee: "b" }], claims: [true, true] });
  });

  test("a call its uses lines do not list is a FrameworkError, and every write before it rolls back, even when the body catches it", async () => {
    const { binding, state } = await seeded();
    const error = await rejection(binding.run(() => Work.sneaky({ task: id(1) }, member)));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(JSON.stringify([String(error), String((error as { cause?: unknown }).cause)])).toContain("work.Work#sneaky called work.Task#complete");
    expect(await state()).toMatchObject({ tasks: [{ state: "open" }], claims: [false, false] });
  });

  test("the input is cast with the operation's schema: a bad uuid is InvalidInputError and runs nothing", async () => {
    const { binding, state } = await seeded();
    expect(await rejection(binding.run(() => Work.handOver({ task: "nope", to: "b" }, member)))).toBeInstanceOf(InvalidInputError);
    expect(await state()).toMatchObject({ tasks: [{ assignee: null }], claims: [false, false] });
  });

  test("the service's policies decide before anything runs: a denial names the service and the operation", async () => {
    const { binding, state } = await seeded();
    const denied = await rejection(binding.run(() => Work.handOver({ task: id(1), to: "b" }, {})));
    expect(denied).toBeInstanceOf(ForbiddenError);
    expect(denied).toMatchObject({ entity: "work.Work", action: "handOver", reason: "failed" });
    expect(await state()).toMatchObject({ tasks: [{ assignee: null }], claims: [false, false] });
  });

  test("an operation no policy covers is forbidden (fail closed)", async () => {
    const { binding } = await seeded();
    expect(await rejection(binding.run(() => Work.ungoverned({}, member)))).toMatchObject({ entity: "work.Work", action: "ungoverned", reason: "not-covered" });
  });

  test("the body reads the actor and the transaction's instant", async () => {
    const { binding } = await seeded();
    expect(await binding.run(() => Work.stamp({}, member))).toEqual({ at: new Date("2026-11-17T12:00:00.000Z"), actor: { id: "a" } });
  });
});
