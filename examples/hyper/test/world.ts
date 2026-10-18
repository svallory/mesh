// The fixtures the Hyper tests share: an in-memory database bound with a clock the test moves, three collaborators
// with their memberships, the context each one acts in, and the binding the command functions run on.
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { ForbiddenError, InvalidInputError, type ActionContext, type AfterCommitEvent, type Issue, type Seams } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { Idempotency } from "#mesh/domain/audit";
import { Invocation, Machine, Run } from "#mesh/domain/execution";
import { Collaborator, Membership, Workspace } from "#mesh/domain/identity";
import { Claim, Dependency, EvidenceReference, Task } from "#mesh/domain/work";
import type { Role } from "../src/context";
import type { Binding } from "../src/domain/binding";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import { reviewAccept, submissionSubmit } from "../src/domain/work/work.commands";

export const NOW = new Date("2026-10-10T12:00:00.000Z");
export const minutes = (n: number, from: Date = NOW) => new Date(from.getTime() + n * 60_000);

/**
 * Each collaborator's role as committed: the role of its active membership, or absent when it has none. Every world
 * keeps it current through an `afterCommit` seam (`trackRoles`), so `as()` reads committed state when a call is made,
 * as HA reads the membership from the database when a call comes in. Collaborator ids are random,
 * so the worlds of one test run share the map without meeting.
 */
const roles = new Map<string, Role>();

/** The `afterCommit` seam that keeps `roles` current: a membership written active sets its role, a revoked one clears it. */
function trackRoles({ changes }: AfterCommitEvent): void {
  for (const change of changes) {
    if (change.entity !== "identity.Membership" || !change.after) continue;
    const { collaboratorId, role, state } = change.after as { collaboratorId: string; role: Role; state: string };
    if (state === "active") roles.set(collaboratorId, role);
    else roles.delete(collaboratorId);
  }
}

/**
 * The command every test call belongs to: an event's cause names the command that published it (`metadata` in
 * `src/events.ts`), and a call that is neither a command nor an engine rule cannot publish.
 */
export const command = Object.freeze({ commandId: "test-command", method: "test.call" });

/**
 * The context of a call made as `collaborator`, as HA builds it: the actor's id and the role of its active membership
 * when the call is made (`null` without one). Only the read policies use the role; write policies read it through `Mesh.privileged`.
 */
export const as = (collaborator: { readonly id: string }): ActionContext => ({ actor: { id: collaborator.id, role: roles.get(collaborator.id) ?? null }, ...command });


/**
 * The context of a call made as `collaborator` with `system` set, as the engine makes a nested call or an effect
 * (ADR-0071): for the bootstrap grant, and for a test that calls an internal action (Claim `expire`, Run `settle`…)
 * directly, as only the engine does.
 */
export const asSystem = (collaborator: { readonly id: string }): ActionContext => ({ ...as(collaborator), system: true });

/**
 * The engine's context for the calls that set up a world before any collaborator exists: registering the first ones,
 * as the spec's bootstrap acts as the engine (PROTOCOL.md:40-52).
 */
export const setup: ActionContext = { actor: { id: "00000000-0000-4000-8000-000000000000", role: null }, system: true, rule: "workspace.bootstrap" };

/** The event log of `mesh.config.ts` with no bus: events are written and read, and nothing delivers them. */
export const events = { load: () => import("../src/events.ts"), keep: "all" } as const;

/**
 * An empty database and its binding; the clock reads `time.now`, which a test moves. The binding's `afterCommit` seam
 * keeps the roles `as()` reads current, and then runs the test's own, if it passes one.
 */
export async function empty(options: { readonly seams?: Seams } = {}) {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const time = { now: NOW };
  const clock = () => time.now;
  const own = options.seams?.afterCommit;
  const seams: Seams = { ...options.seams, afterCommit: async (event) => { trackRoles(event); await own?.(event); } };
  const hyper = bind(db, { clock, seams, events });
  const binding: Binding = { transaction: hyper.transaction };
  /** Write a column the actions never write, to reach a state for a test: set columns of one row. */
  const force = (table: keyof typeof tables, id: string, changes: Record<string, unknown>) =>
    db.transaction((tx) => tx.updateByKey(tables[table], { id } as never, changes as never));
  /** Insert a row as it is, for a fixture no sequence of actions reaches (several active claims on one task). */
  const insert = (table: keyof typeof tables, row: Record<string, unknown>) =>
    db.transaction((tx) => tx.insert(tables[table], { id: crypto.randomUUID(), ...row } as never));
  /** Move the clock by `n` minutes. */
  const advance = (n: number) => { time.now = minutes(n, time.now); };
  return { db, hyper, binding, clock, time, force, insert, advance };
}
export type Empty = Awaited<ReturnType<typeof empty>>;
export type Hyper = Empty["hyper"];

/**
 * Alice (human, owner), Bob (human, member) and Bot (agent, member), and a top-level task Alice created. Alice is its
 * reviewer, by the reviewer rule's last branch (the creator of a task with no parent).
 */
