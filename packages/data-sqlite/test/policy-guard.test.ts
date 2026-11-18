// A destroy whose policy checks that read the record translate to SQL runs as one DELETE that checks them itself
// (ADR-0046, option B; pol05): SQLite declares policy-guards, so the generated destroy calls `deleteByKeyGuarded`, and a
// denial raises inside the statement and comes back as the ForbiddenError the read-first path gives, breakdown and all.
// The read path stays for a seam that wants `before`, a permission question and a layer without the guarded delete;
// each case here compares the two. The domain is built, generated, type-checked under the strictest flags and called
// against `:memory:` SQLite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { ForbiddenError, FrameworkError, Mesh, NotFoundError, type DataLayer, type DataOperations, type Seams } from "@meshfw/runtime";
import { callsOf } from "./calls.ts";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const user = `entity :User table="users"
  attributes
    uuid :id primary-key
  actions auto=[:read]
  policies
    policy :open types=[:read]
      authorize-if=() => true
`;
// A note is its owner's to delete: `&owner.id` is the key column, no join.
const note = `import { User } from "./user.mesh.mx"
entity :Note table="notes"
  attributes
    uuid :id primary-key
    string :title
  relationships
    belongs-to :owner entity=User
  actions auto=[:read, :destroy]
    destroy :remove
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :mine types=[:destroy]
      authorize-if=({ actor }) => &owner.id === actor.id
`;
// Two policies: an admin or the owner may delete (an actor-only check beside a record one), and nobody a locked doc.
const doc = `entity :Doc table="docs"
  attributes
    uuid :id primary-key
    uuid :ownerId
    boolean :locked
  actions auto=[:read, :destroy]
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :adminOrOwner types=[:destroy]
      authorize-if=({ actor }) => actor.admin === true
      authorize-if=({ actor }) => &ownerId === actor.id
    policy :unlocked types=[:destroy]
      forbid-if=() => &locked
`;
// One hop through a nullable belongs-to: a subquery inside the delete's WHERE. A folder is also its owner's to delete,
// items and all, and its `tidy` step runs whatever a test puts in `hooks.step` (a nested call) inside its transaction.
const folder = `import { Item } from "./item.mesh.mx"
import { tidyStep } from "./steps"
entity :Folder table="folders"
  attributes
    uuid :id primary-key
    uuid :ownerId
  relationships
    has-many :items entity=Item
  actions auto=[:read, :destroy]
    update :tidy
      do
        run() {
          await tidyStep()
        }
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :owned types=[:destroy]
      authorize-if=({ actor }) => &ownerId === actor.id
    policy :anyone actions=[&tidy]
      authorize-if=() => true
`;
const steps = `export const hooks: { step: () => Promise<unknown> } = { step: async () => undefined };
export async function tidyStep(): Promise<void> {
  await hooks.step();
}
`;
const item = `import { Folder } from "./folder.mesh.mx"
entity :Item table="items"
  attributes
    uuid :id primary-key
  relationships
    belongs-to :folder entity=Folder nullable
  actions auto=[:read, :destroy]
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :folderOwner types=[:destroy]
      authorize-if=({ actor }) => &folder?.ownerId === actor.id
`;
// A hop to the same table the delete runs on.
const node = `entity :Node table="nodes"
  attributes
    uuid :id primary-key
    boolean :locked
  relationships
    belongs-to :parent entity=Node nullable
  actions auto=[:read, :destroy]
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :parentOpen types=[:destroy]
      forbid-if=() => &parent?.locked === true
`;

