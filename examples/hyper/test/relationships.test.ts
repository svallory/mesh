// M7 in Hyper: Task, Run and Invocation relate to their own type with no import, Collaborator.memberships follows
// the right key, the maxFence rollup, derivedState as the specification defines it, and the cost of `Claim :acquire`'s reads.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DataLayer, DataOperations } from "@meshfw/runtime";
import { tables } from "#mesh";
import { loadInvocationFields, loadRunFields } from "#mesh/domain/execution";
import { loadCollaboratorFields } from "#mesh/domain/identity";
import { loadTaskFields, type Task, type TaskWith } from "#mesh/domain/work";
import { attemptStart } from "../src/domain/execution/execution.commands";
import { as, asSystem, codes, empty, issuesOf, minutes, NOW, setup, type Empty, type Hyper } from "./world";

const root = resolve(import.meta.dir, "..");
const context = setup;
const clock = () => NOW;

/** An empty database, bound with a fixed clock. */
const fresh = empty;
const load = <T>(db: DataLayer, work: (tx: DataOperations) => Promise<T>) => db.transaction(work);
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

/** Alice (owner, by the bootstrap grant) and Bot (member): the policies let both write. */
async function people(hyper: Hyper) {
  const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, setup);
  const bot = await hyper.registerCollaborator({ kind: "agent", name: "Bot" }, setup);
  await hyper.grantMembership({ role: "owner", collaborator: alice.id }, asSystem(alice));
  await hyper.grantMembership({ role: "member", collaborator: bot.id }, as(alice));
  return { alice, bot };
}

/**
 * Rows inserted as they are, for the states these tests read and no sequence of actions reaches (several active
 * claims or pending submissions on one task, the same prerequisite twice). The actions that write them are tested in
 * `composition.test.ts` and `rules.test.ts`.
 */
function rows(insert: Empty["insert"]) {
  return {
    claim: (taskId: string, holderId: string, fence: number, expiresAt: Date, state: "active" | "released" | "revoked" | "expired" = "active") =>
      insert("claim", { taskId, holderId, fence, state, acquiredAt: minutes(-60), expiresAt, endedAt: state === "active" ? null : minutes(-1), endReason: null }),
    submission: (taskId: string, submitterId: string, state: "pending" | "accepted" | "returned" | "withdrawn" = "pending") =>
      insert("submission", { taskId, submitterId, state, summary: "s", evidence: [], fence: null, taskVersion: 1, submittedAt: minutes(-30) }),
    assignment: (taskId: string, assigneeId: string, delegatorId: string) =>
      insert("assignment", { taskId, assigneeId, delegatorId, reviewWaived: false, startedAt: minutes(-60), endedAt: null, endReason: null }),
    dependency: (dependentId: string, prerequisiteId: string, createdById: string) =>
      insert("dependency", { dependentId, prerequisiteId, createdById, createdAt: minutes(-60) }),
  };
}

