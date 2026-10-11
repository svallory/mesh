// M8a: policies run, and an action no policy covers is denied. A domain with policies of every shape (actor-only,
// record-reading, through `tx`, `isSystem(context)`, unknown results), built, generated, pushed to SQLite and called
// through the generated functions. Lead rulings of M8a: where each check runs (ACT-28, POL-08), reads filtered, TXN-06
// as built, `system` as a reserved boolean, the error, deny by default.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { ForbiddenError, InvalidInputError, NotFoundError, type DataLayer, type Seams } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const board = `entity :Board table="boards"
  attributes
    uuid :id primary-key
    string :ownerId
    string :name
    boolean :locked default=false
  actions auto=[:read, :destroy]
    create :open
      input
        &ownerId
        &name
    update :rename
      input
        &name
      validate
        check :named that=({ input }) => input.name.length > 0 code="named" message="a name is required"
      do
        run({ actions, context }) {
          await actions.logAudit({ what: "rename" }, { ...context, system: true });
        }
    update :lock
      do
        set
          &locked=true
        run({ actions }) {
          await actions.logAudit({ what: "lock" });
        }
    update :freeze
      do
        set
          &locked=true
    update :give
      input
        &ownerId
  policies
    policy :signedIn types=[:create, :read]
      authorize-if=({ actor }) => actor.id !== null
    policy :quota actions=[&open]
      forbid-if=async ({ actor, tx }) => (await tx.readBoard({ filter: { ownerId: { eq: actor.id } } })).length >= 2
    policy :owner types=[:update, :destroy]
      authorize-if=({ actor }) => &ownerId === actor.id
    policy :frozen actions=[&rename, &give]
      forbid-if=() => &locked
`;

const ticket = `entity :Ticket table="tickets"
  attributes
    uuid :id primary-key
    string :title
    enum :priority values=[:low, :high] default=:low
  actions auto=[:read]
    create :file
      input
        &title
        &priority
      validate
        check :titled that=({ input }) => input.title.length > 0 code="titled" message="a title is required"
  policies
    policy :readers types=[:read]
      authorize-if=() => true
    policy :instance actions=[&file]
      authorize-if=({ self }) => self.title === null && self.priority === :low
      forbid-if=({ self, actor }) => self.priority === :low && actor.id === "blocked"
`;

const gate = `entity :Gate table="gates"
  attributes
    uuid :id primary-key
    integer :level nullable
  actions auto=[:read]
    create :make
      input
        &level
    update :pass
    update :enter
    update :band
  policies
    policy :anyone types=[:create, :read]
      authorize-if=() => true
    policy :low actions=[&pass]
      forbid-if=() => &level > 3
    policy :high actions=[&enter]
      authorize-if=() => &level > 3
    policy :middle actions=[&band]
      authorize-if=() => &level > 0
      forbid-if=() => &level > 3
      forbid-if=({ actor }) => actor.id === "blocked"
    policy :alsoMiddle actions=[&band]
      authorize-if=() => &level < 5
`;

const audit = `entity :Audit table="audits"
  attributes
    uuid :id primary-key
    string :what
  actions auto=[:read]
    create :log
      input
        &what
  policies
    policy :internal actions=[&log]
      authorize-if=({ context }) => isSystem(context)
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

const SOURCES = { board, ticket, gate, audit, loose };

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};

