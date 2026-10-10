// M5 part 1 in Hyper: the rules that read one record (and the records it points at) run through the generated actions.
// Each rule has a passing and a failing case, named by Hyper's own rule name as the issue `code`. Cascades, the
// events, policies and the plugin hook wait for later milestones (PORTING.md).
import { describe, expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { InvalidInputError, type Issue } from "@meshfw/runtime";
import { bind, tables } from "#mesh";

const context = { actor: { id: "00000000-0000-4000-8000-000000000001" } };
const NOW = new Date("2026-10-10T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

async function world() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const hyper = bind(db, { clock: () => NOW });
  const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, context);
  const bot = await hyper.registerCollaborator({ kind: "agent", name: "Bot" }, context);
  const task = await hyper.createTask({ title: "Ship", creator: alice.id }, context);
  /** Write what the generated actions cannot yet (the cascades are m5b): set a column of one row. */
  const force = (table: keyof typeof tables, key: string, changes: Record<string, unknown>) => db.transaction((tx) => tx.updateByKey(tables[table], { id: key } as never, changes as never));
  return { db, hyper, alice, bot, task, force };
}
type World = Awaited<ReturnType<typeof world>>;

/** The issues a call fails with, or `[]` when it succeeds. */
async function issuesOf(call: Promise<unknown>): Promise<readonly Issue[]> {
  try { await call; return []; }
  catch (cause) {
    if (cause instanceof InvalidInputError) return cause.issues;
    throw cause;
  }
}
const codes = (issues: readonly Issue[]) => issues.map((issue) => issue.code);

async function within<T>(run: (w: World) => Promise<T>): Promise<T> {
  const w = await world();
  try { return await run(w); } finally { await w.db.close(); }
}

describe("Task", () => {
  test("task.open: setPriority, update and move refuse a task that is not open", () => within(async ({ hyper, task, force, alice }) => {
    expect(await issuesOf(hyper.setPriorityTask({ id: task.id, priority: 3 }, context))).toEqual([]);
    await force("task", task.id, { state: "done" });
    for (const call of [hyper.setPriorityTask({ id: task.id, priority: 4 }, context), hyper.updateTask({ id: task.id, title: "New" }, context), hyper.moveTask({ id: task.id, parent: null }, context)])
      expect(codes(await issuesOf(call))).toContain("task.open");
    expect((await hyper.readTask({ filter: { id: { eq: task.id } } }, context))[0]!.priority).toBe(3);
    void alice;
  }));

  test("task.parent-open: a create and a move need an open parent", () => within(async ({ hyper, task, alice, force }) => {
    expect(await issuesOf(hyper.createTask({ title: "child", creator: alice.id, parent: task.id }, context))).toEqual([]);
    const other = await hyper.createTask({ title: "other", creator: alice.id }, context);
    expect(await issuesOf(hyper.moveTask({ id: other.id, parent: task.id }, context))).toEqual([]);
    await force("task", task.id, { state: "canceled" });
    const created = await issuesOf(hyper.createTask({ title: "late child", creator: alice.id, parent: task.id }, context));
    expect(codes(created)).toEqual(["task.parent-open"]);
    expect(created[0]!.message).toBe("the parent task is not open");
    const root = await hyper.createTask({ title: "root", creator: alice.id }, context);
    expect(codes(await issuesOf(hyper.moveTask({ id: root.id, parent: task.id }, context)))).toEqual(["task.parent-open"]);
    expect(await issuesOf(hyper.moveTask({ id: root.id, parent: null }, context))).toEqual([]);
  }));

  test("task.unchanged compares the new values with the stored ones through `before`", () => within(async ({ hyper, task }) => {
    expect(codes(await issuesOf(hyper.updateTask({ id: task.id, title: "Ship" }, context)))).toEqual(["task.unchanged"]);
    expect(await issuesOf(hyper.updateTask({ id: task.id, title: "Ship it" }, context))).toEqual([]);
    expect(await issuesOf(hyper.updateTask({ id: task.id, intent: "by Friday" }, context))).toEqual([]);
    expect(codes(await issuesOf(hyper.updateTask({ id: task.id, intent: "by Friday" }, context)))).toEqual(["task.unchanged"]);
    expect(await issuesOf(hyper.updateTask({ id: task.id, intent: null }, context))).toEqual([]);
    expect(codes(await issuesOf(hyper.updateTask({ id: task.id, intent: null }, context)))).toEqual(["task.unchanged"]);
  }));

  test("task.no-active-claim: a task with a live claim cannot move; an expired one can", () => within(async ({ hyper, task, bot, alice }) => {
    const other = await hyper.createTask({ title: "other", creator: alice.id }, context);
    const claim = await hyper.acquireClaim({ fence: 1, acquiredAt: NOW, expiresAt: minutes(10), task: task.id, holder: bot.id }, context);
    expect(codes(await issuesOf(hyper.moveTask({ id: task.id, parent: other.id }, context)))).toEqual(["task.no-active-claim"]);
    await hyper.revokeClaim({ id: claim.id }, context);
    expect(await issuesOf(hyper.moveTask({ id: task.id, parent: other.id }, context))).toEqual([]);
  }));

  test("task.settled: reopen needs a settled task and returns it to open", () => within(async ({ hyper, task, force }) => {
    expect(codes(await issuesOf(hyper.reopenTask({ id: task.id, reason: "why" }, context)))).toEqual(["task.settled"]);
    await force("task", task.id, { state: "canceled" });
    const reopened = await hyper.reopenTask({ id: task.id, reason: "again" }, context);
    expect(reopened.state).toBe("open");
    expect(reopened.version).toBe(task.version + 1);
  }));

  test("every failing rule of one call is reported together", () => within(async ({ hyper, task, force }) => {
    await force("task", task.id, { state: "done" });
    const issues = await issuesOf(hyper.updateTask({ id: task.id, title: "Ship", expectedVersion: 99 }, context));
    expect(codes(issues)).toEqual(["task.open", "task.unchanged", "expected-version"]);
  }));
});

