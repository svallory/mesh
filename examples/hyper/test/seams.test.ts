// M6, first half: the three lifecycle seams (ADR-0075) over Hyper's 18 entities. Roadmap M6 acceptance tests 1 to 6,
// and the lead's rulings: `beforeTransaction` only for the call that opens the transaction, a throw in `afterCommit`
// leaves the call resolved, a destroy's `before` is the deleted row, the application `transaction` is an outermost
// transaction, and `db` is the four by-key operations.
import { describe, expect, spyOn, test } from "bun:test";
import { FrameworkError, type AfterCommitEvent, type AfterWriteEvent, type BeforeTransactionEvent, type SeamDb, type Seams } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { submissionSubmit } from "../src/domain/work/work.commands";
import { as, empty, populate, setup, world } from "./world";

const ENTITIES = [
  "work.Assignment", "execution.Attempt", "work.Claim", "identity.Collaborator", "work.Completion", "work.Dependency", "audit.Event",
  "work.EvidenceReference", "execution.Invocation", "work.LateResult", "execution.Machine", "identity.Membership", "work.Review",
  "execution.Run", "execution.SessionReference", "work.Submission", "work.Task", "identity.Workspace",
];

/** The declaration part of an FQN: `work.Review` is `Review`. */
const bareOf = (fqn: string) => fqn.slice(fqn.lastIndexOf(".") + 1);

/** An entity's table and the key of one of its rows: every entity keys on `id` but Event, which keys on `seq`. */
const TABLE_OF: Readonly<Record<string, keyof typeof tables>> = {
  Assignment: "assignments", Attempt: "attempts", Claim: "claims", Collaborator: "collaborators", Completion: "completions",
  Dependency: "dependencies", Event: "events", EvidenceReference: "evidence_references", Invocation: "invocations",
  LateResult: "late_results", Machine: "machines", Membership: "memberships", Review: "reviews", Run: "runs",
  SessionReference: "session_references", Submission: "submissions", Task: "tasks", Workspace: "workspaces",
};
const tableOf = (entity: string) => tables[TABLE_OF[bareOf(entity)]!] as never;
const keyOf = (entity: string, row: Record<string, unknown>) => (entity === "audit.Event" ? { seq: row.seq } : { id: row.id }) as never;

/** Every seam call, in order, as plain data; `after` and `commit` hold what the seams received. */
function recorder(extra: Seams = {}) {
  const log: string[] = [];
  const before: BeforeTransactionEvent[] = [];
  const writes: AfterWriteEvent[] = [];
  const commits: AfterCommitEvent[] = [];
  const seams: Seams = {
    async beforeTransaction(event) { log.push(`beforeTransaction ${event.entity}#${event.action}`); before.push(event); await extra.beforeTransaction?.(event); },
    async afterWrite(db, event) { log.push(`afterWrite ${event.entity}#${event.action}`); writes.push(event); await extra.afterWrite?.(db, event); },
    async afterCommit(event) { log.push(`afterCommit ${event.changes.length}`); commits.push(event); await extra.afterCommit?.(event); },
  };
  return { seams, log, before, writes, commits };
}
const shape = (change: { readonly entity: string; readonly action: string }) => `${change.entity}#${change.action}`;

