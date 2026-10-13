// CMP-21: `Mesh.checkPolicies(action, input, context)` resolves to the decision the call would reach, `{ allowed,
// breakdown }`, and changes nothing; `Mesh.can` is its `allowed === true`. A domain with every kind of check (`authorize-if`,
// `forbid-if`, `when`; reading only the caller and the input, or reading the record), unknown results, policies that
// call helpers which read or write through an entity (directly, or through a binding's `run` or `transaction`, the
// question's own or a second one), a step and an application transaction that ask, reads covered and not, built,
// generated, pushed to SQLite and asked through the generated entity values. Every answer is held against the call
// itself: a denial's breakdown deep-equals the `ForbiddenError`'s.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { ForbiddenError, FrameworkError, InvalidInputError, Mesh, NotFoundError, type DataLayer, type Decision, type PolicyCheck } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const doc = `import { Audit } from "./audit.mesh.mx"
import { askInStep, escapes, logs, ownsAny, quietlyLogs, sawAt, seen } from "./doc-helpers"

entity :Doc table="docs"
  attributes
    uuid :id primary-key
    string :ownerId
    string :title
    integer :level nullable
    boolean :locked default=false
    timestamp :insertedAt on=:create
  actions auto=[:read]
    create :draft
      input
        &ownerId
        &title
        &level
      validate
        check :titled that=({ input }) => seen("validate") && input.title.length > 0 code="titled" message="a title is required"
      do
        run() {
          seen("step")
        }
    create :sketch
      input
        &ownerId
        &title
    update :edit
      input
        &title
      validate
        check :titled that=({ input }) => seen("validate") && input.title.length > 0 code="titled" message="a title is required"
      do
        run() {
          seen("step")
        }
    update :raise
    update :lower
    update :stamp
    update :hand
      input
        &ownerId
      do
        run [after=:write] ({ self }) {
          await askInStep(self.id, self.ownerId)
        }
    update :peek
    update :poke
    update :prod
    update :timed
    update :orphan
    update :crash
    update :nudge
    destroy :remove
    read :everything
  policies
    policy :writers actions=[&draft]
      authorize-if=({ actor }) => actor.id !== null
      forbid-if=({ actor }) => actor.id === "blocked"
    policy :trial actions=[&draft] when=({ input }) => input.level === null
      authorize-if=({ actor }) => actor.id === "alice"
    policy :sketchers actions=[&sketch] when=({ input }) => input.title !== "nope"
      authorize-if=() => true
      forbid-if=({ actor }) => actor.id === "mallory"
    policy :owner actions=[&edit, &remove]
      authorize-if=({ actor }) => &ownerId === actor.id
    policy :blocklist actions=[&edit]
      forbid-if=({ actor }) => actor.id === "blocked"
    policy :frozen actions=[&edit]
      forbid-if=() => &locked
    policy :leveled actions=[&raise] when=() => &level > 0
      authorize-if=({ actor }) => actor.id === "admin"
    policy :unsure actions=[&lower]
      authorize-if=() => &level > 3
      forbid-if=() => &level < 1
    policy :stampers actions=[&stamp]
      authorize-if=({ actor }) => actor.id === "alice"
    policy :handers actions=[&hand]
      authorize-if=() => true
    policy :viaHelper actions=[&peek]
      authorize-if=async ({ actor }) => await ownsAny(actor.id)
    policy :viaWriter actions=[&poke]
      authorize-if=async ({ actor }) => await logs(actor.id)
    policy :viaQuietWriter actions=[&prod]
      authorize-if=async ({ actor }) => await quietlyLogs(actor.id)
    policy :clocked actions=[&timed]
      authorize-if=async () => sawAt(%.now)
    policy :viaEscape actions=[&nudge]
      authorize-if=async () => await escapes()
    policy :crashy actions=[&crash]
      authorize-if=() => &level > 0
      forbid-if=({ actor }) => actor.id.length > 10
    policy :readers actions=[&read]
      authorize-if=({ actor }) => actor.id !== null
    policy :hidden actions=[&everything] when=({ actor }) => actor.id === "admin"
      authorize-if=() => true
`;

const audit = `import { Mesh } from "meshfw"
import { seen } from "./doc-helpers"

entity :Audit table="audits"
  attributes
    uuid :id primary-key
    string :what
  actions auto=[:read]
    create :log
      input
        &what
      validate
        check :said that=({ input }) => seen("Audit validate") && input.what.length > 0 code="said" message="say what happened"
      do
        run() {
          seen("Audit step")
        }
        run [after=:write] () {
          seen("Audit after write")
        }
  policies
    policy :internal actions=[&log]
      authorize-if=({ context }) => Mesh.isSystem(context)
    policy :readers types=[:read]
      authorize-if=() => true
`;

/** No policy at all: every action is denied. */
const loose = `entity :Loose table="loose"
  attributes
    uuid :id primary-key
    string :text
  actions auto=[:read]
    create :add
      input
        &text
`;

/**
 * The helpers the policies, checks and steps call. `seen` logs what ran, so a test can tell that no check of `validate`
 * and no step ran (Doc's or Audit's); `ownsAny` reads through an entity value, `logs` writes through one (and
 * `quietlyLogs` swallows what that throws), `sawAt` keeps the instant a policy read, `askInStep`, called by a step after
 * the write, asks, and `escapes` runs what a test puts in `hooks.escape` (a call through a binding's `run` or
 * `transaction`), keeping what it gave and catching what it threw.
 */
const helpers = `import { Mesh, type Decision } from "@meshfw/runtime";
import { Audit, Doc } from "../../.mesh/domain/index.ts";

