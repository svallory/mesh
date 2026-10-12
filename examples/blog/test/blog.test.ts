import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createSchema, sqlite, type SQLiteLayer } from "@meshfw/data-sqlite";
import { ForbiddenError, FrameworkError, InvalidInputError, NotFoundError, type Change, type DataLayer, type DataOperations, type Seams } from "@meshfw/runtime";
import { bind, connect, disconnect, tables } from "#mesh";
import { Comment, Post, User, type PostFilter, type PostSort } from "#mesh/domain/blog";
import config from "../mesh.config";
import { alice } from "../src/context";

const context = { actor: alice };
/** The context of a call made by `user`: the post's `:owner` policy lets only its author publish, archive or destroy it. */
const as = (user: { id: string }) => ({ actor: { id: user.id } });

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  return { db, blog: bind(db) };
}

test("acceptance 1: create, read, update, destroy, and a write after destroy is not found", async () => {
  const { db, blog } = await fresh();
  try {
    await blog.run(async () => {
      const author = await User.create({ name: "Alice" }, context);
      const post = await Post.create({ title: "Hello", author: author.id }, context);
      expect(post).toMatchObject({ title: "Hello", body: null, views: 0, price: 0, featured: false, state: "draft", authorId: author.id });
      expect(await Post.read({}, context)).toEqual([post]);

      const published = await Post.publish({ id: post.id }, as(author));
      expect(published.state).toBe("published");
      expect(published.insertedAt).toEqual(post.insertedAt);

      await Post.destroy({ id: post.id }, as(author));
      expect(await Post.read({}, context)).toEqual([]);
      // Not found comes before forbidden (POL-18): `context` is not the author, and the row is gone.
      await expect(Post.publish({ id: post.id }, context)).rejects.toBeInstanceOf(NotFoundError);
      await expect(Post.destroy({ id: post.id }, context)).rejects.toBeInstanceOf(NotFoundError);
      await expect(Post.archive({ id: post.id }, context)).rejects.toBeInstanceOf(NotFoundError);
    });
  } finally { await db.close(); }
});

/** A layer that counts the locked reads (`selectByKeyForUpdate`) every transaction makes. */
function counting(layer: DataLayer, counter: { locked: number }): DataLayer {
  const wrapped = new WeakMap<DataOperations, DataOperations>();
  return {
    transaction: (run) => layer.transaction((tx) => run(wrapped.get(tx) ?? wrapped.set(tx, {
      ...tx,
      selectByKeyForUpdate: (table, key) => { counter.locked++; return tx.selectByKeyForUpdate(table, key); },
    }).get(tx)!)),
    refuseIfFailed: () => layer.refuseIfFailed(),
    close: () => layer.close(),
  };
}

// What a destroy with no policy that reads the record does (no read without a seam, TXN-13) is in
// packages/data-sqlite/test/lifecycle.test.ts. Here `:owner` reads the post's author, so every destroy reads the row.
describe("a destroy the :owner policy covers reads the row once under the lock, and a seam that wants the change reads it no second time (M6 ruling 4)", () => {
  const destroyOne = async (seams: Seams | undefined) => {
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, tables);
    const counter = { locked: 0 };
    const blog = bind(counting(db, counter), { seams });
    try {
      return await blog.run(async () => {
        const author = await User.create({ name: "Alice" }, context);
        const post = await Post.create({ title: "Hello", author: author.id }, context);
        const before = counter.locked;
        await Post.destroy({ id: post.id }, as(author));
        const first = counter.locked - before;
        const gone = await Post.destroy({ id: post.id }, as(author)).catch((cause: unknown) => cause);
        expect(gone).toBeInstanceOf(NotFoundError);
        // two destroys: the first of a row that is there, the second of one that is not
        return { locked: counter.locked - before, first, post };
      });
    } finally { await db.close(); }
  };

  test("no seam, or one that wants no change: one locked read per destroy, which the policy needs", async () => {
    expect(await destroyOne(undefined)).toMatchObject({ first: 1, locked: 2 });
    expect(await destroyOne({ beforeTransaction() {} })).toMatchObject({ first: 1, locked: 2 });
  });

  test("afterWrite or afterCommit registered: the same one read, and before is the deleted row", async () => {
    const seen: Change[] = [];
    const { locked, first, post } = await destroyOne({ afterWrite: (_db, event) => { if (event.action === "destroy") seen.push({ entity: event.entity, action: event.action, before: event.before, after: event.after }); } });
    expect(first).toBe(1);
    expect(locked).toBe(2);
    expect(seen).toEqual([{ entity: "blog.Post", action: "destroy", before: post, after: null }]);
    const committed: Change[] = [];
    expect((await destroyOne({ afterCommit: ({ changes }) => { committed.push(...changes); } })).locked).toBe(2);
    expect(committed.map((change) => [change.action, change.after])).toEqual([["create", expect.anything()], ["create", expect.anything()], ["destroy", null]]);
    expect(committed[2]!.before).toMatchObject({ title: "Hello" });
  });
});