describe("acceptance 1: self-reference with no import, and the rows load", () => {
  test("Task, Run and Invocation have no import of their own file in the model", () => {
    const model = JSON.parse(readFileSync(resolve(root, ".mesh/model.json"), "utf8")) as { entities: { name: string; imports: { identifiers: string[] }[]; relationships: { name: string; entity: { identifier: string } }[] }[] };
    for (const [name, relation] of [["Task", "parent"], ["Task", "children"], ["Run", "parentRun"], ["Invocation", "corrects"]] as const) {
      const entity = model.entities.find((candidate) => candidate.name === name)!;
      expect(entity.imports.flatMap((i) => i.identifiers), name).not.toContain(name);
      expect(entity.relationships.find((r) => r.name === relation)!.entity.identifier).toBe(name);
    }
    const source = (file: string) => readFileSync(resolve(root, "src/domain", file), "utf8");
    for (const [file, name] of [["work/task.mesh.mx", "Task"], ["execution/run.mesh.mx", "Run"], ["execution/invocation.mesh.mx", "Invocation"]] as const)
      expect(source(file)).not.toContain(`import { ${name} }`);
  });

  test("Task.parent and Task.children", async () => {
    const { db, hyper } = await fresh();
    try {
      const { alice } = await people(hyper);
      const root = await hyper.createTask({ title: "root" }, as(alice));
      const a = await hyper.createTask({ title: "a", parent: root.id }, as(alice));
      const b = await hyper.createTask({ title: "b", parent: root.id }, as(alice));
      const leaf = await hyper.createTask({ title: "leaf", parent: a.id }, as(alice));
      const loaded = await load(db, async (tx) => loadTaskFields(tx, await tx.select(tables.task) as Task[], ["parent", "children"]));
      const byTitle = Object.fromEntries(loaded.map((task) => [task.title, task]));
      expect(byTitle.root!.parent).toBeNull();
      expect(ids(byTitle.root!.children)).toEqual([a.id, b.id].sort());
      expect(byTitle.a!.parent!.id).toBe(root.id);
      expect(ids(byTitle.a!.children)).toEqual([leaf.id]);
      expect(byTitle.leaf!.children).toEqual([]);
      expect(byTitle.leaf!.parent!.title).toBe("a");
    } finally { await db.close(); }
  });

  test("a task that is its own parent loads itself, and its computed fields still finish", async () => {
    const { db, hyper, force } = await fresh();
    try {
      const { alice } = await people(hyper);
      const task = await hyper.createTask({ title: "ouroboros" }, as(alice));
      // task.no-cycle refuses the move, so the row is written as it is: a loader must still finish on it.
      expect(codes(await issuesOf(hyper.moveTask({ id: task.id, parent: task.id }, as(alice))))).toEqual(["task.no-cycle"]);
      await force("task", task.id, { parentId: task.id });
      const [loaded] = await load(db, async (tx) => loadTaskFields(tx, await tx.select(tables.task) as Task[], ["parent", "children", "childrenSettled", "derivedState"]));
      expect(loaded!.parent!.id).toBe(task.id);
      expect(ids(loaded!.children)).toEqual([task.id]);
      // The child is itself and is open, so the children are not settled.
      expect(loaded!.childrenSettled).toBe(false);
      expect(loaded!.derivedState).toBe("ready");
    } finally { await db.close(); }
  });

  test("Run.parentRun", async () => {
    const { db, hyper } = await fresh();
    try {
      const { alice } = await people(hyper);
      const task = await hyper.createTask({ title: "t" }, as(alice));
      const parent = await hyper.startRun({ task: task.id }, as(alice));
      const child = await hyper.startRun({ task: task.id, parentRun: parent.id }, as(alice));
      const loaded = await load(db, async (tx) => loadRunFields(tx, [parent, child], ["parentRun", "attempts"]));
      expect(loaded.map((run) => run.parentRun?.id ?? null)).toEqual([null, parent.id]);
      expect(loaded.map((run) => run.attempts)).toEqual([[], []]);
    } finally { await db.close(); }
  });

  test("Invocation.corrects", async () => {
    const { db, hyper, binding } = await fresh();
    try {
      const { alice, bot } = await people(hyper);
      const task = await hyper.createTask({ title: "t" }, as(alice));
      const run = await hyper.startRun({ task: task.id }, as(alice));
      await hyper.acquireClaim({ task: task.id }, as(bot));
      const { attempt } = await attemptStart({ run: run.id }, as(bot), binding);
      const original = await hyper.recordInvocation({ usageSource: "runtime", attempt: attempt.id }, as(bot));
      const correction = await hyper.correctInvocation({ reason: "wrong tokens", usageSource: "estimate", corrects: original.id }, as(alice));
      expect(correction).toMatchObject({ attemptId: attempt.id, taskId: task.id, recordedById: alice.id });
      const loaded = await load(db, async (tx) => loadInvocationFields(tx, [original, correction], ["corrects"]));
      expect(loaded.map((invocation) => invocation.corrects?.id ?? null)).toEqual([null, original.id]);
    } finally { await db.close(); }
  });
});

