// A read policy that reads the record is a condition on each row (M10): the build lowers each of its functions to a
// condition literal, the authorizer evaluates what does not read the record in memory, binds the rest and combines them
// row by row, and the read (or a caller's load) hands SQLite the result as `where`. The domain is built, generated,
// type-checked under the strictest flags and called against `:memory:` SQLite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, Mesh, type DataLayer, type DataOperations } from "@meshfw/runtime";
import { callsOf } from "./calls.ts";
import build from "../src/build.ts";
import { capabilities, createSchema, sqlite } from "../src/index.ts";

const privilegedOf = (entity: unknown): any => Mesh.privileged(entity as never);

const helpers = "export const lookup = (id: string | null): string | null => id;\n";
// A team is open to every caller; what it loads runs the read policies of the docs it reaches.
const team = `import { Doc } from "./doc.mesh.mx"
entity :Team table="teams"
  attributes
    uuid :id primary-key
    uuid :ownerId
    string :name
  relationships
    has-many :docs entity=Doc
  computed
    integer :docTotal() { return &docs.length }
    count :docCount of=&docs
    max :topScore of=&docs.score
    sum :scoreSum of=&docs.score
    min :lowScore of=&docs.score
    count :tagCount of=&docs.tags
  actions auto=[:read]
  policies
    policy :anyone types=[:read]
      authorize-if=() => true
`;
// A doc is the caller's when its team is theirs or it is not secret, and never when its score is negative or unknown;
// a draft (a when that reads the record) is an admin's only. `:signedIn` reads only the actor.
const doc = `import { Team } from "./team.mesh.mx"
import { Tag } from "./tag.mesh.mx"
import { Tagging } from "./tagging.mesh.mx"
import { lookup } from "./helpers"
entity :Doc table="docs"
  attributes
    uuid :id primary-key
    string :title
    boolean :secret
    integer :score nullable
  relationships
    belongs-to :team entity=Team
    has-many :tags entity=Tag through=Tagging
  computed
    count :tagTotal of=&tags
    max :teamTop of=&team.docs.score
  actions auto=[:read]
    read :ranked
      sort
        desc &score
    read :titled
      input
        string :title
      filter=({ input }) => &title === input.title
  policies
    policy :visible types=[:read]
      authorize-if=({ actor }) => &team.ownerId === lookup(actor.id)
      authorize-if=() => &secret === false
      forbid-if=() => &score < 0
    policy :drafts types=[:read] when=() => &title === "draft"
      authorize-if=({ actor }) => actor.admin === true
    policy :signedIn types=[:read]
      authorize-if=({ actor }) => actor.id !== null
`;
const tag = `entity :Tag table="tags"
  attributes
    uuid :id primary-key
    string :label
    boolean :hidden
  actions auto=[:read]
  policies
    policy :shown types=[:read]
      authorize-if=() => &hidden === false
`;
const tagging = `import { Doc } from "./doc.mesh.mx"
import { Tag } from "./tag.mesh.mx"
entity :Tagging table="taggings"
  attributes
    uuid :id primary-key
    boolean :active
  relationships
    belongs-to :doc entity=Doc
    belongs-to :tag entity=Tag
  actions auto=[:read]
  policies
    policy :live types=[:read]
      authorize-if=() => &active === true
`;

async function generate(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, ".scratch-read-policies-"));
  const data: ResolvedConfig["data"] = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities, options: { file: ":memory:" } };
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data };
  await mkdir(join(dir, "src/domain"), { recursive: true });
  await Bun.write(join(dir, "src/domain/helpers.ts"), helpers);
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries({ team, doc, tag, tagging }).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string | null; admin?: boolean };\n  }\n}\nexport {};\n');
  return dir;
}

