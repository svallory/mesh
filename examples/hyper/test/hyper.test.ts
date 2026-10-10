import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { InvalidInputError } from "@meshfw/runtime";
import { bind, tables } from "#mesh";

const root = resolve(import.meta.dir, "..");
const context = { actor: { id: "00000000-0000-4000-8000-000000000001" } };
const ENTITIES = [
  "Assignment", "Attempt", "Claim", "Collaborator", "Completion", "Dependency", "Event", "EvidenceReference", "Invocation",
  "LateResult", "Machine", "Membership", "Review", "Run", "SessionReference", "Submission", "Task", "Workspace",
];

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  return { db, hyper: bind(db) };
}
type Hyper = Awaited<ReturnType<typeof fresh>>["hyper"];

/** One row of every entity, each created through its generated function. */
async function populate(hyper: Hyper) {
  const at = new Date("2026-10-10T10:00:00.000Z");
  const later = new Date("2026-10-10T11:00:00.000Z");
  const workspace = await hyper.createWorkspace({ name: "Home" }, context);
  const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, context);
  const bot = await hyper.registerCollaborator({ kind: "agent", name: "Bot" }, context);
  const membership = await hyper.grantMembership({ role: "owner", grantedAt: at, collaborator: alice.id, grantedBy: alice.id }, context);
  const task = await hyper.createTask({ title: "Ship", creator: alice.id, priority: 2 }, context);
  const child = await hyper.createTask({ title: "Test", creator: alice.id, parent: task.id }, context);
  const dependency = await hyper.addDependency({ dependent: task.id, prerequisite: child.id, createdBy: alice.id }, context);
  const assignment = await hyper.startAssignment({ reviewWaived: false, startedAt: at, task: task.id, assignee: bot.id, delegator: alice.id }, context);
  const claim = await hyper.acquireClaim({ fence: 1, acquiredAt: at, expiresAt: later, task: task.id, holder: bot.id }, context);
  const submission = await hyper.submitSubmission({ summary: "done", evidence: [{ kind: "file", id: 1 }], fence: 1, taskVersion: 1, task: task.id, submitter: bot.id }, context);
  const review = await hyper.acceptReview({ submission: submission.id, reviewer: alice.id }, context);
  const completion = await hyper.recordCompletion({ rule: "reviewer", task: task.id, submission: submission.id, completedBy: alice.id }, context);
  const lateResult = await hyper.recordLateResult({ fence: 1, evidence: ["a", "b"], task: task.id, holder: bot.id }, context);
  const evidence = await hyper.recordEvidenceReference({ kind: "file", locator: "notes.md", recordedBy: bot.id }, context);
  const machine = await hyper.registerMachine({ name: "laptop", platform: "linux" }, context);
  const session = await hyper.recordSessionReference({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: machine.id, agentProfile: bot.id, recordedBy: bot.id }, context);
  const run = await hyper.startRun({ inputs: { goal: "ship", steps: [1, 2] }, task: task.id, responsible: alice.id, startedBy: alice.id }, context);
  const attempt = await hyper.startAttempt({ number: 1, run: run.id, task: task.id, performer: bot.id, delegator: alice.id, machine: machine.id, session: session.id }, context);
  const invocation = await hyper.recordInvocation({ usageSource: "runtime", estimatedCost: 0.25, inputTokens: 10, attempt: attempt.id, task: task.id, recordedBy: bot.id }, context);
  const event = await hyper.recordEvent({ resource: "Task", action: "create", recordId: task.id, changes: { title: ["", "Ship"] }, task: task.id }, context);
  return { workspace, alice, bot, membership, task, child, dependency, assignment, claim, submission, review, completion, lateResult, evidence, machine, session, run, attempt, invocation, event };
}

describe("the schema", () => {
  test("the model has 18 entities in four modules, each in a folder of its own", async () => {
    const model = JSON.parse(readFileSync(resolve(root, ".mesh/model.json"), "utf8")) as { entities: { name: string; module: string }[] };
    expect(model.entities.map((entity) => entity.name).sort()).toEqual(ENTITIES);
    expect([...new Set(model.entities.map((entity) => entity.module))].sort()).toEqual(["audit", "execution", "identity", "work"]);
    expect(Object.keys(tables)).toHaveLength(18);
  });

  test("`mesh db push` creates 18 tables", () => {
    const file = resolve(root, "hyper.db");
    rmSync(file, { force: true });
    try {
      const pushed = Bun.spawnSync([process.execPath, resolve(root, "../../packages/cli/src/bin.ts"), "db", "push"], { cwd: root });
      expect(pushed.stderr.toString()).not.toContain("error");
      expect(pushed.exitCode).toBe(0);
      const database = new Database(file, { readonly: true });
      const names = (database.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name);
      database.close();
      expect(names).toHaveLength(18);
    } finally { for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true }); }
  });
});