describe("acceptance 2: Collaborator.memberships follows collaboratorId, not grantedById", () => {
  test("a membership belongs to the collaborator it is for, and the one who granted it has it in no list", async () => {
    const { db, hyper } = await fresh();
    try {
      const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, context);
      const bot = await hyper.registerCollaborator({ kind: "agent", name: "Bot" }, context);
      const carol = await hyper.registerCollaborator({ kind: "human", name: "Carol" }, context);
      const dave = await hyper.registerCollaborator({ kind: "human", name: "Dave" }, context);
      // The bootstrap grants Alice hers; Alice (owner) grants Bot an owner's; Bot grants Carol one; Dave has none and
      // granted none. Only an owner grants (policy ownerOnly), so each granter is one.
      const forAlice = await hyper.grantMembership({ role: "owner", collaborator: alice.id }, asSystem(alice));
      const forBot = await hyper.grantMembership({ role: "owner", collaborator: bot.id }, as(alice));
      const forCarol = await hyper.grantMembership({ role: "member", collaborator: carol.id }, as(bot));
      const loaded = await load(db, async (tx) => loadCollaboratorFields(tx, [alice, bot, carol, dave], ["memberships"]));
      expect(loaded.map((c) => [c.name, ids(c.memberships)])).toEqual([["Alice", [forAlice.id]], ["Bot", [forBot.id]], ["Carol", [forCarol.id]], ["Dave", []]]);
      expect(loaded[1]!.memberships[0]).toMatchObject({ collaboratorId: bot.id, grantedById: alice.id });
      expect(loaded[2]!.memberships[0]).toMatchObject({ collaboratorId: carol.id, grantedById: bot.id });
    } finally { await db.close(); }
  });

  test("the model records the key", () => {
    const model = JSON.parse(readFileSync(resolve(root, ".mesh/model.json"), "utf8")) as { entities: { name: string; relationships: { name: string; inverse?: string }[] }[] };
    const relationships = (name: string) => model.entities.find((entity) => entity.name === name)!.relationships;
    expect(relationships("Collaborator").find((r) => r.name === "memberships")!.inverse).toBe("collaborator");
    expect(relationships("Task").filter((r) => r.name === "dependencies" || r.name === "dependents").map((r) => [r.name, r.inverse])).toEqual([["dependencies", "dependent"], ["dependents", "prerequisite"]]);
    expect(relationships("Task").find((r) => r.name === "children")!.inverse).toBe("parent");
  });

  test("Task.dependencies and Task.dependents follow the two keys Dependency holds to Task", async () => {
    const { db, hyper } = await fresh();
    try {
      const { alice } = await people(hyper);
      const design = await hyper.createTask({ title: "design" }, as(alice));
      const build = await hyper.createTask({ title: "build" }, as(alice));
      const ship = await hyper.createTask({ title: "ship" }, as(alice));
      // build waits for design; ship waits for build.
      const first = await hyper.addDependency({ dependent: build.id, prerequisite: design.id }, as(alice));
      const second = await hyper.addDependency({ dependent: ship.id, prerequisite: build.id }, as(alice));
      const loaded = await load(db, async (tx) => loadTaskFields(tx, [design, build, ship] as Task[], ["dependencies", "dependents"]));
      expect(loaded.map((t) => [t.title, ids(t.dependencies), ids(t.dependents)])).toEqual([
        ["design", [], [first.id]], ["build", [first.id], [second.id]], ["ship", [second.id], []],
      ]);
    } finally { await db.close(); }
  });
});

describe("acceptance 3: maxFence over claims returns the highest fence", () => {
  test("the highest of a task's claims, whatever their state; null with none; another task's claims do not count", async () => {
    const { db, hyper, insert } = await fresh();
    try {
      const { alice, bot } = await people(hyper);
      const busy = await hyper.createTask({ title: "busy" }, as(alice));
      const idle = await hyper.createTask({ title: "idle" }, as(alice));
      const other = await hyper.createTask({ title: "other" }, as(alice));
      const claim = rows(insert).claim;
      await claim(busy.id, bot.id, 2, minutes(10));
      // A released claim still counts: the fence never goes down.
      await claim(busy.id, bot.id, 7, minutes(10), "released");
      await claim(busy.id, bot.id, 3, minutes(10));
      await claim(other.id, bot.id, 99, minutes(10));
      const loaded = await load(db, async (tx) => loadTaskFields(tx, [busy, idle, other] as Task[], ["maxFence"]));
      expect(loaded.map((task) => [task.title, task.maxFence])).toEqual([["busy", 7], ["idle", null], ["other", 99]]);
    } finally { await db.close(); }
  });
});

