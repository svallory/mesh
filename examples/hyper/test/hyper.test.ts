import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { FrameworkError, InvalidInputError } from "@meshfw/runtime";
import { tables } from "#mesh";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import { reviewAccept, submissionSubmit } from "../src/domain/work/work.commands";
import { as, empty, setup, type Empty } from "./world";

const root = resolve(import.meta.dir, "..");
const context = setup;
const ENTITIES = [
  "Assignment", "Attempt", "Claim", "Collaborator", "Completion", "Dependency", "Event", "EvidenceReference", "Invocation",
  "LateResult", "Machine", "Membership", "Review", "Run", "SessionReference", "Submission", "Task", "Workspace",
];

/** An event in the spec's v0 shape (PROTOCOL.md, `Event`): typed, with a cause and a payload. */
function eventOf(n: number, extra: Record<string, unknown> = {}) {
  return {
    type: "task.created", workspaceId: "00000000-0000-4000-8000-0000000000aa", recordType: "task",
    recordId: "00000000-0000-4000-8000-000000000001", recordVersion: 1, actor: "engine", caller: "engine",
    occurredAt: new Date("2026-10-10T10:00:00.000Z"),
    cause: { kind: "command", commandId: `c-${n}`, method: "task.create" }, payload: { n },
    ...extra,
  } as never;
}

/**
 * One row of every entity (two of Collaborator, Membership, Task, Claim and Assignment), each written by the generated
 * actions or the command functions, through one piece of work: Bot claims, submits and has its work accepted on the
 * child task, then claims the parent, reports an attempt on a machine, loses the claim and reports late.
 */