let dir: string;
let app: any;
let domain: any;
beforeAll(async () => {
  dir = await generate();
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const alice = { actor: { id: id(91) } };
const bob = { actor: { id: id(92) } };
const admin = { actor: { id: id(92), admin: true } };
const nobody = { actor: { id: null } };

/**
 * Team t1 (owner 91) holds d1 "plan" (secret, 5), d2 "draft" (secret, 7), d3 "memo" (public, score unknown); team t2
 * (owner 92) holds d4 "notes" (public, 3), d5 "old" (secret, -1). d1 is tagged a (shown, live link) and b (hidden), d4
 * is tagged a through a link that is not live, and c (shown).
 */
async function seed(tx: DataOperations) {
  await tx.insert(app.tables.teams, { id: id(1), ownerId: id(91), name: "t1" });
  await tx.insert(app.tables.teams, { id: id(2), ownerId: id(92), name: "t2" });
  await tx.insert(app.tables.docs, { id: id(11), title: "plan", secret: true, score: 5, teamId: id(1) });
  await tx.insert(app.tables.docs, { id: id(12), title: "draft", secret: true, score: 7, teamId: id(1) });
  await tx.insert(app.tables.docs, { id: id(13), title: "memo", secret: false, score: null, teamId: id(1) });
  await tx.insert(app.tables.docs, { id: id(14), title: "notes", secret: false, score: 3, teamId: id(2) });
  await tx.insert(app.tables.docs, { id: id(15), title: "old", secret: true, score: -1, teamId: id(2) });
  await tx.insert(app.tables.tags, { id: id(31), label: "a", hidden: false });
  await tx.insert(app.tables.tags, { id: id(32), label: "b", hidden: true });
  await tx.insert(app.tables.tags, { id: id(33), label: "c", hidden: false });
  await tx.insert(app.tables.taggings, { id: id(41), active: true, docId: id(11), tagId: id(31) });
  await tx.insert(app.tables.taggings, { id: id(42), active: true, docId: id(11), tagId: id(32) });
  await tx.insert(app.tables.taggings, { id: id(43), active: false, docId: id(14), tagId: id(31) });
  await tx.insert(app.tables.taggings, { id: id(44), active: true, docId: id(14), tagId: id(33) });
}

/** A seeded `:memory:` database, with a layer that counts the transactions opened on it (it keeps the manifest). */
async function seeded() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  await db.transaction(seed);
  const counts = { transactions: 0 };
  const counted = {
    transaction: (run: (tx: DataOperations) => Promise<unknown>) => { counts.transactions += 1; return db.transaction(run); },
    refuseIfFailed: () => db.refuseIfFailed(),
    close: () => db.close(),
    capabilities: (db as { capabilities?: unknown }).capabilities,
  } as unknown as DataLayer;
  const binding = app.bind(counted);
  return { db, binding, counts, mesh: callsOf(binding, domain) };
}
const titles = (rows: readonly { title: string }[]) => rows.map((row) => row.title).sort();

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

  test("the load plan reads each condition when a load runs, never when it loads", async () => {
    const load = await Bun.file(join(dir, ".mesh/load.ts")).text();
    expect(load).toContain("$conditions as $Doc$conditions");
    expect(load).toContain('sql: () => $Doc$conditions["policy.visible.authorize-if.0"]');
    // A fresh process that enters the import cycle through an expressions file, then reads a condition from the plan:
    // no temporal dead zone at module load, and the thunk reaches the literal.
    const script = `const e = await import(${JSON.stringify(join(dir, ".mesh/domain/doc.expressions.ts"))});
const { loadPlan } = await import(${JSON.stringify(join(dir, ".mesh/load.ts"))});
console.log(Object.keys(e.$conditions).join(","), loadPlan.Doc.reads[0].checks[0].sql().what);`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: dir });
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString().trim()).toBe("read.titled.filter,policy.visible.authorize-if.0,policy.visible.authorize-if.1,policy.visible.forbid-if.0,policy.drafts.when policy :visible authorize-if of Doc");
  });
});

