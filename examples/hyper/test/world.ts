// The fixtures the Hyper tests share: an in-memory database bound with a clock the test moves, three collaborators
// with their memberships, the context each one acts in, and the binding the command functions run on.
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { InvalidInputError, type ActionContext, type Issue } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import type { Binding } from "../src/domain/binding";

export const NOW = new Date("2026-10-10T12:00:00.000Z");
export const minutes = (n: number, from: Date = NOW) => new Date(from.getTime() + n * 60_000);

/** The context of a call made as `collaborator`. */
export const as = (collaborator: { readonly id: string }): ActionContext => ({ actor: { id: collaborator.id } });

/** The actor of the calls that set up a world before any collaborator exists: registering the first ones. */
export const setup: ActionContext = { actor: { id: "00000000-0000-4000-8000-000000000000" } };

/** An empty database and its binding; the clock reads `time.now`, which a test moves. */
export async function empty() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const time = { now: NOW };
  const clock = () => time.now;
  const hyper = bind(db, { clock });
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
