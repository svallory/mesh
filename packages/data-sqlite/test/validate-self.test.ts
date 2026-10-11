// ACT-01, ACT-27, POL-08 (the operator's rulings of 2026-10-11): `validate` sees `self` before the input is applied. On an
// update or destroy `self` is the stored record, read under the lock; on a create it is the new instance Mesh builds, with
// its defaults, its stamps and a `uuid` or `string` key already filled, before the member inputs (`&x`). The caller's
// values are in `input`, `before` is gone from `validate`, and the inputs are applied after the checks pass, so `do` and
// `run` see them, with `before` the stored record (null on a create). A domain is built, generated, pushed to SQLite and
// called; plain functions record what each phase saw.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { InvalidInputError, type Issue } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const helpers = `// What a phase saw: the record, and the input (in a check) or \`before\` (in a step).
const pick = (row: any): any => row == null ? row : { id: row.id, title: row.title, body: row.body, priority: row.priority, state: row.state, ownerId: row.ownerId, createdAt: row.createdAt == null ? row.createdAt : new Date(row.createdAt.getTime()) };
export function sawNote(context: any, phase: string, self: any, other: any): boolean {
  const isInput = phase.startsWith("validate") || phase === "always";
  context.seen.push({ phase, self: pick(self), ...(isInput ? { input: { ...other }, sent: Object.keys(other).sort() } : { before: pick(other) }) });
  return true;
}
export function sawKey(context: any, phase: string, key: unknown, other: unknown): boolean {
  context.seen.push({ phase, key, other });
  return true;
}
`;

const person = `entity :Person table="people"
  attributes
    uuid :id primary-key
    string :name min=1
  actions auto=[:read]
    create :join
      input
        &name
`;

const note = `import { Person } from "./person.mesh.mx"
import { sawNote } from "./helpers"
entity :Note table="notes"
  attributes
    uuid :id primary-key
    string :title min=1
    string :body nullable
    integer :priority default=3
    enum :state values=[:draft, :live] default=:draft
    timestamp :createdAt on=:create
  relationships
    belongs-to :owner entity=Person
  actions auto=[:read]
    always types=[:create, :update]
      validate
        check :titleNotShouting [
          that=({ input }) => (input.title ?? &title) !== "STOP"
          code="note.shouting"
          message="do not shout"
        ]
        check :watch that=({ self, input, context }) => sawNote(context, "always", self, input) code="watch" message="watch"
      do
        run({ self, before, context }) {
          sawNote(context, "do", self, before);
        }
        run [after=:write] ({ self, before, context }) {
          sawNote(context, "after", self, before);
        }
    create :write
      input
        &title
        &body
        &priority
        &owner
      validate
        check :watch that=({ self, input, context }) => sawNote(context, "validate", self, input) code="watch" message="watch"
        check :ownerExists [
          that=async ({ input, tx }) => (await tx.readPerson({ filter: { id: { eq: input.owner } } })).length === 1
          code="note.owner"
          message="no such person"
        ]
    create :writeLive
      input
        &title
        &owner
      do
        run [after=:write] async ({ self, actions }) {
          await actions.publishNote({ id: self.id });
        }
    update :edit
      input
        &title
        &body
        &priority
      validate
        check :watch that=({ self, input, context }) => sawNote(context, "validate", self, input) code="watch" message="watch"
        check :keepsLocked [
          that=({ input }) => &body === null || &body !== "locked" || (input.body ?? &body) === "locked"
          code="note.locked"
          message="a locked body cannot change"
        ]
    update :editStrict
      input
        &body
      validate
        check :keepsLocked [
          that=({ self, input }) => self.body !== "locked" || input.body === undefined || input.body === "locked"
          code="note.locked"
          message="a locked body cannot change"
        ]
    update :publish
      validate
        check :watch that=({ self, input, context }) => sawNote(context, "validate publish", self, input) code="watch" message="watch"
        check :draftOnly that=() => &state === :draft code="note.live" message="only a draft can be published"
      do
        set
          &state=:live
    destroy :drop
      validate
        check :watch that=({ self, input, context }) => sawNote(context, "validate", self, input) code="watch" message="watch"
        check :draftOnly that=() => &state === :draft code="note.live" message="only a draft can be dropped"
      do
        run({ self, before, context }) {
          sawNote(context, "do", self, before);
        }