describe("a read whose policies read the record returns only the rows they admit", () => {
  test("through the auto read and a declared read, combined with the read's own filter and sort", async () => {
    const { db, mesh } = await seeded();
    try {
      // alice owns t1: plan (hers), memo is public but its score is unknown (forbid-if unknown forbids), draft is an
      // admin's only; from t2, notes is public; old is secret and negative.
      expect(titles(await mesh.readDoc({}, alice))).toEqual(["notes", "plan"]);
      expect(titles(await mesh.readDoc({}, bob))).toEqual(["notes"]);
      // The admin owns t2: notes; old is forbidden by its score; the draft is not theirs and secret.
      expect(titles(await mesh.readDoc({}, admin))).toEqual(["notes"]);
      expect((await mesh.rankedDoc({}, alice)).map((row: { title: string }) => row.title)).toEqual(["plan", "notes"]);
      expect(titles(await mesh.titledDoc({ title: "plan" }, alice))).toEqual(["plan"]);
      expect(await mesh.titledDoc({ title: "plan" }, bob)).toEqual([]);
      // The caller's own filter narrows it further.
      expect(titles(await mesh.readDoc({ filter: { score: { gte: 4 } } }, alice))).toEqual(["plan"]);
    } finally { await db.close(); }
  });

  test("a when that reads the record applies the policy to the rows it holds for", async () => {
    const { db, mesh } = await seeded();
    try {
      await db.transaction((tx) => tx.updateByKey(app.tables.docs, { id: id(12) }, { secret: false }));
      // The draft is public now: alice may see it under :visible, but :drafts applies to it and she is no admin.
      expect(titles(await mesh.readDoc({}, alice))).toEqual(["notes", "plan"]);
      expect(titles(await mesh.readDoc({}, admin))).toEqual(["draft", "notes"]);
    } finally { await db.close(); }
  });

  test("an actor-only denial gives no rows with no transaction; Mesh.privileged runs no policy", async () => {
    const { db, binding, counts, mesh } = await seeded();
    try {
      counts.transactions = 0;
      expect(await mesh.readDoc({}, nobody)).toEqual([]);
      expect(await mesh.rankedDoc({}, nobody)).toEqual([]);
      expect(counts.transactions).toBe(0);
      expect(titles(await binding.run(() => privilegedOf(domain.Doc).read({}, nobody)))).toEqual(["draft", "memo", "notes", "old", "plan"]);
      expect(titles(await binding.run(() => privilegedOf(domain.Doc).titled({ title: "old" }, nobody)))).toEqual(["old"]);
    } finally { await db.close(); }
  });

  test("Mesh.can on the read answers whether it is allowed at all: what reads the record is part of the query", async () => {
    const { db, binding } = await seeded();
    try {
      expect(await binding.run(() => Mesh.can(domain.Doc.read, {}, alice as never))).toBe(true);
      expect(await binding.run(() => Mesh.can(domain.Doc.read, {}, nobody as never))).toBe(false);
      const decision = await binding.run(() => Mesh.checkPolicies(domain.Doc.read, {}, alice as never));
      expect(decision.allowed).toBe(true);
      // Only the checks that ran: the actor-only `:signedIn`.
      expect(decision.breakdown.map((check: { policy: string }) => check.policy)).toEqual(["signedIn"]);
    } finally { await db.close(); }
  });
});