/** The specification's rule (PROTOCOL.md section 5, "Derived state"), first match wins, written without any of Mesh's expressions. */
function specDerivedState(facts: { stored: "open" | "done" | "canceled"; pendingSubmission: boolean; activeClaim: boolean; prerequisites: readonly ("open" | "done" | "canceled")[] }) {
  if (facts.stored === "done" || facts.stored === "canceled") return facts.stored;
  if (facts.pendingSubmission) return "in-review";
  if (facts.activeClaim) return "claimed";
  if (facts.prerequisites.some((state) => state !== "done")) return "blocked";
  return "ready";
}

describe("acceptance 4: derivedState is Hyper's DerivedState for the same rows", () => {
  const stored = ["open", "done", "canceled"] as const;
  const submissions = ["none", "pending", "settled"] as const;
  const claims = ["none", "active", "lapsed", "released"] as const;
  const prerequisites = [[], ["done"], ["open"], ["canceled"], ["done", "open"]] as const;

  test("every combination of stored state, submission, claim and prerequisites, in one load", async () => {
    const { db, hyper, insert: raw } = await fresh();
    const insert = rows(raw);
    try {
      const { alice, bot } = await people(hyper);
      const pre = {
        open: await hyper.createTask({ title: "pre open" }, as(alice)),
        done: await hyper.createTask({ title: "pre done" }, as(alice)),
        canceled: await hyper.createTask({ title: "pre canceled" }, as(alice)),
      };
      await load(db, async (tx) => {
        await tx.updateByKey(tables.task, { id: pre.done.id }, { state: "done" });
        await tx.updateByKey(tables.task, { id: pre.canceled.id }, { state: "canceled" });
      });
      const expected = new Map<string, string>();
      let fence = 0;
      for (const state of stored) for (const submission of submissions) for (const claim of claims) for (const wait of prerequisites) {
        const title = `${state}/${submission}/${claim}/${wait.join("+") || "-"}`;
        const task = await hyper.createTask({ title }, as(alice));
        if (state !== "open") await load(db, (tx) => tx.updateByKey(tables.task, { id: task.id }, { state }));
        if (submission !== "none") await insert.submission(task.id, bot.id, submission === "settled" ? "accepted" : "pending");
        if (claim !== "none") await insert.claim(task.id, bot.id, ++fence, claim === "lapsed" ? minutes(-5) : minutes(30), claim === "released" ? "released" : "active");
        for (const prerequisite of wait) await hyper.addDependency({ dependent: task.id, prerequisite: pre[prerequisite].id }, as(alice));
        expected.set(task.id, specDerivedState({
          stored: state, pendingSubmission: submission === "pending",
          // "Active" is an active claim whose lease has not run out; a lapsed one is the sweeper's to expire.
          activeClaim: claim === "active", prerequisites: wait,
        }));
      }
      expect(expected.size).toBe(3 * 3 * 4 * 5);
      const { rows, calls } = await load(db, async (tx) => {
        const counting = counted(tx);
        const rows = await loadTaskFields(counting.tx, await tx.select(tables.task) as Task[], ["derivedState"], { clock });
        return { rows, calls: counting.calls };
      });
      let checked = 0;
      for (const task of rows) {
        if (!expected.has(task.id)) continue; // the three prerequisites
        expect(task.derivedState, task.title).toBe(expected.get(task.id) as never);
        checked++;
      }
      expect(checked).toBe(180);
      // Whatever the number of tasks, claims, submissions and dependencies: claims, submissions, dependencies, then the prerequisites.
      expect(calls).toEqual(["select", "select", "select", "select"]);
      // All six values occur, so the table above exercised every branch.
      expect(new Set(expected.values())).toEqual(new Set(["ready", "blocked", "claimed", "in-review", "done", "canceled"]));
    } finally { await db.close(); }
  });

  test("a lease that runs out is not claimed any more, by the injected clock", async () => {
    const { db, hyper } = await fresh();
    try {
      const { alice, bot } = await people(hyper);
      const task = await hyper.createTask({ title: "leased" }, as(alice));
      // The lease the server sets: ten minutes from the bound clock's now.
      await hyper.acquireClaim({ task: task.id }, as(bot));
      const derived = (at: Date) => load(db, async (tx) => (await loadTaskFields(tx, [task] as Task[], ["derivedState", "claimed", "lapsedClaim"], { clock: () => at }))[0]!);
      expect(await derived(minutes(0))).toMatchObject({ derivedState: "claimed", claimed: true, lapsedClaim: false });
      expect(await derived(minutes(9))).toMatchObject({ derivedState: "claimed", claimed: true, lapsedClaim: false });
      expect(await derived(minutes(10))).toMatchObject({ derivedState: "ready", claimed: false, lapsedClaim: true });
      expect(await derived(minutes(60))).toMatchObject({ derivedState: "ready", claimed: false, lapsedClaim: true });
    } finally { await db.close(); }
  });

  test("a task with no rows of any kind is ready, and the prerequisite's own prerequisites do not matter", async () => {
    const { db, hyper } = await fresh();
    try {
      const { alice } = await people(hyper);
      const first = await hyper.createTask({ title: "first" }, as(alice));
      const second = await hyper.createTask({ title: "second" }, as(alice));
      const third = await hyper.createTask({ title: "third" }, as(alice));
      await hyper.addDependency({ dependent: second.id, prerequisite: first.id }, as(alice));
      await hyper.addDependency({ dependent: third.id, prerequisite: second.id }, as(alice));
      await load(db, (tx) => tx.updateByKey(tables.task, { id: second.id }, { state: "done" }));
      const loaded = await load(db, async (tx) => loadTaskFields(tx, await tx.select(tables.task) as Task[], ["derivedState", "blocked"]));
      // second is done (stored wins) though its own prerequisite is open; third waits for a done task, so it is ready.
      expect(loaded.map((task) => [task.title, task.derivedState, task.blocked])).toEqual([["first", "ready", false], ["second", "done", true], ["third", "ready", false]]);
    } finally { await db.close(); }
  });
});