async function populate({ hyper, binding }: Pick<Empty, "hyper" | "binding">) {
  const workspace = await hyper.createWorkspace({ name: "Home" }, setup);
  const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, setup);
  const bot = await hyper.registerCollaborator({ kind: "agent", name: "Bot" }, setup);
  const membership = await hyper.grantMembership({ role: "owner", collaborator: alice.id }, as(alice));
  const botMembership = await hyper.grantMembership({ role: "member", collaborator: bot.id }, as(alice));
  const task = await hyper.createTask({ title: "Ship", priority: 2 }, as(alice));
  const child = await hyper.createTask({ title: "Test", parent: task.id }, as(alice));
  const dependency = await hyper.addDependency({ dependent: task.id, prerequisite: child.id }, as(alice));
  await hyper.assignTask({ id: child.id, assignee: bot.id }, as(alice));
  const childClaim = await hyper.acquireClaim({ task: child.id }, as(bot));
  const evidence = await hyper.recordEvidenceReference({ kind: "file", locator: "notes.md" }, as(bot));
  const submitted = await submissionSubmit({ summary: "done", evidence: [evidence.id], fence: childClaim.fence, task: child.id }, as(bot), binding);
  if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
  const accepted = await reviewAccept({ submission: submitted.submission.id }, as(alice), binding);
  const machine = await hyper.registerMachine({ name: "laptop", platform: "linux" }, as(bot));
  const { sessionReference: session } = await sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: bot.id }, as(bot), binding);
  const run = await hyper.startRun({ inputs: { goal: "ship", steps: [1, 2] }, task: task.id }, as(alice));
  const claim = await hyper.acquireClaim({ task: task.id }, as(bot));
  const { attempt } = await attemptStart({ run: run.id, machine: "laptop", session: session.id }, as(bot), binding);
  const invocation = await hyper.recordInvocation({ usageSource: "runtime", estimatedCost: 0.25, inputTokens: 10, outputTokens: 5, attempt: attempt.id }, as(bot));
  await hyper.revokeClaim({ id: claim.id, reason: "taking over" }, as(alice));
  const late = await submissionSubmit({ summary: "late", fence: claim.fence, task: task.id }, as(bot), binding);
  if (late.outcome !== "late-result-recorded") throw new Error(late.outcome);
  const event = await hyper.recordEvent(eventOf(1, { recordId: task.id, payload: { taskId: task.id, title: "Ship" }, task: task.id }), setup);
  return {
    workspace, alice, bot, membership, botMembership, task, child, dependency, childClaim, claim, evidence,
    submission: submitted.submission, review: accepted.review, completion: accepted.completion, lateResult: late.lateResult, machine, session, run, attempt, invocation, event,
  };
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
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const rows = await populate(fresh);
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
      // The rows no later step changed read back as they were returned.
      const unchanged: Record<string, unknown[]> = {
        Workspace: [rows.workspace], Membership: [rows.membership, rows.botMembership], Dependency: [rows.dependency],
        Review: [rows.review], Completion: [rows.completion], LateResult: [rows.lateResult], EvidenceReference: [rows.evidence],
        Run: [rows.run], Attempt: [rows.attempt], Invocation: [rows.invocation], Machine: [rows.machine],
        SessionReference: [rows.session], Event: [rows.event], Collaborator: [rows.alice, rows.bot],
      };
      for (const [name, expected] of Object.entries(unchanged)) expect(await reads[name]!(), name).toEqual(expected);
      // The rows later steps changed read back with those changes.
      // Task: the dependency, the claim and its revocation (the late result changes nothing); child: assign, claim, submit, accept.
      const byId = async <T extends { id: string }>(read: Promise<T[]>) => new Map((await read).map((row) => [row.id, row]));
      const tasks = await byId(hyper.readTask({}, context));
      expect(tasks.get(rows.task.id)).toMatchObject({ state: "open", version: rows.task.version + 3 });
      expect(tasks.get(rows.child.id)).toMatchObject({ state: "done", version: rows.child.version + 4 });
      expect(await reads.Submission!()).toEqual([{ ...rows.submission, state: "accepted" }]);
      const claims = await byId(hyper.readClaim({}, context));
      expect(claims.size).toBe(2);
      expect(claims.get(rows.childClaim.id)).toMatchObject({ state: "released", endReason: "submitted" });
      expect(claims.get(rows.claim.id)).toMatchObject({ state: "revoked", endReason: "taking over" });
      expect(await reads.Assignment!()).toHaveLength(2);
      expect(rows.review).toMatchObject({ decision: "accept" });
    } finally { await db.close(); }
  });

  test("enum values with hyphens are stored and validated as the spec spells them", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { task, submission, alice, completion, review } = await populate(fresh);
      expect(completion.rule).toBe("review-accepted");
      // The child's parent has no current assignment, so its creator reviews.
      expect(review.ruleApplied).toBe("parent-creator");
      const second = await hyper.recordCompletion({ rule: "performer-is-reviewer", task: task.id }, as(alice));
      expect((await hyper.readCompletion({ filter: { rule: { in: ["performer-is-reviewer", "review-waived"] } } }, context)).map((c) => c.id)).toEqual([second.id]);
      // @ts-expect-error "reviewer" is not one of the spec's completion rules
      await expect(hyper.recordCompletion({ rule: "reviewer", task: task.id, submission: submission.id }, as(alice))).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });

  test("defaults, stamps and the keys Mesh fills", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { task, event, alice } = await populate(fresh);
      expect(task).toMatchObject({ state: "open", version: 1, intent: null, parentId: null, creatorId: alice.id });
      expect(event).toMatchObject({ schemaVersion: 1, actor: "engine", caller: "engine", cause: { kind: "command", commandId: "c-1", method: "task.create" } });
      expect(event.recordedAt).toBeInstanceOf(Date);
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(event.seq).toBe(1);
    } finally { await db.close(); }
  });

  test("the plain updates change only what they accept, and a missing row is not found", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { task, alice } = await populate(fresh);
      expect(await hyper.setPriorityTask({ id: task.id, priority: 9 }, context)).toMatchObject({ priority: 9, title: "Ship", state: "open" });
      const other = await hyper.createTask({ title: "Release" }, as(alice));
      expect(await hyper.moveTask({ id: task.id, parent: other.id }, context)).toMatchObject({ parentId: other.id });
      expect(await hyper.updateCollaborator({ id: alice.id, name: "Alicia" }, context)).toMatchObject({ name: "Alicia", kind: "human" });
      await expect(hyper.setPriorityTask({ id: "00000000-0000-4000-8000-0000000000ff", priority: 1 }, context)).rejects.toMatchObject({ code: "not_found" });
    } finally { await db.close(); }
  });

  test("a unique column refuses a second row; a dependency can be removed", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { dependency, machine } = await populate(fresh);
      // machine.name-free refuses first; past the rule, the unique index still refuses the row.
      await expect(hyper.registerMachine({ name: "laptop" }, context)).rejects.toBeInstanceOf(InvalidInputError);
      const refused = await fresh.insert("machine", { ...machine, id: crypto.randomUUID() }).then(() => undefined, (caught: unknown) => caught);
      expect(refused).toBeInstanceOf(FrameworkError);
      expect(String((refused as FrameworkError).cause)).toContain("UNIQUE constraint failed: machines.name");
      await hyper.removeDependency({ id: dependency.id }, context);
      expect(await hyper.readDependency({}, context)).toEqual([]);
    } finally { await db.close(); }
  });
});

