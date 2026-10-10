// M7: relationships and computed fields load through a second query, in memory, or through the data layer's
// count and max. The domain is built, generated, pushed to SQLite and loaded through the generated functions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { CHUNK, FrameworkError, type DataOperations } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const author = `import { Post } from "./post.mesh.mx"
import { Profile } from "./profile.mesh.mx"
import { Orphan } from "./orphan.mesh.mx"
import { Comment } from "./comment.mesh.mx"
entity :Author table="authors"
  attributes
    uuid :id primary-key
    string :name
    boolean :retired default=false
  relationships
    has-many :posts entity=Post via=:author
    has-many :reviews entity=Post via=:reviewer
    has-one :profile entity=Profile
    has-many :orphans entity=Orphan
  computed
    count :postCount of="posts"
    max :lastPostedAt of="posts.postedAt"
    max :topScore of="posts.score"
    boolean :prolific() { return &postCount > 1 }
  actions auto=[:read]
`;
const post = `import { Author } from "./author.mesh.mx"
import { Comment } from "./comment.mesh.mx"
entity :Post table="posts"
  attributes
    uuid :id primary-key
    string :title
    integer :score nullable
    timestamp :postedAt
  relationships
    belongs-to :author entity=Author
    belongs-to :reviewer entity=Author nullable
    belongs-to :replyTo entity=Post nullable
    has-many :replies entity=Post via=:replyTo
    has-many :comments entity=Comment
  computed
    boolean :answered() { return &replies.length > 0 }
    boolean :hasPinned() { return &comments.some((c) => c.pinned) }
    string :authorName() { return &author.name }
    boolean :authorIsProlific() { return &author.prolific }
    boolean :reviewedBySelf() { return &reviewer?.name === &author.name }
    boolean :isOld() { return &postedAt < now() }
    boolean :lonely() { return &replyTo === null && &replies.length === 0 }
    string :replyToAnswered() { return JSON.stringify(&replyTo?.answered) }
    string :grandReplyToAnswered() { return JSON.stringify(&replyTo?.replyTo?.answered) }
    string :viaVariable() { const parent = &replyTo; return JSON.stringify(parent?.answered) }
    string :plainTitle() { return JSON.stringify(&title) }
  actions auto=[:read]
`;
const comment = `import { Post } from "./post.mesh.mx"
entity :Comment table="comments"
  attributes
    uuid :id primary-key
    string :body
    boolean :pinned default=false
  relationships
    belongs-to :post entity=Post
`;
const profile = `import { Author } from "./author.mesh.mx"
entity :Profile table="profiles"
  attributes
    uuid :id primary-key
    string :bio
  relationships
    belongs-to :author entity=Author
`;
const orphan = `entity :Orphan table="orphans"
  attributes
    uuid :id primary-key
`;
const ticket = `entity :Ticket table="tickets"
  attributes
    integer :id primary-key
    string :title
  relationships
    belongs-to :duplicateOf entity=Ticket nullable
    has-many :duplicates entity=Ticket via=:duplicateOf
  computed
    count :duplicateCount of="duplicates"
  actions auto=[:read]