describe("acceptance 5: an unloaded relationship is a type error; a load that cannot be served is an error", () => {
  test("only what was named is on the loaded record (and this file is type-checked by `bun run typecheck`)", async () => {
    const { db, hyper } = await fresh();
    try {
      const { alice } = await people(hyper);
      const task = await hyper.createTask({ title: "t" }, as(alice));
      // @ts-expect-error children was not loaded
      void task.children;
      // @ts-expect-error nor was a computed field
      void task.derivedState;
      const [loaded] = await load(db, (tx) => loadTaskFields(tx, [task], ["children", "derivedState"]));
      const typed: TaskWith<"children" | "derivedState"> = loaded!;
      expect(typed.children).toEqual([]);
      expect(typed.derivedState).toBe("ready");
      // @ts-expect-error parent was not among the names
      void loaded!.parent;
      expect("parent" in loaded!).toBe(false);
      // @ts-expect-error not a relationship or computed field of Task
      await expect(load(db, (tx) => loadTaskFields(tx, [task], ["childs"]))).rejects.toThrow('Task has no relationship or computed field "childs" to load');
    } finally { await db.close(); }
  });

  test("a read by a rollup or computed field fails with the error that names M10", async () => {
    const { db, hyper } = await fresh();
    try {
      await expect(hyper.readTask({ filter: { maxFence: { gt: 1 } } }, context)).rejects.toThrow("filtering and sorting by one is evaluated by the SQL evaluator, which arrives in M10");
      await expect(hyper.readTask({ sort: ["-derivedState"] }, context)).rejects.toThrow("A sort by work.Task#derivedState is not available yet");
    } finally { await db.close(); }
  });
});

