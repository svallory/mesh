// The fixtures the Hyper tests share: an in-memory database bound with a clock the test moves, three collaborators
// with their memberships, the context each one acts in, and the binding the command functions run on.
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { InvalidInputError, type ActionContext, type Issue, type Seams } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import type { Binding } from "../src/domain/binding";
import { attemptStart, sessionRecord } from "../src/domain/execution/execution.commands";
import { reviewAccept, submissionSubmit } from "../src/domain/work/work.commands";

export const NOW = new Date("2026-10-10T12:00:00.000Z");
export const minutes = (n: number, from: Date = NOW) => new Date(from.getTime() + n * 60_000);

/** The context of a call made as `collaborator`. */
export const as = (collaborator: { readonly id: string }): ActionContext => ({ actor: { id: collaborator.id } });

/** The actor of the calls that set up a world before any collaborator exists: registering the first ones. */
export const setup: ActionContext = { actor: { id: "00000000-0000-4000-8000-000000000000" } };

/** An empty database and its binding; the clock reads `time.now`, which a test moves. */
export async function empty(options: { readonly seams?: Seams } = {}) {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const time = { now: NOW };
  const clock = () => time.now;
  const hyper = bind(db, { clock, seams: options.seams });
  const binding: Binding = { transaction: hyper.transaction, clock };
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
  const { hyper } = base;
  const alice = await hyper.registerCollaborator({ kind: "human", name: "Alice" }, setup);
  const bob = await hyper.registerCollaborator({ kind: "human", name: "Bob" }, setup);
  const bot = await hyper.registerCollaborator({ kind: "agent", name: "Bot" }, setup);
  const owner = await hyper.grantMembership({ collaborator: alice.id, role: "owner" }, as(alice));
  const bobMember = await hyper.grantMembership({ collaborator: bob.id, role: "member" }, as(alice));
  const botMember = await hyper.grantMembership({ collaborator: bot.id, role: "member" }, as(alice));
  const task = await hyper.createTask({ title: "Ship" }, as(alice));
  return { ...base, alice, bob, bot, memberships: { alice: owner, bob: bobMember, bot: botMember }, task };
}
export type World = Awaited<ReturnType<typeof world>>;

/** Run `body` on a fresh world and close its database. */
export async function within<T>(body: (w: World) => Promise<T>): Promise<T> {
  const w = await world();
  try { return await body(w); } finally { await w.db.close(); }
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

/** The one row of `read`'s result, or a failure naming what was missing. */
export async function one<T>(rows: Promise<readonly T[]>): Promise<T> {
  const [row, ...rest] = await rows;
  if (!row || rest.length > 0) throw new Error(`expected one row, got ${rest.length + (row ? 1 : 0)}`);
  return row;
}

/** An event in the spec's v0 shape (PROTOCOL.md, `Event`): typed, with a cause and a payload. */
export function eventOf(n: number, extra: Record<string, unknown> = {}) {
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
export async function populate({ hyper, binding }: Pick<Empty, "hyper" | "binding">) {
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