describe("a caller's load keeps only the related rows the policies admit", () => {
  test("a has-many lists fewer rows, a body still counts every row, and a rollup counts or maxes the admitted ones", async () => {
    const { db, mesh } = await seeded();
    try {
      const [t1, t2] = await mesh.readTeam({ sort: ["name"], load: ["docs", "docTotal", "docCount", "topScore"] }, alice);
      expect(titles(t1.docs)).toEqual(["plan"]);
      expect(t1).toMatchObject({ docTotal: 3, docCount: 1, topScore: 5 });
      expect(titles(t2.docs)).toEqual(["notes"]);
      expect(t2).toMatchObject({ docTotal: 2, docCount: 1, topScore: 3 });
      // Asked without the body, the same.
      const [plain] = await mesh.readTeam({ sort: ["name"], load: ["docs", "docCount"] }, bob);
      expect(plain.docs).toEqual([]);
      expect(plain.docCount).toBe(0);
    } finally { await db.close(); }
  });

  test("a belongs-to the policies exclude is null; a dangling key is still the error", async () => {
    const { db, mesh } = await seeded();
    try {
      // The taggings bob may read (43 is not live); their doc: d11 is alice's and secret, d14 is public.
      const links = await mesh.readTagging({ sort: ["id"], load: ["doc", "tag"] }, bob);
      expect(links.map((link: { doc: { title: string } | null; tag: { label: string } | null }) => [link.doc?.title ?? null, link.tag?.label ?? null]))
        .toEqual([[null, "a"], [null, null], ["notes", "c"]]);
      await db.transaction((tx) => tx.insert(app.tables.taggings, { id: id(45), active: true, docId: id(99), tagId: id(33) }));
      await expect(mesh.readTagging({ load: ["doc"] }, bob)).rejects.toThrow(/points at Doc .*99", which does not exist/);
    } finally { await db.close(); }
  });

  test("a has-many through applies the link entity's policies and the far entity's both", async () => {
    const { db, mesh } = await seeded();
    try {
      const docs = await mesh.readDoc({ sort: ["title"], load: ["tags"] }, alice);
      // plan: a (b is hidden); notes: c (a goes through a link that is not live).
      expect(docs.map((row: { title: string; tags: { label: string }[] }) => [row.title, row.tags.map((t) => t.label)])).toEqual([["notes", ["c"]], ["plan", ["a"]]]);
      // A far key that names no row is still the error.
      await db.transaction((tx) => tx.insert(app.tables.taggings, { id: id(46), active: true, docId: id(11), tagId: id(98) }));
      await expect(mesh.readDoc({ load: ["tags"] }, alice)).rejects.toThrow(/which does not exist/);
    } finally { await db.close(); }
  });

  test("a batched rollup aggregates only the rows each entity of its path admits, a link entity's included", async () => {
    const { db, binding, mesh } = await seeded();
    try {
      const load = ["scoreSum", "lowScore", "tagCount"] as const;
      const values = (rows: Record<string, unknown>[], names: readonly string[]) => rows.map((row) => names.map((name) => row[name]));
      // One table (docs), and a joined route: the docs, their live links, the shown tags. alice may read plan and notes;
      // plan's live links reach a (shown) and b (hidden); notes reaches c, and a only through a link that is not live.
      expect(values(await mesh.readTeam({ sort: ["name"], load }, alice), load)).toEqual([[5, 5, 1], [3, 3, 1]]);
      expect(values(await mesh.readTeam({ sort: ["name"], load }, bob), load)).toEqual([[null, null, 0], [3, 3, 1]]);
      // A through relationship; a route that starts at a belongs-to (the doc's team, whose read admits every caller).
      const docLoad = ["tagTotal", "teamTop"] as const;
      expect(values(await mesh.readDoc({ sort: ["title"], load: docLoad }, alice), docLoad)).toEqual([[1, 3], [1, 5]]);
      expect(values(await mesh.readDoc({ sort: ["title"], load: docLoad }, bob), docLoad)).toEqual([[1, 3]]);
      // Through Mesh.privileged no policy runs: every doc, link and tag counts.
      const all = await binding.run(() => privilegedOf(domain.Team).read({ sort: ["name"], load }, nobody));
      expect(values(all, load)).toEqual([[12, 5, 2], [2, -1, 2]]);
      const plan = (await binding.run(() => privilegedOf(domain.Doc).read({ filter: { title: { eq: "plan" } }, load: docLoad }, nobody)))[0];
      expect([plan.tagTotal, plan.teamTop]).toEqual([2, 7]);
    } finally { await db.close(); }
  });

  test("a parameter that is a helper's result is bound; one of the wrong class is refused, not compared by SQLite", async () => {
    const { db, mesh } = await seeded();
    try {
      // `lookup(actor.id)` is a parameter; the runtime policy tests pin the frame mark around it.
      expect(titles(await mesh.readDoc({ filter: { title: { eq: "plan" } } }, alice))).toEqual(["plan"]);
      const error = await mesh.readDoc({}, { actor: { id: 7 } }).then(() => undefined, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(FrameworkError);
      expect(String((error as Error).message)).toContain("the database would convert it, so Mesh refuses it");
    } finally { await db.close(); }
  });
});