test("a create fills timestamps from one clock reading, and an update moves only updatedAt", async () => {
  const { db, blog } = await fresh();
  try {
    await blog.run(async () => {
      const author = await User.create({ name: "Alice" }, context);
      const post = await Post.create({ title: "Hello", author: author.id }, context);
      expect(post.insertedAt).toBeInstanceOf(Date);
      expect(post.insertedAt.getTime()).toBe(post.updatedAt.getTime());
      await Bun.sleep(5);
      const published = await Post.publish({ id: post.id }, as(author));
      expect(published.insertedAt.getTime()).toBe(post.insertedAt.getTime());
      expect(published.updatedAt.getTime()).toBeGreaterThan(post.updatedAt.getTime());
    });
  } finally { await db.close(); }
});

test("acceptance 2: a field not in the action's input is rejected, and nothing is written", async () => {
  const { db, blog } = await fresh();
  try {
    await blog.run(async () => {
      const author = await User.create({ name: "Alice" }, context);
      // @ts-expect-error `state` is not in Post.create's input
      const call = Post.create({ title: "Hello", author: author.id, state: "published" }, context);
      await expect(call).rejects.toBeInstanceOf(InvalidInputError);
      expect(await Post.read({}, context)).toEqual([]);
    });
  } finally { await db.close(); }
});