describe("acceptance 1: afterWrite runs once for each row written, with its before and after; a read runs no seam", () => {
  test("every write of the 18 entities calls afterWrite with the row as it was and as written, and nothing else does", async () => {
    const rec = recorder({
      // The seam runs right after the write: the stored row is the one it was handed.
      async afterWrite(db, { entity, after }) {
        if (after === null) return;
        expect(await db.selectByKey(tableOf(entity), keyOf(entity, after)), entity).toEqual(after);
      },
    });
    const fresh = await empty({ seams: rec.seams });
    try {
      await populate(fresh);
      expect(new Set(rec.writes.map((event) => event.entity))).toEqual(new Set(ENTITIES));
      // Replayed, the events are a consistent history: a create has no `before` and a new key, an update's `before` is the
      // row as the last event left it, so no row is written twice for one call and none is missed.
      const rows = new Map<string, Record<string, unknown>>();
      for (const { entity, action, before, after } of rec.writes) {
        expect(after, `${entity}#${action}`).not.toBeNull();
        const key = `${entity}/${String(entity === "audit.Event" ? after!.seq : after!.id)}`;
        const known = rows.get(key);
        if (known === undefined) expect(before, `${entity}#${action} creates ${key}`).toBeNull();
        else expect(before, `${entity}#${action} updates ${key}`).toEqual(known);
        if (known !== undefined) expect(before, `${entity}#${action} changed nothing`).not.toEqual(after);
        rows.set(key, after!);
      }
      // What the events say the rows are is what is stored.
      for (const [key, row] of rows) {
        const entity = key.split("/")[0]!;
        expect(await fresh.db.transaction((tx) => tx.selectByKey(tableOf(entity), keyOf(entity, row))), key).toEqual(row);
      }
      expect(rec.before.length).toBeGreaterThan(0);
    } finally { await fresh.db.close(); }
  });

  test("one create is one afterWrite call, with before null; an update's before is the stored row; a read runs no seam", async () => {
    const rec = recorder();
    const fresh = await empty({ seams: rec.seams });
    try {
      const alice = await fresh.hyper.registerCollaborator({ kind: "human", name: "Alice" }, setup);
      expect(rec.log).toEqual(["beforeTransaction identity.Collaborator#register", "afterWrite identity.Collaborator#register", "afterCommit 1"]);
      expect(rec.writes[0]).toMatchObject({ entity: "identity.Collaborator", action: "register", before: null, after: alice, input: { kind: "human", name: "Alice" }, context: setup });
      rec.log.length = 0;
      const renamed = await fresh.hyper.updateCollaborator({ id: alice.id, name: "Alicia" }, setup);
      expect(rec.log).toEqual(["beforeTransaction identity.Collaborator#update", "afterWrite identity.Collaborator#update", "afterCommit 1"]);
      expect(rec.writes[1]).toMatchObject({ before: alice, after: renamed });
      rec.log.length = 0;
      expect(await fresh.hyper.readCollaborator({}, setup)).toEqual([renamed]);
      expect(rec.log).toEqual([]);
    } finally { await fresh.db.close(); }
  });
});

describe("acceptance 2: a nested write reaches the seams in the order the rows are written", () => {
  test("Review :accept is seen before the task.complete, submission.settle and completion.record it causes", async () => {
    const rec = recorder();
    const w = await world();
    try {
      const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
      const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
      if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
      // Bind again over the same data with the seams: only what follows is recorded.
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await watched.acceptReview({ submission: submitted.submission.id }, as(w.alice));
      const seen = rec.writes.map(shape);
      // Written in the order the lifecycle runs them: the review's row, then the steps after it, which call the others.
      expect(seen).toEqual(["work.Review#accept", "work.Submission#settle", "work.Task#complete", "work.Completion#record"]);
      // The seams see the whole call as one transaction: the top-level action is the only one that ran beforeTransaction,
      // and afterCommit ran once, after every write, with the same list.
      expect(rec.before.map((event) => `${event.entity}#${event.action}`)).toEqual(["work.Review#accept"]);
      expect(rec.commits).toHaveLength(1);
      expect(rec.commits[0]!.changes.map(shape)).toEqual(seen);
      expect(rec.log.at(-1)).toBe(`afterCommit ${seen.length}`);
    } finally { await w.db.close(); }
  });
});

/** Bob's work on the world's task, submitted and waiting for Alice's review. */
async function pending(w: Awaited<ReturnType<typeof world>>) {
  const claim = await w.hyper.acquireClaim({ task: w.task.id }, as(w.bot));
  const submitted = await submissionSubmit({ task: w.task.id, fence: claim.fence, summary: "ready" }, as(w.bot), w.binding);
  if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
  return submitted.submission;
}
/** Everything the world's tables hold that a review of its pending submission changes. */
const state = async (w: Awaited<ReturnType<typeof world>>) => ({
  reviews: await w.hyper.readReview({}, as(w.alice)),
  submissions: await w.hyper.readSubmission({}, as(w.alice)),
  tasks: await w.hyper.readTask({}, as(w.alice)),
  completions: await w.hyper.readCompletion({}, as(w.alice)),
  claims: await w.hyper.readClaim({}, as(w.alice)),
  workspaces: await w.hyper.readWorkspace({}, as(w.alice)),
});
const boom = new Error("the seam refused");