/** Build the domain into a temporary project folder and write its generated files. */
async function generate(prefix: string, sources: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, prefix));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(sources).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  // `binding.ts` imports the project's config, which is not part of this fixture.
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  // The project declares its actor (ADR-0059); `system` is Mesh's own key.
  await Bun.write(join(dir, "project-context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor?: { id?: string };\n  }\n}\nexport {};\n');
  return dir;
}

/** Type-check the generated files under the strictest flags a consuming project might use. */
function typeCheck(dir: string, files: string[]): string {
  const child = Bun.spawnSync([
    resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
    "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "project-context.ts", ...files,
  ], { cwd: dir });
  return child.stdout.toString() + child.stderr.toString();
}

/**
 * The same domain with every policies section written in the reverse order, and the checks of each policy reversed:
 * POL-03 says the order changes no decision.
 */
function reversed(source: string): string {
  const at = source.indexOf("\n  policies\n");
  if (at < 0) return source;
  const blocks = source.slice(at + "\n  policies\n".length).split(/\n(?= {4}policy :)/).map((block) => block.replace(/\n$/, ""));
  const flipped = blocks.map((block) => {
    const [head, ...checks] = block.split("\n");
    return [head, ...checks.reverse()].join("\n");
  });
  return `${source.slice(0, at)}\n  policies\n${flipped.reverse().join("\n")}\n`;
}

let dir: string;
let flippedDir: string;
let app: any;
let flippedApp: any;
beforeAll(async () => {
  dir = await generate(".policies-", SOURCES);
  flippedDir = await generate(".policies-reversed-", Object.fromEntries(Object.entries(SOURCES).map(([name, source]) => [name, reversed(source)])));
  app = await import(join(dir, ".mesh/index.ts"));
  flippedApp = await import(join(flippedDir, ".mesh/index.ts"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (flippedDir) await rm(flippedDir, { recursive: true, force: true });
});

const alice = { actor: { id: "alice" } };
const bob = { actor: { id: "bob" } };
const blocked = { actor: { id: "blocked" } };
/** A caller with no actor id. */
const anonymous = { actor: {} };

/** A data layer that counts the transactions opened on it, so a test can tell a denial before the transaction. */
function counting(layer: DataLayer) {
  const counts = { transactions: 0 };
  const wrapped: DataLayer = {
    transaction: (run) => { counts.transactions += 1; return layer.transaction(run); },
    refuseIfFailed: () => layer.refuseIfFailed(),
    close: () => layer.close(),
  };
  return { wrapped, counts };
}

async function fresh(generated = app, seams?: Seams) {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, generated.tables);
  const { wrapped, counts } = counting(db);
  return { db, mesh: generated.bind(wrapped, { seams }), counts };
}

async function denial(call: Promise<unknown>): Promise<ForbiddenError> {
  const error = await call.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ForbiddenError);
  return error as ForbiddenError;
}

test("the generated tree type-checks, policies and all", async () => {
  const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
  expect(typeCheck(dir, files)).toBe("");
});

describe("deny by default", () => {
  test("an action no policy covers is forbidden, and the error shows an open policy to copy", async () => {
    const { db, mesh } = await fresh();
    try {
      const error = await denial(mesh.addLoose({ text: "x" }, alice));
      expect(error).toMatchObject({ code: "forbidden", entity: "Loose", action: "add", policies: [], breakdown: [] });
      expect(error.message).toContain("no policy of :Loose covers it");
      expect(error.message).toContain("policy :open actions=[&add] authorize-if=() => true");
      // A read no policy covers is forbidden too: deny by default holds for reads.
      await denial(mesh.readLoose({}, alice));
      // A policy that covers other actions does not cover this one: Audit's read is covered, its create only by :internal.
      expect(await mesh.readAudit({}, alice)).toEqual([]);
    } finally { await db.close(); }
  });
});

describe("authorize-if and forbid-if combine (POL-03)", () => {
  test("types= and actions= say what a policy covers, and every covering policy must pass", async () => {
    const { db, mesh } = await fresh();
    try {
      const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      // :owner (types=[:update]) and :frozen (actions=[&rename]) both cover rename.
      expect((await mesh.renameBoard({ id: board.id, name: "Roadmap" }, alice)).name).toBe("Roadmap");
      const notOwner = await denial(mesh.renameBoard({ id: board.id, name: "Mine" }, bob));
      expect(notOwner.policies).toEqual(["owner"]);
      await mesh.freezeBoard({ id: board.id }, alice);
      const locked = await denial(mesh.renameBoard({ id: board.id, name: "Again" }, alice));
      expect(locked.policies).toEqual(["frozen"]);
      expect(locked.message).toBe("Board.rename is forbidden by policy :frozen");
      // Both fail: the error names both, in the order the file declares them.
      const both = await denial(mesh.renameBoard({ id: board.id, name: "Again" }, bob));
      expect(both.policies).toEqual(["owner", "frozen"]);
      expect(both.message).toBe("Board.rename is forbidden by policies :owner, :frozen");
      // The auto destroy is covered by types=[:destroy].
      await denial(mesh.destroyBoard({ id: board.id }, bob));
      await mesh.destroyBoard({ id: board.id }, alice);
      expect(await mesh.readBoard({}, alice)).toEqual([]);
    } finally { await db.close(); }
  });

  test("a policy passes when one authorize-if holds and no forbid-if holds; another covering policy must pass too", async () => {
    const { db, mesh } = await fresh();
    try {
      const at = async (level: number | null) => (await mesh.makeGate({ level }, alice)).id;
      const band = async (level: number | null, context = alice) =>
        mesh.bandGate({ id: await at(level) }, context).then(() => "allowed", (error: unknown) => (error instanceof ForbiddenError ? error.policies.join("+") : "other"));
      expect(await band(2)).toBe("allowed");
      expect(await band(0)).toBe("middle");
      expect(await band(4)).toBe("middle");
      expect(await band(6)).toBe("middle+alsoMiddle");
      expect(await band(2, blocked)).toBe("middle");
    } finally { await db.close(); }
  });

  test("an unknown forbid-if forbids; an unknown authorize-if does not authorize; the breakdown says null", async () => {
    const { db, mesh } = await fresh();
    try {
      const unknown = (await mesh.makeGate({ level: null }, alice)).id;
      const pass = await denial(mesh.passGate({ id: unknown }, alice));
      expect(pass.breakdown).toEqual([{ policy: "low", kind: "forbid-if", check: "() => &level > 3", result: null, decisive: true }]);
      const enter = await denial(mesh.enterGate({ id: unknown }, alice));
      expect(enter.breakdown).toEqual([{ policy: "high", kind: "authorize-if", check: "() => &level > 3", result: null, decisive: true }]);
      // Known values decide as written.
      const low = (await mesh.makeGate({ level: 1 }, alice)).id;
      await mesh.passGate({ id: low }, alice);
      await denial(mesh.enterGate({ id: low }, alice));
      const high = (await mesh.makeGate({ level: 5 }, alice)).id;
      await denial(mesh.passGate({ id: high }, alice));
      await mesh.enterGate({ id: high }, alice);
    } finally { await db.close(); }
  });

  test("the breakdown is plain data: it survives JSON unchanged, and it is frozen", async () => {
    const { db, mesh } = await fresh();
    try {
      const id = (await mesh.makeGate({ level: 4 }, alice)).id;
      const error = await denial(mesh.bandGate({ id }, alice));
      expect(error.breakdown).toEqual([
        { policy: "middle", kind: "authorize-if", check: "() => &level > 0", result: true, decisive: false },
        { policy: "middle", kind: "forbid-if", check: "() => &level > 3", result: true, decisive: true },
        { policy: "middle", kind: "forbid-if", check: "({ actor }) => actor.id === \"blocked\"", result: false, decisive: false },
        { policy: "alsoMiddle", kind: "authorize-if", check: "() => &level < 5", result: true, decisive: false },
      ]);
      expect(JSON.parse(JSON.stringify(error.breakdown))).toEqual(error.breakdown);
      expect(Object.isFrozen(error.breakdown) && error.breakdown.every((check) => Object.isFrozen(check) && Object.getPrototypeOf(check) === Object.prototype)).toBe(true);
    } finally { await db.close(); }
  });

  test("writing the policies, and the checks of each, in the reverse order changes no decision", async () => {
    const script = async (generated: any) => {
      const { db, mesh } = await fresh(generated);
      const outcomes: string[] = [];
      const note = (call: Promise<unknown>) => call.then(() => outcomes.push("allowed"), (error: unknown) =>
        outcomes.push(error instanceof ForbiddenError ? `forbidden ${[...error.policies].sort().join("+")}` : (error as Error).constructor.name));
      try {
        for (const level of [null, 0, 2, 4, 6]) {
          const id = (await mesh.makeGate({ level }, alice)).id;
          for (const context of [alice, blocked]) {
            await note(mesh.passGate({ id }, context));
            await note(mesh.enterGate({ id }, context));
            await note(mesh.bandGate({ id }, context));
          }
        }
        const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
        for (const context of [alice, bob, anonymous]) await note(mesh.renameBoard({ id: board.id, name: "x" }, context));
        await note(mesh.lockBoard({ id: board.id }, alice));
        await note(mesh.freezeBoard({ id: board.id }, alice));
        for (const context of [alice, bob]) await note(mesh.renameBoard({ id: board.id, name: "y" }, context));
        await note(mesh.openBoard({ ownerId: "anyone", name: "z" }, anonymous));
        await note(mesh.fileTicket({ title: "t", priority: "high" }, blocked));
        await note(mesh.fileTicket({ title: "t", priority: "high" }, alice));
        await note(mesh.readBoard({}, anonymous).then((rows: unknown[]) => { if (rows.length) throw new Error("rows"); }));
      } finally { await db.close(); }
      return outcomes;
    };
    const written = await script(app);
    expect(written).toContain("allowed");
    expect(written.some((outcome) => outcome.startsWith("forbidden"))).toBe(true);
    expect(await script(flippedApp)).toEqual(written);
  });
});

describe("where each check runs (ACT-28, POL-08)", () => {
  test("an actor-only denial comes before the transaction: no transaction opens, nothing is written, no row is locked", async () => {
    const { db, mesh, counts } = await fresh();
    try {
      await denial(mesh.openBoard({ ownerId: "anyone", name: "Spam" }, anonymous));
      expect(counts.transactions).toBe(0);
      await denial(mesh.logAudit({ what: "x" }, alice));
      expect(counts.transactions).toBe(0);
      // An actor-only read policy that does not admit the caller: no rows, never an error, and no query.
      expect(await mesh.readBoard({}, anonymous)).toEqual([]);
      expect(counts.transactions).toBe(0);
      expect(await mesh.readBoard({}, alice)).toEqual([]);
      expect(counts.transactions).toBe(1);
    } finally { await db.close(); }
  });

  test("an actor-only denial runs no seam; a record-reading denial runs only beforeTransaction, and nothing after the write (M6)", async () => {
    const calls: string[] = [];
    const seams: Seams = {
      beforeTransaction: ({ entity, action }) => { calls.push(`before ${entity}.${action}`); },
      afterWrite: (_db, { entity, action }) => { calls.push(`write ${entity}.${action}`); },
      afterCommit: ({ changes }) => { calls.push(`commit ${changes.length}`); },
    };
    const { db, mesh, counts } = await fresh(app, seams);
    try {
      // The pre-check comes before `runAction`: a denied call does not reach `beforeTransaction`, since it writes nothing.
      await denial(mesh.openBoard({ ownerId: "anyone", name: "Spam" }, anonymous));
      await denial(mesh.logAudit({ what: "x" }, alice));
      expect(calls).toEqual([]);
      expect(counts.transactions).toBe(0);
      // A read runs no seam, admitted or not.
      expect(await mesh.readBoard({}, anonymous)).toEqual([]);
      expect(await mesh.readBoard({}, alice)).toEqual([]);
      expect(calls).toEqual([]);
      // An allowed call runs all three.
      const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      expect(calls).toEqual(["before Board.open", "write Board.open", "commit 1"]);
      // A check that reads the record runs inside the transaction, which beforeTransaction precedes; its denial rolls the
      // transaction back before the write, so neither afterWrite nor afterCommit runs.
      calls.length = 0;
      await denial(mesh.renameBoard({ id: board.id, name: "Mine" }, bob));
      expect(calls).toEqual(["before Board.rename"]);
    } finally { await db.close(); }
  });

  test("an invalid input is still reported as one, on a read the policies do not admit and on a write they would deny", async () => {
    const { db, mesh } = await fresh();
    try {
      await expect(mesh.readBoard({ limit: -1 }, anonymous)).rejects.toBeInstanceOf(InvalidInputError);
      await expect(mesh.openBoard({ ownerId: "x", name: "y", typo: 1 }, anonymous)).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });

  test("on an update a record-reading check sees the locked row as stored, before the input; a missing row is NotFoundError first", async () => {
    const { db, mesh } = await fresh();
    try {
      const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      // :owner reads the stored ownerId, not the one in the input: alice gives the board to bob, then may not take it back.
      expect((await mesh.giveBoard({ id: board.id, ownerId: "bob" }, alice)).ownerId).toBe("bob");
      await denial(mesh.giveBoard({ id: board.id, ownerId: "alice" }, alice));
      // bob, sending his own id as the new owner of a board he does not own, is refused: the input is not what the check reads.
      const other = await mesh.openBoard({ ownerId: "alice", name: "Other" }, alice);
      await denial(mesh.giveBoard({ id: other.id, ownerId: "bob" }, bob));
      await expect(mesh.renameBoard({ id: crypto.randomUUID(), name: "x" }, bob)).rejects.toBeInstanceOf(NotFoundError);
    } finally { await db.close(); }
  });

  test("the policies run before validate: a caller they deny gets ForbiddenError, never the input's issues", async () => {
    const { db, mesh } = await fresh();
    try {
      const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      await denial(mesh.renameBoard({ id: board.id, name: "" }, bob));
      await expect(mesh.renameBoard({ id: board.id, name: "" }, alice)).rejects.toBeInstanceOf(InvalidInputError);
      await denial(mesh.fileTicket({ title: "" }, blocked));
      await expect(mesh.fileTicket({ title: "" }, alice)).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });

  test("on a create a record-reading check sees the new instance before the member inputs", async () => {
    const { db, mesh } = await fresh();
    try {
      // :instance holds only where the title is still null and the priority the default: the input is not applied yet.
      const ticket = await mesh.fileTicket({ title: "Broken", priority: "high" }, alice);
      expect(ticket).toMatchObject({ title: "Broken", priority: "high" });
      // The forbid-if reads the instance's :low, not the input's :high.
      const error = await denial(mesh.fileTicket({ title: "Broken", priority: "high" }, blocked));
      expect(error.breakdown.find((check) => check.kind === "forbid-if")).toMatchObject({ result: true, decisive: true });
      expect(await mesh.readTicket({}, alice)).toHaveLength(1);
    } finally { await db.close(); }
  });

  test("a record-reading denial rolls its transaction back: nothing the action did is written", async () => {
    const { db, mesh, counts } = await fresh();
    try {
      const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      const before = counts.transactions;
      await denial(mesh.lockBoard({ id: board.id }, bob));
      expect(counts.transactions).toBe(before + 1);
      expect((await mesh.readBoard({}, alice))[0]).toMatchObject({ locked: false });
      expect(await mesh.readAudit({}, alice)).toEqual([]);
    } finally { await db.close(); }
  });

  test("a write policy that reads through tx sees an earlier write of the same transaction", async () => {
    const { db, mesh } = await fresh();
    try {
      await mesh.openBoard({ ownerId: "alice", name: "One" }, alice);
      await mesh.openBoard({ ownerId: "alice", name: "Two" }, alice);
      const quota = await denial(mesh.openBoard({ ownerId: "alice", name: "Three" }, alice));
      expect(quota.policies).toEqual(["quota"]);
      // In one transaction, bob's first two boards are not committed yet; :quota reads them through tx and refuses the third,
      // and the denial fails the whole transaction.
      const call = mesh.transaction(async ({ actions }: any) => {
        await actions.openBoard({ ownerId: "bob", name: "One" });
        await actions.openBoard({ ownerId: "bob", name: "Two" });
        await actions.openBoard({ ownerId: "bob", name: "Three" });
      }, bob);
      await denial(call);
      expect((await mesh.readBoard({}, alice)).map((row: { ownerId: string }) => row.ownerId)).toEqual(["alice", "alice"]);
    } finally { await db.close(); }
  });
});

describe("a nested call is checked against the nested action's policies (TXN-06)", () => {
  test("a direct call without system is forbidden; with system, isSystem(context) admits it", async () => {
    const { db, mesh } = await fresh();
    try {
      const error = await denial(mesh.logAudit({ what: "x" }, alice));
      expect(error.breakdown).toEqual([{ policy: "internal", kind: "authorize-if", check: "({ context }) => isSystem(context)", result: false, decisive: true }]);
      await mesh.logAudit({ what: "system" }, { ...alice, system: true });
      // Only the boolean true counts.
      await denial(mesh.logAudit({ what: "x" }, { ...alice, system: "true" }));
      expect((await mesh.readAudit({}, alice)).map((row: { what: string }) => row.what)).toEqual(["system"]);
    } finally { await db.close(); }
  });

  test("a step that calls with system: true is admitted; one that carries the caller's context is checked as the caller", async () => {
    const { db, mesh } = await fresh();
    try {
      const board = await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      // rename's step passes { ...context, system: true }: the nested log is admitted.
      await mesh.renameBoard({ id: board.id, name: "Roadmap" }, alice);
      expect((await mesh.readAudit({}, alice)).map((row: { what: string }) => row.what)).toEqual(["rename"]);
      // lock's step carries alice's context, which is not system: the nested log is forbidden, and the lock is rolled back.
      const error = await denial(mesh.lockBoard({ id: board.id }, alice));
      expect(error).toMatchObject({ entity: "Audit", action: "log", policies: ["internal"] });
      expect((await mesh.readBoard({}, alice))[0]).toMatchObject({ locked: false, name: "Roadmap" });
      expect(await mesh.readAudit({}, alice)).toHaveLength(1);
    } finally { await db.close(); }
  });

  test("a read through tx skips the read's policies", async () => {
    const { db, mesh } = await fresh();
    try {
      await mesh.openBoard({ ownerId: "alice", name: "Plans" }, alice);
      // The anonymous caller's own read gives no rows; the same read through tx, in a transaction, reads the row.
      expect(await mesh.readBoard({}, anonymous)).toEqual([]);
      const seen = await mesh.transaction(async ({ tx }: any) => (await tx.readBoard({})).length, anonymous);
      expect(seen).toBe(1);
    } finally { await db.close(); }
  });
});