/** A transaction whose data-layer reads are counted. */
function counted(tx: DataOperations) {
  const calls: string[] = [];
  const wrap = <K extends "select" | "count" | "max">(name: K): DataOperations[K] =>
    (async (table: object, ...rest: never[]) => { calls.push(name); return (tx[name] as (...args: unknown[]) => unknown)(table, ...rest); }) as never;
  return { tx: { ...tx, select: wrap("select"), count: wrap("count"), max: wrap("max") } as DataOperations, calls };
}

describe("the cost of Claim :acquire's reads (the M7 risk: a computed field that loads rows per record)", () => {
  // Hyper's LockedTask reads six values in one SELECT: in_review?, claimed?, assigned?, lapsed_claim?, open_prerequisite? and max_fence.
  const LOCKED = ["inReview", "claimed", "assigned", "lapsedClaim", "blocked", "maxFence"] as const;

  async function world({ hyper, insert: raw }: Empty, tasks: number, perTask: number) {
    const insert = rows(raw);
    const { alice, bot } = await people(hyper);
    const prerequisite = await hyper.createTask({ title: "prerequisite" }, as(alice));
    const made: Task[] = [];
    for (let n = 0; n < tasks; n++) {
      const task = await hyper.createTask({ title: `task ${n}` }, as(alice));
      made.push(task);
      for (let k = 0; k < perTask; k++) {
        await insert.claim(task.id, bot.id, k + 1, minutes(-30));
        await insert.assignment(task.id, bot.id, alice.id);
        await insert.submission(task.id, bot.id);
        await insert.dependency(task.id, prerequisite.id, alice.id);
      }
    }
    return made;
  }

  test("one task, the six values LockedTask reads, and derivedState: a fixed number of queries whatever the rows hold", async () => {
    const results: number[][] = [];
    for (const perTask of [0, 1, 20]) {
      const base = await fresh();
      const { db } = base;
      try {
        const [task] = await world(base, 1, perTask);
        const { calls } = await load(db, async (tx) => {
          const counting = counted(tx);
          await loadTaskFields(counting.tx, [task!], [...LOCKED, "derivedState"], { clock });
          return counting;
        });
        results.push([calls.filter((c) => c === "select").length, calls.filter((c) => c === "max").length, calls.filter((c) => c === "count").length]);
        // claims, submissions, assignments, dependencies, and the prerequisites of those dependencies (not asked when there are none); maxFence is worked out from the claims the same call loaded, so it costs no call.
        expect(calls.sort()).toEqual(perTask === 0 ? ["select", "select", "select", "select"] : ["select", "select", "select", "select", "select"]);
      } finally { await db.close(); }
    }
    expect(results).toEqual([[4, 0, 0], [5, 0, 0], [5, 0, 0]]);
  });

  test("N tasks: the same five queries, and no call per task, because the rollup reads the claims already loaded", async () => {
    const base = await fresh();
    const { db } = base;
    try {
      const tasks = await world(base, 50, 2);
      const { calls, rows } = await load(db, async (tx) => {
        const counting = counted(tx);
        const rows = await loadTaskFields(counting.tx, tasks, [...LOCKED, "derivedState"], { clock });
        return { calls: counting.calls, rows };
      });
      expect(rows).toHaveLength(50);
      expect(calls.filter((c) => c === "select")).toHaveLength(5);
      expect(calls.filter((c) => c === "max")).toHaveLength(0);
      // The lease ran out, an assignment is open, a submission is pending and a prerequisite is open.
      expect(rows[0]).toMatchObject({ inReview: true, claimed: false, assigned: true, lapsedClaim: true, blocked: true, maxFence: 2, derivedState: "in-review" });
    } finally { await db.close(); }
  });
});