describe("one row of every entity round-trips through its generated functions", () => {
  test("create, then read back the same row", async () => {
    const { db, hyper } = await fresh();
    try {
      const rows = await populate(hyper);
      const reads: Record<string, () => Promise<unknown[]>> = {
        Workspace: () => hyper.readWorkspace({}, context), Collaborator: () => hyper.readCollaborator({}, context),
        Membership: () => hyper.readMembership({}, context), Task: () => hyper.readTask({}, context),
        Dependency: () => hyper.readDependency({}, context), Assignment: () => hyper.readAssignment({}, context),
        Claim: () => hyper.readClaim({}, context), Submission: () => hyper.readSubmission({}, context),
        Review: () => hyper.readReview({}, context), Completion: () => hyper.readCompletion({}, context),
        LateResult: () => hyper.readLateResult({}, context), EvidenceReference: () => hyper.readEvidenceReference({}, context),
        Run: () => hyper.readRun({}, context), Attempt: () => hyper.readAttempt({}, context),
        Invocation: () => hyper.readInvocation({}, context), Machine: () => hyper.readMachine({}, context),
        SessionReference: () => hyper.readSessionReference({}, context), Event: () => hyper.readEvent({}, context),
      };
      expect(Object.keys(reads).sort()).toEqual(ENTITIES);
      const created: Record<string, unknown> = {
        Workspace: rows.workspace, Membership: rows.membership, Dependency: rows.dependency, Assignment: rows.assignment,
        Claim: rows.claim, Submission: rows.submission, Review: rows.review, Completion: rows.completion,
        LateResult: rows.lateResult, EvidenceReference: rows.evidence, Run: rows.run, Attempt: rows.attempt,
        Invocation: rows.invocation, Machine: rows.machine, SessionReference: rows.session, Event: rows.event,
      };
      for (const [name, row] of Object.entries(created)) expect(await reads[name]!(), name).toEqual([row]);
      expect(await reads.Collaborator!()).toEqual([rows.alice, rows.bot]);
      expect(await reads.Task!()).toEqual([rows.task, rows.child]);
      expect(rows.review).toMatchObject({ decision: "accept" });
      expect((await hyper.returnReview({ reasons: "more tests", submission: rows.submission.id, reviewer: rows.alice.id }, context))).toMatchObject({ decision: "return", reasons: "more tests" });
    } finally { await db.close(); }
  });

  test("defaults, stamps and the keys Mesh fills", async () => {
    const { db, hyper } = await fresh();
    try {
      const { task, event, alice } = await populate(hyper);
      expect(task).toMatchObject({ state: "open", version: 1, intent: null, parentId: null, creatorId: alice.id });
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(event.seq).toBe(1);
    } finally { await db.close(); }
  });

  test("the plain updates change only what they accept, and a missing row is not found", async () => {
    const { db, hyper } = await fresh();
    try {
      const { task, child, alice } = await populate(hyper);
      expect(await hyper.setPriorityTask({ id: task.id, priority: 9 }, context)).toMatchObject({ priority: 9, title: "Ship", state: "open" });
      expect(await hyper.moveTask({ id: child.id, parent: null }, context)).toMatchObject({ parentId: null });
      expect(await hyper.updateCollaborator({ id: alice.id, name: "Alicia" }, context)).toMatchObject({ name: "Alicia", kind: "human" });
      await expect(hyper.setPriorityTask({ id: "00000000-0000-4000-8000-0000000000ff", priority: 1 }, context)).rejects.toMatchObject({ code: "not_found" });
    } finally { await db.close(); }
  });

  test("a unique column refuses a second row; a dependency can be removed", async () => {
    const { db, hyper } = await fresh();
    try {
      const { dependency } = await populate(hyper);
      await expect(hyper.registerMachine({ name: "laptop" }, context)).rejects.toThrow();
      await hyper.removeDependency({ id: dependency.id }, context);
      expect(await hyper.readDependency({}, context)).toEqual([]);
    } finally { await db.close(); }
  });
});