export const log: string[] = [];
export function seen(what: string): boolean {
  log.push(what);
  return true;
}
const as = (id: string | undefined) => ({ actor: id === undefined ? {} : { id } });
export async function ownsAny(id: string | undefined): Promise<boolean> {
  return (await Doc.read({ filter: { ownerId: { eq: id ?? "" } } }, as(id))).length > 0;
}
export async function logs(id: string | undefined): Promise<boolean> {
  await Audit.log({ what: \`poked by \${id}\` }, { ...as(id), system: true });
  return true;
}
export async function quietlyLogs(id: string | undefined): Promise<boolean> {
  try {
    await logs(id);
  } catch {
    // A policy that catches what its write threw still cannot be checked.
  }
  return true;
}
export const instants: Date[] = [];
export function sawAt(at: Date): boolean {
  instants.push(at);
  return true;
}
export const hooks: { escape: () => Promise<unknown>; results: unknown[]; caught: unknown[] } = { escape: async () => undefined, results: [], caught: [] };
export async function escapes(): Promise<boolean> {
  try {
    hooks.results.push(await hooks.escape());
  } catch (error) {
    hooks.caught.push(error);
  }
  return true;
}
export const answers: Decision[] = [];
export async function askInStep(id: string, owner: string): Promise<void> {
  answers.push(await Mesh.checkPolicies(Doc.edit, { id, title: "by the new owner" }, as(owner)));
  answers.push(await Mesh.checkPolicies(Doc.edit, { id, title: "by the old owner" }, as("alice")));
}
`;

/** Application code the types are checked on: the input is the action's own, and the context is required. */
const typed = `import { Mesh, type Decision } from "@meshfw/runtime";
import { Doc, Loose } from "./.mesh/domain/index.ts";

const alice = { actor: { id: "alice" } };
export async function typed(): Promise<readonly unknown[]> {
  const decision: Decision = await Mesh.checkPolicies(Doc.edit, { id: "x", title: "t" }, alice);
  const allowed: boolean = decision.allowed;
  const first: string | undefined = decision.breakdown[0]?.policy;
  return [
    allowed,
    first,
    await Mesh.can(Doc.read, {}, alice),
    await Mesh.can(Doc.read, { filter: { ownerId: { eq: "alice" } }, limit: 1 }, alice),
    await Mesh.can(Loose.add, { text: "x" }, alice),
    await Mesh.can(Doc.remove, { id: "x" }, alice),
    // @ts-expect-error the input is the action's own: the title is a string
    await Mesh.can(Doc.edit, { id: "x", title: 5 }, alice),
    // @ts-expect-error a member the action does not take is refused, as on the call
    await Mesh.checkPolicies(Doc.edit, { id: "x", title: "t", ownerId: "bob" }, alice),
    // @ts-expect-error the key is required
    await Mesh.can(Doc.edit, { title: "t" }, alice),
    // @ts-expect-error another action's input
    await Mesh.checkPolicies(Doc.edit, { text: "x" }, alice),
    // @ts-expect-error the context is required
    await Mesh.can(Doc.edit, { id: "x", title: "t" }),
    // @ts-expect-error the action comes first, then its input
    await Mesh.can({ id: "x", title: "t" }, Doc.edit, alice),
  ];
}
`;

const SOURCES = { doc, audit, loose };

/**
 * `Mesh.checkPolicies` and `Mesh.can`, untyped: this file takes the generated project untyped, as `policies.test.ts` does.
 * Their types are checked on `typed.ts`, application code over the generated tree.
 */
const checkPolicies = Mesh.checkPolicies as (action: unknown, input: unknown, context: unknown) => Promise<Decision>;
const can = Mesh.can as (action: unknown, input: unknown, context: unknown) => Promise<boolean>;

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};

let dir: string;
let app: any;
let domain: any;
let helperModule: any;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".check-policies-"));
  await Bun.write(join(dir, "src/domain/doc-helpers.ts"), helpers);
  await Bun.write(join(dir, "typed.ts"), typed);
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(SOURCES).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  // `binding.ts` imports the project's config, which is not part of this fixture.
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  // The project declares its actor (ADR-0059); `system` is Mesh's own key.
  await Bun.write(join(dir, "project-context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor?: { id?: string };\n  }\n}\nexport {};\n');
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
  helperModule = await import(join(dir, "src/domain/doc-helpers.ts"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const alice = { actor: { id: "alice" } };
const bob = { actor: { id: "bob" } };
const carol = { actor: { id: "carol" } };
const admin = { actor: { id: "admin" } };
const blocked = { actor: { id: "blocked" } };
/** A caller with no actor id. */
const anonymous = { actor: {} };

const ids = {
  plain: "00000000-0000-4000-8000-000000000001",
  locked: "00000000-0000-4000-8000-000000000002",
  zero: "00000000-0000-4000-8000-000000000003",
  bobs: "00000000-0000-4000-8000-000000000004",
  missing: "00000000-0000-4000-8000-0000000000ff",
};

/**
 * What every seam was called with, how many transactions were opened on the layer, and what each transaction callback
 * handed the layer: what it resolved with, or rejected with.
 */
interface World {
  db: ReturnType<typeof sqlite>;
  binding: any;
  seams: string[];
  counts: { transactions: number };
  handed: unknown[];
}

/**
 * A fresh database with four docs (Alice's plain one with no level, her locked one at level 5, her one at level 0, and
 * Bob's at level 2), bound with spies on all three seams and a layer that counts the transactions opened on it.
 */
async function fresh(clock?: () => Date): Promise<World> {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  const at = new Date(Date.UTC(2026, 0, 1));
  await db.transaction(async (tx) => {
    await tx.insert(app.tables.docs, { id: ids.plain, ownerId: "alice", title: "plain", level: null, locked: false, insertedAt: at });
    await tx.insert(app.tables.docs, { id: ids.locked, ownerId: "alice", title: "locked", level: 5, locked: true, insertedAt: at });
    await tx.insert(app.tables.docs, { id: ids.zero, ownerId: "alice", title: "zero", level: 0, locked: false, insertedAt: at });
    await tx.insert(app.tables.docs, { id: ids.bobs, ownerId: "bob", title: "bob's", level: 2, locked: false, insertedAt: at });
  });
  const counts = { transactions: 0 };
  const handed: unknown[] = [];
  const counted: DataLayer = {
    transaction: (run) => {
      counts.transactions += 1;
      return db.transaction(async (tx) => {
        try {
          const value = await run(tx);
          handed.push(value);
          return value;
        } catch (error) {
          handed.push(error);
          throw error;
        }
      });
    },
    refuseIfFailed: () => db.refuseIfFailed(),
    close: () => db.close(),
  };
  const seams: string[] = [];
  const binding = app.bind(counted, { ...(clock ? { clock } : {}), seams: spies(seams) });
  return { db, binding, seams, counts, handed };
}

/** Seams that write down each call in `seams`. */
function spies(seams: string[]) {
  return {
    beforeTransaction: (event: { action: string }) => { seams.push(`beforeTransaction ${event.action}`); },
    afterWrite: (_db: unknown, event: { action: string }) => { seams.push(`afterWrite ${event.action}`); },
    afterCommit: (event: { changes: unknown[] }) => { seams.push(`afterCommit ${event.changes.length}`); },
  };
}

/** A second binding of the project over the same database, with seams of its own: what `app.bind(layer, { seams })` gives. */
function secondOf(world: World): { binding: any; seams: string[] } {
  const seams: string[] = [];
  return { binding: app.bind(world.db, { seams: spies(seams) }), seams };
}

/** Every row of every table, read on the database itself. */
async function dump(db: DataLayer): Promise<unknown> {
  return db.transaction(async (tx) => Object.fromEntries(await Promise.all(Object.entries(app.tables).map(async ([name, table]) => [name, await tx.select(table as object)]))));
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
const outcome = (work: Promise<unknown>): Promise<Outcome> => work.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

/** An entry of a breakdown. */
const entry = (policy: string, kind: PolicyCheck["kind"], check: string, result: boolean | null, decisive: boolean): PolicyCheck =>
  ({ policy, kind, check, result, decisive });

/**
 * Ask, then hold the answer against the call: the question changes nothing (no row, no seam, no check of `validate`, no
 * step); `can` is `allowed === true`; and the call, made after it on the same data, is denied exactly when the answer
 * is no, with the same breakdown, or throws the same error before its policies decide. `expected` is what the question
 * gives: a decision, or the class of the error the call and the question throw; `transactions` is how many the question
 * opens on the layer (each rolled back).
 */
async function compare(world: World, action: (entity: any) => Function, input: unknown, context: unknown, transactions: number, expected: Decision | (new (...args: never[]) => Error)): Promise<void> {
  const fn = action(domain);
  const before = await dump(world.db);
  helperModule.log.length = 0;
  world.seams.length = 0;
  const opened = world.counts.transactions;
  const asked = await outcome(world.binding.run(() => checkPolicies(fn as never, input as never, context as never)));
  expect(world.counts.transactions - opened).toBe(transactions);
  const yes = await outcome(world.binding.run(() => can(fn as never, input as never, context as never)));
  // `can` asks the same question, the same way.
  expect(world.counts.transactions - opened).toBe(2 * transactions);
  expect(await dump(world.db)).toEqual(before);
  expect(world.seams).toEqual([]);
  expect(helperModule.log).toEqual([]);
  const called = await outcome(world.binding.run(() => fn(input, context)));
  world.seams.length = 0;
  helperModule.log.length = 0;
  if (typeof expected === "function") {
    expect(asked.ok).toBe(false);
    const error = (asked as { error: Error }).error;
    expect(error).toBeInstanceOf(expected);
    expect(called.ok).toBe(false);
    expect((called as { error: unknown }).error).toBeInstanceOf(expected);
    expect(error.message).toBe(((called as { error: Error }).error).message);
    expect(yes).toEqual(asked);
    return;
  }
  if (!asked.ok) throw asked.error;
  const decision = asked.value as Decision;
  expect(decision).toEqual(expected);
  expect(Object.isFrozen(decision) && Object.isFrozen(decision.breakdown) && decision.breakdown.every((check) => Object.isFrozen(check))).toBe(true);
  expect(yes).toEqual({ ok: true, value: decision.allowed === true });
  const forbidden = !called.ok && called.error instanceof ForbiddenError ? called.error : undefined;
  if (decision.allowed) expect(forbidden).toBeUndefined();
  else if (forbidden) expect(decision.breakdown).toEqual(forbidden.breakdown);
  else {
    // A read the policies do not admit gives no rows rather than an error (ADR-0022).
    expect(called).toEqual({ ok: true, value: [] });
  }
}

const allowed = (...breakdown: PolicyCheck[]): Decision => ({ allowed: true, breakdown });
const denied = (...breakdown: PolicyCheck[]): Decision => ({ allowed: false, breakdown });

const WRITERS_AUTHORIZE = "({ actor }) => actor.id !== null";
const WRITERS_FORBID = "({ actor }) => actor.id === \"blocked\"";
const TRIAL = "({ actor }) => actor.id === \"alice\"";
const OWNER = "({ actor }) => &ownerId === actor.id";
const BLOCKLIST = "({ actor }) => actor.id === \"blocked\"";

test("the generated tree and application code that asks type-check under the strictest flags: the input is the action's own", async () => {
  const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
  const child = Bun.spawnSync([
    resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
    "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "project-context.ts", "typed.ts", ...files,
  ], { cwd: dir });
  expect(child.stdout.toString() + child.stderr.toString()).toBe("");
}, 60_000);

describe("checks that read only the caller and the input: decided before any transaction", () => {
  test("authorize-if and forbid-if, allowed and denied, as the call decides", async () => {
    const world = await fresh();
    try {
      // In an allowed answer, the authorize-if checks that held are decisive; a forbid-if that held back nothing is not.
      await compare(world, (d) => d.Doc.draft, { ownerId: "alice", title: "new", level: null }, alice, 0, allowed(
        entry("writers", "authorize-if", WRITERS_AUTHORIZE, true, true),
        entry("writers", "forbid-if", WRITERS_FORBID, false, false),
        entry("trial", "authorize-if", TRIAL, true, true),
      ));
      await compare(world, (d) => d.Doc.draft, { ownerId: "bob", title: "new", level: null }, bob, 0, denied(
        entry("writers", "authorize-if", WRITERS_AUTHORIZE, true, false),
        entry("writers", "forbid-if", WRITERS_FORBID, false, false),
        entry("trial", "authorize-if", TRIAL, false, true),
      ));
      // A forbid-if that holds; trial's `when` is false (a level is given), so trial does not apply and is not listed.
      await compare(world, (d) => d.Doc.draft, { ownerId: "x", title: "new", level: 1 }, blocked, 0, denied(
        entry("writers", "authorize-if", WRITERS_AUTHORIZE, true, false),
        entry("writers", "forbid-if", WRITERS_FORBID, true, true),
      ));
      // No actor id: the authorize-if is false and the forbid-if unknown, which forbids (POL-04) and is what decides.
      await compare(world, (d) => d.Doc.draft, { ownerId: "x", title: "new", level: 1 }, anonymous, 0, denied(
        entry("writers", "authorize-if", WRITERS_AUTHORIZE, false, false),
        entry("writers", "forbid-if", WRITERS_FORBID, null, true),
      ));
    } finally { await world.db.close(); }
  });

  test("a when that is false for every covering policy denies the call; an unknown forbid-if denies it", async () => {
    const world = await fresh();
    try {
      await compare(world, (d) => d.Doc.sketch, { ownerId: "alice", title: "nope" }, alice, 0,
        denied(entry("sketchers", "when", "({ input }) => input.title !== \"nope\"", false, true)));
      await compare(world, (d) => d.Doc.sketch, { ownerId: "alice", title: "fine" }, alice, 0, allowed(
        entry("sketchers", "authorize-if", "() => true", true, true),
        entry("sketchers", "forbid-if", "({ actor }) => actor.id === \"mallory\"", false, false),
      ));
      // `actor.id` is missing, so the forbid-if is unknown, which forbids (POL-04).
      await compare(world, (d) => d.Doc.sketch, { ownerId: "alice", title: "fine" }, anonymous, 0, denied(
        entry("sketchers", "authorize-if", "() => true", true, false),
        entry("sketchers", "forbid-if", "({ actor }) => actor.id === \"mallory\"", null, true),
      ));
    } finally { await world.db.close(); }
  });

  test("an action no policy covers is denied with an empty breakdown", async () => {
    const world = await fresh();
    try {
      await compare(world, (d) => d.Doc.orphan, { id: ids.plain }, alice, 0, denied());
      await compare(world, (d) => d.Loose.add, { text: "x" }, alice, 0, denied());
    } finally { await world.db.close(); }
  });

  test("a missing row is not read when every check reads only the caller: the question answers before the call reads it", async () => {
    const world = await fresh();
    try {
      // The call decides, then reads the row and throws NotFoundError; the question stops at the decision.
      const decision = await world.binding.run(() => checkPolicies(domain.Doc.stamp, { id: ids.missing }, alice));
      expect(decision).toEqual(allowed(entry("stampers", "authorize-if", TRIAL, true, true)));
      expect(world.counts.transactions).toBe(0);
      expect(await world.binding.run(() => can(domain.Doc.stamp, { id: ids.missing }, alice))).toBe(true);
      expect(await outcome(world.binding.run(() => domain.Doc.stamp({ id: ids.missing }, alice)))).toEqual({ ok: false, error: expect.any(NotFoundError) });
      await compare(world, (d) => d.Doc.stamp, { id: ids.missing }, bob, 0, denied(entry("stampers", "authorize-if", TRIAL, false, true)));
    } finally { await world.db.close(); }
  });
});

describe("checks that read the record: decided on the stored row, in a transaction that is rolled back", () => {
  test("authorize-if and forbid-if on the row, allowed and denied, as the call decides", async () => {
    const world = await fresh();
    try {
      // A policy with no authorize-if passes by its forbid-if checks, all false: those are decisive.
      await compare(world, (d) => d.Doc.edit, { id: ids.plain, title: "renamed" }, alice, 1, allowed(
        entry("owner", "authorize-if", OWNER, true, true),
        entry("blocklist", "forbid-if", BLOCKLIST, false, true),
        entry("frozen", "forbid-if", "() => &locked", false, true),
      ));
      await compare(world, (d) => d.Doc.edit, { id: ids.plain, title: "renamed" }, bob, 1, denied(
        entry("owner", "authorize-if", OWNER, false, true),
        entry("blocklist", "forbid-if", BLOCKLIST, false, false),
        entry("frozen", "forbid-if", "() => &locked", false, false),
      ));
      await compare(world, (d) => d.Doc.edit, { id: ids.locked, title: "renamed" }, alice, 1, denied(
        entry("owner", "authorize-if", OWNER, true, false),
        entry("blocklist", "forbid-if", BLOCKLIST, false, false),
        entry("frozen", "forbid-if", "() => &locked", true, true),
      ));
      // The caller-only forbid-if denies before the transaction, so no check that reads the row runs.
      await compare(world, (d) => d.Doc.edit, { id: ids.plain, title: "renamed" }, blocked, 0, denied(entry("blocklist", "forbid-if", BLOCKLIST, true, true)));
      await compare(world, (d) => d.Doc.remove, { id: ids.plain }, bob, 1, denied(entry("owner", "authorize-if", OWNER, false, true)));
      await compare(world, (d) => d.Doc.remove, { id: ids.plain }, alice, 1, allowed(entry("owner", "authorize-if", OWNER, true, true)));
    } finally { await world.db.close(); }
  });

  test("a when on the row: false for every covering policy, unknown, and true", async () => {
    const world = await fresh();
    try {
      const when = "() => &level > 0";
      const admins = "({ actor }) => actor.id === \"admin\"";
      await compare(world, (d) => d.Doc.raise, { id: ids.zero }, admin, 1, denied(entry("leveled", "when", when, false, true)));
      // An unknown when applies the policy and denies; the authorize-if, which reads only the caller, ran before it.
      await compare(world, (d) => d.Doc.raise, { id: ids.plain }, admin, 1, denied(entry("leveled", "when", when, null, true), entry("leveled", "authorize-if", admins, true, false)));
      await compare(world, (d) => d.Doc.raise, { id: ids.locked }, admin, 1, allowed(entry("leveled", "authorize-if", admins, true, true)));
      await compare(world, (d) => d.Doc.raise, { id: ids.locked }, bob, 1, denied(entry("leveled", "authorize-if", admins, false, true)));
    } finally { await world.db.close(); }
  });

  test("unknown results fail closed exactly as the call does", async () => {
    const world = await fresh();
    try {
      const above = "() => &level > 3";
      const below = "() => &level < 1";
      // No level: both checks are unknown; the unknown forbid-if forbids and the unknown authorize-if does not authorize.
      await compare(world, (d) => d.Doc.lower, { id: ids.plain }, alice, 1, denied(entry("unsure", "authorize-if", above, null, false), entry("unsure", "forbid-if", below, null, true)));
      await compare(world, (d) => d.Doc.lower, { id: ids.zero }, alice, 1, denied(entry("unsure", "authorize-if", above, false, false), entry("unsure", "forbid-if", below, true, true)));
      await compare(world, (d) => d.Doc.lower, { id: ids.locked }, alice, 1, allowed(entry("unsure", "authorize-if", above, true, true), entry("unsure", "forbid-if", below, false, false)));
    } finally { await world.db.close(); }
  });

  test("the question opens one transaction and rolls it back; the call it asks about runs neither validate nor its steps", async () => {
    const world = await fresh();
    try {
      // The call itself fails `validate` (an empty title) after its policies allowed it: the question says allowed.
      await compare(world, (d) => d.Doc.edit, { id: ids.plain, title: "" }, alice, 1, allowed(
        entry("owner", "authorize-if", OWNER, true, true),
        entry("blocklist", "forbid-if", BLOCKLIST, false, true),
        entry("frozen", "forbid-if", "() => &locked", false, true),
      ));
      // The call, made on the same input, opens its transaction, runs the seam before it and the check of validate, which fails.
      helperModule.log.length = 0;
      expect(await outcome(world.binding.run(() => domain.Doc.edit({ id: ids.plain, title: "" }, alice)))).toEqual({ ok: false, error: expect.any(InvalidInputError) });
      expect(world.seams).toEqual(["beforeTransaction edit"]);
      expect(helperModule.log).toEqual(["validate"]);
    } finally { await world.db.close(); }
  });
});

describe("where the call throws before its policies decide, the question throws the same error", () => {
  test("an input that fails the cast is InvalidInputError, and a row the checks would read that is missing is NotFoundError", async () => {
    const world = await fresh();
    try {
      await compare(world, (d) => d.Doc.edit, { id: ids.plain, title: 5 }, alice, 0, InvalidInputError);
      await compare(world, (d) => d.Doc.edit, { id: ids.plain, title: "x", ownerId: "bob" }, alice, 0, InvalidInputError);
      await compare(world, (d) => d.Doc.draft, { ownerId: "alice", title: "x", level: "high" }, alice, 0, InvalidInputError);
      await compare(world, (d) => d.Doc.edit, { id: ids.missing, title: "x" }, alice, 1, NotFoundError);
      await compare(world, (d) => d.Doc.read, { limit: -1 }, alice, 0, InvalidInputError);
      // A check that throws (`length` of a missing actor id) throws from the question as from the call.
      await compare(world, (d) => d.Doc.crash, { id: ids.plain }, anonymous, 0, FrameworkError);
    } finally { await world.db.close(); }
  });

  test("a denial is never thrown: the question resolves with allowed false", async () => {
    const world = await fresh();
    try {
      const answer = await outcome(world.binding.run(() => checkPolicies(domain.Doc.edit, { id: ids.plain, title: "x" }, bob)));
      expect(answer.ok).toBe(true);
    } finally { await world.db.close(); }
  });
});

describe("reads: whether the read is allowed at all", () => {
  test("a read its policies admit, one they do not admit (no rows, not an error), one whose when is false, and one no policy covers", async () => {
    const world = await fresh();
    try {
      await compare(world, (d) => d.Doc.read, {}, alice, 0, allowed(entry("readers", "authorize-if", WRITERS_AUTHORIZE, true, true)));
      await compare(world, (d) => d.Doc.read, { filter: { ownerId: { eq: "nobody" } } }, alice, 0, allowed(entry("readers", "authorize-if", WRITERS_AUTHORIZE, true, true)));
      await compare(world, (d) => d.Doc.read, {}, anonymous, 0, denied(entry("readers", "authorize-if", WRITERS_AUTHORIZE, false, true)));
      await compare(world, (d) => d.Doc.everything, {}, admin, 0, allowed(entry("hidden", "authorize-if", "() => true", true, true)));
      await compare(world, (d) => d.Doc.everything, {}, alice, 0, denied(entry("hidden", "when", "({ actor }) => actor.id === \"admin\"", false, true)));
      // Deny by default: a read no policy covers is forbidden, and the question says no with nothing in the breakdown.
      await compare(world, (d) => d.Loose.read, {}, alice, 0, denied());
    } finally { await world.db.close(); }
  });
});

describe("inside a running transaction the question joins it, reads its instant and sees what it wrote", () => {
  test("inside transaction(fn): an uncommitted row is checked, and an error the question throws does not fail the transaction", async () => {
    let reads = 0;
    const world = await fresh(() => new Date(Date.UTC(2026, 5, 1) + 1_000 * ++reads));
    try {
      const { draft, decisions, missing, at } = await world.binding.transaction(async () => {
        const draft = await domain.Doc.draft({ ownerId: "carol", title: "uncommitted", level: 1 }, carol);
        const decisions = [
          await checkPolicies(domain.Doc.edit, { id: draft.id, title: "x" }, carol),
          await checkPolicies(domain.Doc.edit, { id: draft.id, title: "x" }, bob),
          await can(domain.Doc.peek, { id: ids.plain }, carol),
        ];
        const missing = await outcome(checkPolicies(domain.Doc.edit, { id: ids.missing, title: "x" }, alice));
        const invalid = await outcome(checkPolicies(domain.Doc.edit, { id: ids.plain, title: 5 }, alice));
        expect(invalid).toEqual({ ok: false, error: expect.any(InvalidInputError) });
        const thrown = await outcome(checkPolicies(domain.Doc.crash, { id: ids.plain }, anonymous));
        expect(thrown).toEqual({ ok: false, error: expect.any(FrameworkError) });
        helperModule.instants.length = 0;
        await checkPolicies(domain.Doc.timed, { id: ids.plain }, alice);
        return { draft, decisions, missing, at: helperModule.instants[0] };
      });
      expect(decisions).toEqual([
        allowed(entry("owner", "authorize-if", OWNER, true, true), entry("blocklist", "forbid-if", BLOCKLIST, false, true), entry("frozen", "forbid-if", "() => &locked", false, true)),
        denied(entry("owner", "authorize-if", OWNER, false, true), entry("blocklist", "forbid-if", BLOCKLIST, false, false), entry("frozen", "forbid-if", "() => &locked", false, false)),
        // Carol owns the uncommitted doc: the policy's helper reads through an entity and sees it.
        true,
      ]);
      expect(missing).toEqual({ ok: false, error: expect.any(NotFoundError) });
      // The question read the transaction's instant, the one the draft was stamped with.
      expect(at).toEqual(draft.insertedAt);
      // Neither error failed the transaction: it committed the draft, and the seams ran for the draft alone.
      expect((await dump(world.db) as { docs: unknown[] }).docs).toHaveLength(5);
      expect(world.seams).toEqual(["afterWrite draft", "afterCommit 1"]);
      // Outside a transaction the question reads an instant of its own.
      helperModule.instants.length = 0;
      await world.binding.run(() => checkPolicies(domain.Doc.timed, { id: ids.plain }, alice));
      expect(helperModule.instants[0].getTime()).toBeGreaterThan(draft.insertedAt.getTime());
    } finally { await world.db.close(); }
  });

  test("inside a step: the question joins the action's transaction and sees the row the action has just written", async () => {
    const world = await fresh();
    try {
      helperModule.answers.length = 0;
      const handed = await world.binding.run(() => domain.Doc.hand({ id: ids.plain, ownerId: "bob" }, alice));
      expect(handed.ownerId).toBe("bob");
      expect(helperModule.answers.map((answer: Decision) => answer.allowed)).toEqual([true, false]);
      expect(helperModule.answers[1].breakdown).toEqual([
        entry("owner", "authorize-if", OWNER, false, true), entry("blocklist", "forbid-if", BLOCKLIST, false, false), entry("frozen", "forbid-if", "() => &locked", false, false),
      ]);
      expect(world.seams).toEqual(["beforeTransaction hand", "afterWrite hand", "afterCommit 1"]);
    } finally { await world.db.close(); }
  });
});

describe("a policy whose helper calls an entity", () => {
  test("a nested read runs on the question's transaction and gives what it gives the call", async () => {
    const world = await fresh();
    try {
      const helper = "async ({ actor }) => await ownsAny(actor.id)";
      // The layer counts every transaction() made on it, joins included: the question's own (rolled back), and the two
      // the nested read makes to join it; the call makes the same three.
      await compare(world, (d) => d.Doc.peek, { id: ids.plain }, alice, 3, allowed(entry("viaHelper", "authorize-if", helper, true, true)));
      await compare(world, (d) => d.Doc.peek, { id: ids.plain }, carol, 3, denied(entry("viaHelper", "authorize-if", helper, false, true)));
    } finally { await world.db.close(); }
  });

  test("a nested write throws a FrameworkError naming both actions, writes nothing and runs no seam, even when the helper catches it", async () => {
    const world = await fresh();
    try {
      const before = await dump(world.db);
      for (const action of ["poke", "prod"]) {
        const asked = await outcome(world.binding.run(() => checkPolicies(domain.Doc[action], { id: ids.plain }, alice)));
        expect(asked.ok).toBe(false);
        const error = (asked as { error: Error }).error;
        expect(error).toBeInstanceOf(FrameworkError);
        expect(error.message).toStartWith(`Mesh.checkPolicies(Doc#${action}) cannot answer without writing: Audit#log, called while its policies were checked, writes a row.`);
        // `Mesh.can` names itself in the same message.
        await expect(world.binding.run(() => can(domain.Doc[action], { id: ids.plain }, alice))).rejects.toThrow(error.message.replace("Mesh.checkPolicies(", "Mesh.can("));
      }
      expect(await dump(world.db)).toEqual(before);
      expect(world.seams).toEqual([]);
      // The write is refused before it starts: Audit#log casts nothing, and runs neither its check nor its steps.
      expect(helperModule.log).toEqual([]);
      // Inside a transaction the question throws too, and the transaction goes on and commits what it wrote.
      await world.binding.transaction(async () => {
        await expect(checkPolicies(domain.Doc.poke, { id: ids.plain }, alice)).rejects.toBeInstanceOf(FrameworkError);
        await domain.Doc.sketch({ ownerId: "alice", title: "after" }, alice);
      });
      expect((await dump(world.db) as { docs: unknown[]; audits: unknown[] }).docs).toHaveLength(5);
      expect((await dump(world.db) as { audits: unknown[] }).audits).toHaveLength(0);
      expect(helperModule.log).toEqual([]);
      // The call itself writes through its policy, as it always has, and runs what Audit#log runs.
      await world.binding.run(() => domain.Doc.poke({ id: ids.plain }, alice));
      expect((await dump(world.db) as { audits: unknown[] }).audits).toHaveLength(1);
      expect(helperModule.log).toEqual(["Audit validate", "Audit step", "Audit after write"]);
    } finally { await world.db.close(); }
  });
});

/**
 * Each way a policy's helper can reach a write besides calling it in place: through `run` or `transaction` of the
 * question's own binding, or of a second binding of the project (`app.bind(layer, { seams })`), which puts a scope of its
 * own in the project's async frame.
 */
const ROUTES: [string, (world: World, second: { binding: any }, call: () => Promise<unknown>) => Promise<unknown>][] = [
  ["the question's binding's run", (world, _second, call) => world.binding.run(call)],
  ["the question's binding's transaction", (world, _second, call) => world.binding.transaction(call)],
  ["a second binding's run", (_world, second, call) => second.binding.run(call)],
  ["a second binding's transaction", (_world, second, call) => second.binding.transaction(call)],
];

describe("while a question is answered no write action starts, through any binding of the project", () => {
  const log = () => domain.Audit.log({ what: "escaped" }, { system: true });
  const nudge = (context: unknown) => checkPolicies(domain.Doc.nudge, { id: ids.plain }, context);
  const refusal = "Mesh.checkPolicies(Doc#nudge) cannot answer without writing: Audit#log, called while its policies were checked, writes a row.";

  for (const [route, through] of ROUTES)
    test(`a helper that writes through ${route}: refused before it starts, outside and inside transaction(fn); the call writes`, async () => {
      const world = await fresh();
      const second = secondOf(world);
      const { hooks } = helperModule;
      try {
        const before = await dump(world.db);
        hooks.escape = () => through(world, second, log);
        hooks.caught.length = 0;
        helperModule.log.length = 0;
        // Outside any transaction: the helper catches the refusal, and the question throws it all the same.
        const asked = await outcome(world.binding.run(() => nudge(alice)));
        expect(asked).toEqual({ ok: false, error: expect.any(FrameworkError) });
        const error = (asked as { error: Error }).error;
        expect(error.message).toStartWith(refusal);
        expect(hooks.caught).toEqual([error]);
        expect(await dump(world.db)).toEqual(before);
        expect(helperModule.log).toEqual([]);
        expect(world.seams).toEqual([]);
        expect(second.seams).toEqual([]);
        // Inside the application's transaction: the refusal fails nothing, and the application's next call commits.
        hooks.caught.length = 0;
        await world.binding.transaction(async () => {
          await expect(nudge(alice)).rejects.toThrow(refusal);
          await domain.Doc.sketch({ ownerId: "alice", title: "after" }, alice);
        });
        expect(hooks.caught).toHaveLength(1);
        const after = await dump(world.db) as { docs: unknown[]; audits: unknown[] };
        expect(after.docs).toHaveLength(5);
        expect(after.audits).toEqual([]);
        expect(helperModule.log).toEqual([]);
        expect(world.seams).toEqual(["afterWrite sketch", "afterCommit 1"]);
        expect(second.seams).toEqual([]);
        // The call itself writes through the same route, as it always has: the route is real.
        world.seams.length = 0;
        await world.binding.run(() => domain.Doc.nudge({ id: ids.plain }, alice));
        expect((await dump(world.db) as { audits: unknown[] }).audits).toHaveLength(1);
        expect(helperModule.log).toEqual(["Audit validate", "Audit step", "Audit after write"]);
      } finally {
        hooks.escape = async () => undefined;
        await world.db.close();
      }
    });

  test("a read through the question's binding's run reads on the question's transaction; one through a second binding runs as it would", async () => {
    const world = await fresh();
    const second = secondOf(world);
    const { hooks } = helperModule;
    const carols = () => domain.Doc.read({ filter: { ownerId: { eq: "carol" } } }, carol);
    try {
      for (const [index, [route, through]] of ROUTES.entries()) {
        hooks.escape = () => through(world, second, carols);
        hooks.results.length = 0;
        hooks.caught.length = 0;
        const decisions = await world.binding.transaction(async () => {
          await domain.Doc.draft({ ownerId: "carol", title: "uncommitted", level: 1 }, carol);
          return [await nudge(carol), await can(domain.Doc.nudge, { id: ids.plain }, carol)];
        });
        expect([route, hooks.caught]).toEqual([route, []]);
        // Each read, the question's and can's, sees the row the transaction has not committed, and those committed before it.
        expect([route, hooks.results.map((rows: unknown) => (rows as unknown[]).length)]).toEqual([route, [index + 1, index + 1]]);
        expect(decisions).toEqual([allowed(entry("viaEscape", "authorize-if", "async () => await escapes()", true, true)), true]);
        expect(second.seams).toEqual([]);
      }
    } finally {
      hooks.escape = async () => undefined;
      await world.db.close();
    }
  });

  test("a read that fails inside transaction(fn), through any binding, fails nothing: the question answers and the application's next call commits", async () => {
    const world = await fresh();
    const second = secondOf(world);
    const { hooks } = helperModule;
    // A filter on an attribute Doc does not have: the read's cast fails with InvalidInputError.
    const bogus = { filter: { bogus: { eq: 1 } } };
    const reads: [string, () => Promise<unknown>][] = [
      ["the question's binding's run", () => world.binding.run(() => domain.Doc.read(bogus, carol))],
      ["a second binding's run", () => second.binding.run(() => domain.Doc.read(bogus, carol))],
      ["a second binding's transaction", () => second.binding.transaction(() => domain.Doc.read(bogus, carol))],
      ["a privileged read through a second binding", () => second.binding.run(() => (Mesh.privileged(domain.Doc as never) as { read: (input: unknown) => Promise<unknown> }).read(bogus))],
    ];
    try {
      for (const [index, [route, read]] of reads.entries()) {
        hooks.escape = read;
        hooks.caught.length = 0;
        world.seams.length = 0;
        const decision = await world.binding.transaction(async () => {
          await domain.Doc.draft({ ownerId: "carol", title: "uncommitted", level: 1 }, carol);
          const decision = await nudge(carol);
          await domain.Doc.sketch({ ownerId: "carol", title: "after" }, carol);
          return decision;
        });
        // The helper caught what the read threw, and the question answered what the policy decided.
        expect([route, hooks.caught]).toEqual([route, [expect.any(InvalidInputError)]]);
        expect([route, decision]).toEqual([route, allowed(entry("viaEscape", "authorize-if", "async () => await escapes()", true, true))]);
        // The transaction committed both rows, and its seams ran for both.
        expect([route, (await dump(world.db) as { docs: unknown[] }).docs.length]).toEqual([route, 4 + 2 * (index + 1)]);
        expect([route, world.seams]).toEqual([route, ["afterWrite draft", "afterWrite sketch", "afterCommit 2"]]);
        expect(second.seams).toEqual([]);
      }
    } finally {
      hooks.escape = async () => undefined;
      await world.db.close();
    }
  });

  test("the question's mark outlives its answer: a write a helper's timer starts after the question resolved is refused, and a call made at the same time is not", async () => {
    const world = await fresh();
    const { hooks } = helperModule;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let late: Promise<Outcome> | undefined;
    try {
      // The helper starts a timer that waits for the question to have answered, then writes.
      hooks.escape = async () => {
        late = new Promise((resolve) => setTimeout(async () => { await gate; resolve(await outcome(log())); }, 0));
      };
      hooks.caught.length = 0;
      helperModule.log.length = 0;
      const decision = await world.binding.run(() => nudge(alice));
      expect(decision).toEqual(allowed(entry("viaEscape", "authorize-if", "async () => await escapes()", true, true)));
      expect(hooks.caught).toEqual([]);
      // The question has answered; the timer's write and an application call start together.
      const real = world.binding.run(() => domain.Audit.log({ what: "real" }, { system: true }));
      release();
      const refused = await late!;
      expect((await real).what).toBe("real");
      expect(refused).toEqual({ ok: false, error: expect.any(FrameworkError) });
      expect(((refused as { error: Error }).error).message).toStartWith("Audit#log cannot write: it was started while Mesh.checkPolicies(Doc#nudge) was answered,");
      expect(((await dump(world.db)) as { audits: { what: string }[] }).audits.map((row) => row.what)).toEqual(["real"]);
      // Only the application's call ran Audit#log's check, steps and seams.
      expect(helperModule.log).toEqual(["Audit validate", "Audit step", "Audit after write"]);
      expect(world.seams).toEqual(["beforeTransaction log", "afterWrite log", "afterCommit 1"]);
    } finally {
      hooks.escape = async () => undefined;
      release();
      await world.db.close();
    }
  });

  test("once the question has answered, a read its helper left running joins the transaction it was made in while that transaction runs", async () => {
    const world = await fresh();
    const { hooks } = helperModule;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let late: Promise<Outcome> | undefined;
    try {
      hooks.escape = async () => { late = gate.then(() => outcome(domain.Doc.read({ filter: { ownerId: { eq: "carol" } } }, carol))); };
      const [decision, read] = await world.binding.transaction(async () => {
        await domain.Doc.draft({ ownerId: "carol", title: "uncommitted", level: 1 }, carol);
        const decision = await nudge(carol);
        release();
        const read = await late!;
        await domain.Doc.sketch({ ownerId: "carol", title: "after" }, carol);
        return [decision, read];
      });
      expect(decision).toEqual(allowed(entry("viaEscape", "authorize-if", "async () => await escapes()", true, true)));
      // The question's layers were dropped when it answered; the read made them again and joined the running transaction.
      expect(read).toEqual({ ok: true, value: [expect.objectContaining({ title: "uncommitted" })] });
      expect(((await dump(world.db)) as { docs: unknown[] }).docs).toHaveLength(6);
    } finally {
      hooks.escape = async () => undefined;
      release();
      await world.db.close();
    }
  });
});

describe("a question asked inside a question", () => {
  test("a policy's helper asks, in place and through a second binding: each inner answer is the one the call's helper gets, nothing is written and no seam runs, outside and inside transaction(fn)", async () => {
    const world = await fresh();
    const second = secondOf(world);
    const { hooks } = helperModule;
    const edit = { id: ids.plain, title: "asked inside" };
    /** What an inner answer is, comparable: a decision or a boolean as is, an error as its class and message. */
    const plain = (answer: unknown): unknown => {
      const settled = answer as Outcome;
      if (typeof answer !== "object" || answer === null || !("ok" in answer)) return answer;
      return settled.ok ? settled.value : { error: (settled.error as Error).constructor.name, message: (settled.error as Error).message };
    };
    // Every inner question the helper of Doc#nudge's policy asks: allowed, denied, one whose policy writes, two through a
    // second binding's run and transaction, and a can whose policy reads through an entity.
    hooks.escape = async () => [
      await checkPolicies(domain.Doc.edit, edit, alice),
      await checkPolicies(domain.Doc.edit, edit, bob),
      await outcome(checkPolicies(domain.Doc.poke, { id: ids.plain }, alice)),
      await second.binding.run(() => checkPolicies(domain.Doc.edit, edit, alice)),
      await second.binding.transaction(() => checkPolicies(domain.Doc.edit, edit, bob)),
      await can(domain.Doc.peek, { id: ids.plain }, carol),
    ];
    const NUDGE = allowed(entry("viaEscape", "authorize-if", "async () => await escapes()", true, true));
    try {
      for (const where of ["outside", "inside"]) {
        const inside = where === "inside";
        const draft = () => domain.Doc.draft({ ownerId: "carol", title: `uncommitted ${where}`, level: 1 }, carol);
        hooks.results.length = 0;
        hooks.caught.length = 0;
        helperModule.log.length = 0;
        world.seams.length = 0;
        const before = await dump(world.db) as { docs: unknown[]; audits: unknown[] };
        const decision = inside
          ? await world.binding.transaction(async () => {
            await draft();
            const decision = await checkPolicies(domain.Doc.nudge, { id: ids.plain }, carol);
            await domain.Doc.sketch({ ownerId: "carol", title: `after ${where}` }, carol);
            return decision;
          })
          : await world.binding.run(() => checkPolicies(domain.Doc.nudge, { id: ids.plain }, carol));
        expect([where, decision]).toEqual([where, NUDGE]);
        expect([where, hooks.caught]).toEqual([where, []]);
        const asked = (hooks.results[0] as unknown[]).map(plain);
        // The questions wrote nothing and ran no seam, no check and no step; inside, the transaction committed its own two rows.
        const after = await dump(world.db) as { docs: unknown[]; audits: unknown[] };
        expect([where, after.docs.length, after.audits]).toEqual([where, before.docs.length + (inside ? 2 : 0), []]);
        expect([where, world.seams, second.seams]).toEqual([where, inside ? ["afterWrite draft", "afterWrite sketch", "afterCommit 2"] : [], []]);
        // Inside, the draft ran its check and its step; nothing else did.
        expect([where, helperModule.log]).toEqual([where, inside ? ["validate", "step"] : []]);
        // The call itself, on the same data, runs the same helper, which asks the same questions.
        hooks.results.length = 0;
        await (inside
          ? world.binding.transaction(async () => {
            await draft();
            await domain.Doc.nudge({ id: ids.plain }, carol);
          })
          : world.binding.run(() => domain.Doc.nudge({ id: ids.plain }, carol)));
        const called = (hooks.results[0] as unknown[]).map(plain);
        expect([where, asked]).toEqual([where, called]);
        expect([where, asked]).toEqual([where, [
          allowed(entry("owner", "authorize-if", OWNER, true, true), entry("blocklist", "forbid-if", BLOCKLIST, false, true), entry("frozen", "forbid-if", "() => &locked", false, true)),
          denied(entry("owner", "authorize-if", OWNER, false, true), entry("blocklist", "forbid-if", BLOCKLIST, false, false), entry("frozen", "forbid-if", "() => &locked", false, false)),
          { error: "FrameworkError", message: expect.stringContaining("Mesh.checkPolicies(Doc#poke) cannot answer without writing: Audit#log, called while its policies were checked, writes a row.") },
          allowed(entry("owner", "authorize-if", OWNER, true, true), entry("blocklist", "forbid-if", BLOCKLIST, false, true), entry("frozen", "forbid-if", "() => &locked", false, true)),
          denied(entry("owner", "authorize-if", OWNER, false, true), entry("blocklist", "forbid-if", BLOCKLIST, false, false), entry("frozen", "forbid-if", "() => &locked", false, false)),
          // Carol owns a doc only inside the transaction, where her uncommitted draft is.
          inside,
        ]]);
        expect(second.seams).toEqual([]);
      }
      expect(((await dump(world.db)) as { audits: unknown[] }).audits).toEqual([]);
    } finally {
      hooks.escape = async () => undefined;
      await world.db.close();
    }
  });
});

describe("questions and calls at once, and a layer that fails", () => {
  const edit = (title: string) => ({ id: ids.plain, title });
  const ALICE_EDITS = allowed(entry("owner", "authorize-if", OWNER, true, true), entry("blocklist", "forbid-if", BLOCKLIST, false, true), entry("frozen", "forbid-if", "() => &locked", false, true));
  const BOB_EDITS = denied(entry("owner", "authorize-if", OWNER, false, true), entry("blocklist", "forbid-if", BLOCKLIST, false, false), entry("frozen", "forbid-if", "() => &locked", false, false));

  test("two questions, one whose policy writes, and a real call, in parallel on one binding: each gets its own answer, and only the call writes", async () => {
    const world = await fresh();
    try {
      helperModule.log.length = 0;
      const [mine, theirs, poked, edited] = await world.binding.run(() => Promise.all([
        checkPolicies(domain.Doc.edit, edit("asked"), alice),
        checkPolicies(domain.Doc.edit, edit("asked"), bob),
        outcome(checkPolicies(domain.Doc.poke, { id: ids.plain }, alice)),
        domain.Doc.edit(edit("parallel"), alice),
      ]));
      expect(mine).toEqual(ALICE_EDITS);
      expect(theirs).toEqual(BOB_EDITS);
      expect(poked).toEqual({ ok: false, error: expect.any(FrameworkError) });
      expect(edited.title).toBe("parallel");
      const after = await dump(world.db) as { docs: { id: string; title: string }[]; audits: unknown[] };
      expect(after.docs.find((doc) => doc.id === ids.plain)?.title).toBe("parallel");
      expect(after.audits).toEqual([]);
      // Only the call ran its check, its step and its seams; the refused write ran nothing.
      expect(helperModule.log).toEqual(["validate", "step"]);
      expect(world.seams).toEqual(["beforeTransaction edit", "afterWrite edit", "afterCommit 1"]);
    } finally { await world.db.close(); }
  });

  test("the same inside transaction(fn): the questions join it one at a time, and the refused write fails nothing", async () => {
    const world = await fresh();
    try {
      helperModule.log.length = 0;
      const [mine, theirs, poked, edited] = await world.binding.transaction(() => Promise.all([
        checkPolicies(domain.Doc.edit, edit("asked"), alice),
        checkPolicies(domain.Doc.edit, edit("asked"), bob),
        outcome(checkPolicies(domain.Doc.poke, { id: ids.plain }, alice)),
        domain.Doc.edit(edit("parallel"), alice),
      ]));
      expect(mine).toEqual(ALICE_EDITS);
      expect(theirs).toEqual(BOB_EDITS);
      expect(poked).toEqual({ ok: false, error: expect.any(FrameworkError) });
      expect(edited.title).toBe("parallel");
      const after = await dump(world.db) as { docs: { id: string; title: string }[]; audits: unknown[] };
      expect(after.docs.find((doc) => doc.id === ids.plain)?.title).toBe("parallel");
      expect(after.audits).toEqual([]);
      expect(helperModule.log).toEqual(["validate", "step"]);
      expect(world.seams).toEqual(["afterWrite edit", "afterCommit 1"]);
      // A question joined to the transaction hands the layer nothing: no answer, no outcome, and nothing it rejected with.
      expect(world.handed.filter((value) => value instanceof Error || (typeof value === "object" && value !== null && ("ok" in value || "decision" in value)))).toEqual([]);
    } finally { await world.db.close(); }
  });

  test("questions beside real writes on a second binding, outside and inside transaction(fn): each gets its own answer, and only the writes write", async () => {
    const world = await fresh();
    const second = secondOf(world);
    try {
      const asked = () => [
        checkPolicies(domain.Doc.edit, edit("asked"), alice),
        checkPolicies(domain.Doc.edit, edit("asked"), bob),
        outcome(checkPolicies(domain.Doc.poke, { id: ids.plain }, alice)),
      ];
      const scenarios: [string, (writes: () => Promise<unknown>) => Promise<unknown[]>, string[], string[]][] = [
        ["outside", (writes) => world.binding.run(() => Promise.all([...asked(), second.binding.run(writes)])),
          [], ["beforeTransaction edit", "afterWrite edit", "afterCommit 1", "beforeTransaction log", "afterWrite log", "afterCommit 1"]],
        ["inside", (writes) => world.binding.transaction(() => Promise.all([...asked(), second.binding.transaction(writes)])),
          ["afterCommit 2"], ["afterWrite edit", "afterWrite log"]],
      ];
      for (const [where, run, mine, theirs] of scenarios) {
        helperModule.log.length = 0;
        world.seams.length = 0;
        second.seams.length = 0;
        const [aliceEdits, bobEdits, poked, written] = await run(async () => {
          const edited = await domain.Doc.edit(edit(`parallel ${where}`), alice);
          await domain.Audit.log({ what: `logged ${where}` }, { system: true });
          return edited;
        });
        expect([where, aliceEdits, bobEdits]).toEqual([where, ALICE_EDITS, BOB_EDITS]);
        expect(poked).toEqual({ ok: false, error: expect.any(FrameworkError) });
        expect(((poked as { error: Error }).error).message).toStartWith("Mesh.checkPolicies(Doc#poke) cannot answer without writing: Audit#log");
        expect((written as { title: string }).title).toBe(`parallel ${where}`);
        const after = await dump(world.db) as { docs: { id: string; title: string }[]; audits: { what: string }[] };
        expect(after.docs.find((doc) => doc.id === ids.plain)?.title).toBe(`parallel ${where}`);
        expect(after.audits.map((row) => row.what).at(-1)).toBe(`logged ${where}`);
        // Only the second binding's calls ran their checks, steps and seams.
        expect([where, helperModule.log]).toEqual([where, ["validate", "step", "Audit validate", "Audit step", "Audit after write"]]);
        expect([where, world.seams, second.seams]).toEqual([where, mine, theirs]);
      }
      expect(((await dump(world.db)) as { audits: unknown[] }).audits).toHaveLength(2);
    } finally { await world.db.close(); }
  });

  test("a rollback that fails is not swallowed: the question throws what the layer threw", async () => {
    const world = await fresh();
    try {
      // A layer that rolls the transaction back, then rejects with an error of its own instead of what the callback threw.
      const failing: DataLayer = {
        transaction: async (run) => {
          try { return await world.db.transaction(run); }
          catch (cause) { throw new Error("the rollback failed", { cause }); }
        },
        refuseIfFailed: () => world.db.refuseIfFailed(),
        close: () => world.db.close(),
      };
      const binding = app.bind(failing, {});
      // A question its policies decide on the row opens a transaction of its own, and that transaction's end fails.
      const asked = await outcome(binding.run(() => checkPolicies(domain.Doc.edit, edit("x"), alice)));
      expect(asked).toEqual({ ok: false, error: expect.any(Error) });
      expect(((asked as { error: Error }).error).message).toBe("the rollback failed");
      // One its policies decide on the caller alone opens none, and answers.
      expect(await binding.run(() => can(domain.Doc.draft, { ownerId: "alice", title: "new", level: null }, alice))).toBe(true);
    } finally { await world.db.close(); }
  });
});

describe("what the question is asked about", () => {
  test("anything but an action function of an entity value throws a FrameworkError saying so, and nothing is added to the function", async () => {
    const world = await fresh();
    try {
      const given = "a function that is not one (a plain function, a Mesh.privileged read, a copy made with .bind, or an action of an entity value made by a "
        + "second copy of @meshfw/runtime in the install, which meshfw avoids by taking @meshfw/runtime as a peer dependency)";
      const values: [unknown, string][] = [
        [async (_input: unknown, _context: unknown) => undefined, given],
        [(Mesh.privileged(domain.Doc as never) as { read: unknown }).read, given],
        [domain.Doc.edit.bind(domain.Doc), given],
        [domain.Doc, "an object"],
      ];
      for (const [value, what] of values)
        for (const [member, ask] of [["checkPolicies", checkPolicies], ["can", can]] as const) {
          const asked = await outcome(world.binding.run(() => ask(value as never, { id: ids.plain }, alice)));
          expect(asked).toEqual({ ok: false, error: expect.any(FrameworkError) });
          expect(((asked as { error: Error }).error).message).toBe(`Mesh.${member}() takes an action function of an entity value, such as Mesh.${member}(Todo.complete, input, context), and was given ${what}`);
        }
      expect(Reflect.ownKeys(domain.Doc.edit).sort()).toEqual(["length", "name"]);
    } finally { await world.db.close(); }
  });

  test("outside run() and with nothing connected, it is not connected, as the call is", async () => {
    const asked = await outcome(checkPolicies(domain.Doc.edit, { id: ids.plain, title: "x" }, alice));
    expect(asked).toEqual({ ok: false, error: expect.any(FrameworkError) });
    expect(((asked as { error: Error }).error).message).toBe("Mesh.checkPolicies(Doc#edit) was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own");
  });
});
