import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { FrameworkError, InvalidInputError } from "@meshfw/runtime";
import { readEvents, tables } from "#mesh";
import { Idempotency } from "#mesh/domain/audit";
import { Attempt, Invocation, Machine, Run, SessionReference } from "#mesh/domain/execution";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Assignment, Claim, Completion, Dependency, EvidenceReference, LateResult, Review, Submission, Task } from "#mesh/domain/work";
import { as, asSystem, empty, populate, setup } from "./world";

const root = resolve(import.meta.dir, "..");
const context = setup;
const ENTITIES = [
  "Assignment", "Attempt", "Claim", "Collaborator", "Completion", "Dependency", "EvidenceReference", "Idempotency", "Invocation",
  "LateResult", "Machine", "Membership", "Review", "Run", "SessionReference", "Submission", "Task", "Workspace",
];

/** Core's tables of the event log, which `tables` and the database hold beside the entities' own. */
const CORE = ["mesh_handler_progress", "mesh_outbox", "mesh_outbox_state", "mesh_subscription_progress"];

describe("the schema", () => {
  test("the model has 18 entities in four modules, each in a folder of its own", async () => {
    const model = JSON.parse(readFileSync(resolve(root, ".mesh/model.json"), "utf8")) as { entities: { name: string; module: string }[] };
    expect(model.entities.map((entity) => entity.name).sort()).toEqual(ENTITIES);
    expect([...new Set(model.entities.map((entity) => entity.module))].sort()).toEqual(["audit", "execution", "identity", "work"]);
    // The 18 entity tables, and core's four tables of the event log (the outbox, its state, handler and subscription progress).
    expect(Object.keys(tables).filter((name) => !CORE.includes(name))).toHaveLength(18);
    expect(Object.keys(tables).filter((name) => CORE.includes(name)).sort()).toEqual(CORE);
  });

  test("`mesh db push` creates the 18 entity tables and core's four", () => {
    const file = resolve(root, "hyper.db");
    rmSync(file, { force: true });
    try {
      const pushed = Bun.spawnSync([process.execPath, resolve(root, "../../packages/cli/src/bin.ts"), "db", "push"], { cwd: root });
      expect(pushed.stderr.toString()).not.toContain("error");
      expect(pushed.exitCode).toBe(0);
      const database = new Database(file, { readonly: true });
      const names = (database.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name);
      database.close();
      // SQLite adds `sqlite_sequence` for the outbox's never-reused AUTOINCREMENT key.
      expect(names.filter((name) => !CORE.includes(name) && name !== "sqlite_sequence")).toHaveLength(18);
      expect(names.filter((name) => CORE.includes(name)).sort()).toEqual(CORE);
      expect(names).toContain("sqlite_sequence");
    } finally { for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true }); }
  }, 30_000);
});

