import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSchema, sqlite, type SQLiteLayer } from "@meshfw/data-sqlite";
import { FrameworkError, InvalidInputError, NotFoundError } from "@meshfw/runtime";
import { bind, connect, createPost, createUser, disconnect, readPost, tables } from "#mesh";
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