test("acceptance 3: a failing validation's first frame outside node_modules and Mesh's packages is the generated action", async () => {
  const { db, blog } = await fresh();
  try {
    await blog.run(async () => {
      let caught: unknown;
      try { await Post.create({ title: "", author: alice.id }, context); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(InvalidInputError);
      const frames = (caught as Error).stack!.split("\n").filter((line) => line.trimStart().startsWith("at "));
      const packages = resolve(import.meta.dir, "../../../packages");
      const first = frames.find((frame) => !frame.includes("node_modules") && !frame.includes(packages));
      expect(first).toContain(resolve(import.meta.dir, "../.mesh/domain/blog/post.actions.ts"));
    });
  } finally { await db.close(); }
});

test("a constant set is applied: Post.publish sets state to published", async () => {
  const { db, blog } = await fresh();
  try {
    await blog.run(async () => {
      const author = await User.create({ name: "Alice" }, context);
      const post = await Post.create({ title: "Hello", author: author.id }, context);
      await Post.publish({ id: post.id }, as(author));
      expect((await Post.read({}, context))[0]?.state).toBe("published");
    });
  } finally { await db.close(); }
});

test("a read with filter and sort throws the M4 FrameworkError instead of returning unfiltered rows", async () => {
  const { db, blog } = await fresh();
  try {
    await blog.run(async () => {
      await expect(Post.published({}, context)).rejects.toThrow(
        new FrameworkError("publishedPost cannot run in this version: its filter and sort are evaluated by the SQL evaluator, which arrives in M10"));
    });
  } finally { await db.close(); }
});

/** A blog with one author and the titles given, created in order; `body` is set on every other post. */
async function seeded(titles: string[]) {
  const world = await fresh();
  return world.blog.run(async () => {
    const author = await User.create({ name: "Alice" }, context);
    const posts = [];
    for (const [index, title] of titles.entries())
      posts.push(await Post.create({ title, author: author.id, ...(index % 2 === 0 ? { body: `body ${title}` } : {}) }, context));
    return { ...world, author, posts };
  });
}
const titlesOf = (posts: { title: string }[]) => posts.map((post) => post.title);

describe("policies (M8a): every action is covered, and a caller the policies do not admit is forbidden", () => {
  test("only the author publishes, archives or destroys a post; anyone else gets ForbiddenError and nothing is written", async () => {
    const { db, blog } = await fresh();
    try {
      await blog.run(async () => {
        const author = await User.create({ name: "Alice" }, context);
        const post = await Post.create({ title: "Hello", author: author.id }, context);
        const error = await Post.publish({ id: post.id }, context).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(ForbiddenError);
        expect(error).toMatchObject({ code: "forbidden", entity: "blog.Post", action: "publish", policies: ["owner"], message: "blog.Post#publish is forbidden by policy :owner" });
        // The breakdown is plain data: it survives JSON unchanged.
        const breakdown = (error as ForbiddenError).breakdown;
        expect(breakdown).toEqual([{ policy: "owner", kind: "authorize-if", check: "({ actor }) => &author.id === actor.id", result: false, decisive: true }]);
        expect(JSON.parse(JSON.stringify(breakdown))).toEqual(breakdown);
        await expect(Post.archive({ id: post.id }, context)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(Post.destroy({ id: post.id }, context)).rejects.toMatchObject({ code: "forbidden", policies: ["owner"] });
        expect(await Post.read({}, context)).toEqual([post]);
        // A post that does not exist is not found, whoever asks (POL-18): the row is read before the policy that reads it.
        await expect(Post.publish({ id: crypto.randomUUID() }, context)).rejects.toBeInstanceOf(NotFoundError);
        await expect(Post.destroy({ id: crypto.randomUUID() }, context)).rejects.toBeInstanceOf(NotFoundError);
      });
    } finally { await db.close(); }
  });

  test("the policy runs before validate: a stranger is told they may not publish, not that the title is missing", async () => {
    const { db, blog } = await fresh();
    try {
      await blog.run(async () => {
        const author = await User.create({ name: "Alice" }, context);
        const post = await Post.create({ title: "Hello", author: author.id }, context);
        // A title `titlePresent` rejects, which no create can store (`min=1`): written past the actions.
        await db.transaction((tx) => tx.updateByKey(tables.posts, { id: post.id }, { title: "" }));
        const other = await User.create({ name: "Bob" }, context);
        await expect(Post.publish({ id: post.id }, as(other))).rejects.toBeInstanceOf(ForbiddenError);
        // The author passes the policy and meets validate.
        await expect(Post.publish({ id: post.id }, as(author))).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "title_required" })] });
        expect((await Post.read({}, context))[0]).toMatchObject({ title: "", state: "draft" });
      });
    } finally { await db.close(); }
  });

  test("what a caller loads runs the read policies of the entity it reaches (POL-17); through tx nothing is filtered", async () => {
    const { db, blog } = await fresh();
    try {
      await blog.run(async () => {
        const author = await User.create({ name: "Alice" }, context);
        const post = await Post.create({ title: "Hello", author: author.id }, context);
        // Comment has no create action: the row is written past the actions.
        await db.transaction((tx) => tx.insert(tables.comments, { id: crypto.randomUUID(), body: "First", postId: post.id }));
        const load = ["comments", "author", "commentCount"] as const;
        // A guest may read posts (`:public`) but not users or comments (`:signedIn`).
        const guest = { actor: {} } as unknown as typeof context;
        const [seen] = await Post.read({ load }, guest);
        expect(seen).toMatchObject({ id: post.id, comments: [], author: null, commentCount: 0 });
        const [signedIn] = await Post.read({ load }, context);
        expect(signedIn).toMatchObject({ comments: [{ body: "First" }], author: { name: "Alice" }, commentCount: 1 });
        // Inside a transaction, `tx` runs no policy (ADR-0068): the same guest's read sees everything.
        const [inside] = await blog.transaction(({ tx }) => tx.readPost({ load }), guest);
        expect(inside).toMatchObject({ comments: [{ body: "First" }], author: { name: "Alice" }, commentCount: 1 });
        // The types say the same: a caller's author may be null, while through `tx` the key always finds it.
        const typed = (caller: NonNullable<typeof seen>, inTx: NonNullable<typeof inside>): string[] => [
          // @ts-expect-error a caller's `author` is `User | null`
          caller.author.name,
          inTx.author.name,
        ];
        void typed;
        // A write's `load` step gives the caller the result, so it runs the same policies.
        expect((await Post.publish({ id: post.id }, as(author))).comments).toEqual([expect.objectContaining({ body: "First" })]);
      });
    } finally { await db.close(); }
  });

  test("a call whose actor has no id reads every post, may not create a user or a post, and reads no user or comment", async () => {
    const { db, blog } = await fresh();
    try {
      await blog.run(async () => {
        const author = await User.create({ name: "Alice" }, context);
        await Post.create({ title: "Hello", author: author.id }, context);
        const anonymous = { actor: {} } as unknown as typeof context;
        expect(await Post.read({}, anonymous)).toHaveLength(1);
        await expect(User.create({ name: "Eve" }, anonymous)).rejects.toMatchObject({ code: "forbidden", policies: ["signedIn"] });
        await expect(Post.create({ title: "Spam", author: author.id }, anonymous)).rejects.toBeInstanceOf(ForbiddenError);
        // A read whose policies do not admit the caller gives no rows, never an error.
        expect(await User.read({}, anonymous)).toEqual([]);
        expect(await Comment.read({}, anonymous)).toEqual([]);
        expect(await User.read({}, context)).toHaveLength(1);
        expect(await Post.read({}, context)).toHaveLength(1);
      });
    } finally { await db.close(); }
  });
});