describe("one row of every entity round-trips through its generated functions", () => {
  test("create, then read back the same row", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const rows = await populate(fresh);
        const reads: Record<string, () => Promise<unknown[]>> = {
          Workspace: () => Workspace.read({}, context), Collaborator: () => Collaborator.read({}, context),
          Membership: () => Membership.read({}, context), Task: () => Task.read({}, context),
          Dependency: () => Dependency.read({}, context), Assignment: () => Assignment.read({}, context),
          Claim: () => Claim.read({}, context), Submission: () => Submission.read({}, context),
          Review: () => Review.read({}, context), Completion: () => Completion.read({}, context),
          LateResult: () => LateResult.read({}, context), EvidenceReference: () => EvidenceReference.read({}, context),
          Run: () => Run.read({}, context), Attempt: () => Attempt.read({}, context),
          Invocation: () => Invocation.read({}, context), Machine: () => Machine.read({}, context),
          SessionReference: () => SessionReference.read({}, context), Idempotency: () => Idempotency.read({}, context),
        };
        expect(Object.keys(reads).sort()).toEqual(ENTITIES);
        // The rows no later step changed read back as they were returned.
        const unchanged: Record<string, unknown[]> = {
          Workspace: [rows.workspace], Membership: [rows.membership, rows.botMembership], Dependency: [rows.dependency],
          Review: [rows.review], Completion: [rows.completion], LateResult: [rows.lateResult], EvidenceReference: [rows.evidence],
          Run: [rows.run], Attempt: [rows.attempt], Invocation: [rows.invocation], Machine: [rows.machine],
          SessionReference: [rows.session], Idempotency: [rows.idempotency], Collaborator: [rows.alice, rows.bot],
        };
        for (const [name, expected] of Object.entries(unchanged)) expect(await reads[name]!(), name).toEqual(expected);
        // The rows later steps changed read back with those changes.
        // Task: the dependency, the claim and its revocation (the late result changes nothing); child: assign, claim, submit, accept.
        const byId = async <T extends { id: string }>(read: Promise<T[]>) => new Map((await read).map((row) => [row.id, row]));
        const tasks = await byId(Task.read({}, context));
        expect(tasks.get(rows.task.id)).toMatchObject({ state: "open", version: rows.task.version + 3 });
        expect(tasks.get(rows.child.id)).toMatchObject({ state: "done", version: rows.child.version + 4 });
        expect(await reads.Submission!()).toEqual([{ ...rows.submission, state: "accepted" }]);
        const claims = await byId(Claim.read({}, context));
        expect(claims.size).toBe(2);
        expect(claims.get(rows.childClaim.id)).toMatchObject({ state: "released", endReason: "submitted" });
        expect(claims.get(rows.claim.id)).toMatchObject({ state: "revoked", endReason: "taking over" });
        expect(await reads.Assignment!()).toHaveLength(2);
        expect(rows.review).toMatchObject({ decision: "accept" });
      });
    } finally { await db.close(); }
  });

  test("enum values with hyphens are stored and validated as the spec spells them", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { task, submission, alice, completion, review } = await populate(fresh);
        expect(completion.rule).toBe("review-accepted");
        // The child's parent has no current assignment, so its creator reviews.
        expect(review.ruleApplied).toBe("parent-creator");
        // Completion :record is internal (only task.complete records one): the test calls it as the engine would.
        const second = await Completion.record({ rule: "performer-is-reviewer", task: task.id }, asSystem(alice));
        expect((await Completion.read({ filter: { rule: { in: ["performer-is-reviewer", "review-waived"] } } }, context)).map((c) => c.id)).toEqual([second.id]);
        // @ts-expect-error "reviewer" is not one of the spec's completion rules
        await expect(Completion.record({ rule: "reviewer", task: task.id, submission: submission.id }, asSystem(alice))).rejects.toBeInstanceOf(InvalidInputError);
      });
    } finally { await db.close(); }
  });

  test("defaults, stamps and the keys Mesh fills", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { task, idempotency, alice } = await populate(fresh);
      expect(task).toMatchObject({ state: "open", version: 1, intent: null, parentId: null, creatorId: alice.id });
      expect(idempotency).toMatchObject({ commandId: "populate", method: "task.create", result: { ok: true } });
      expect(idempotency.recordedAt).toBeInstanceOf(Date);
      expect(task.createdAt).toBeInstanceOf(Date);
      for (const id of [task.id, idempotency.id]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally { await db.close(); }
  });

  test("the plain updates change only what they accept, and a missing row is not found", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { task, alice } = await populate(fresh);
        expect(await Task.setPriority({ id: task.id, priority: 9 }, context)).toMatchObject({ priority: 9, title: "Ship", state: "open" });
        const other = await Task.create({ title: "Release" }, as(alice));
        expect(await Task.move({ id: task.id, parent: other.id }, context)).toMatchObject({ parentId: other.id });
        expect(await Collaborator.update({ id: alice.id, name: "Alicia" }, context)).toMatchObject({ name: "Alicia", kind: "human" });
        await expect(Task.setPriority({ id: "00000000-0000-4000-8000-0000000000ff", priority: 1 }, context)).rejects.toMatchObject({ code: "not_found" });
      });
    } finally { await db.close(); }
  });

  test("a unique column refuses a second row; a dependency can be removed", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { dependency, machine } = await populate(fresh);
        // machine.name-free refuses first; past the rule, the unique index still refuses the row.
        await expect(Machine.register({ name: "laptop" }, context)).rejects.toBeInstanceOf(InvalidInputError);
        const refused = await fresh.insert("machines", { ...machine, id: crypto.randomUUID() }).then(() => undefined, (caught: unknown) => caught);
        expect(refused).toBeInstanceOf(FrameworkError);
        expect(String((refused as FrameworkError).cause)).toContain("UNIQUE constraint failed: machines.name");
        await Dependency.remove({ id: dependency.id }, context);
        expect(await Dependency.read({}, context)).toEqual([]);
      });
    } finally { await db.close(); }
  });
});

describe("json attributes", () => {
  test("an object and an array are stored and returned, and the defaults are an empty object and array", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { task, bot, run, attempt, submission, evidence, lateResult } = await populate(fresh);
        expect(run.inputs).toEqual({ goal: "ship", steps: [1, 2] });
        expect(submission.evidence).toEqual([evidence.id]);
        expect(run.outcome).toBeNull();
        expect(attempt.outcome).toBeNull();
        const second = await Run.start({ task: task.id }, as(bot));
        expect(second.inputs).toEqual({});
        expect(lateResult.evidence).toEqual([]);
        expect((await Run.read({ sort: ["startedAt", "id"] }, context)).map((r) => r.inputs)).toEqual([run.inputs, {}]);
      });
    } finally { await db.close(); }
  });

  test("a value JSON cannot hold fails at the validator and writes nothing", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { task, alice } = await populate(fresh);
        for (const bad of [() => 1, new Date(), Number.NaN, { a: undefined }, new Map(), 1n])
          await expect(Run.start({ task: task.id, inputs: bad }, as(alice)), String(bad)).rejects.toBeInstanceOf(InvalidInputError);
        expect(await Run.read({}, context)).toHaveLength(1);
        // @ts-expect-error a json attribute is not a filter key
        await expect(Run.read({ filter: { inputs: { eq: "x" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
      });
    } finally { await db.close(); }
  });
});