describe("acceptance 3: a throw in afterWrite rolls back the whole outermost transaction", () => {
  test("a throw on a nested call's write undoes the review, the settled submission and what the seam wrote through db", async () => {
    const w = await world();
    try {
      const submission = await pending(w);
      const untouched = await state(w);
      const watched = bind(w.db, {
        clock: w.clock,
        seams: {
          async afterWrite(db, { entity, action }) {
            // Written through `db` by the first seam call, before the nested ones: it must go too.
            if (entity === "work.Review") await db.insert(tables.workspaces, { id: "00000000-0000-4000-8000-0000000000f1", name: "seam", location: "local", state: "active", version: 1 });
            if (entity === "work.Completion" && action === "record") throw boom;
          },
        },
      });
      await expect(watched.acceptReview({ submission: submission.id }, as(w.alice))).rejects.toBe(boom);
      expect(await state(w)).toEqual(untouched);
    } finally { await w.db.close(); }
  });

  test("a throw on the top-level action's own write leaves nothing behind, and the next call works", async () => {
    const w = await world();
    try {
      const untouched = await state(w);
      let armed = true;
      const watched = bind(w.db, { clock: w.clock, seams: { afterWrite() { if (armed) throw boom; } } });
      await expect(watched.createTask({ title: "Never" }, as(w.alice))).rejects.toBe(boom);
      expect(await state(w)).toEqual(untouched);
      armed = false;
      await watched.createTask({ title: "Now" }, as(w.alice));
      expect((await state(w)).tasks).toHaveLength(untouched.tasks.length + 1);
    } finally { await w.db.close(); }
  });

  test("a throw in a nested call rolls the caller back, even when the caller catches it: the call rejects with a FrameworkError whose cause is the throw", async () => {
    const w = await world();
    try {
      const untouched = await state(w);
      const rec = recorder({ afterWrite(_db, { input }) { if ((input as { title?: string }).title === "Never") throw boom; } });
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      const failure = await watched.transaction(async ({ actions }) => {
        await actions.createTask({ title: "Kept" });
        await actions.createTask({ title: "Never" }).catch(() => undefined);
      }, as(w.alice)).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(FrameworkError);
      expect((failure as FrameworkError).cause).toBe(boom);
      expect(await state(w)).toEqual(untouched);
      expect(rec.commits).toEqual([]);
    } finally { await w.db.close(); }
  });

  test("a throw in a call a step made through actions rolls the whole review back", async () => {
    const w = await world();
    try {
      const submission = await pending(w);
      const untouched = await state(w);
      const watched = bind(w.db, { clock: w.clock, seams: { afterWrite(_db, { entity }) { if (entity === "work.Submission") throw boom; } } });
      await expect(watched.acceptReview({ submission: submission.id }, as(w.alice))).rejects.toBe(boom);
      expect(await state(w)).toEqual(untouched);
    } finally { await w.db.close(); }
  });
});