describe("derivedState with several rows of each kind", () => {
  // Several claims, submissions and prerequisites per task, so a body that looked at the first row only (or the last) would fail.
  type ClaimState = "active" | "released" | "revoked" | "expired";
  type SubmissionState = "pending" | "accepted" | "returned" | "withdrawn";
  interface Case { name: string; claims?: [ClaimState, "future" | "past"][]; submissions?: SubmissionState[]; prerequisites?: ("open" | "done" | "canceled")[] }
  const cases: Case[] = [
    { name: "an active claim after a released one", claims: [["released", "future"], ["active", "future"]] },
    { name: "an active claim before a released one", claims: [["active", "future"], ["released", "future"]] },
    { name: "an active claim among expired and revoked", claims: [["expired", "past"], ["active", "future"], ["revoked", "past"]] },
    { name: "only expired, revoked and released claims", claims: [["expired", "past"], ["revoked", "future"], ["released", "future"]] },
    { name: "an active claim whose lease ran out, and an active one that did not", claims: [["active", "past"], ["active", "future"]] },
    { name: "only lapsed active claims", claims: [["active", "past"], ["active", "past"]] },
    { name: "a pending submission after an accepted one", submissions: ["accepted", "pending"] },
    { name: "a pending submission before a returned one", submissions: ["pending", "returned"] },
    { name: "returned and withdrawn submissions only", submissions: ["returned", "withdrawn", "accepted"] },
    { name: "a pending submission and an active claim", submissions: ["accepted", "pending"], claims: [["released", "future"], ["active", "future"]] },
    { name: "prerequisites done then canceled", prerequisites: ["done", "canceled"] },
    { name: "prerequisites canceled then done", prerequisites: ["canceled", "done"] },
    { name: "three prerequisites, the open one last", prerequisites: ["done", "done", "open"] },
    { name: "three prerequisites, the open one first", prerequisites: ["open", "done", "done"] },
    { name: "every prerequisite done", prerequisites: ["done", "done", "done"] },
    { name: "an active claim and an open prerequisite", claims: [["active", "future"]], prerequisites: ["done", "open"] },
    { name: "a lapsed claim and an open prerequisite", claims: [["active", "past"], ["released", "future"]], prerequisites: ["open", "done"] },
  ];

  test("each case equals the specification's rule applied to the facts of its rows", async () => {
    const { db, hyper, insert: raw } = await fresh();
    const insert = rows(raw);
    try {
      const { alice, bot } = await people(hyper);
      const pre = {
        open: await hyper.createTask({ title: "pre open" }, as(alice)),
        done: await hyper.createTask({ title: "pre done" }, as(alice)),
        canceled: await hyper.createTask({ title: "pre canceled" }, as(alice)),
      };
      await load(db, async (tx) => {
        await tx.updateByKey(tables.task, { id: pre.done.id }, { state: "done" });
        await tx.updateByKey(tables.task, { id: pre.canceled.id }, { state: "canceled" });
      });
      const expected = new Map<string, { name: string; state: string }>();
      let fence = 0;
      for (const item of cases) {
        const task = await hyper.createTask({ title: item.name }, as(alice));
        for (const [state, lease] of item.claims ?? []) {
          await insert.claim(task.id, bot.id, ++fence, lease === "past" ? minutes(-5) : minutes(30), state);
        }
        for (const state of item.submissions ?? []) await insert.submission(task.id, bot.id, state);
        for (const prerequisite of item.prerequisites ?? [])
          await insert.dependency(task.id, (prerequisite === "open" ? pre.open : prerequisite === "done" ? pre.done : pre.canceled).id, alice.id);
        expected.set(task.id, {
          name: item.name,
          state: specDerivedState({
            stored: "open",
            pendingSubmission: (item.submissions ?? []).includes("pending"),
            activeClaim: (item.claims ?? []).some(([state, lease]) => state === "active" && lease === "future"),
            prerequisites: item.prerequisites ?? [],
          }),
        });
      }
      const rows = await load(db, async (tx) => loadTaskFields(tx, await tx.select(tables.task) as Task[], ["derivedState"], { clock }));
      const got = new Map(rows.filter((task) => expected.has(task.id)).map((task) => [task.id, task.derivedState]));
      for (const [id, { name, state }] of expected) expect(got.get(id), name).toBe(state as never);
      // The cases reach every value an open task can have.
      expect(new Set([...expected.values()].map((entry) => entry.state))).toEqual(new Set(["ready", "blocked", "claimed", "in-review"]));
    } finally { await db.close(); }
  });
});