describe("expected-version and the version bump (a check and a set, G02)", () => {
  test("a stale expectedVersion changes nothing and names the current version; the right one bumps by one", () => within(async ({ hyper, task }) => {
    const first = await hyper.setPriorityTask({ id: task.id, priority: 1, expectedVersion: 1 }, context);
    expect(first.version).toBe(2);
    const stale = await issuesOf(hyper.setPriorityTask({ id: task.id, priority: 2, expectedVersion: 1 }, context));
    expect(codes(stale)).toEqual(["expected-version"]);
    expect(stale[0]!.details).toEqual({ currentVersion: 2 });
    const [row] = await hyper.readTask({ filter: { id: { eq: task.id } } }, context);
    expect(row).toMatchObject({ priority: 1, version: 2 });
    expect((await hyper.setPriorityTask({ id: task.id, priority: 5 }, context)).version).toBe(3);
  }));

  test("the same rule guards Workspace, Collaborator, Membership, Machine and SessionReference", () => within(async ({ hyper, alice, bot }) => {
    const workspace = await hyper.createWorkspace({ name: "Home" }, context);
    const membership = await hyper.grantMembership({ role: "member", grantedAt: NOW, collaborator: bot.id, grantedBy: alice.id }, context);
    const machine = await hyper.registerMachine({ name: "laptop" }, context);
    const session = await hyper.recordSessionReference({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: machine.id, agentProfile: bot.id, recordedBy: bot.id }, context);
    let flipped = 0;
    const roles = ["owner", "guest"] as const satisfies readonly ("owner" | "guest")[];
    const roleQueue: ("owner" | "guest")[] = [...roles];
    const calls = [
      (v: number) => hyper.renameWorkspace({ id: workspace.id, name: `n${v}`, expectedVersion: v }, context),
      (v: number) => hyper.updateCollaborator({ id: alice.id, name: `a${v}`, expectedVersion: v }, context),
      (v: number) => hyper.changeRoleMembership({ id: membership.id, role: roleQueue.shift()!, expectedVersion: v }, context),
      (v: number) => hyper.updateMachine({ id: machine.id, platform: `p${v}`, expectedVersion: v }, context),
      (v: number) => hyper.setAvailabilitySessionReference({ id: session.id, availability: v === 1 && !flipped++ ? "partial" : "unavailable", expectedVersion: v }, context),
    ];
    for (const call of calls) {
      expect((await call(1)).version).toBe(2);
      expect(codes(await issuesOf(call(1)))).toEqual(["expected-version"]);
    }
  }));
});