describe("acceptance 4: afterCommit runs once, after the commit, with every change in order", () => {
  test("it is not called when the transaction rolls back, whichever seam or step failed it", async () => {
    const rec = recorder({ afterWrite(_db, { entity }) { if (entity === "work.Completion") throw boom; } });
    const w = await world();
    try {
      const submission = await pending(w);
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await expect(watched.acceptReview({ submission: submission.id }, as(w.alice))).rejects.toBe(boom);
      expect(rec.commits).toEqual([]);
      // A failed check fails the call before any write, and an input that does not validate before any transaction.
      await expect(watched.createTask({} as never, as(w.alice))).rejects.toThrow();
      expect(rec.commits).toEqual([]);
    } finally { await w.db.close(); }
  });

  test("it is called once with every change the action made, nested calls included, in the order the rows were written", async () => {
    const rec = recorder();
    const w = await world();
    try {
      const submission = await pending(w);
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await watched.acceptReview({ submission: submission.id }, as(w.alice));
      expect(rec.commits).toHaveLength(1);
      // The same rows afterWrite received, in the same order: before and after as plain data.
      expect(rec.commits[0]!.changes).toEqual(rec.writes.map(({ entity, action, before, after }) => ({ entity, action, before, after })));
      expect(rec.commits[0]!.changes.map(shape)).toEqual(["work.Review#accept", "work.Submission#settle", "work.Task#complete", "work.Completion#record"]);
      // After the commit: what the call changed is there to read, and afterCommit came after every afterWrite.
      expect(rec.log.at(-1)).toBe("afterCommit 4");
    } finally { await w.db.close(); }
  });

  test("the application's transaction is an outermost transaction: once, when it commits, with every change made inside it", async () => {
    const rec = recorder();
    const w = await world();
    try {
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      const created = await watched.transaction(async ({ actions }) => {
        const first = await actions.createTask({ title: "One" });
        const second = await actions.createTask({ title: "Two" });
        // Nothing has committed yet.
        expect(rec.commits).toEqual([]);
        return [first, second];
      }, as(w.alice));
      expect(rec.commits).toHaveLength(1);
      expect(rec.commits[0]!.changes.map((change) => [shape(change), change.after!.id])).toEqual([["work.Task#create", created[0]!.id], ["work.Task#create", created[1]!.id]]);
      // The actions it called joined it: none ran beforeTransaction.
      expect(rec.before).toEqual([]);
    } finally { await w.db.close(); }
  });

  test("a transaction nested in another one reports to the outer one only; one that rolls back, or wrote nothing, reports nothing", async () => {
    const rec = recorder();
    const w = await world();
    try {
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await watched.transaction(async ({ actions }) => {
        await actions.createTask({ title: "Outer" });
        await watched.transaction(async (inner) => { await inner.actions.createTask({ title: "Inner" }); }, as(w.alice));
        expect(rec.commits).toEqual([]);
      }, as(w.alice));
      expect(rec.commits).toHaveLength(1);
      expect(rec.commits[0]!.changes).toHaveLength(2);
      await expect(watched.transaction(async ({ actions }) => { await actions.createTask({ title: "Lost" }); throw boom; }, as(w.alice))).rejects.toBe(boom);
      await watched.transaction(async ({ tx }) => { await tx.readTask({}); }, as(w.alice));
      expect(rec.commits).toHaveLength(1);
      // A joined call that failed and was caught still rolls the whole transaction back: nothing is reported.
      await expect(watched.transaction(async ({ actions }) => {
        await actions.createTask({ title: "Kept?" });
        await actions.createTask({} as never).catch(() => undefined);
      }, as(w.alice))).rejects.toThrow();
      expect(rec.commits).toHaveLength(1);
    } finally { await w.db.close(); }
  });

  test("a throw in afterCommit leaves the call resolved and the data committed, and is reported naming the seam", async () => {
    const w = await world();
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const watched = bind(w.db, { clock: w.clock, seams: { afterCommit() { throw boom; } } });
      const created = await watched.createTask({ title: "Committed" }, as(w.alice));
      expect(created.title).toBe("Committed");
      expect((await w.hyper.readTask({ filter: { id: { eq: created.id } } }, as(w.alice)))[0]).toEqual(created);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain("afterCommit");
      expect(errors.mock.calls[0]![1]).toBe(boom);
      // An asynchronous throw is the same, and so is one in the application's transaction.
      const later = bind(w.db, { clock: w.clock, seams: { async afterCommit() { await Promise.resolve(); throw boom; } } });
      await later.transaction(async ({ actions }) => { await actions.createTask({ title: "Two" }); }, as(w.alice));
      expect(errors).toHaveBeenCalledTimes(2);
    } finally { errors.mockRestore(); await w.db.close(); }
  });
});

describe("acceptance 5: beforeTransaction runs for the call that opens the transaction, and refuses it by throwing", () => {
  test("a throw writes nothing and rejects the call with that error", async () => {
    const w = await world();
    try {
      const untouched = await state(w);
      const rec = recorder({ beforeTransaction() { throw boom; } });
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await expect(watched.createTask({ title: "Refused" }, as(w.alice))).rejects.toBe(boom);
      expect(rec.log).toEqual(["beforeTransaction work.Task#create"]);
      expect(await state(w)).toEqual(untouched);
      // The caller does not wait on a transaction the refusal never opened: the layer is free for the next call.
      await w.hyper.createTask({ title: "Fine" }, as(w.alice));
    } finally { await w.db.close(); }
  });

  test("it receives the validated input and the context, once for a top-level call; the calls it makes through actions run none", async () => {
    const w = await world();
    try {
      const submission = await pending(w);
      const rec = recorder();
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      const context = { ...as(w.alice), commandId: "c-1" };
      await watched.acceptReview({ submission: submission.id }, context);
      expect(rec.before).toEqual([{ entity: "work.Review", action: "accept", input: { submission: submission.id }, context }]);
      expect(rec.writes.length).toBe(4);
    } finally { await w.db.close(); }
  });

  test("a call inside the application's transaction is joined, so it runs none either", async () => {
    const w = await world();
    try {
      const rec = recorder();
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await watched.transaction(async ({ actions }) => { await actions.createTask({ title: "Joined" }); }, as(w.alice));
      expect(rec.before).toEqual([]);
      // A call made after it, at top level, is a new transaction and runs it again.
      await watched.createTask({ title: "Top" }, as(w.alice));
      expect(rec.before.map(shape)).toEqual(["work.Task#create"]);
    } finally { await w.db.close(); }
  });

  test("an input that does not validate is refused before the seam: there is no transaction to run it before", async () => {
    const w = await world();
    try {
      const rec = recorder();
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await expect(watched.createTask({} as never, as(w.alice))).rejects.toThrow();
      expect(rec.log).toEqual([]);
    } finally { await w.db.close(); }
  });
});