describe("json attributes", () => {
  test("an object and an array are stored and returned, and the defaults are an empty object and array", async () => {
    const { db, hyper } = await fresh();
    try {
      const { task, bot, run, attempt, submission } = await populate(hyper);
      expect(run.inputs).toEqual({ goal: "ship", steps: [1, 2] });
      expect(submission.evidence).toEqual([{ kind: "file", id: 1 }]);
      expect(run.outcome).toBeNull();
      expect(attempt.outcome).toBeNull();
      const second = await hyper.startRun({ task: task.id, responsible: bot.id, startedBy: bot.id }, context);
      expect(second.inputs).toEqual({});
      const late = await hyper.recordLateResult({ fence: 2, task: task.id, holder: bot.id }, context);
      expect(late.evidence).toEqual([]);
      const event = await hyper.recordEvent({ resource: "Run", action: "start", recordId: run.id }, context);
      expect(event.changes).toEqual({});
      expect((await hyper.readRun({ sort: ["startedAt", "id"] }, context)).map((r) => r.inputs)).toEqual([run.inputs, {}]);
    } finally { await db.close(); }
  });

  test("a value JSON cannot hold fails at the validator and writes nothing", async () => {
    const { db, hyper } = await fresh();
    try {
      const { task, alice } = await populate(hyper);
      const base = { task: task.id, responsible: alice.id, startedBy: alice.id };
      for (const bad of [() => 1, new Date(), Number.NaN, { a: undefined }, new Map(), 1n, null])
        await expect(hyper.startRun({ ...base, inputs: bad }, context), String(bad)).rejects.toBeInstanceOf(InvalidInputError);
      expect(await hyper.readRun({}, context)).toHaveLength(1);
      // @ts-expect-error a json attribute is not a filter key
      await expect(hyper.readRun({ filter: { inputs: { eq: "x" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });
});

describe("integer keys", () => {
  const event = (n: number) => ({ resource: "Task", action: "create", recordId: "00000000-0000-4000-8000-000000000001", commandId: `c-${n}` });

  test("1,000 creates with a rolled-back transaction every tenth leave keys 1 to 900 with no gap", async () => {
    const { db, hyper } = await fresh();
    try {
      for (let n = 1; n <= 1000; n++) {
        if (n % 10 === 0) {
          // The generated call joins this transaction; the throw rolls the write back.
          await expect(db.transaction(async () => { await hyper.recordEvent(event(n), context); throw new Error("rollback"); })).rejects.toThrow("rollback");
        } else await hyper.recordEvent(event(n), context);
      }
      const events = await hyper.readEvent({ sort: ["seq"] }, context);
      expect(events).toHaveLength(900);
      expect(events.map((row) => row.seq)).toEqual(Array.from({ length: 900 }, (_, i) => i + 1));
    } finally { await db.close(); }
  });

  test("parallel creates get distinct consecutive keys", async () => {
    const { db, hyper } = await fresh();
    try {
      const rows = await Promise.all(Array.from({ length: 25 }, (_, n) => hyper.recordEvent(event(n), context)));
      expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    } finally { await db.close(); }
  });

  test("a client cannot send the key, and a filter pages by it", async () => {
    const { db, hyper } = await fresh();
    try {
      // @ts-expect-error seq is filled by the data layer, so it is not in the input
      await expect(hyper.recordEvent({ ...event(0), seq: 5 }, context)).rejects.toBeInstanceOf(InvalidInputError);
      for (let n = 1; n <= 10; n++) await hyper.recordEvent(event(n), context);
      const page = await hyper.readEvent({ filter: { seq: { gt: 5 } }, sort: ["seq"], limit: 3 }, context);
      expect(page.map((row) => row.seq)).toEqual([6, 7, 8]);
      expect((await hyper.readEvent({ sort: ["-seq"], limit: 1 }, context))[0]!.seq).toBe(10);
    } finally { await db.close(); }
  });
});

describe("reads of Hyper's list_tasks shape", () => {
  test("readTask({ filter: { parentId: { eq } }, sort: [createdAt, id], limit: 10 }) returns the first page of that parent's children", async () => {
    const { db, hyper } = await fresh();
    try {
      const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, context);
      const parent = await hyper.createTask({ title: "parent", creator: alice.id }, context);
      const other = await hyper.createTask({ title: "other parent", creator: alice.id }, context);
      const mine: string[] = [];
      for (let n = 0; n < 25; n++) {
        mine.push((await hyper.createTask({ title: `child ${n}`, creator: alice.id, parent: parent.id }, context)).title);
        await hyper.createTask({ title: `stranger ${n}`, creator: alice.id, parent: other.id }, context);
      }
      const filter = { parentId: { eq: parent.id } };
      const first = await hyper.readTask({ filter, sort: ["createdAt", "id"], limit: 10 }, context);
      expect(first.map((task) => task.title)).toEqual(mine.slice(0, 10));
      const second = await hyper.readTask({ filter, sort: ["createdAt", "id"], limit: 10, offset: 10 }, context);
      expect(second.map((task) => task.title)).toEqual(mine.slice(10, 20));
      const last = await hyper.readTask({ filter, sort: ["createdAt", "id"], limit: 10, offset: 20 }, context);
      expect(last.map((task) => task.title)).toEqual(mine.slice(20));
      expect(await hyper.readTask({ filter: { parentId: { nil: true } }, sort: ["createdAt", "id"] }, context)).toHaveLength(2);
      expect(await hyper.readTask({ filter: { and: [filter, { state: { eq: "done" } }] } }, context)).toEqual([]);
    } finally { await db.close(); }
  });
});

test("PORTING.md lists each omission as one line: entity, construct, milestone", () => {
  const lines = readFileSync(resolve(root, "PORTING.md"), "utf8").split("\n").filter((line) => line.startsWith("- "));
  expect(lines.length).toBeGreaterThan(20);
  for (const line of lines) expect(line, line).toMatch(/^- (?:[A-Z][A-Za-z]+(?:, [A-Z][A-Za-z]+)*|All entities): .+: (?:M\d+|after 1\.0|not scheduled)\.$/);
});

afterAll(() => { if (existsSync(resolve(root, "hyper.db"))) rmSync(resolve(root, "hyper.db"), { force: true }); });