describe("json attributes", () => {
  test("an object and an array are stored and returned, and the defaults are an empty object and array", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { task, bot, run, attempt, submission, evidence, lateResult } = await populate(fresh);
      expect(run.inputs).toEqual({ goal: "ship", steps: [1, 2] });
      expect(submission.evidence).toEqual([evidence.id]);
      expect(run.outcome).toBeNull();
      expect(attempt.outcome).toBeNull();
      const second = await hyper.startRun({ task: task.id }, as(bot));
      expect(second.inputs).toEqual({});
      expect(lateResult.evidence).toEqual([]);
      const event = await hyper.recordEvent(eventOf(2, { recordId: run.id, checks: undefined }), context);
      expect(event.checks).toBeNull();
      expect((await hyper.readRun({ sort: ["startedAt", "id"] }, context)).map((r) => r.inputs)).toEqual([run.inputs, {}]);
    } finally { await db.close(); }
  });

  test("a value JSON cannot hold fails at the validator and writes nothing", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const { task, alice } = await populate(fresh);
      for (const bad of [() => 1, new Date(), Number.NaN, { a: undefined }, new Map(), 1n])
        await expect(hyper.startRun({ task: task.id, inputs: bad }, as(alice)), String(bad)).rejects.toBeInstanceOf(InvalidInputError);
      expect(await hyper.readRun({}, context)).toHaveLength(1);
      // @ts-expect-error a json attribute is not a filter key
      await expect(hyper.readRun({ filter: { inputs: { eq: "x" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });
});

describe("integer keys", () => {
  const event = (n: number) => eventOf(n);

  test("1,000 creates with a rolled-back transaction every tenth leave keys 1 to 900 with no gap", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
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
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const rows = await Promise.all(Array.from({ length: 25 }, (_, n) => hyper.recordEvent(event(n), context)));
      expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    } finally { await db.close(); }
  });

  test("a client cannot send the key, and a filter pages by it", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      await expect(hyper.recordEvent({ ...(event(0) as object), seq: 5 } as never, context)).rejects.toBeInstanceOf(InvalidInputError);
      for (let n = 1; n <= 10; n++) await hyper.recordEvent(event(n), context);
      const page = await hyper.readEvent({ filter: { seq: { gt: 5 } }, sort: ["seq"], limit: 3 }, context);
      expect(page.map((row) => row.seq)).toEqual([6, 7, 8]);
      expect((await hyper.readEvent({ sort: ["-seq"], limit: 1 }, context))[0]!.seq).toBe(10);
    } finally { await db.close(); }
  });
});

describe("reads of Hyper's list_tasks shape", () => {
  test("readTask({ filter: { parentId: { eq } }, sort: [createdAt, id], limit: 10 }) returns the first page of that parent's children", async () => {
    const fresh = await empty();
    const { db, hyper } = fresh;
    try {
      const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, context);
      const parent = await hyper.createTask({ title: "parent" }, as(alice));
      const other = await hyper.createTask({ title: "other parent" }, as(alice));
      const mine: string[] = [];
      for (let n = 0; n < 25; n++) {
        fresh.advance(1);
        mine.push((await hyper.createTask({ title: `child ${n}`, parent: parent.id }, as(alice))).title);
        await hyper.createTask({ title: `stranger ${n}`, parent: other.id }, as(alice));
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

test("PORTING.md lists each omission as one line: entity, construct, milestone; none is M5's, which is done", () => {
  const text = readFileSync(resolve(root, "PORTING.md"), "utf8");
  const lines = text.split("\n").filter((line) => line.startsWith("- "));
  expect(lines.length).toBeGreaterThan(20);
  for (const line of lines) {
    expect(line, line).toMatch(/^- (?:[A-Z][A-Za-z]+(?:, [A-Z][A-Za-z]+)*|All entities): .+ \((?:[GD]\d+(?:, [GD]\d+)*|no gap code)\): (?:M\d+|after 1\.0|not scheduled|application code)\.$/);
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