describe("ids (UUIDv7, filled when Mesh builds the new record, ACT-27)", () => {
  test("a create's id is a UUIDv7, and ids sort in creation order", async () => {
    const { db, posts } = await seeded(Array.from({ length: 25 }, (_, index) => `post ${index}`));
    try {
      for (const post of posts) expect(post.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(posts.map((post) => post.id)).toEqual(posts.map((post) => post.id).sort());
      expect(new Set(posts.map((post) => post.id)).size).toBe(25);
    } finally { await db.close(); }
  });

  test("the generated create fills the id itself, never from the input, and a client cannot send one", async () => {
    // A uuid key is filled when Mesh builds the record, so a check or a step already reads `&id`; an integer key is left to the data layer.
    const actions = readFileSync(resolve(import.meta.dir, "../.mesh/domain/blog/post.actions.ts"), "utf8");
    expect(actions.match(/^\s+id: \$uuidv7\(\),$/gm)).toHaveLength(1);
    expect(actions).not.toMatch(/randomUUID|^\s+id: (?!\$uuidv7\(\),$)/m);
    const { db, blog, author } = await seeded([]);
    try {
      await blog.run(async () => {
        // @ts-expect-error the id is not part of Post.create's input
        await expect(Post.create({ title: "x", author: author.id, id: crypto.randomUUID() }, context)).rejects.toBeInstanceOf(InvalidInputError);
      });
    } finally { await db.close(); }
  });
});

describe("json attributes", () => {
  const values: [string, unknown][] = [
    ["an object", { tags: ["a", "b"], nested: { n: 1, ok: true, none: null } }],
    ["an array", [1, "two", [3], { four: 4 }]],
    ["a string", "text"],
    ["a number", 0],
    ["a boolean", false],
    ["an empty object", {}],
    ["an empty array", []],
    ["null", null],
  ];
  test.each(values)("%s is stored and returned as it was given", async (_name, metadata) => {
    const { db, blog, author } = await fresh().then(async (world) => ({ ...world, author: await world.blog.run(() => User.create({ name: "Alice" }, context)) }));
    try {
      await blog.run(async () => {
        const post = await Post.create({ title: "Hello", author: author.id, metadata }, context);
        expect(post.metadata).toEqual(metadata);
        expect((await Post.read({}, context))[0]!.metadata).toEqual(metadata);
      });
    } finally { await db.close(); }
  });

  test("a post without metadata gets the declared default, an object and not a shared one", async () => {
    const { db, posts } = await seeded(["a", "b"]);
    try {
      expect(posts.map((post) => post.metadata)).toEqual([{}, {}]);
      expect(posts[0]!.metadata).not.toBe(posts[1]!.metadata);
    } finally { await db.close(); }
  });

  test.each<[string, unknown]>([
    ["a function", () => 1],
    ["undefined inside an object", { a: undefined }],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a Date", new Date()],
    ["a Map", new Map()],
    ["a symbol", Symbol("x")],
    ["a bigint", 1n],
  ])("%s fails at the validator and nothing is written", async (_name, metadata) => {
    const { db, blog, author } = await fresh().then(async (world) => ({ ...world, author: await world.blog.run(() => User.create({ name: "Alice" }, context)) }));
    try {
      await blog.run(async () => {
        await expect(Post.create({ title: "Hello", author: author.id, metadata }, context)).rejects.toBeInstanceOf(InvalidInputError);
        expect(await Post.read({}, context)).toEqual([]);
      });
    } finally { await db.close(); }
  });

  test("a json attribute is not filterable or sortable, in the types or at run time", async () => {
    const { db, blog } = await seeded(["a"]);
    try {
      await blog.run(async () => {
        // @ts-expect-error metadata is json: not a key of PostFilter
        await expect(Post.read({ filter: { metadata: { eq: "x" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
        // @ts-expect-error metadata is json: not a sort key
        await expect(Post.read({ sort: ["metadata"] }, context)).rejects.toBeInstanceOf(InvalidInputError);
      });
    } finally { await db.close(); }
  });
});

describe("reads take a filter, sort, limit and offset", () => {
  const titles = ["delta", "alpha", "echo", "bravo", "charlie"];

  test("no input returns every row in key order, which is creation order", async () => {
    const { db, blog } = await seeded(titles);
    try { await blog.run(async () => { expect(titlesOf(await Post.read({}, context))).toEqual(titles); }); } finally { await db.close(); }
  });

  test("eq, ne, in and nil", async () => {
    const { db, blog } = await seeded(titles);
    try {
      await blog.run(async () => {
        expect(titlesOf(await Post.read({ filter: { title: { eq: "echo" } } }, context))).toEqual(["echo"]);
        expect(titlesOf(await Post.read({ filter: { title: { ne: "echo" } } }, context))).toEqual(["delta", "alpha", "bravo", "charlie"]);
        expect(titlesOf(await Post.read({ filter: { title: { in: ["bravo", "delta", "nope"] } } }, context))).toEqual(["delta", "bravo"]);
        expect(await Post.read({ filter: { title: { in: [] } } }, context)).toEqual([]);
        // Posts 0, 2 and 4 have a body.
        expect(titlesOf(await Post.read({ filter: { body: { nil: true } } }, context))).toEqual(["alpha", "bravo"]);
        expect(titlesOf(await Post.read({ filter: { body: { nil: false } } }, context))).toEqual(["delta", "echo", "charlie"]);
        expect(titlesOf(await Post.read({ filter: { body: { eq: null } } }, context))).toEqual(["alpha", "bravo"]);
      });
    } finally { await db.close(); }
  });

  test("lt, lte, gt and gte compare text, numbers and dates", async () => {
    const { db, blog, posts } = await seeded(titles);
    try {
      await blog.run(async () => {
        expect(titlesOf(await Post.read({ filter: { title: { gt: "charlie" } }, sort: ["title"] }, context))).toEqual(["delta", "echo"]);
        expect(titlesOf(await Post.read({ filter: { title: { gte: "charlie", lt: "echo" } }, sort: ["title"] }, context))).toEqual(["charlie", "delta"]);
        expect(titlesOf(await Post.read({ filter: { title: { lte: "alpha" } } }, context))).toEqual(["alpha"]);
        expect(await Post.read({ filter: { views: { gt: 0 } } }, context)).toEqual([]);
        expect(await Post.read({ filter: { views: { eq: 0 } } }, context)).toHaveLength(5);
        const stamp = posts[0]!.insertedAt;
        expect(await Post.read({ filter: { insertedAt: { gt: new Date(stamp.getTime() + 60_000) } } }, context)).toEqual([]);
        expect(await Post.read({ filter: { insertedAt: { lte: new Date(stamp.getTime() + 60_000) } } }, context)).toHaveLength(5);
      });
    } finally { await db.close(); }
  });

  test("booleans, enums and the key column of a relationship", async () => {
    const { db, blog, author, posts } = await seeded(titles);
    try {
      await blog.run(async () => {
        await Post.publish({ id: posts[1]!.id }, as(author));
        expect(titlesOf(await Post.read({ filter: { state: { eq: "published" } } }, context))).toEqual(["alpha"]);
        expect(await Post.read({ filter: { featured: { eq: true } } }, context)).toEqual([]);
        expect(await Post.read({ filter: { authorId: { eq: author.id } } }, context)).toHaveLength(5);
        expect(await Post.read({ filter: { authorId: { ne: author.id } } }, context)).toEqual([]);
        // @ts-expect-error "archived" is not a value of the state enum
        await expect(Post.read({ filter: { state: { eq: "archived" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
      });
    } finally { await db.close(); }
  });

  test("and, or and nesting", async () => {
    const { db, blog } = await seeded(titles);
    try {
      await blog.run(async () => {
        const filter = { and: [{ or: [{ title: { eq: "delta" } }, { title: { eq: "bravo" } }] }, { body: { nil: true } }] };
        expect(titlesOf(await Post.read({ filter }, context))).toEqual(["bravo"]);
        expect(titlesOf(await Post.read({ filter: { or: [{ title: { eq: "delta" } }, { body: { nil: true } }] } }, context))).toEqual(["delta", "alpha", "bravo"]);
        expect(await Post.read({ filter: { and: [] } }, context)).toHaveLength(5);
        expect(await Post.read({ filter: { or: [] } }, context)).toEqual([]);
        expect(await Post.read({ filter: {} }, context)).toHaveLength(5);
        expect(titlesOf(await Post.read({ filter: { title: { gt: "a", lt: "c" } } }, context))).toEqual(["alpha", "bravo"]);
      });
    } finally { await db.close(); }
  });

  test("sort ascending, descending, by several keys, with the key as the last tie-break", async () => {
    const { db, blog } = await seeded(titles);
    try {
      await blog.run(async () => {
        expect(titlesOf(await Post.read({ sort: ["title"] }, context))).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
        expect(titlesOf(await Post.read({ sort: ["-title"] }, context))).toEqual(["echo", "delta", "charlie", "bravo", "alpha"]);
        // Every post has the same `views`, so the next key decides; then the id.
        expect(titlesOf(await Post.read({ sort: ["views", "-title"] }, context))).toEqual(["echo", "delta", "charlie", "bravo", "alpha"]);
        expect(titlesOf(await Post.read({ sort: ["views"] }, context))).toEqual(titles);
        expect(titlesOf(await Post.read({ sort: ["-views"] }, context))).toEqual(titles);
        const readOnly = ["title"] as const;
        expect(titlesOf(await Post.read({ sort: readOnly }, context))[0]).toBe("alpha");
      });
    } finally { await db.close(); }
  });

  test("limit and offset page the result, and an offset past the end returns nothing", async () => {
    const { db, blog } = await seeded(titles);
    try {
      await blog.run(async () => {
        const sort = ["title"] as const;
        expect(titlesOf(await Post.read({ sort, limit: 2 }, context))).toEqual(["alpha", "bravo"]);
        expect(titlesOf(await Post.read({ sort, limit: 2, offset: 2 }, context))).toEqual(["charlie", "delta"]);
        expect(titlesOf(await Post.read({ sort, limit: 2, offset: 4 }, context))).toEqual(["echo"]);
        expect(await Post.read({ sort, limit: 2, offset: 10 }, context)).toEqual([]);
        expect(titlesOf(await Post.read({ sort, offset: 3 }, context))).toEqual(["delta", "echo"]);
        expect(await Post.read({ limit: 0 }, context)).toEqual([]);
        expect(await Post.read({ limit: 100 }, context)).toHaveLength(5);
        const pages = [];
        for (let offset = 0; offset < 5; offset += 2) pages.push(titlesOf(await Post.read({ sort, limit: 2, offset }, context)));
        expect(pages.flat()).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
      });
    } finally { await db.close(); }
  });

  test("filter, sort and limit together return the expected page", async () => {
    const { db, blog, author } = await seeded(titles);
    try {
      await blog.run(async () => {
        const page = await Post.read({ filter: { authorId: { eq: author.id }, title: { ne: "alpha" } }, sort: ["-title"], limit: 3 }, context);
        expect(titlesOf(page)).toEqual(["echo", "delta", "charlie"]);
      });
    } finally { await db.close(); }
  });

  test.each<[string, unknown]>([
    ["an unknown attribute", { filter: { nope: { eq: 1 } } }],
    ["a bare value instead of a comparison", { filter: { title: "alpha" } }],
    ["an unknown operator", { filter: { title: { like: "a" } } }],
    ["an upper-case operator", { filter: { title: { EQ: "a" } } }],
    ["a wrong value type", { filter: { views: { eq: "many" } } }],
    ["an array where an object belongs", { filter: [] }],
    ["and mixed with an attribute", { filter: { and: [], title: { eq: "a" } } }],
    ["a bad list under and", { filter: { and: { title: { eq: "a" } } } }],
    ["an operand that is undefined", { filter: { title: { eq: undefined } } }],
    ["a comparison with no operator", { filter: { title: {} } }],
    ["an attribute that is undefined", { filter: { title: undefined } }],
    ["an unknown sort key", { sort: ["nope"] }],
    ["a sort that is not a list", { sort: "title" }],
    ["a negative limit", { limit: -1 }],
    ["a fractional limit", { limit: 1.5 }],
    ["a negative offset", { offset: -1 }],
    ["a string limit", { limit: "5" }],
    ["an unknown field", { where: {} }],
  ])("%s is an InvalidInputError", async (_name, input) => {
    const { db, blog } = await seeded(["a"]);
    try { await blog.run(async () => { await expect(Post.read(input as never, context)).rejects.toBeInstanceOf(InvalidInputError); }); } finally { await db.close(); }
  });

  test("the types name the filter and sort of the entity", () => {
    const filter: PostFilter = { and: [{ title: { eq: "a" } }, { or: [{ views: { gte: 1 } }] }] };
    const sort: PostSort = ["title", "-insertedAt"];
    void filter; void sort;
    // @ts-expect-error a filter value has its attribute's type
    const wrong: PostFilter = { views: { eq: "many" } };
    void wrong;
  });
});

test("two bindings do not share rows", async () => {
  const one = await fresh();
  const two = await fresh();
  try {
    await one.blog.run(async () => {
      const author = await User.create({ name: "Alice" }, context);
      await Post.create({ title: "Hello", author: author.id }, context);
      expect(await Post.read({}, context)).toHaveLength(1);
      expect(await two.blog.run(() => Post.read({}, context))).toEqual([]);
    });
  } finally { await one.db.close(); await two.db.close(); }
});

describe("connect and disconnect (ADR-0047)", () => {
  // `mesh.config.ts` names `blog.db`, relative to the working directory: run these in a
  // temporary one so the example's own database is never touched.
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "mesh-blog-connect-"));
  beforeAll(() => process.chdir(dir));
  afterAll(async () => {
    await disconnect();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a call before connect throws FrameworkError, and disconnect without connect does nothing", async () => {
    await expect(Post.read({}, context)).rejects.toThrow(new FrameworkError(
      "blog.Post.read was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
    await disconnect();
  });

  test("connect binds the configured layer without opening it; a second connect throws", async () => {
    await connect();
    // ADR-0047: the layer opens on its first transaction, not at connect().
    expect(existsSync("blog.db")).toBe(false);
    // The configured value is a descriptor and, for sqlite(), the run-time layer too.
    await createSchema(config.data as SQLiteLayer, tables);
    const author = await User.create({ name: "Alice" }, context);
    await Post.create({ title: "Hello", author: author.id }, context);
    expect(await Post.read({}, context)).toHaveLength(1);
    await expect(connect()).rejects.toThrow(new FrameworkError("connect() was called while connected; call disconnect() first"));
  });

  test("calls after disconnect throw; connect again reopens the same file", async () => {
    await disconnect();
    await expect(Post.read({}, context)).rejects.toBeInstanceOf(FrameworkError);
    await connect();
    expect(await Post.read({}, context)).toHaveLength(1);
    await disconnect();
  });

  test("disconnect waits for a call already made to settle before it closes the layer", async () => {
    await connect();
    const author = await User.create({ name: "Bob" }, context);
    // Not awaited: the call is in flight (validating its input) when disconnect starts.
    const pending = Post.create({ title: "In flight", author: author.id }, context);
    let settled = false;
    void pending.then(() => { settled = true; });
    await disconnect();
    expect(settled).toBe(true);
    expect((await pending).title).toBe("In flight");
    await connect();
    expect((await Post.read({}, context)).map((post) => post.title)).toContain("In flight");
    await disconnect();
  });

  test("connect binds the seams of mesh.config.ts, so the top-level functions run them (ADR-0075)", async () => {
    const calls: string[] = [];
    const changes: Change[] = [];
    config.seams = {
      beforeTransaction: ({ entity, action }) => { calls.push(`before ${entity}#${action}`); },
      afterWrite: (_db, { entity, action }) => { calls.push(`write ${entity}#${action}`); },
      afterCommit: (event) => { calls.push("commit"); changes.push(...event.changes); },
    };
    try {
      await connect();
      const author = await User.create({ name: "Seamed" }, context);
      expect(calls).toEqual(["before blog.User#create", "write blog.User#create", "commit"]);
      expect(changes).toEqual([{ entity: "blog.User", action: "create", before: null, after: author }]);
      await Post.read({}, context);
      expect(calls).toHaveLength(3);
    } finally {
      delete config.seams;
      await disconnect();
    }
    // Read when connect() runs: a config without seams binds none.
    await connect();
    await User.create({ name: "Quiet" }, context);
    expect(calls).toHaveLength(3);
    await disconnect();
  });

  test("disconnect never closes a layer passed to bind", async () => {
    const { db, blog } = await fresh();
    try {
      await connect();
      await disconnect();
      expect(await blog.run(() => Post.read({}, context))).toEqual([]);
    } finally { await db.close(); }
  });

  test("while connected, a call inside run() of a binding runs on that binding, and one outside any run on the connected one", async () => {
    const { db, blog } = await fresh();
    await connect();
    try {
      const connected = (await Post.read({}, context)).length;
      expect(connected).toBeGreaterThan(0);
      await blog.run(async () => {
        const author = await User.create({ name: "Scoped" }, context);
        await Post.create({ title: "Scoped", author: author.id }, context);
        expect((await Post.read({}, context)).map((post) => post.title)).toEqual(["Scoped"]);
      });
      expect(await Post.read({}, context)).toHaveLength(connected);
    } finally {
      await disconnect();
      await db.close();
    }
  });
});

test.each(["domain/blog/post.actions.ts", "domain/blog/index.ts", "binding.ts", "index.ts"])("acceptance 6: mesh build --check fails on an edited byte in .mesh/%s", (path) => {
  const file = resolve(import.meta.dir, "../.mesh", path);
  const original = readFileSync(file);
  const check = () => Bun.spawnSync([process.execPath, "x", "mesh", "build", "--check"], { cwd: resolve(import.meta.dir, "..") });
  try {
    writeFileSync(file, Buffer.concat([original, Buffer.from(" ")]));
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`.mesh/${path}:1:1 error Generated bytes differ`);
  } finally { writeFileSync(file, original); }
  expect(check().exitCode).toBe(0);
}, 60_000);

test("a mesh.config.ts that declares seams passes mesh build and build --check, and connect() runs them (ADR-0075)", async () => {
  // On a copy of the project, inside the example so its node_modules resolve; the copy's config names the seams for real.
  const project = resolve(import.meta.dir, "..");
  const copy = mkdtempSync(join(import.meta.dir, ".seams-"));
  const cwd = process.cwd();
  try {
    for (const entry of ["package.json", "src", ".mesh"]) cpSync(join(project, entry), join(copy, entry), { recursive: true });
    writeFileSync(join(copy, "mesh.config.ts"), readFileSync(join(project, "mesh.config.ts"), "utf8").replace(
      "  data:", `  seams: {
    beforeTransaction: ({ entity, action }) => { (globalThis as any).__seamLog.push(\`before \${entity}#\${action}\`); },
    afterWrite: (_db, { entity, action }) => { (globalThis as any).__seamLog.push(\`write \${entity}#\${action}\`); },
    afterCommit: ({ changes }) => { (globalThis as any).__seamLog.push(\`commit \${changes.length}\`); },
  },
  data:`));
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "x", "mesh", "build", ...args], { cwd: copy });
    expect(run("--check").stderr.toString()).toBe("0 errors, 0 warnings\n");
    expect(run("--check").exitCode).toBe(0);
    expect(run().exitCode).toBe(0);
    const log: string[] = [];
    (globalThis as any).__seamLog = log;
    process.chdir(copy);
    const mesh = await import(join(copy, ".mesh/index.ts")) as typeof import("#mesh");
    const blog = await import(join(copy, ".mesh/domain/blog/index.ts")) as typeof import("#mesh/domain/blog");
    await mesh.connect();
    try {
      const configured = (await import(join(copy, "mesh.config.ts"))).default as { data: SQLiteLayer };
      await createSchema(configured.data, mesh.tables);
      // The copy's own entity values: `connect()` above bound them, not this project's.
      await blog.User.create({ name: "Configured" }, context);
      await blog.Post.read({}, context);
    } finally { await mesh.disconnect(); }
    expect(log).toEqual(["before blog.User#create", "write blog.User#create", "commit 1"]);
  } finally {
    process.chdir(cwd);
    delete (globalThis as any).__seamLog;
    rmSync(copy, { recursive: true, force: true });
  }
}, 60_000);

test("acceptance 6: mesh build --check fails on a deleted module index, and mesh build writes it back", () => {
  // On a copy of the project, so a failure here never leaves the committed .mesh/ tree changed. The copy
  // sits inside the example, where the example's node_modules resolve meshfw and the adapter.
  const project = resolve(import.meta.dir, "..");
  const copy = mkdtempSync(join(import.meta.dir, ".guard-"));
  try {
    for (const entry of ["mesh.config.ts", "package.json", "src", ".mesh"]) cpSync(join(project, entry), join(copy, entry), { recursive: true });
    const file = join(copy, ".mesh/domain/blog/index.ts");
    const original = readFileSync(file);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "x", "mesh", "build", ...args], { cwd: copy });
    expect(run("--check").exitCode).toBe(0);
    rmSync(file);
    const result = run("--check");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(".mesh/domain/blog/index.ts:1:1 error Generated file is missing");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(file)).toEqual(original);
    expect(run("--check").exitCode).toBe(0);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}, 60_000);

/**
 * Acceptance 8's scan: every import, export-from and dynamic import specifier in the code files under
 * `<project>/src`. Allowed: `#mesh`, `#mesh/domain`, `#mesh/domain/<module>`, a relative path that does
 * not resolve into `<project>/.mesh/` (that tree is reached only through the `#mesh` specifiers), and a
 * bare `import "x"` next to `declare module "x"`. Returns `src/<file>: <specifier>` for the rest.
 */
function importOffenders(project: string): string[] {
  const src = join(project, "src");
  const output = join(project, ".mesh");
  const files = readdirSync(src, { recursive: true }).map(String).filter((name) => /\.[cm]?[jt]sx?$/.test(name)).sort();
  if (files.length === 0) return ["src: No code files scanned"];
  const offenders: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(src, name), "utf8");
    // A bare `import "x"` is allowed only next to `declare module "x"`: that is the
    // ActionContext augmentation ADR-0059 prescribes, a type, not a run-time import.
    const augmented = new Set([...source.matchAll(/declare module "([^"]+)"/g)].map((match) => match[1]));
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      const bare = /^import\s*["']/.test(match[0]);
      const generated = specifier === "#mesh" || specifier === "#mesh/domain" || specifier.startsWith("#mesh/domain/");
      const local = specifier.startsWith(".") && !inside(output, resolve(src, dirname(name), specifier));
      if (generated || local || (bare && augmented.has(specifier))) continue;
      offenders.push(`src/${name.split(sep).join("/")}: ${specifier}`);
    }
  }
  return offenders;
}

/** True when `path` is `folder` or below it. */
function inside(folder: string, path: string): boolean {
  const rest = relative(folder, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

test("acceptance 8: application code imports only #mesh, a module's #mesh/domain specifier and relative paths outside .mesh/", () => {
  expect(importOffenders(resolve(import.meta.dir, ".."))).toEqual([]);
});

test("acceptance 8: a relative path into .mesh/, or a #mesh specifier the package does not map, is an offender", () => {
  const project = mkdtempSync(join(tmpdir(), "mesh-blog-imports-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  try {
    put("src/main.ts", [
      'import { Post } from "#mesh/domain/blog";',
      'import { connect } from "#mesh";',
      'import { alice } from "./context";',
      'import { bindPost } from "../.mesh/domain/blog/post.actions";',
      'import { tables } from "../.mesh";',
      'export * from "../.mesh/index.ts";',
      'const binding = await import("../.mesh/binding");',
      'import { bind } from "#mesh/binding";',
      'import "../.meshy/notes";',
      'import "../.mesh-generators/index.ts.jig";',
    ].join("\n"));
    put("src/context.ts", 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {}\nimport { z } from "zod";');
    put("src/domain/blog/helpers.ts", 'import { x } from "../../../.mesh/domain/blog/index.ts";\nimport { y } from "../../main";');
    expect(importOffenders(project)).toEqual([
      "src/context.ts: zod",
      "src/domain/blog/helpers.ts: ../../../.mesh/domain/blog/index.ts",
      "src/main.ts: ../.mesh/domain/blog/post.actions",
      "src/main.ts: ../.mesh",
      "src/main.ts: ../.mesh/index.ts",
      "src/main.ts: ../.mesh/binding",
      "src/main.ts: #mesh/binding",
    ]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