// An integer key (cast to text in the marker), an enum compared with an atom, `%.now` (bound from the pre-check's
// clock) and two rollups over has-many, one per destroy, each inside the delete's WHERE.
const box = `import { Thing } from "./thing.mesh.mx"
entity :Box table="boxes"
  attributes
    integer :id primary-key
    enum :state values=[:draft, :closed]
    datetime :closesAt nullable
  relationships
    has-many :things entity=Thing
  computed
    count :thingCount of=&things
  actions auto=[:read]
    destroy :empty
    destroy :drafted
    destroy :expired
    destroy :noneDone
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :isEmpty actions=[&empty]
      forbid-if=() => &thingCount > 0
    policy :isDraft actions=[&drafted]
      authorize-if=() => &state === :draft
    policy :isExpired actions=[&expired]
      authorize-if=() => &closesAt !== null && &closesAt < %.now
    policy :noneDoneYet actions=[&noneDone]
      forbid-if=() => &things.some((t) => t.done)
`;
const thing = `import { Box } from "./box.mesh.mx"
entity :Thing table="things"
  attributes
    uuid :id primary-key
    boolean :done
  relationships
    belongs-to :box entity=Box
  actions auto=[:read]
  policies
    policy :open types=[:read]
      authorize-if=() => true
`;
// One policy covers the read and the destroy: the guarded check reuses the read policy's literal.
const pad = `entity :Pad table="pads"
  attributes
    uuid :id primary-key
    uuid :ownerId
  actions auto=[:read, :destroy]
  policies
    policy :mine types=[:read, :destroy]
      authorize-if=({ actor }) => &ownerId === actor.id
`;

// Staff may delete any memo; anyone else only their own. For staff the record-reading policy does not apply (its
// `when` reads only the actor), so the guard has no check left and the generated code runs a plain delete by key.
const memo = `entity :Memo table="memos"
  attributes
    uuid :id primary-key
    uuid :ownerId
  actions auto=[:read, :destroy]
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :staff types=[:destroy]
      authorize-if=({ actor }) => actor.id !== null
    policy :own types=[:destroy] when=({ actor }) => actor.admin !== true
      authorize-if=({ actor }) => &ownerId === actor.id
`;

async function generate(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-policy-guard-"));
  const data: ResolvedConfig["data"] = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: { file: ":memory:" } };
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data };
  await mkdir(join(dir, "src/domain"), { recursive: true });
  await Bun.write(join(dir, "src/domain/steps.ts"), steps);
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ user, note, doc, folder, item, node, box, thing, pad, memo }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string | null; admin?: boolean };\n  }\n}\nexport {};\n');
  return dir;
}