describe("the event log's positions", () => {
  test("200 commands with a rolled-back transaction every tenth leave positions 1 to 180 with no gap", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { alice } = await populate(fresh);
        const { cursor: start } = await readEvents({ after: 0, limit: 1000 });
        for (let n = 1; n <= 200; n++) {
          if (n % 10 === 0) {
            // The generated call joins this transaction; the throw rolls the write and its event back.
            await expect(db.transaction(async () => { await Task.create({ title: `T${n}` }, as(alice)); throw new Error("rollback"); })).rejects.toThrow("rollback");
          } else await Task.create({ title: `T${n}` }, as(alice));
        }
        const { events } = await readEvents({ after: start, limit: 1000 });
        expect(events.map((event) => event.position)).toEqual(Array.from({ length: 180 }, (_, i) => start + i + 1));
        expect(new Set(events.map((event) => event.name))).toEqual(new Set(["work.TaskCreated"]));
      });
    } finally { await db.close(); }
  }, 30_000);

  test("parallel commands get distinct consecutive positions", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const { alice } = await populate(fresh);
        const { cursor: start } = await readEvents({ after: 0, limit: 1000 });
        await Promise.all(Array.from({ length: 25 }, (_, n) => Task.create({ title: `P${n}` }, as(alice))));
        const { events } = await readEvents({ after: start });
        expect(events.map((event) => event.position)).toEqual(Array.from({ length: 25 }, (_, i) => start + i + 1));
      });
    } finally { await db.close(); }
  });
});

describe("reads of Hyper's list_tasks shape", () => {
  test("Task.read({ filter: { parentId: { eq } }, sort: [createdAt, id], limit: 10 }) returns the first page of that parent's children", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await hyper.run(async () => {
        const alice = await Collaborator.register({ kind: "human", name: "Alice" }, context);
        await Membership.grant({ role: "owner", collaborator: alice.id }, asSystem(alice));
        const parent = await Task.create({ title: "parent" }, as(alice));
        const other = await Task.create({ title: "other parent" }, as(alice));
        const mine: string[] = [];
        for (let n = 0; n < 25; n++) {
          fresh.advance(1);
          mine.push((await Task.create({ title: `child ${n}`, parent: parent.id }, as(alice))).title);
          await Task.create({ title: `stranger ${n}`, parent: other.id }, as(alice));
        }
        const filter = { parentId: { eq: parent.id } };
        const first = await Task.read({ filter, sort: ["createdAt", "id"], limit: 10 }, context);
        expect(first.map((task) => task.title)).toEqual(mine.slice(0, 10));
        const second = await Task.read({ filter, sort: ["createdAt", "id"], limit: 10, offset: 10 }, context);
        expect(second.map((task) => task.title)).toEqual(mine.slice(10, 20));
        const last = await Task.read({ filter, sort: ["createdAt", "id"], limit: 10, offset: 20 }, context);
        expect(last.map((task) => task.title)).toEqual(mine.slice(20));
        expect(await Task.read({ filter: { parentId: { nil: true } }, sort: ["createdAt", "id"] }, context)).toHaveLength(2);
        expect(await Task.read({ filter: { and: [filter, { state: { eq: "done" } }] } }, context)).toEqual([]);
      });
    } finally { await db.close(); }
  });
});

test("PORTING.md lists each omission as one line: entity, construct, milestone; none is M5's, which is done", () => {
  const text = readFileSync(resolve(root, "PORTING.md"), "utf8");
  const lines = text.split("\n").filter((line) => line.startsWith("- "));
  expect(lines.length).toBeGreaterThan(20);
  for (const line of lines) {
    expect(line, line).toMatch(/^- (?:[A-Z][A-Za-z]+(?:, [A-Z][A-Za-z]+)*|All entities): .+ \((?:[GD]\d+(?:, [GD]\d+)*|no gap code)\): (?:M\d+[a-z]?|after 1\.0|not scheduled|application code)\.$/);
    expect(line, line).not.toMatch(/: M5\.$/);
  }
});

test("PORTING.md's table places each of the 13 effects (G05) in an entity file or a command function", () => {
  const text = readFileSync(resolve(root, "PORTING.md"), "utf8");
  const rows = text.split("\n").filter((line) => /^\| `[a-z]+\.[a-z]+` \|/.test(line));
  expect(rows.map((row) => row.split(" | ")[0]!.slice(2))).toEqual([
    "`task.complete`", "`task.cancel`", "`task.assign`", "`task.unassign`", "`claim.acquire`", "`submission.submit`",
    "`review.accept`", "`review.return`", "`collaborator.retire`", "`membership.revoke`", "`attempt.start`",
    "`attempt.finish`", "`session.record`",
  ]);
  for (const row of rows) expect(row, row).toMatch(/\.mesh\.mx`|\.commands\.ts`/);
});

afterAll(() => { if (existsSync(resolve(root, "hyper.db"))) rmSync(resolve(root, "hyper.db"), { force: true }); });
