import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSchema, sqlite, type SQLiteLayer } from "@meshfw/data-sqlite";
import { FrameworkError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import { bind, connect, createPost, createUser, disconnect, readPost, tables, type PostFilter, type PostSort } from "#mesh";
import config from "../mesh.config";
import { alice } from "../src/context";

const context = { actor: alice };

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  return { db, blog: bind(db) };
}

test("acceptance 1: create, read, update, destroy, and a write after destroy is not found", async () => {
  const { db, blog } = await fresh();
  try {
    const author = await blog.createUser({ name: "Alice" }, context);
    const post = await blog.createPost({ title: "Hello", author: author.id }, context);
    expect(post).toMatchObject({ title: "Hello", body: null, views: 0, price: 0, featured: false, state: "draft", authorId: author.id });
    expect(await blog.readPost({}, context)).toEqual([post]);

    const published = await blog.publishPost({ id: post.id }, context);
    expect(published.state).toBe("published");
    expect(published.insertedAt).toEqual(post.insertedAt);

    await blog.destroyPost({ id: post.id }, context);
    expect(await blog.readPost({}, context)).toEqual([]);
    await expect(blog.publishPost({ id: post.id }, context)).rejects.toBeInstanceOf(NotFoundError);
    await expect(blog.destroyPost({ id: post.id }, context)).rejects.toBeInstanceOf(NotFoundError);
    await expect(blog.archivePost({ id: post.id }, context)).rejects.toBeInstanceOf(NotFoundError);
  } finally { await db.close(); }
});

test("a create fills timestamps from one clock reading, and an update moves only updatedAt", async () => {
  const { db, blog } = await fresh();
  try {
    const author = await blog.createUser({ name: "Alice" }, context);
    const post = await blog.createPost({ title: "Hello", author: author.id }, context);
    expect(post.insertedAt).toBeInstanceOf(Date);
    expect(post.insertedAt.getTime()).toBe(post.updatedAt.getTime());
    await Bun.sleep(5);
    const published = await blog.publishPost({ id: post.id }, context);
    expect(published.insertedAt.getTime()).toBe(post.insertedAt.getTime());
    expect(published.updatedAt.getTime()).toBeGreaterThan(post.updatedAt.getTime());
  } finally { await db.close(); }
});

test("acceptance 2: a field not in the action's input is rejected, and nothing is written", async () => {
  const { db, blog } = await fresh();
  try {
    const author = await blog.createUser({ name: "Alice" }, context);
    // @ts-expect-error `state` is not in createPost's input
    const call = blog.createPost({ title: "Hello", author: author.id, state: "published" }, context);
    await expect(call).rejects.toBeInstanceOf(InvalidInputError);
    expect(await blog.readPost({}, context)).toEqual([]);
  } finally { await db.close(); }
});