let dir: string;
let app: any;
let domain: any;
let stepHooks: { step: () => Promise<unknown> };
beforeAll(async () => {
  dir = await generate();
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
  stepHooks = (await import(join(dir, "src/domain/steps.ts"))).hooks;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// The contexts the generated project declares (its own `context.ts`), which this package's `ActionContext` does not know.
const alice: any = { actor: { id: id(91) } };
const bob: any = { actor: { id: id(92) } };
const admin: any = { actor: { id: id(93), admin: true } };
const nobody: any = { actor: { id: null } };

async function seed(tx: DataOperations) {
  await tx.insert(app.tables.users, { id: id(91) });
  await tx.insert(app.tables.users, { id: id(92) });
  await tx.insert(app.tables.notes, { id: id(1), title: "a", ownerId: id(91) });
  await tx.insert(app.tables.notes, { id: id(2), title: "b", ownerId: id(91) });
  await tx.insert(app.tables.docs, { id: id(11), ownerId: id(91), locked: false });
  await tx.insert(app.tables.docs, { id: id(12), ownerId: id(91), locked: true });
  await tx.insert(app.tables.folders, { id: id(21), ownerId: id(91) });
  await tx.insert(app.tables.items, { id: id(31), folderId: id(21) });
  await tx.insert(app.tables.items, { id: id(32), folderId: null });
  await tx.insert(app.tables.nodes, { id: id(41), locked: true, parentId: null });
  await tx.insert(app.tables.nodes, { id: id(42), locked: false, parentId: id(41) });
  await tx.insert(app.tables.nodes, { id: id(43), locked: false, parentId: null });
  await tx.insert(app.tables.nodes, { id: id(44), locked: false, parentId: id(43) });
  // Box 1: a draft, closed in the past, with one thing done. Box 2: closed, closing next century, empty. Box 3: a draft
  // with no closing time and one thing not done.
  await tx.insert(app.tables.boxes, { id: 1, state: "draft", closesAt: new Date(Date.UTC(2020, 0, 1)) });
  await tx.insert(app.tables.boxes, { id: 2, state: "closed", closesAt: new Date(Date.UTC(2120, 0, 1)) });
  await tx.insert(app.tables.boxes, { id: 3, state: "draft", closesAt: null });
  await tx.insert(app.tables.things, { id: id(51), done: true, boxId: 1 });
  await tx.insert(app.tables.things, { id: id(52), done: false, boxId: 3 });
  await tx.insert(app.tables.pads, { id: id(61), ownerId: id(91) });
  await tx.insert(app.tables.memos, { id: id(71), ownerId: id(91) });
  await tx.insert(app.tables.memos, { id: id(72), ownerId: id(91) });
}

/**
 * A seeded `:memory:` database. The layer counts the locked reads and guarded deletes; with `drop` it hands every
 * transaction operations without `deleteByKeyGuarded`, as a wrapper that lists its members one by one does.
 */
async function seeded(options: { seams?: Seams; drop?: boolean } = {}) {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  await db.transaction(seed);
  const counts = { locked: 0, guarded: 0 };
  const wrap = (tx: DataOperations): DataOperations => {
    const { deleteByKeyGuarded, ...rest } = tx;
    return {
      ...rest,
      selectByKeyForUpdate: (table, key) => { counts.locked++; return tx.selectByKeyForUpdate(table, key); },
      ...(options.drop || !deleteByKeyGuarded ? {} : { deleteByKeyGuarded: (table, key, guard) => { counts.guarded++; return deleteByKeyGuarded(table, key, guard); } }),
    } as DataOperations;
  };
  // One wrapper per transaction's operations, so a joined call sees the same object as the call it joins.
  const wrapped = new WeakMap<DataOperations, DataOperations>();
  const layer = {
    transaction: (run: (tx: DataOperations) => Promise<unknown>) => db.transaction((tx) => {
      if (!wrapped.has(tx)) wrapped.set(tx, wrap(tx));
      return run(wrapped.get(tx)!);
    }),
    refuseIfFailed: () => db.refuseIfFailed(),
    close: () => db.close(),
    capabilities: (db as { capabilities?: unknown }).capabilities,
  } as unknown as DataLayer;
  const binding = app.bind(layer, options.seams ? { seams: options.seams } : {});
  const rows = async (table: string) => (await db.transaction((tx) => tx.select(app.tables[table]))).map((row: any) => row.id).sort();
  return { db, binding, counts, rows, mesh: callsOf(binding, domain) };
}

/** What a call rejects with, as plain data (a ForbiddenError's fields, a NotFoundError's code). */
const outcome = async (call: () => Promise<unknown>) => {
  try { await call(); return "done"; }
  catch (error) {
    if (error instanceof ForbiddenError) return { forbidden: { entity: error.entity, action: error.action, policies: error.policies, reason: error.reason, breakdown: error.breakdown, message: error.message } };
    if (error instanceof NotFoundError) return "not found";
    throw error;
  }
};
/**
 * The same call through the guarded delete and through the read path (an afterWrite seam), each on a fresh database.
 * With `readsFirst`, the call without a seam is expected to take the read path too.
 */
async function bothPaths(call: (mesh: any) => Promise<unknown>, table: string, options: { readsFirst?: boolean } = {}) {
  const guarded = await seeded();
  const read = await seeded({ seams: { afterWrite() {} } });
  try {
    const result = { guarded: await outcome(() => call(guarded.mesh)), read: await outcome(() => call(read.mesh)) };
    if (options.readsFirst) expect(guarded.counts.guarded).toBe(0);
    else expect(guarded.counts.locked).toBe(0);
    expect(read.counts.guarded).toBe(0);
    expect(await guarded.rows(table)).toEqual(await read.rows(table));
    return { ...result, rows: await guarded.rows(table), guardedCounts: guarded.counts };
  } finally { await guarded.db.close(); await read.db.close(); }
}

describe("the generated files", () => {
  test("type-check under the strictest flags", async () => {
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "context.ts", ...files,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
  }, 30_000);

  test("every destroy here is guarded", async () => {
    for (const entity of ["note", "doc", "folder", "item", "node", "box", "pad", "memo"])
      expect(await Bun.file(join(dir, `.mesh/domain/${entity}.actions.ts`)).text()).toContain("tx.deleteByKeyGuarded!(");
  });
});

describe("a guarded destroy", () => {
  test("the owner deletes, in one statement, with no read", async () => {
    const result = await bothPaths((mesh) => mesh.destroyNote({ id: id(1) }, alice), "notes");
    expect(result).toMatchObject({ guarded: "done", read: "done", rows: [id(2)], guardedCounts: { locked: 0, guarded: 1 } });
  });

  test("a declared destroy is guarded as the auto one is", async () => {
    const result = await bothPaths((mesh) => mesh.removeNote({ id: id(1) }, bob), "notes");
    expect(result.guarded).toEqual(result.read);
    expect(result.rows).toEqual([id(1), id(2)]);
  });

  test("a stranger gets the ForbiddenError the read path gives, breakdown included, and nothing is deleted (R2)", async () => {
    const result = await bothPaths((mesh) => mesh.destroyNote({ id: id(1) }, bob), "notes");
    expect(result.guarded).toEqual(result.read);
    expect(result.guarded).toEqual({ forbidden: {
      entity: "Note", action: "destroy", policies: ["mine"], reason: "failed", message: "Note#destroy is forbidden by policy :mine",
      breakdown: [{ policy: "mine", kind: "authorize-if", check: "({ actor }) => &owner.id === actor.id", result: false, decisive: true }],
    } });
    expect(result.rows).toEqual([id(1), id(2)]);
  });

  test("an unknown result fails closed: a null actor id is forbidden with result null (R5)", async () => {
    const result = await bothPaths((mesh) => mesh.destroyNote({ id: id(1) }, nobody), "notes");
    expect(result.guarded).toEqual(result.read);
    expect((result.guarded as any).forbidden.breakdown).toEqual([{ policy: "mine", kind: "authorize-if", check: "({ actor }) => &owner.id === actor.id", result: null, decisive: true }]);
  });

  test("an actor value that does not fit the column is decided on the read path: forbidden, never a bind refusal (R2)", async () => {
    for (const actorId of [5, [id(91)], {}]) {
      const result = await bothPaths((mesh) => mesh.destroyNote({ id: id(1) }, { actor: { id: actorId } }), "notes", { readsFirst: true });
      expect(result.guarded).toEqual(result.read);
      expect(result).toMatchObject({ rows: [id(1), id(2)], guardedCounts: { locked: 1, guarded: 0 } });
      expect((result.guarded as any).forbidden.breakdown).toEqual([{ policy: "mine", kind: "authorize-if", check: "({ actor }) => &owner.id === actor.id", result: false, decisive: true }]);
    }
  });

  test("a guard with no check left (the record policy's when is false) runs a plain delete by key", async () => {
    expect(await bothPaths((mesh) => mesh.destroyMemo({ id: id(71) }, admin), "memos"))
      .toMatchObject({ guarded: "done", read: "done", rows: [id(72)], guardedCounts: { locked: 0, guarded: 0 } });
    expect(await bothPaths((mesh) => mesh.destroyMemo({ id: id(79) }, admin), "memos"))
      .toMatchObject({ guarded: "not found", read: "not found", guardedCounts: { locked: 0, guarded: 0 } });
    // For anyone else (an unset `admin` would make the when unknown) the policy applies and the delete is guarded.
    const owner: any = { actor: { id: id(91), admin: false } };
    const stranger: any = { actor: { id: id(92), admin: false } };
    expect(await bothPaths((mesh) => mesh.destroyMemo({ id: id(71) }, owner), "memos"))
      .toMatchObject({ guarded: "done", read: "done", rows: [id(72)], guardedCounts: { locked: 0, guarded: 1 } });
    const denied = await bothPaths((mesh) => mesh.destroyMemo({ id: id(71) }, stranger), "memos");
    expect(denied.guarded).toEqual(denied.read);
    expect(denied).toMatchObject({ rows: [id(71), id(72)], guardedCounts: { locked: 0, guarded: 1 } });
  });

  test("a key that names no row is not found, never forbidden (R3)", async () => {
    for (const context of [alice, bob]) {
      const result = await bothPaths((mesh) => mesh.destroyNote({ id: id(9) }, context), "notes");
      expect(result).toMatchObject({ guarded: "not found", read: "not found" });
    }
  });

  test("two policies: an admin may not delete a locked doc, and the breakdown lists every check as the read path does", async () => {
    for (const [key, context] of [[id(12), admin], [id(12), alice], [id(11), bob], [id(11), nobody]] as const) {
      const result = await bothPaths((mesh) => mesh.destroyDoc({ id: key }, context), "docs");
      expect(result.guarded).toEqual(result.read);
      expect(result.guarded).not.toBe("done");
    }
    const locked = await bothPaths((mesh) => mesh.destroyDoc({ id: id(12) }, admin), "docs");
    expect((locked.guarded as any).forbidden).toMatchObject({ policies: ["unlocked"], reason: "failed" });
    expect((locked.guarded as any).forbidden.breakdown).toEqual([
      { policy: "adminOrOwner", kind: "authorize-if", check: "({ actor }) => actor.admin === true", result: true, decisive: false },
      { policy: "adminOrOwner", kind: "authorize-if", check: "({ actor }) => &ownerId === actor.id", result: false, decisive: false },
      { policy: "unlocked", kind: "forbid-if", check: "() => &locked", result: true, decisive: true },
    ]);
    for (const [key, context] of [[id(11), admin], [id(11), alice]] as const) {
      const result = await bothPaths((mesh) => mesh.destroyDoc({ id: key }, context), "docs");
      expect(result).toMatchObject({ guarded: "done", read: "done", rows: [id(12)] });
    }
  });

  test("through one hop: the folder's owner deletes, another is forbidden, and an item in no folder is unknown", async () => {
    expect(await bothPaths((mesh) => mesh.destroyItem({ id: id(31) }, alice), "items")).toMatchObject({ guarded: "done", read: "done", rows: [id(32)] });
    const denied = await bothPaths((mesh) => mesh.destroyItem({ id: id(31) }, bob), "items");
    expect(denied.guarded).toEqual(denied.read);
    expect((denied.guarded as any).forbidden.breakdown[0].result).toBe(false);
    const orphan = await bothPaths((mesh) => mesh.destroyItem({ id: id(32) }, alice), "items");
    expect(orphan.guarded).toEqual(orphan.read);
    expect((orphan.guarded as any).forbidden.breakdown[0].result).toBe(null);
  });

  test("a folder that has items: a stranger is forbidden on both paths, the owner deletes on both", async () => {
    const denied = await bothPaths((mesh) => mesh.destroyFolder({ id: id(21) }, bob), "folders");
    expect(denied.guarded).toEqual(denied.read);
    expect(denied).toMatchObject({ rows: [id(21)], guardedCounts: { locked: 0, guarded: 1 } });
    expect((denied.guarded as any).forbidden).toMatchObject({ policies: ["owned"], reason: "failed" });
    // SQLite gets no foreign keys from createSchema, so the delete goes through on both paths and the items stay.
    const allowed = await bothPaths((mesh) => mesh.destroyFolder({ id: id(21) }, alice), "folders");
    expect(allowed).toMatchObject({ guarded: "done", read: "done", rows: [], guardedCounts: { locked: 0, guarded: 1 } });
  });

  test("through a hop to its own table: a node under a locked parent is kept, one under an open parent or none is deleted", async () => {
    const denied = await bothPaths((mesh) => mesh.destroyNode({ id: id(42) }, alice), "nodes");
    expect(denied.guarded).toEqual(denied.read);
    expect((denied.guarded as any).forbidden.breakdown).toEqual([{ policy: "parentOpen", kind: "forbid-if", check: "() => &parent?.locked === true", result: true, decisive: true }]);
    expect(await bothPaths((mesh) => mesh.destroyNode({ id: id(44) }, alice), "nodes")).toMatchObject({ guarded: "done", read: "done" });
    // No parent: `&parent?.locked === true` is unknown, and an unknown forbid-if forbids.
    const root = await bothPaths((mesh) => mesh.destroyNode({ id: id(43) }, alice), "nodes");
    expect(root.guarded).toEqual(root.read);
    expect((root.guarded as any).forbidden.breakdown[0].result).toBe(null);
  });
});

describe("what a guarded check may read", () => {
  /** Each key's outcome on both paths, which must agree; `true` where the delete went through. */
  async function outcomes(call: (mesh: any, key: number) => Promise<unknown>, keys: readonly number[]) {
    const seen: Record<number, unknown> = {};
    for (const key of keys) {
      const result = await bothPaths((mesh) => call(mesh, key), "boxes");
      expect(result.guarded).toEqual(result.read);
      expect(result.guardedCounts).toEqual({ locked: 0, guarded: 1 });
      seen[key] = result.guarded === "done" ? true : result.guarded === "not found" ? "not found" : (result.guarded as any).forbidden.breakdown.map((entry: any) => entry.result);
    }
    return seen;
  }

  test("an integer key: a missing one is not found, never forbidden", async () => {
    expect(await outcomes((mesh, key) => mesh.draftedBox({ id: key }, alice), [1, 2, 9])).toEqual({ 1: true, 2: [false], 9: "not found" });
  });

  test("an enum compared with an atom", async () => {
    expect(await outcomes((mesh, key) => mesh.draftedBox({ id: key }, alice), [3, 2])).toEqual({ 3: true, 2: [false] });
  });

  test("%.now, bound from the clock: past is allowed, future denied, no closing time denied (the null guard makes it false)", async () => {
    expect(await outcomes((mesh, key) => mesh.expiredBox({ id: key }, alice), [1, 2, 3])).toEqual({ 1: true, 2: [false], 3: [false] });
  });

  test("a count rollup inside the delete: an empty box goes, a full one stays", async () => {
    expect(await outcomes((mesh, key) => mesh.emptyBox({ id: key }, alice), [2, 1])).toEqual({ 2: true, 1: [true] });
  });

  test("a some over has-many inside the delete", async () => {
    expect(await outcomes((mesh, key) => mesh.noneDoneBox({ id: key }, alice), [1, 3, 2])).toEqual({ 1: [true], 3: true, 2: true });
  });

  test("a check whose policy covers the read too: the owner deletes, a stranger is forbidden", async () => {
    const denied = await bothPaths((mesh) => mesh.destroyPad({ id: id(61) }, bob), "pads");
    expect(denied.guarded).toEqual(denied.read);
    expect(denied).toMatchObject({ rows: [id(61)], guardedCounts: { locked: 0, guarded: 1 } });
    expect((denied.guarded as any).forbidden).toMatchObject({ policies: ["mine"], reason: "failed" });
    expect(await bothPaths((mesh) => mesh.destroyPad({ id: id(61) }, alice), "pads")).toMatchObject({ guarded: "done", read: "done", rows: [], guardedCounts: { locked: 0, guarded: 1 } });
  });
});

describe("the read path stays where the guarded delete cannot serve (R7)", () => {
  test("with an afterWrite or afterCommit seam, the row is read once under the lock and the seam gets before", async () => {
    const seen: unknown[] = [];
    for (const seams of [{ afterWrite: (_: unknown, change: { before: unknown }) => { seen.push(change.before); } }, { afterCommit: () => {} }] as Seams[]) {
      const { db, mesh, counts } = await seeded({ seams });
      try {
        await mesh.destroyNote({ id: id(1) }, alice);
        expect(counts).toEqual({ locked: 1, guarded: 0 });
      } finally { await db.close(); }
    }
    expect(seen).toEqual([{ id: id(1), title: "a", ownerId: id(91) }]);
    // A seam that wants no change keeps the guarded delete.
    const { db, mesh, counts } = await seeded({ seams: { beforeTransaction() {} } });
    try {
      await mesh.destroyNote({ id: id(1) }, alice);
      expect(counts).toEqual({ locked: 0, guarded: 1 });
    } finally { await db.close(); }
  });

  test("Mesh.checkPolicies and Mesh.can give the call's decision through the read path and delete nothing", async () => {
    const { db, binding, counts, rows, mesh } = await seeded();
    try {
      const denied = await binding.run(() => Mesh.checkPolicies(domain.Note.destroy, { id: id(1) }, bob));
      const call = await outcome(() => mesh.destroyNote({ id: id(1) }, bob));
      expect(denied.allowed).toBe(false);
      expect(denied.breakdown).toEqual((call as any).forbidden.breakdown);
      expect(await binding.run(() => Mesh.can(domain.Note.destroy, { id: id(1) }, alice))).toBe(true);
      expect(await binding.run(() => Mesh.can(domain.Doc.destroy, { id: id(12) }, admin))).toBe(false);
      expect(counts.guarded).toBe(1);
      expect(await rows("notes")).toEqual([id(1), id(2)]);
      // Asked inside a running transaction, the question leaves it usable.
      await binding.transaction(async () => {
        expect(await Mesh.can(domain.Note.destroy, { id: id(1) }, bob)).toBe(false);
        await domain.Note.destroy({ id: id(2) }, alice);
      });
      expect(await rows("notes")).toEqual([id(1)]);
    } finally { await db.close(); }
  });

  test("a layer without deleteByKeyGuarded reads first and gives the same results", async () => {
    for (const [call, table] of [
      [(mesh: any) => mesh.destroyNote({ id: id(1) }, bob), "notes"],
      [(mesh: any) => mesh.destroyNote({ id: id(1) }, alice), "notes"],
      [(mesh: any) => mesh.destroyDoc({ id: id(12) }, admin), "docs"],
      [(mesh: any) => mesh.destroyItem({ id: id(32) }, alice), "items"],
      [(mesh: any) => mesh.destroyNote({ id: id(9) }, alice), "notes"],
    ] as const) {
      const guarded = await seeded();
      const dropped = await seeded({ drop: true });
      try {
        expect(await outcome(() => call(dropped.mesh))).toEqual(await outcome(() => call(guarded.mesh)));
        expect(await dropped.rows(table)).toEqual(await guarded.rows(table));
        expect(dropped.counts.guarded).toBe(0);
        expect(dropped.counts.locked).toBe(1);
      } finally { await guarded.db.close(); await dropped.db.close(); }
    }
  });
});

test("a denied guarded destroy inside a transaction fails that transaction, even when caught", async () => {
  const { db, binding, rows } = await seeded();
  try {
    const failed = await binding.transaction(async () => {
      await domain.Note.destroy({ id: id(2) }, alice);
      await domain.Note.destroy({ id: id(1) }, bob).catch(() => undefined);
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(FrameworkError);
    expect((failed as FrameworkError).cause).toBeInstanceOf(ForbiddenError);
    expect(await rows("notes")).toEqual([id(1), id(2)]);
  } finally { await db.close(); }
});

describe("a guarded destroy called from another action's step", () => {
  afterAll(() => { stepHooks.step = async () => undefined; });

  test("when it is denied, the outer action fails and its transaction rolls back", async () => {
    const { db, mesh, rows, counts } = await seeded();
    try {
      stepHooks.step = async () => {
        await domain.Note.destroy({ id: id(2) }, alice);
        await domain.Note.destroy({ id: id(1) }, bob);
      };
      const failed = await mesh.tidyFolder({ id: id(21) }, alice).then(() => "done", (error: unknown) => error);
      expect(failed).toBeInstanceOf(ForbiddenError);
      expect((failed as ForbiddenError).entity).toBe("Note");
      // The one locked read is the outer update's own; both nested deletes are guarded.
      expect(counts).toEqual({ locked: 1, guarded: 2 });
      expect(await rows("notes")).toEqual([id(1), id(2)]);
      // Caught inside the step, the denial still fails the outer transaction.
      stepHooks.step = async () => {
        await domain.Note.destroy({ id: id(2) }, alice);
        await domain.Note.destroy({ id: id(1) }, bob).catch(() => undefined);
      };
      const caught = await mesh.tidyFolder({ id: id(21) }, alice).then(() => "done", (error: unknown) => error);
      expect(caught).toBeInstanceOf(FrameworkError);
      expect((caught as FrameworkError).cause).toBeInstanceOf(ForbiddenError);
      expect(await rows("notes")).toEqual([id(1), id(2)]);
      // Allowed, the nested delete commits with the outer action.
      stepHooks.step = async () => { await domain.Note.destroy({ id: id(2) }, alice); };
      expect(await mesh.tidyFolder({ id: id(21) }, alice).then(() => "done")).toBe("done");
      expect(await rows("notes")).toEqual([id(1)]);
    } finally { await db.close(); }
  });
});