describe("acceptance 6: the context of a call reaches the seams of every row it writes", () => {
  test("commandId and caller are on the afterWrite input of a nested call, with the person as actor", async () => {
    const w = await world();
    try {
      const submission = await pending(w);
      const rec = recorder();
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await watched.acceptReview({ submission: submission.id }, { ...as(w.alice), commandId: "cmd-7", caller: "cli" });
      expect(rec.writes.map(shape)).toEqual(["work.Review#accept", "work.Submission#settle", "work.Task#complete", "work.Completion#record"]);
      for (const event of rec.writes) expect(event.context, shape(event)).toMatchObject({ commandId: "cmd-7", caller: "cli", actor: { id: w.alice.id } });
      // A nested call's own input, not the caller's.
      expect(rec.writes[1]!.input).toEqual({ id: submission.id, outcome: "accepted" });
    } finally { await w.db.close(); }
  });

  test("through the application's transaction, a call with no context of its own carries the transaction's", async () => {
    const w = await world();
    try {
      const rec = recorder();
      const watched = bind(w.db, { clock: w.clock, seams: rec.seams });
      await watched.transaction(async ({ actions }) => { await actions.createTask({ title: "Ctx" }); }, { ...as(w.alice), commandId: "cmd-9" });
      expect(rec.writes[0]!.context).toMatchObject({ commandId: "cmd-9" });
    } finally { await w.db.close(); }
  });
});

describe("a destroy gives its seams the row it deleted", () => {
  test("afterWrite sees before as the deleted row and after as null, and afterCommit the same change", async () => {
    const rec = recorder();
    const fresh = await empty({ seams: rec.seams });
    try {
      const { dependency } = await populate(fresh);
      rec.writes.length = 0;
      rec.commits.length = 0;
      await fresh.hyper.removeDependency({ id: dependency.id }, setup);
      // The destroy's own write, then the Task it touches in a step after the write.
      expect(rec.writes.map(shape)).toEqual(["work.Dependency#remove", "work.Task#touch"]);
      expect(rec.writes[0]).toMatchObject({ before: dependency, after: null });
      expect(rec.commits[0]!.changes[0]).toEqual({ entity: "work.Dependency", action: "remove", before: dependency, after: null });
      expect(rec.commits[0]!.changes).toHaveLength(2);
      expect(await fresh.hyper.readDependency({}, setup)).toEqual([]);
    } finally { await fresh.db.close(); }
  });

  test("a destroy of a row that is not there is NotFound, with a seam and without one", async () => {
    for (const seams of [undefined, recorder().seams]) {
      const fresh = await empty({ seams });
      try {
        const error = await fresh.hyper.removeDependency({ id: "00000000-0000-4000-8000-0000000000aa" }, setup).catch((cause: unknown) => cause);
        expect(error).toMatchObject({ code: "not_found" });
      } finally { await fresh.db.close(); }
    }
  });
});

describe("db", () => {
  test("it is the four operations by key, a write through it runs no seam and is not a change in afterCommit", async () => {
    let seen: SeamDb | undefined;
    const rec = recorder({
      async afterWrite(db, { entity }) {
        seen = db;
        if (entity !== "identity.Workspace") return;
        const key = { id: "00000000-0000-4000-8000-0000000000f2" };
        const row = await db.insert(tables.workspaces, { ...key, name: "log", location: "local", state: "active", version: 1 });
        expect(await db.selectByKey(tables.workspaces, key)).toEqual(row);
        expect(await db.updateByKey(tables.workspaces, key, { name: "log 2" })).toMatchObject({ name: "log 2" });
        const second = { id: "00000000-0000-4000-8000-0000000000f3" };
        await db.insert(tables.workspaces, { ...second, name: "gone", location: "local", state: "active", version: 1 });
        expect(await db.deleteByKey(tables.workspaces, second)).toBe(true);
      },
    });
    const fresh = await empty({ seams: rec.seams });
    try {
      await fresh.hyper.createWorkspace({ name: "Home" }, setup);
      expect(Object.keys(seen!).sort()).toEqual(["deleteByKey", "insert", "selectByKey", "updateByKey"]);
      expect(rec.writes).toHaveLength(1);
      expect(rec.commits[0]!.changes.map(shape)).toEqual(["identity.Workspace#create"]);
      expect((await fresh.hyper.readWorkspace({}, setup)).map((row) => row.name).sort()).toEqual(["Home", "log 2"]);
    } finally { await fresh.db.close(); }
  });
});