export async function world() {
  const base = await empty();
  return base.hyper.run(async () => {
    const alice = await Collaborator.register({ kind: "human", name: "Alice" }, setup);
    const bob = await Collaborator.register({ kind: "human", name: "Bob" }, setup);
    const bot = await Collaborator.register({ kind: "agent", name: "Bot" }, setup);
    // The bootstrap grant (PROTOCOL.md:48): the engine grants the first owner, recorded as granted by that owner.
    const owner = await Membership.grant({ collaborator: alice.id, role: "owner" }, asSystem(alice));
    const bobMember = await Membership.grant({ collaborator: bob.id, role: "member" }, as(alice));
    const botMember = await Membership.grant({ collaborator: bot.id, role: "member" }, as(alice));
    const task = await Task.create({ title: "Ship" }, as(alice));
    return { ...base, alice, bob, bot, memberships: { alice: owner, bob: bobMember, bot: botMember }, task };
  });
}
export type World = Awaited<ReturnType<typeof world>>;

/** Run `body` on a fresh world, with its binding in scope, and close its database. */
export async function within<T>(body: (w: World) => Promise<T>): Promise<T> {
  const w = await world();
  try { return await w.hyper.run(() => body(w)); } finally { await w.db.close(); }
}

/** The issues a call fails with, or `[]` when it succeeds; any other error is rethrown. */
export async function issuesOf(call: Promise<unknown>): Promise<readonly Issue[]> {
  try { await call; return []; }
  catch (cause) {
    if (cause instanceof InvalidInputError) return cause.issues;
    throw cause;
  }
}
export const codes = (issues: readonly Issue[]) => issues.map((issue) => issue.code);

/**
 * The policies a call is refused by (`ForbiddenError.policies`, each named after the spec's check id, `PORTING.md`), or
 * `[]` when it succeeds; any other error is rethrown, so a call refused for another reason fails the test.
 */
export async function deniedBy(call: Promise<unknown>): Promise<readonly string[]> {
  try { await call; return []; }
  catch (cause) {
    if (cause instanceof ForbiddenError) return cause.policies;
    throw cause;
  }
}

/** The one row of `read`'s result, or a failure naming what was missing. */
export async function one<T>(rows: Promise<readonly T[]>): Promise<T> {
  const [row, ...rest] = await rows;
  if (!row || rest.length > 0) throw new Error(`expected one row, got ${rest.length + (row ? 1 : 0)}`);
  return row;
}

/**
 * One row of every entity (two of Collaborator, Membership, Task, Claim and Assignment), each written by the generated
 * actions or the command functions, through one piece of work: Bot claims, submits and has its work accepted on the
 * child task, then claims the parent, reports an attempt on a machine, loses the claim and reports late; one stored command fills Idempotency. It runs with
 * `hyper` in scope.
 */
export async function populate({ hyper, binding }: Pick<Empty, "hyper" | "binding">) {
  return hyper.run(async () => {
    const workspace = await Workspace.create({ name: "Home" }, setup);
    const alice = await Collaborator.register({ kind: "human", name: "Alice" }, setup);
    const bot = await Collaborator.register({ kind: "agent", name: "Bot" }, setup);
    const membership = await Membership.grant({ role: "owner", collaborator: alice.id }, asSystem(alice));
    const botMembership = await Membership.grant({ role: "member", collaborator: bot.id }, as(alice));
    const task = await Task.create({ title: "Ship", priority: 2 }, as(alice));
    const child = await Task.create({ title: "Test", parent: task.id }, as(alice));
    const dependency = await Dependency.add({ dependent: task.id, prerequisite: child.id }, as(alice));
    await Task.assign({ id: child.id, assignee: bot.id }, as(alice));
    const childClaim = await Claim.acquire({ task: child.id }, as(bot));
    const evidence = await EvidenceReference.record({ kind: "file", locator: "notes.md" }, as(bot));
    const submitted = await submissionSubmit({ summary: "done", evidence: [evidence.id], fence: childClaim.fence, task: child.id }, as(bot), binding);
    if (submitted.outcome !== "submitted") throw new Error(submitted.outcome);
    const accepted = await reviewAccept({ submission: submitted.submission.id }, as(alice), binding);
    const machine = await Machine.register({ name: "laptop", platform: "linux" }, as(bot));
    const { sessionReference: session } = await sessionRecord({ runtime: "claude", runtimeSessionId: "s-1", availability: "complete", machine: "laptop", agentProfile: bot.id }, as(bot), binding);
    const run = await Run.start({ inputs: { goal: "ship", steps: [1, 2] }, task: task.id }, as(alice));
    const claim = await Claim.acquire({ task: task.id }, as(bot));
    const { attempt } = await attemptStart({ run: run.id, machine: "laptop", session: session.id }, as(bot), binding);
    const invocation = await Invocation.record({ usageSource: "runtime", estimatedCost: 0.25, inputTokens: 10, outputTokens: 5, attempt: attempt.id }, as(bot));
    await Claim.revoke({ id: claim.id, reason: "taking over" }, as(alice));
    const late = await submissionSubmit({ summary: "late", fence: claim.fence, task: task.id }, as(bot), binding);
    if (late.outcome !== "late-result-recorded") throw new Error(late.outcome);
    const idempotency = await Idempotency.record({ commandId: "populate", method: "task.create", hash: "0".repeat(64), result: { ok: true } }, asSystem(alice));
    return {
      workspace, alice, bot, membership, botMembership, task, child, dependency, childClaim, claim, evidence,
      submission: submitted.submission, review: accepted.review, completion: accepted.completion, lateResult: late.lateResult, machine, session, run, attempt, invocation, idempotency,
    };
  });
}