`;

// An integer key is given by the data layer when it writes the row; a string key is filled like a uuid one.
const event = `import { sawKey } from "./helpers"
entity :Event table="events"
  attributes
    integer :seq primary-key
    string :what min=1
  actions auto=[:read]
    create :log
      input
        &what
      validate
        check :watch that=({ self, context }) => sawKey(context, "validate", self.seq, self.what) code="watch" message="watch"
      do
        run({ self, context }) {
          sawKey(context, "do", self.seq, self.what);
        }
        run [after=:write] ({ self, context }) {
          sawKey(context, "after", self.seq, null);
        }
`;
const tag = `import { sawKey } from "./helpers"
entity :Tag table="tags"
  attributes
    string :code primary-key
    string :label min=1
  actions auto=[:read]
    create :make
      input
        &label
      validate
        check :watch that=({ self, context }) => sawKey(context, "validate", self.code, self.label) code="watch" message="watch"
`;

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};

let dir: string;
let app: any;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".validate-self-"));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  await Bun.write(join(dir, "src/domain/helpers.ts"), helpers);
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ person, note, event, tag }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  // `binding.ts` imports the project's config, which is not part of this fixture.
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  app = await import(join(dir, ".mesh/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-11T10:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Seen = { phase: string; self?: any; input?: any; sent?: string[]; before?: any; key?: unknown; other?: unknown };

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  const seen: Seen[] = [];
  const ctx = { actor: { id: "a" }, seen };
  const mesh = app.bind(db, { clock: () => NOW });
  const ada = await mesh.joinPerson({ name: "Ada" }, ctx);
  const bo = await mesh.joinPerson({ name: "Bo" }, ctx);
  return { db, mesh, ctx, seen, ada, bo };
}
type World = Awaited<ReturnType<typeof fresh>>;
const phase = (world: World, name: string) => world.seen.filter((entry) => entry.phase === name);
/** Write a note and forget what its phases saw. */
async function written(world: World, extra: Record<string, unknown> = {}) {
  const row = await world.mesh.writeNote({ title: "first", body: "hello", priority: 5, owner: world.ada.id, ...extra }, world.ctx);
  world.seen.length = 0;
  return row;
}
async function invalid(call: Promise<unknown>): Promise<InvalidInputError> {
  try { await call; } catch (error) { expect(error).toBeInstanceOf(InvalidInputError); return error as InvalidInputError; }
  throw new Error("expected the call to reject");
}
const labels = (error: InvalidInputError) => error.issues.map((issue: Issue) => issue.label);

describe("the generated files", () => {
  test("type-check under the strictest flags a consuming project might use", async () => {
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", ...files,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
  });
});

describe("create: validate sees the new instance, do sees the input applied", () => {
  test("validate: the uuid key filled, the defaults and the stamp, null where the input will go; the caller's values in input", async () => {
    const world = await fresh();
    try {
      const row = await world.mesh.writeNote({ title: "first", body: "hello", priority: 5, owner: world.ada.id }, world.ctx);
      const [check] = phase(world, "validate");
      expect(check!.self.id).toMatch(UUID);
      expect(check!.self).toEqual({ id: check!.self.id, title: null, body: null, priority: 3, state: "draft", ownerId: null, createdAt: NOW });
      expect(check!.input).toEqual({ title: "first", body: "hello", priority: 5, owner: world.ada.id });
      // The always block sees the same instance, first.
      expect(world.seen.map((entry) => entry.phase)).toEqual(["always", "validate", "do", "after"]);
      expect(phase(world, "always")[0]!.self).toEqual(check!.self);
      // The key Mesh filled for the checks is the key the row is stored under.
      expect(row.id).toBe(check!.self.id);
      expect((await world.mesh.readNote({}, world.ctx)).map((note: { id: string }) => note.id)).toEqual([check!.self.id]);
    } finally { await world.db.close(); }
  });

  test("do: the member inputs are applied, the same key, and before is null; after the write, self is the stored row", async () => {
    const world = await fresh();
    try {
      const row = await world.mesh.writeNote({ title: "first", body: "hello", priority: 5, owner: world.ada.id }, world.ctx);
      const id = phase(world, "validate")[0]!.self.id;
      const [step] = phase(world, "do");
      expect(step!.self).toEqual({ id, title: "first", body: "hello", priority: 5, state: "draft", ownerId: world.ada.id, createdAt: NOW });
      expect(step!.before).toBeNull();
      const [after] = phase(world, "after");
      expect(after!.self).toEqual(step!.self);
      expect(after!.before).toBeNull();
      expect(row).toMatchObject({ id, title: "first", body: "hello", priority: 5, ownerId: world.ada.id });
    } finally { await world.db.close(); }
  });

  test("an input the caller leaves out keeps the instance's default in do; a nullable one sent as null stays null", async () => {
    const world = await fresh();
    try {
      const row = await world.mesh.writeNote({ title: "t", body: null, owner: world.ada.id }, world.ctx);
      const [check] = phase(world, "validate");
      expect(check!.sent).toEqual(["body", "owner", "title"]);
      expect(check!.input.body).toBeNull();
      expect(phase(world, "do")[0]!.self).toMatchObject({ priority: 3, body: null });
      expect(row).toMatchObject({ priority: 3, body: null });
    } finally { await world.db.close(); }
  });

  test("a check that reads a related record goes through tx with input.owner, since &owner is not there yet (POL-08)", async () => {
    const world = await fresh();
    try {
      const error = await invalid(world.mesh.writeNote({ title: "t", owner: "00000000-0000-7000-8000-000000000000" }, world.ctx));
      expect(labels(error)).toEqual(["ownerExists"]);
      expect(phase(world, "do")).toEqual([]);
      expect(await world.mesh.readNote({}, world.ctx)).toEqual([]);
    } finally { await world.db.close(); }
  });

  test("a failed check stores nothing and runs no step: the input was never applied", async () => {
    const world = await fresh();
    try {
      const error = await invalid(world.mesh.writeNote({ title: "STOP", owner: world.ada.id }, world.ctx));
      expect(labels(error)).toEqual(["titleNotShouting"]);
      expect(world.seen.map((entry) => entry.phase)).toEqual(["always", "validate"]);
      expect(await world.mesh.readNote({}, world.ctx)).toEqual([]);
    } finally { await world.db.close(); }
  });
});

describe("update: validate sees the stored record, do sees the input applied", () => {
  test("a partial input: validate sees the stored record and only what was sent; do sees it applied and before the stored record", async () => {
    const world = await fresh();
    try {
      const row = await written(world);
      const stored = { id: row.id, title: "first", body: "hello", priority: 5, state: "draft", ownerId: world.ada.id, createdAt: NOW };
      const edited = await world.mesh.editNote({ id: row.id, title: "second" }, world.ctx);
      const [check] = phase(world, "validate");
      expect(check!.self).toEqual(stored);
      expect(check!.sent).toEqual(["id", "title"]);
      expect(check!.input.title).toBe("second");
      expect(phase(world, "always")[0]!.self).toEqual(stored);
      const [step] = phase(world, "do");
      expect(step!.self).toEqual({ ...stored, title: "second" });
      expect(step!.before).toEqual(stored);
      expect(phase(world, "after")[0]!.before).toEqual(stored);
      expect(edited).toMatchObject({ title: "second", body: "hello", priority: 5 });
    } finally { await world.db.close(); }
  });

  test("a field not sent: input.x ?? &x is the stored value, so the always check passes on a stored title and fails on a sent one", async () => {
    const world = await fresh();
    try {
      const row = await written(world);
      expect((await world.mesh.editNote({ id: row.id, priority: 1 }, world.ctx)).priority).toBe(1);
      const error = await invalid(world.mesh.editNote({ id: row.id, title: "STOP" }, world.ctx));
      expect(labels(error)).toEqual(["titleNotShouting"]);
      expect(phase(world, "do")).toHaveLength(1);
      expect((await world.mesh.readNote({}, world.ctx))[0]).toMatchObject({ title: "first", priority: 1 });
    } finally { await world.db.close(); }
  });

  test("a nullable field sent as null: input has null, self the stored value until do, and the row stores null", async () => {
    const world = await fresh();
    try {
      const row = await written(world);
      const edited = await world.mesh.editNote({ id: row.id, body: null }, world.ctx);
      const [check] = phase(world, "validate");
      expect(check!.sent).toEqual(["body", "id"]);
      expect(check!.input.body).toBeNull();
      expect(check!.self.body).toBe("hello");
      expect(phase(world, "do")[0]!.self.body).toBeNull();
      expect(phase(world, "do")[0]!.before.body).toBe("hello");
      expect(edited.body).toBeNull();
    } finally { await world.db.close(); }
  });

  test("the trap: `input.body ?? &body` reads a body sent as null like one not sent; a plain check tells them apart", async () => {
    const world = await fresh();
    try {
      const loose = await written(world, { body: "locked" });
      // Translated: changing the locked body is refused, leaving it out passes...
      expect(labels(await invalid(world.mesh.editNote({ id: loose.id, body: "other" }, world.ctx)))).toEqual(["keepsLocked"]);
      expect((await world.mesh.editNote({ id: loose.id, title: "kept" }, world.ctx)).body).toBe("locked");
      // ...and clearing it passes too, because `null ?? "locked"` is "locked": the check cannot see the null.
      expect((await world.mesh.editNote({ id: loose.id, body: null }, world.ctx)).body).toBeNull();

      const strict = await written(world, { body: "locked" });
      expect(labels(await invalid(world.mesh.editStrictNote({ id: strict.id, body: "other" }, world.ctx)))).toEqual(["keepsLocked"]);
      expect(labels(await invalid(world.mesh.editStrictNote({ id: strict.id, body: null }, world.ctx)))).toEqual(["keepsLocked"]);
      expect((await world.mesh.editStrictNote({ id: strict.id }, world.ctx)).body).toBe("locked");
    } finally { await world.db.close(); }
  });
});

describe("destroy", () => {
  test("validate sees the stored record and the input; do sees it too, with before the stored record", async () => {
    const world = await fresh();
    try {
      const row = await written(world);
      expect(await world.mesh.dropNote({ id: row.id }, world.ctx)).toBeUndefined();
      const stored = { id: row.id, title: "first", body: "hello", priority: 5, state: "draft", ownerId: world.ada.id, createdAt: NOW };
      expect(phase(world, "validate")[0]).toMatchObject({ self: stored, sent: ["id"] });
      expect(phase(world, "do")[0]).toMatchObject({ self: stored, before: stored });
      expect(await world.mesh.readNote({}, world.ctx)).toEqual([]);
    } finally { await world.db.close(); }
  });

  test("a check on the stored state refuses the destroy and deletes nothing", async () => {
    const world = await fresh();
    try {
      const row = await written(world);
      await world.mesh.publishNote({ id: row.id }, world.ctx);
      expect(labels(await invalid(world.mesh.dropNote({ id: row.id }, world.ctx)))).toEqual(["draftOnly"]);
      expect(await world.mesh.readNote({}, world.ctx)).toHaveLength(1);
    } finally { await world.db.close(); }
  });
});

describe("composition: an action called through actions or tx checks the record it finds", () => {
  test("a run after the write calls publish, whose check sees the stored new row; a second publish is refused", async () => {
    const world = await fresh();
    try {
      const row = await world.mesh.writeLiveNote({ title: "live", owner: world.ada.id }, world.ctx);
      const [check] = phase(world, "validate publish");
      expect(check!.self).toMatchObject({ id: row.id, title: "live", state: "draft", ownerId: world.ada.id });
      expect(row.state).toBe("live");
      expect(labels(await invalid(world.mesh.publishNote({ id: row.id }, world.ctx)))).toEqual(["draftOnly"]);
    } finally { await world.db.close(); }
  });

  test("in one transaction, an edit after a create sees the row the create wrote, not the edit's input", async () => {
    const world = await fresh();
    try {
      const result = await world.mesh.transaction(async ({ actions, tx }: any) => {
        const made = await actions.writeNote({ title: "a", owner: world.bo.id });
        world.seen.length = 0;
        await actions.editNote({ id: made.id, title: "b" });
        return (await tx.readNote({ filter: { id: { eq: made.id } } }))[0];
      }, world.ctx);
      expect(phase(world, "validate")[0]).toMatchObject({ self: { id: result.id, title: "a", ownerId: world.bo.id }, input: { id: result.id, title: "b" } });
      expect(phase(world, "do")[0]!.self.title).toBe("b");
      expect(result.title).toBe("b");
    } finally { await world.db.close(); }
  });
});

describe("the key on a create", () => {
  test("an integer key is null in validate and in do, and set after the write; the data layer counts from 1", async () => {
    const world = await fresh();
    try {
      const first = await world.mesh.logEvent({ what: "x" }, world.ctx);
      const second = await world.mesh.logEvent({ what: "y" }, world.ctx);
      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(world.seen.map(({ phase, key, other }) => [phase, key, other])).toEqual([
        ["validate", null, null], ["do", null, "x"], ["after", 1, null],
        ["validate", null, null], ["do", null, "y"], ["after", 2, null],
      ]);
    } finally { await world.db.close(); }
  });

  test("a string key is filled like a uuid one when Mesh builds the instance, and is the key stored", async () => {
    const world = await fresh();
    try {
      const made = await world.mesh.makeTag({ label: "l" }, world.ctx);
      const [check] = world.seen;
      expect(check).toMatchObject({ phase: "validate", other: null });
      expect(check!.key).toMatch(UUID);
      expect(made.code).toBe(check!.key);
    } finally { await world.db.close(); }
  });

  test("two creates in a row get two different keys, each known in validate", async () => {
    const world = await fresh();
    try {
      const a = await world.mesh.writeNote({ title: "a", owner: world.ada.id }, world.ctx);
      const b = await world.mesh.writeNote({ title: "b", owner: world.ada.id }, world.ctx);
      const keys = phase(world, "validate").map((entry) => entry.self.id);
      expect(keys).toEqual([a.id, b.id]);
      expect(a.id).not.toBe(b.id);
    } finally { await world.db.close(); }
  });
});

describe("before is gone from validate", () => {
  test("a check that reads before is a build error with MESH_VALIDATE_BEFORE, and says what to write instead", () => {
    const source = note.replace("check :draftOnly that=() => &state === :draft code=\"note.live\" message=\"only a draft can be published\"",
      "check :draftOnly that=({ before }) => before.state === :draft code=\"note.live\" message=\"only a draft can be published\"");
    expect(source).not.toBe(note);
    const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ person, note: source }).map(([name, text]) => ({ file: `src/domain/${name}.mesh.mx`, source: text })) });
    const errors = built.diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toEqual(["MESH_VALIDATE_BEFORE"]);
    expect(errors[0]!.message).toContain("`before` is gone from `validate`");
    expect(errors[0]!.message).toContain("the caller's values are `input.x`");
  });
});