describe("Workspace, Collaborator, Membership, Machine and SessionReference", () => {
  test("workspace.active", () => within(async ({ hyper, force }) => {
    const workspace = await hyper.createWorkspace({ name: "Home" }, context);
    expect((await hyper.renameWorkspace({ id: workspace.id, name: "Base" }, context)).name).toBe("Base");
    await force("workspace", workspace.id, { state: "moved" });
    expect(codes(await issuesOf(hyper.renameWorkspace({ id: workspace.id, name: "Again" }, context)))).toEqual(["workspace.active"]);
  }));

  test("collaborator.active and collaborator.kind-immutable", () => within(async ({ hyper, bot, force }) => {
    expect((await hyper.updateCollaborator({ id: bot.id, name: "Robot", kind: "agent" }, context)).name).toBe("Robot");
    expect(codes(await issuesOf(hyper.updateCollaborator({ id: bot.id, kind: "human" }, context)))).toEqual(["collaborator.kind-immutable"]);
    await force("collaborator", bot.id, { state: "retired" });
    expect(codes(await issuesOf(hyper.updateCollaborator({ id: bot.id, name: "Ghost" }, context)))).toEqual(["collaborator.active"]);
  }));

  test("membership.active and membership.unchanged", () => within(async ({ hyper, alice, bot, force }) => {
    const membership = await hyper.grantMembership({ role: "member", grantedAt: NOW, collaborator: bot.id, grantedBy: alice.id }, context);
    expect(codes(await issuesOf(hyper.changeRoleMembership({ id: membership.id, role: "member" }, context)))).toEqual(["membership.unchanged"]);
    expect((await hyper.changeRoleMembership({ id: membership.id, role: "owner" }, context)).role).toBe("owner");
    await force("membership", membership.id, { state: "revoked" });
    expect(codes(await issuesOf(hyper.changeRoleMembership({ id: membership.id, role: "guest" }, context)))).toEqual(["membership.active"]);
  }));

  test("machine.active", () => within(async ({ hyper, force }) => {
    const machine = await hyper.registerMachine({ name: "laptop" }, context);
    expect((await hyper.updateMachine({ id: machine.id, platform: "linux" }, context)).platform).toBe("linux");
    await force("machine", machine.id, { state: "retired" });
    expect(codes(await issuesOf(hyper.updateMachine({ id: machine.id, platform: "mac" }, context)))).toEqual(["machine.active"]);
  }));

  test("session.not-redacted and session.availability; redact clears the location and the redaction is final", () => within(async ({ hyper, alice, bot }) => {
    const machine = await hyper.registerMachine({ name: "laptop" }, context);
    const session = await hyper.recordSessionReference({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", location: "/home/s-1", machine: machine.id, agentProfile: bot.id, recordedBy: alice.id }, context);
    expect(codes(await issuesOf(hyper.setAvailabilitySessionReference({ id: session.id, availability: "complete" }, context)))).toEqual(["session.availability"]);
    expect((await hyper.setAvailabilitySessionReference({ id: session.id, availability: "partial" }, context)).availability).toBe("partial");
    const redacted = await hyper.redactSessionReference({ id: session.id }, context);
    expect(redacted).toMatchObject({ availability: "redacted", location: null, version: 3 });
    expect(codes(await issuesOf(hyper.redactSessionReference({ id: session.id }, context)))).toEqual(["session.not-redacted"]);
    expect(codes(await issuesOf(hyper.setAvailabilitySessionReference({ id: session.id, availability: "complete" }, context)))).toEqual(["session.not-redacted"]);
  }));
});

describe("Dependency", () => {
  test("dependency.distinct: a task cannot depend on itself", () => within(async ({ hyper, task, alice }) => {
    const other = await hyper.createTask({ title: "other", creator: alice.id }, context);
    expect(codes(await issuesOf(hyper.addDependency({ dependent: task.id, prerequisite: task.id, createdBy: alice.id }, context)))).toEqual(["dependency.distinct"]);
    expect(await issuesOf(hyper.addDependency({ dependent: task.id, prerequisite: other.id, createdBy: alice.id }, context))).toEqual([]);
  }));
});

describe("Claim", () => {
  async function claimed(w: World) {
    return w.hyper.acquireClaim({ fence: 2, acquiredAt: NOW, expiresAt: minutes(10), task: w.task.id, holder: w.bot.id }, context);
  }

  test("claim.current-fence names the current fence and says whether the caller's was stale (details.stale)", () => within(async (w) => {
    const claim = await claimed(w);
    const stale = await issuesOf(w.hyper.releaseClaim({ id: claim.id, fence: 1 }, context));
    expect(codes(stale)).toEqual(["claim.current-fence"]);
    expect(stale[0]!.details).toEqual({ currentFence: 2, stale: true });
    const ahead = await issuesOf(w.hyper.renewClaim({ id: claim.id, fence: 3, newExpiresAt: minutes(20) }, context));
    expect(ahead[0]!.details).toEqual({ currentFence: 2, stale: false });
    expect((await w.hyper.renewClaim({ id: claim.id, fence: 2, newExpiresAt: minutes(20) }, context)).expiresAt).toEqual(minutes(20));
  }));

  test("release ends the claim with its time and reason; a second release is refused with claim.active", () => within(async (w) => {
    const claim = await claimed(w);
    const released = await w.hyper.releaseClaim({ id: claim.id, fence: 2, reason: "done" }, context);
    expect(released).toMatchObject({ state: "released", endReason: "done" });
    expect(released.endedAt).toEqual(NOW);
    expect(codes(await issuesOf(w.hyper.releaseClaim({ id: claim.id, fence: 2 }, context)))).toEqual(["claim.active"]);
    expect(codes(await issuesOf(w.hyper.revokeClaim({ id: claim.id }, context)))).toEqual(["claim.active"]);
  }));

  test("revoke without a reason leaves endReason null", () => within(async (w) => {
    const claim = await claimed(w);
    expect(await w.hyper.revokeClaim({ id: claim.id }, context)).toMatchObject({ state: "revoked", endReason: null });
  }));

  test("claim.expired: a lapsed lease cannot be renewed, judged by the stored expiry and not by the new one", () => within(async (w) => {
    const claim = await w.hyper.acquireClaim({ fence: 1, acquiredAt: minutes(-20), expiresAt: minutes(-5), task: w.task.id, holder: w.bot.id }, context);
    expect(codes(await issuesOf(w.hyper.renewClaim({ id: claim.id, fence: 1, newExpiresAt: minutes(30) }, context)))).toEqual(["claim.expired"]);
  }));

  test("an unknown claim is NotFoundError, not an issue", () => within(async (w) => {
    await expect(w.hyper.revokeClaim({ id: "00000000-0000-4000-8000-0000000000ff" }, context)).rejects.toThrow("not found");
  }));
});