`;

type Row = Record<string, any>;
interface Generated {
  loadAuthorFields(tx: DataOperations, rows: readonly Row[], names: readonly string[], options?: object): Promise<Row[]>;
  loadPostFields(tx: DataOperations, rows: readonly Row[], names: readonly string[], options?: object): Promise<Row[]>;
  loadCommentFields(tx: DataOperations, rows: readonly Row[], names: readonly string[], options?: object): Promise<Row[]>;
  loadProfileFields(tx: DataOperations, rows: readonly Row[], names: readonly string[], options?: object): Promise<Row[]>;
  loadTicketFields(tx: DataOperations, rows: readonly Row[], names: readonly string[], options?: object): Promise<Row[]>;
  bind(layer: ReturnType<typeof sqlite>): any;
  tables: Record<string, any>;
}

let dir: string;
let app: Generated;
let expressions: Record<string, Record<string, (s: never) => unknown>>;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".load-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" } },
  };
  const files = { author, post, comment, profile, orphan, ticket };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(files).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  app = await import(join(dir, ".mesh/index.ts")) as Generated;
  expressions = { post: (await import(join(dir, ".mesh/post.expressions.ts"))).expressions };
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (ms: number) => new Date(ms);

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  return db;
}

/** A transaction whose reads are counted, by table and operation. */
function counted(tx: DataOperations) {
  const calls: string[] = [];
  const wrap = <K extends "select" | "count" | "max">(name: K): DataOperations[K] =>
    (async (table: object, ...rest: never[]) => {
      calls.push(name);
      return (tx[name] as (...args: unknown[]) => unknown)(table, ...rest);
    }) as never;
  return { tx: { ...tx, select: wrap("select"), count: wrap("count"), max: wrap("max") } as DataOperations, calls };
}

async function seed(tx: DataOperations) {
  const t = app.tables;
  await tx.insert(t.author, { id: id(1), name: "Ada", retired: false });
  await tx.insert(t.author, { id: id(2), name: "Bo", retired: false });
  await tx.insert(t.author, { id: id(3), name: "Cy", retired: true });
  await tx.insert(t.profile, { id: id(1), bio: "mathematician", authorId: id(1) });
  // Ada: p1 (score 5), p2 (no score). Bo: p3 (score 9), reviewed by Ada. Cy: nothing.
  await tx.insert(t.post, { id: id(11), title: "p1", score: 5, postedAt: at(1_000), authorId: id(1), reviewerId: null, replyToId: null });
  await tx.insert(t.post, { id: id(12), title: "p2", score: null, postedAt: at(3_000), authorId: id(1), reviewerId: null, replyToId: id(11) });
  await tx.insert(t.post, { id: id(13), title: "p3", score: 9, postedAt: at(2_000), authorId: id(2), reviewerId: id(1), replyToId: id(11) });
  await tx.insert(t.comment, { id: id(21), body: "first", pinned: false, postId: id(11) });
  await tx.insert(t.comment, { id: id(22), body: "second", pinned: true, postId: id(11) });
  await tx.insert(t.comment, { id: id(23), body: "third", pinned: false, postId: id(13) });
}

const run = async <T>(db: ReturnType<typeof sqlite>, work: (tx: DataOperations) => Promise<T>) => db.transaction(work);
const rowsOf = (tx: DataOperations, table: string) => tx.select(app.tables[table]);

describe("belongs-to", () => {
  test("a required belongs-to loads the record, and a null key on a nullable one loads null", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const posts = await rowsOf(tx, "post");
        const loaded = await app.loadPostFields(tx, posts, ["author", "reviewer", "replyTo"]);
        expect(loaded.map((p) => [p.title, p.author.name, p.reviewer?.name ?? null, p.replyTo?.title ?? null])).toEqual([
          ["p1", "Ada", null, null], ["p2", "Ada", null, "p1"], ["p3", "Bo", "Ada", "p1"],
        ]);
        expect(loaded[0]!.reviewer).toBeNull();
        // The loaded record is the stored row, nothing added.
        expect(loaded[0]!.author).toEqual(await tx.selectByKey(app.tables.author, { id: id(1) }));
      });
    } finally { await db.close(); }
  });

  test("the rows passed in are not changed, and only the named fields are on the result", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const posts = await rowsOf(tx, "post");
        const before = structuredClone(posts);
        const [first] = await app.loadPostFields(tx, posts, ["authorName"]);
        expect(posts).toEqual(before);
        expect(Object.keys(first!).sort()).toEqual([...Object.keys(before[0]!), "authorName"].sort());
        expect(first!.authorName).toBe("Ada");
        expect("author" in first!).toBe(false);
      });
    } finally { await db.close(); }
  });

  test("an empty list of rows makes no query", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        const { tx: counting, calls } = counted(tx);
        expect(await app.loadPostFields(counting, [], ["author", "comments", "answered"])).toEqual([]);
        expect(calls).toEqual([]);
      });
    } finally { await db.close(); }
  });

  test("a key that points at no row is an error that names it, not a null", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await tx.insert(app.tables.post, { id: id(11), title: "lost", score: null, postedAt: at(1), authorId: id(99), reviewerId: null, replyToId: null });
        await expect(app.loadPostFields(tx, await rowsOf(tx, "post"), ["author"])).rejects.toThrow(
          `belongs-to :author of :Post points at Author "${id(99)}", which does not exist`);
      });
    } finally { await db.close(); }
  });

  test("one query serves every row, and a long list is a query per chunk of keys", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const { tx: counting, calls } = counted(tx);
        await app.loadPostFields(counting, await rowsOf(tx, "post"), ["author", "reviewer", "replyTo"]);
        expect(calls).toEqual(["select", "select", "select"]);
        const many = CHUNK * 2 + 1;
        for (let n = 0; n < many; n++) await tx.insert(app.tables.author, { id: id(1000 + n), name: `a${n}`, retired: false });
        for (let n = 0; n < many; n++) await tx.insert(app.tables.profile, { id: id(5000 + n), bio: `b${n}`, authorId: id(1000 + n) });
        const profiles = await rowsOf(tx, "profile");
        const { tx: counting2, calls: calls2 } = counted(tx);
        const loaded = await app.loadProfileFields(counting2, profiles, ["author"]);
        expect(calls2).toEqual(["select", "select", "select"]);
        expect(loaded.every((p) => p.author.id === p.authorId)).toBe(true);
      });
    } finally { await db.close(); }
  });
});

describe("has-many and has-one", () => {
  test("a has-many loads its rows in primary-key order, empty when there are none", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const authors = await rowsOf(tx, "author");
        const loaded = await app.loadAuthorFields(tx, authors, ["posts"]);
        expect(loaded.map((a) => [a.name, a.posts.map((p: Row) => p.title)])).toEqual([["Ada", ["p1", "p2"]], ["Bo", ["p3"]], ["Cy", []]]);
        expect(Array.isArray(loaded[2]!.posts)).toBe(true);
      });
    } finally { await db.close(); }
  });

  test("via picks the key: posts follow author, reviews follow reviewer", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["posts", "reviews"]);
        expect(loaded.map((a) => [a.name, a.posts.map((p: Row) => p.title), a.reviews.map((p: Row) => p.title)])).toEqual([
          ["Ada", ["p1", "p2"], ["p3"]], ["Bo", ["p3"], []], ["Cy", [], []],
        ]);
      });
    } finally { await db.close(); }
  });

  test("a has-one loads the row or null; two rows for one key is an error, not a pick", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["profile"]);
        expect(loaded.map((a) => a.profile?.bio ?? null)).toEqual(["mathematician", null, null]);
        await tx.insert(app.tables.profile, { id: id(2), bio: "second", authorId: id(1) });
        await expect(app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["profile"])).rejects.toThrow(
          `has-one :profile of :Author found 2 rows for "${id(1)}", and a has-one is for at most one`);
      });
    } finally { await db.close(); }
  });

  test("a has-many with no belongs-to back builds and fails when loaded, saying what to declare", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        await expect(app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["orphans"])).rejects.toThrow(
          "has-many :orphans of :Author cannot be loaded: :Orphan has no belongs-to back to :Author");
      });
    } finally { await db.close(); }
  });

  test("the tables are read once per relationship for all the rows, nested paths included", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const { tx: counting, calls } = counted(tx);
        await app.loadAuthorFields(counting, await rowsOf(tx, "author"), ["posts", "reviews", "profile"]);
        expect(calls).toEqual(["select", "select", "select"]);
      });
    } finally { await db.close(); }
  });
});

describe("self-reference", () => {
  test("replies and replyTo are the same table, loaded one level at a time", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const [p1] = await tx.select(app.tables.post, { filter: { id: { eq: id(11) } } });
        const [loaded] = await app.loadPostFields(tx, [p1!], ["replies", "replyTo"]);
        expect(loaded!.replyTo).toBeNull();
        expect(loaded!.replies.map((r: Row) => r.title)).toEqual(["p2", "p3"]);
        // A level down is not loaded unless asked for.
        expect("replies" in loaded!.replies[0]).toBe(false);
      });
    } finally { await db.close(); }
  });

  test("a row that is its own parent loads itself and does not loop", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await tx.insert(app.tables.author, { id: id(1), name: "Ada", retired: false });
        await tx.insert(app.tables.post, { id: id(11), title: "loop", score: null, postedAt: at(1), authorId: id(1), reviewerId: null, replyToId: id(11) });
        const [loaded] = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["replyTo", "replies", "answered", "lonely"]);
        expect(loaded!.replyTo.id).toBe(id(11));
        expect(loaded!.replies.map((r: Row) => r.id)).toEqual([id(11)]);
        expect(loaded!.answered).toBe(true);
        expect(loaded!.lonely).toBe(false);
      });
    } finally { await db.close(); }
  });

  test("an integer-keyed entity relates to itself by integer keys", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        const t = app.tables.ticket;
        await tx.insert(t, { title: "one", duplicateOfId: null });
        await tx.insert(t, { title: "two", duplicateOfId: 1 });
        await tx.insert(t, { title: "three", duplicateOfId: 1 });
        const loaded = await app.loadTicketFields(tx, await tx.select(t), ["duplicateOf", "duplicates", "duplicateCount"]);
        expect(loaded.map((r) => [r.title, r.duplicateOf?.title ?? null, r.duplicates.map((d: Row) => d.title), r.duplicateCount])).toEqual([
          ["one", null, ["two", "three"], 2], ["two", "one", [], 0], ["three", "one", [], 0],
        ]);
      });
    } finally { await db.close(); }
  });
});

describe("rollups", () => {
  test("count and max over a has-many, per row", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["postCount", "topScore"]);
        expect(loaded.map((a) => [a.name, a.postCount, a.topScore])).toEqual([["Ada", 2, 5], ["Bo", 1, 9], ["Cy", 0, null]]);
      });
    } finally { await db.close(); }
  });

  test("max over a timestamp is a Date; on no rows it is null", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["lastPostedAt"]);
        expect(loaded[0]!.lastPostedAt).toEqual(at(3_000));
        expect(loaded[0]!.lastPostedAt).toBeInstanceOf(Date);
        expect(loaded[1]!.lastPostedAt).toEqual(at(2_000));
        expect(loaded[2]!.lastPostedAt).toBeNull();
      });
    } finally { await db.close(); }
  });

  test("a max whose values are all null is null, and a count counts rows", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await tx.insert(app.tables.author, { id: id(1), name: "Ada", retired: false });
        await tx.insert(app.tables.post, { id: id(11), title: "a", score: null, postedAt: at(1), authorId: id(1), reviewerId: null, replyToId: null });
        await tx.insert(app.tables.post, { id: id(12), title: "b", score: null, postedAt: at(2), authorId: id(1), reviewerId: null, replyToId: null });
        const [loaded] = await app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["topScore", "postCount"]);
        expect([loaded!.topScore, loaded!.postCount]).toEqual([null, 2]);
      });
    } finally { await db.close(); }
  });

  test("one data-layer call per row and rollup: count and max, no joins", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const { tx: counting, calls } = counted(tx);
        await app.loadAuthorFields(counting, await rowsOf(tx, "author"), ["postCount", "lastPostedAt"]);
        expect(calls.sort()).toEqual(["count", "count", "count", "max", "max", "max"]);
      });
    } finally { await db.close(); }
  });

  test("a rollup over a has-many the same call loads is worked out from those rows, with no query, and gives the data layer's answer", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        await tx.insert(app.tables.post, { id: id(14), title: "p4", score: null, postedAt: at(500), authorId: id(2), reviewerId: null, replyToId: null });
        const authors = await rowsOf(tx, "author");
        const viaLayer = await app.loadAuthorFields(tx, authors, ["postCount", "lastPostedAt", "topScore"]);
        const { tx: counting, calls } = counted(tx);
        const fromRows = await app.loadAuthorFields(counting, authors, ["postCount", "lastPostedAt", "topScore", "posts"]);
        expect(calls).toEqual(["select"]);
        expect(fromRows.map((a) => [a.postCount, a.lastPostedAt, a.topScore])).toEqual(viaLayer.map((a) => [a.postCount, a.lastPostedAt, a.topScore]));
        expect(fromRows[2]).toMatchObject({ postCount: 0, lastPostedAt: null, topScore: null });
      });
    } finally { await db.close(); }
  });

  test("a computed body reads a rollup of its own row", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["prolific"]);
        expect(loaded.map((a) => a.prolific)).toEqual([true, false, false]);
      });
    } finally { await db.close(); }
  });

  test("filtering or sorting a read by a rollup fails with the not-implemented error that names M10", async () => {
    const db = await fresh();
    try {
      const authors = app.bind(db);
      await authors.createAuthor?.({});
      await run(db, async (tx) => { await seed(tx); });
      const refused = (what: "filter" | "sort", name: string) =>
        `A ${what} by Author.${name} is not available yet: ${name} is a computed field or rollup, and filtering and sorting by one is evaluated by the SQL evaluator, which arrives in M10`;
      await expect(authors.readAuthor({ filter: { postCount: { gt: 1 } } })).rejects.toThrow(refused("filter", "postCount"));
      await expect(authors.readAuthor({ sort: ["-lastPostedAt"] })).rejects.toThrow(refused("sort", "lastPostedAt"));
      await expect(authors.readAuthor({ filter: { and: [{ name: { eq: "Ada" } }, { or: [{ topScore: { eq: 9 } }] }] } })).rejects.toThrow(refused("filter", "topScore"));
      await expect(authors.readAuthor({ filter: { prolific: { eq: true } } })).rejects.toThrow(refused("filter", "prolific"));
      // An attribute still filters and sorts.
      expect((await authors.readAuthor({ filter: { name: { eq: "Bo" } }, sort: ["-name"] })).map((a: Row) => a.name)).toEqual(["Bo"]);
    } finally { await db.close(); }
  });
});

describe("computed fields with a body", () => {
  test("a body over a loaded has-many: quantifiers, length, an empty list", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["answered", "hasPinned"]);
        expect(loaded.map((p) => [p.title, p.answered, p.hasPinned])).toEqual([["p1", true, true], ["p2", false, false], ["p3", false, false]]);
      });
    } finally { await db.close(); }
  });

  test("loading a computed field loads what its body reads, and a path through a related row", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const { tx: counting, calls } = counted(tx);
        // authorIsProlific reads author.prolific, and prolific reads postCount: a relationship, then two computed fields.
        const loaded = await app.loadPostFields(counting, await rowsOf(tx, "post"), ["authorIsProlific"]);
        expect(loaded.map((p) => p.authorIsProlific)).toEqual([true, true, false]);
        expect(calls.filter((c) => c === "select")).toHaveLength(1);
        expect(calls.filter((c) => c === "count")).toHaveLength(2);
      });
    } finally { await db.close(); }
  });

  test("a body that reads a nullable belongs-to through ?. gives unknown, which is not true", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        // p3 is by Bo and reviewed by Ada; the other two have no reviewer, so the comparison is unknown (null).
        await tx.insert(app.tables.post, { id: id(14), title: "p4", score: null, postedAt: at(4_000), authorId: id(1), reviewerId: id(1), replyToId: null });
        const loaded = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["reviewedBySelf"]);
        expect(loaded.map((p) => [p.title, p.reviewedBySelf])).toEqual([["p1", null], ["p2", null], ["p3", false], ["p4", true]]);
      });
    } finally { await db.close(); }
  });

  test("now() reads the clock the caller passes, once", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const early = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["isOld"], { clock: () => at(1_500) });
        expect(early.map((p) => p.isOld)).toEqual([true, false, false]);
        const late = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["isOld"], { clock: () => at(10_000) });
        expect(late.map((p) => p.isOld)).toEqual([true, true, true]);
      });
    } finally { await db.close(); }
  });

  test("a body called on a row whose list was not loaded is an error, never an empty list", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const [p1] = await rowsOf(tx, "post");
        const { scope } = await import("@meshfw/runtime");
        expect(() => expressions.post!["computed.answered"]!(scope({ self: p1 }) as never)).toThrow("the list was not loaded");
        expect(() => expressions.post!["computed.hasPinned"]!(scope({ self: p1 }) as never)).toThrow("the list was not loaded");
      });
    } finally { await db.close(); }
  });

  test("a null belongs-to reads as null through ?. and a required comparison is unknown, not true", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        const loaded = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["lonely"]);
        // p1 has no parent and has replies; p2 and p3 have a parent; unknown (null === null is not used) stays false.
        expect(loaded.map((p) => p.lonely)).toEqual([false, false, false]);
      });
    } finally { await db.close(); }
  });
});

describe("a computed body that runs as plain code", () => {
  async function chain(tx: DataOperations) {
    await tx.insert(app.tables.author, { id: id(1), name: "Ada", retired: false });
    const post = (n: number, replyToId: string | null) => tx.insert(app.tables.post, { id: id(n), title: `p${n}`, score: null, postedAt: at(n), authorId: id(1), reviewerId: null, replyToId });
    await post(11, null); await post(12, id(11)); await post(13, id(12)); await post(14, id(13));
    // p11 has a reply, so it is answered; p14 has none. The chain p14 -> p13 -> p12 -> p11.
  }
  test("a read one relationship deep (&replyTo?.answered) loads the related row's computed field", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await chain(tx);
        const loaded = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["replyToAnswered"]);
        // p11 has no parent: undefined, which JSON.stringify gives as undefined (not a loaded value); p12..p14 have an answered parent.
        expect(loaded.map((p) => p.replyToAnswered)).toEqual([undefined, "true", "true", "true"]);
      });
    } finally { await db.close(); }
  });
  test("two relationships deep (&replyTo?.replyTo?.answered) loads both", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await chain(tx);
        const loaded = await app.loadPostFields(tx, await rowsOf(tx, "post"), ["grandReplyToAnswered"]);
        expect(loaded.map((p) => p.grandReplyToAnswered)).toEqual([undefined, undefined, "true", "true"]);
      });
    } finally { await db.close(); }
  });
  test("the needs include every link of the chain", async () => {
    const model = JSON.parse(await Bun.file(join(dir, ".mesh/model.json")).text()) as { entities: { name: string; computed: { name: string; needs?: string[] }[] }[] };
    const needs = (name: string) => model.entities.find((e) => e.name === "Post")!.computed.find((c) => c.name === name)!.needs;
    expect(needs("replyToAnswered")).toEqual(["replyTo", "replyTo.answered"]);
    expect(needs("grandReplyToAnswered")).toEqual(["replyTo", "replyTo.replyTo", "replyTo.replyTo.answered"]);
  });
  test("a read the text does not show (through a variable) is an error, never a silent null", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await chain(tx);
        await expect(app.loadPostFields(tx, await rowsOf(tx, "post"), ["viaVariable"])).rejects.toThrow(
          "A plain computed body read Post.answered, which was not loaded");
        await expect(app.loadPostFields(tx, await rowsOf(tx, "post"), ["viaVariable"])).rejects.toBeInstanceOf(FrameworkError);
      });
    } finally { await db.close(); }
  });
  test("an attribute a plain body reads is just there", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await chain(tx);
        expect((await app.loadPostFields(tx, await rowsOf(tx, "post"), ["plainTitle"])).map((p) => p.plainTitle)).toEqual(['"p11"', '"p12"', '"p13"', '"p14"']);
      });
    } finally { await db.close(); }
  });
});

describe("what cannot be loaded is an error", () => {
  test("an unknown name lists the ones that exist", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await expect(app.loadPostFields(tx, [], ["autor"])).rejects.toThrow(/Post has no relationship or computed field "autor" to load \(it has author, reviewer, replyTo, replies, comments, answered/);
      });
    } finally { await db.close(); }
  });

  test("an error is a FrameworkError", async () => {
    const db = await fresh();
    try {
      await run(db, async (tx) => {
        await seed(tx);
        await expect(app.loadAuthorFields(tx, await rowsOf(tx, "author"), ["orphans"])).rejects.toBeInstanceOf(FrameworkError);
      });
    } finally { await db.close(); }
  });
});

describe("types", () => {
  test("reading a relationship or a computed field that was not loaded is a type error", async () => {
    await writeFile(join(dir, "check.ts"), `import type { Post, PostWith, PostLoadable } from "./.mesh/post.types";