test("acceptance 3: a failing validation's first frame outside node_modules and Mesh's packages is the generated action", async () => {
  const { db, blog } = await fresh();
  try {
    let caught: unknown;
    try { await blog.createPost({ title: "", author: alice.id }, context); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(InvalidInputError);
    const frames = (caught as Error).stack!.split("\n").filter((line) => line.trimStart().startsWith("at "));
    const packages = resolve(import.meta.dir, "../../../packages");
    const first = frames.find((frame) => !frame.includes("node_modules") && !frame.includes(packages));
    expect(first).toContain(resolve(import.meta.dir, "../.mesh/blog/post.actions.ts"));
  } finally { await db.close(); }
});

test("a constant set is applied: publishPost sets state to published", async () => {
  const { db, blog } = await fresh();
  try {
    const author = await blog.createUser({ name: "Alice" }, context);
    const post = await blog.createPost({ title: "Hello", author: author.id }, context);
    await blog.publishPost({ id: post.id }, context);
    expect((await blog.readPost({}, context))[0]?.state).toBe("published");
  } finally { await db.close(); }
});

test("a read with filter and sort throws the M4 FrameworkError instead of returning unfiltered rows", async () => {
  const { db, blog } = await fresh();
  try {
    await expect(blog.publishedPost({}, context)).rejects.toThrow(
      new FrameworkError("publishedPost cannot run in this version: its filter and sort are evaluated from M4"));
  } finally { await db.close(); }
});

/** A blog with one author and the titles given, created in order; `body` is set on every other post. */
async function seeded(titles: string[]) {
  const world = await fresh();
  const author = await world.blog.createUser({ name: "Alice" }, context);
  const posts = [];
  for (const [index, title] of titles.entries())
    posts.push(await world.blog.createPost({ title, author: author.id, ...(index % 2 === 0 ? { body: `body ${title}` } : {}) }, context));
  return { ...world, author, posts };
}
const titlesOf = (posts: { title: string }[]) => posts.map((post) => post.title);

describe("ids (UUIDv7, filled by the data layer)", () => {
  test("a create writes no id of its own: the id is a UUIDv7, and ids sort in creation order", async () => {
    const { db, posts } = await seeded(Array.from({ length: 25 }, (_, index) => `post ${index}`));
    try {
      for (const post of posts) expect(post.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(posts.map((post) => post.id)).toEqual(posts.map((post) => post.id).sort());
      expect(new Set(posts.map((post) => post.id)).size).toBe(25);
    } finally { await db.close(); }
  });

  test("the generated create does not mention the id, and a client cannot send one", async () => {
    expect(readFileSync(resolve(import.meta.dir, "../.mesh/blog/post.actions.ts"), "utf8")).not.toMatch(/randomUUID|^\s+id: /m);
    const { db, blog, author } = await seeded([]);
    try {
      // @ts-expect-error the id is not part of createPost's input
      await expect(blog.createPost({ title: "x", author: author.id, id: crypto.randomUUID() }, context)).rejects.toBeInstanceOf(InvalidInputError);
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
  ];
  test.each(values)("%s is stored and returned as it was given", async (_name, metadata) => {
    const { db, blog, author } = await fresh().then(async (world) => ({ ...world, author: await world.blog.createUser({ name: "Alice" }, context) }));
    try {
      const post = await blog.createPost({ title: "Hello", author: author.id, metadata }, context);
      expect(post.metadata).toEqual(metadata);
      expect((await blog.readPost({}, context))[0]!.metadata).toEqual(metadata);
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
    ["null, because the attribute is not nullable", null],
  ])("%s fails at the validator and nothing is written", async (_name, metadata) => {
    const { db, blog, author } = await fresh().then(async (world) => ({ ...world, author: await world.blog.createUser({ name: "Alice" }, context) }));
    try {
      await expect(blog.createPost({ title: "Hello", author: author.id, metadata }, context)).rejects.toBeInstanceOf(InvalidInputError);
      expect(await blog.readPost({}, context)).toEqual([]);
    } finally { await db.close(); }
  });

  test("a json attribute is not filterable or sortable, in the types or at run time", async () => {
    const { db, blog } = await seeded(["a"]);
    try {
      // @ts-expect-error metadata is json: not a key of PostFilter
      await expect(blog.readPost({ filter: { metadata: { eq: "x" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
      // @ts-expect-error metadata is json: not a sort key
      await expect(blog.readPost({ sort: ["metadata"] }, context)).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });
});

describe("reads take a filter, sort, limit and offset", () => {
  const titles = ["delta", "alpha", "echo", "bravo", "charlie"];

  test("no input returns every row in key order, which is creation order", async () => {
    const { db, blog } = await seeded(titles);
    try { expect(titlesOf(await blog.readPost({}, context))).toEqual(titles); } finally { await db.close(); }
  });

  test("eq, ne, in and nil", async () => {
    const { db, blog } = await seeded(titles);
    try {
      expect(titlesOf(await blog.readPost({ filter: { title: { eq: "echo" } } }, context))).toEqual(["echo"]);
      expect(titlesOf(await blog.readPost({ filter: { title: { ne: "echo" } } }, context))).toEqual(["delta", "alpha", "bravo", "charlie"]);
      expect(titlesOf(await blog.readPost({ filter: { title: { in: ["bravo", "delta", "nope"] } } }, context))).toEqual(["delta", "bravo"]);
      expect(await blog.readPost({ filter: { title: { in: [] } } }, context)).toEqual([]);
      // Posts 0, 2 and 4 have a body.
      expect(titlesOf(await blog.readPost({ filter: { body: { nil: true } } }, context))).toEqual(["alpha", "bravo"]);
      expect(titlesOf(await blog.readPost({ filter: { body: { nil: false } } }, context))).toEqual(["delta", "echo", "charlie"]);
      expect(titlesOf(await blog.readPost({ filter: { body: { eq: null } } }, context))).toEqual(["alpha", "bravo"]);
    } finally { await db.close(); }
  });

  test("lt, lte, gt and gte compare text, numbers and dates", async () => {
    const { db, blog, posts } = await seeded(titles);
    try {
      expect(titlesOf(await blog.readPost({ filter: { title: { gt: "charlie" } }, sort: ["title"] }, context))).toEqual(["delta", "echo"]);
      expect(titlesOf(await blog.readPost({ filter: { title: { gte: "charlie", lt: "echo" } }, sort: ["title"] }, context))).toEqual(["charlie", "delta"]);
      expect(titlesOf(await blog.readPost({ filter: { title: { lte: "alpha" } } }, context))).toEqual(["alpha"]);
      expect(await blog.readPost({ filter: { views: { gt: 0 } } }, context)).toEqual([]);
      expect(await blog.readPost({ filter: { views: { eq: 0 } } }, context)).toHaveLength(5);
      const stamp = posts[0]!.insertedAt;
      expect(await blog.readPost({ filter: { insertedAt: { gt: new Date(stamp.getTime() + 60_000) } } }, context)).toEqual([]);
      expect(await blog.readPost({ filter: { insertedAt: { lte: new Date(stamp.getTime() + 60_000) } } }, context)).toHaveLength(5);
    } finally { await db.close(); }
  });

  test("booleans, enums and the key column of a relationship", async () => {
    const { db, blog, author, posts } = await seeded(titles);
    try {
      await blog.publishPost({ id: posts[1]!.id }, context);
      expect(titlesOf(await blog.readPost({ filter: { state: { eq: "published" } } }, context))).toEqual(["alpha"]);
      expect(await blog.readPost({ filter: { featured: { eq: true } } }, context)).toEqual([]);
      expect(await blog.readPost({ filter: { authorId: { eq: author.id } } }, context)).toHaveLength(5);
      expect(await blog.readPost({ filter: { authorId: { ne: author.id } } }, context)).toEqual([]);
      // @ts-expect-error "archived" is not a value of the state enum
      await expect(blog.readPost({ filter: { state: { eq: "archived" } } }, context)).rejects.toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });

  test("and, or and nesting", async () => {
    const { db, blog } = await seeded(titles);
    try {
      const filter = { and: [{ or: [{ title: { eq: "delta" } }, { title: { eq: "bravo" } }] }, { body: { nil: true } }] };
      expect(titlesOf(await blog.readPost({ filter }, context))).toEqual(["bravo"]);
      expect(titlesOf(await blog.readPost({ filter: { or: [{ title: { eq: "delta" } }, { body: { nil: true } }] } }, context))).toEqual(["delta", "alpha", "bravo"]);
      expect(await blog.readPost({ filter: { and: [] } }, context)).toHaveLength(5);
      expect(await blog.readPost({ filter: { or: [] } }, context)).toEqual([]);
      expect(await blog.readPost({ filter: {} }, context)).toHaveLength(5);
      expect(titlesOf(await blog.readPost({ filter: { title: { gt: "a", lt: "c" } } }, context))).toEqual(["alpha", "bravo"]);
    } finally { await db.close(); }
  });

  test("sort ascending, descending, by several keys, with the key as the last tie-break", async () => {
    const { db, blog } = await seeded(titles);
    try {
      expect(titlesOf(await blog.readPost({ sort: ["title"] }, context))).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
      expect(titlesOf(await blog.readPost({ sort: ["-title"] }, context))).toEqual(["echo", "delta", "charlie", "bravo", "alpha"]);
      // Every post has the same `views`, so the next key decides; then the id.
      expect(titlesOf(await blog.readPost({ sort: ["views", "-title"] }, context))).toEqual(["echo", "delta", "charlie", "bravo", "alpha"]);
      expect(titlesOf(await blog.readPost({ sort: ["views"] }, context))).toEqual(titles);
      expect(titlesOf(await blog.readPost({ sort: ["-views"] }, context))).toEqual(titles);
      const readOnly = ["title"] as const;
      expect(titlesOf(await blog.readPost({ sort: readOnly }, context))[0]).toBe("alpha");
    } finally { await db.close(); }
  });

  test("limit and offset page the result, and an offset past the end returns nothing", async () => {
    const { db, blog } = await seeded(titles);
    try {
      const sort = ["title"] as const;
      expect(titlesOf(await blog.readPost({ sort, limit: 2 }, context))).toEqual(["alpha", "bravo"]);
      expect(titlesOf(await blog.readPost({ sort, limit: 2, offset: 2 }, context))).toEqual(["charlie", "delta"]);
      expect(titlesOf(await blog.readPost({ sort, limit: 2, offset: 4 }, context))).toEqual(["echo"]);
      expect(await blog.readPost({ sort, limit: 2, offset: 10 }, context)).toEqual([]);
      expect(titlesOf(await blog.readPost({ sort, offset: 3 }, context))).toEqual(["delta", "echo"]);
      expect(await blog.readPost({ limit: 0 }, context)).toEqual([]);
      expect(await blog.readPost({ limit: 100 }, context)).toHaveLength(5);
      const pages = [];
      for (let offset = 0; offset < 5; offset += 2) pages.push(titlesOf(await blog.readPost({ sort, limit: 2, offset }, context)));
      expect(pages.flat()).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    } finally { await db.close(); }
  });

  test("filter, sort and limit together return the expected page", async () => {
    const { db, blog, author } = await seeded(titles);
    try {
      const page = await blog.readPost({ filter: { authorId: { eq: author.id }, title: { ne: "alpha" } }, sort: ["-title"], limit: 3 }, context);
      expect(titlesOf(page)).toEqual(["echo", "delta", "charlie"]);
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
    try { await expect(blog.readPost(input as never, context)).rejects.toBeInstanceOf(InvalidInputError); } finally { await db.close(); }
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
    const author = await one.blog.createUser({ name: "Alice" }, context);
    await one.blog.createPost({ title: "Hello", author: author.id }, context);
    expect(await one.blog.readPost({}, context)).toHaveLength(1);
    expect(await two.blog.readPost({}, context)).toEqual([]);
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
    await expect(readPost({}, context)).rejects.toThrow(new FrameworkError(
      "readPost was called while not connected: call connect() first, or use bind(db) with a data layer of your own"));
    await disconnect();
  });

  test("connect binds the configured layer without opening it; a second connect throws", async () => {
    await connect();
    // ADR-0047: the layer opens on its first transaction, not at connect().
    expect(existsSync("blog.db")).toBe(false);
    // The configured value is a descriptor and, for sqlite(), the run-time layer too.
    await createSchema(config.data as SQLiteLayer, tables);
    const author = await createUser({ name: "Alice" }, context);
    await createPost({ title: "Hello", author: author.id }, context);
    expect(await readPost({}, context)).toHaveLength(1);
    await expect(connect()).rejects.toThrow(new FrameworkError("connect() was called while connected; call disconnect() first"));
  });

  test("calls after disconnect throw; connect again reopens the same file", async () => {
    await disconnect();
    await expect(readPost({}, context)).rejects.toBeInstanceOf(FrameworkError);
    await connect();
    expect(await readPost({}, context)).toHaveLength(1);
    await disconnect();
  });

  test("disconnect waits for a call already made to settle before it closes the layer", async () => {
    await connect();
    const author = await createUser({ name: "Bob" }, context);
    // Not awaited: the call is in flight (validating its input) when disconnect starts.
    const pending = createPost({ title: "In flight", author: author.id }, context);
    let settled = false;
    void pending.then(() => { settled = true; });
    await disconnect();
    expect(settled).toBe(true);
    expect((await pending).title).toBe("In flight");
    await connect();
    expect((await readPost({}, context)).map((post) => post.title)).toContain("In flight");
    await disconnect();
  });

  test("disconnect never closes a layer passed to bind", async () => {
    const { db, blog } = await fresh();
    try {
      await connect();
      await disconnect();
      expect(await blog.readPost({}, context)).toEqual([]);
    } finally { await db.close(); }
  });
});

test.each(["blog/post.actions.ts", "index.ts"])("acceptance 6: mesh build --check fails on an edited byte in .mesh/%s", (path) => {
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
});

test("acceptance 8: application code imports only #mesh and relative paths", () => {
  const src = resolve(import.meta.dir, "../src");
  const files = readdirSync(src, { recursive: true }).map(String).filter((name) => /\.[cm]?[jt]sx?$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(src, name), "utf8");
    // A bare `import "x"` is allowed only next to `declare module "x"`: that is the
    // ActionContext augmentation ADR-0059 prescribes, a type, not a run-time import.
    const augmented = new Set([...source.matchAll(/declare module "([^"]+)"/g)].map((match) => match[1]));
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      const bare = /^import\s*["']/.test(match[0]);
      if (specifier === "#mesh" || specifier.startsWith(".") || (bare && augmented.has(specifier))) continue;
      offenders.push(`src/${name}: ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});