import { loadPostFields, loadAuthorFields } from "./.mesh/load";
import type { DataOperations } from "@meshfw/runtime";
declare const tx: DataOperations;
declare const post: Post;
// @ts-expect-error author was not loaded
export const a = post.author;
// @ts-expect-error nor was a computed field
export const b = post.answered;
declare const loaded: PostWith<"author" | "answered">;
export const author: string = loaded.author.name;
export const answered: boolean = loaded.answered;
// @ts-expect-error only what was named is there
export const comments = loaded.comments;
export const stored: string = loaded.title;
// A has-many is a list, a nullable belongs-to is nullable, a has-one is nullable.
declare const more: PostWith<"comments" | "reviewer" | "replyTo">;
export const count: number = more.comments.length;
// @ts-expect-error a nullable belongs-to can be null
export const reviewerName: string = more.reviewer.name;
export const replyToTitle: string | undefined = more.replyTo?.title;
export async function use() {
  const posts = await loadPostFields(tx, [post], ["author", "comments"]);
  const first = posts[0]!;
  const name: string = first.author.name;
  const n: number = first.comments.length;
  // @ts-expect-error reviewer was not among the names
  first.reviewer;
  // @ts-expect-error not a relationship or a computed field of Post
  await loadPostFields(tx, [post], ["autor"]);
  const authors = await loadAuthorFields(tx, [], ["postCount", "lastPostedAt", "topScore", "profile"]);
  const top: number | null = authors[0]!.topScore;
  const last: Date | null = authors[0]!.lastPostedAt;
  const posted: number = authors[0]!.postCount;
  const bio: string | undefined = authors[0]!.profile?.bio;
  return [name, n, top, last, posted, bio];
}
export type Keys = keyof PostLoadable;
`);
    const tsc = join(import.meta.dir, "../../../node_modules/.bin/tsc");
    const result = Bun.spawnSync([tsc, "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes", "--skipLibCheck", "--allowImportingTsExtensions",
      "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--types", "bun", join(dir, "check.ts")], { cwd: dir });
    expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  });
});
