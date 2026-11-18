import { describe, expect, test } from "bun:test";
import { InvalidInputError, relateRows, type RelateSpec, type Row } from "../src/index.ts";

const source = { file: "domain/music/album.mesh.mx", line: 9, column: 9 };
const T1 = "0190a0a0-0000-7000-8000-000000000001";
const T2 = "0190a0a0-0000-7000-8000-000000000002";
const T3 = "0190a0a0-0000-7000-8000-000000000003";

/** A spec over `rows` whose functions record each call, in order. */
function recorded(rows: readonly Row[], options: { destroy?: boolean; update?: boolean; create?: boolean; key?: string; uuidKey?: boolean } = {}) {
  const calls: string[] = [];
  let reads = 0;
  const key = options.key ?? "id";
  const spec: RelateSpec<Row, string> = {
    where: "music.Album#tracks",
    field: "tracks",
    key,
    uuidKey: options.uuidKey ?? true,
    source,
    current: async () => { reads++; return rows; },
    ...(options.destroy !== false ? { destroy: async (k: object) => { calls.push(`destroy ${JSON.stringify(k)}`); } } : {}),
    ...(options.update !== false ? { update: async (item: Row) => { calls.push(`update ${JSON.stringify(item)}`); } } : {}),
    ...(options.create !== false ? { create: async (item: Row) => { calls.push(`create ${JSON.stringify(item)}`); } } : {}),
  };
  return { spec, calls, reads: () => reads };
}

async function issuesOf(promise: Promise<unknown>) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as InvalidInputError).issues.map(({ code, path, label, source: at, details }) => ({ code, path, label, at, details }));
  }
  throw new Error("expected the call to reject");
}

describe("relateRows", () => {
  test("undefined items do nothing and read nothing", async () => {
    const { spec, calls, reads } = recorded([{ id: T1 }]);
    await relateRows(spec, undefined);
    expect(calls).toEqual([]);
    expect(reads()).toBe(0);
  });

  test("destroys, then updates, then creates, each in its order", async () => {
    const { spec, calls } = recorded([{ id: T1, name: "a" }, { id: T2, name: "b" }, { id: T3, name: "c" }]);
    await relateRows(spec, [{ name: "new 1" }, { id: T3, name: "c2" }, { id: T1 }, { name: "new 2" }]);
    expect(calls).toEqual([
      `destroy {"id":"${T2}"}`,
      `update {"id":"${T3}","name":"c2"}`,
      `update {"id":"${T1}"}`,
      `create {"name":"new 1"}`,
      `create {"name":"new 2"}`,
    ]);
  });

  test("an empty list destroys every current child, and keeps them without destroy", async () => {
    const all = recorded([{ id: T1 }, { id: T2 }]);
    await relateRows(all.spec, []);
    expect(all.calls).toEqual([`destroy {"id":"${T1}"}`, `destroy {"id":"${T2}"}`]);
    const kept = recorded([{ id: T1 }, { id: T2 }], { destroy: false });
    await relateRows(kept.spec, []);
    expect(kept.calls).toEqual([]);
  });

  test("without update a keyed item only keeps its child", async () => {
    const { spec, calls } = recorded([{ id: T1 }, { id: T2 }], { update: false });
    await relateRows(spec, [{ id: T1 }]);
    expect(calls).toEqual([`destroy {"id":"${T2}"}`]);
  });

  test("unknown and repeated keys are reported together, before any call", async () => {
    const { spec, calls } = recorded([{ id: T1 }, { id: T2 }]);
    const issues = await issuesOf(relateRows(spec, [{ id: T3 }, { id: T1 }, { name: "x" }, { id: T1 }, { id: "nope" }]));
    expect(issues).toEqual([
      { code: "not_related", path: ["tracks", 0, "id"], label: "relate", at: source, details: { id: T3 } },
      { code: "duplicate", path: ["tracks", 3, "id"], label: "relate", at: source, details: { id: T1 } },
      { code: "not_related", path: ["tracks", 4, "id"], label: "relate", at: source, details: { id: "nope" } },
    ]);
    expect(calls).toEqual([]);
  });

  test("a uuid key is compared lower-cased and reaches update as stored", async () => {
    const { spec, calls } = recorded([{ id: T1 }, { id: T2 }]);
    await relateRows(spec, [{ id: T1.toUpperCase(), name: "x" }, { id: T2.toUpperCase() }]);
    expect(calls).toEqual([`update {"id":"${T1}","name":"x"}`, `update {"id":"${T2}"}`]);
    // the same key in two casings is one key given twice
    const twice = recorded([{ id: T1 }]);
    expect(await issuesOf(relateRows(twice.spec, [{ id: T1 }, { id: T1.toUpperCase() }]))).toEqual([
      { code: "duplicate", path: ["tracks", 1, "id"], label: "relate", at: source, details: { id: T1.toUpperCase() } },
    ]);
  });

  test("any other key is compared exactly", async () => {
    const integer = recorded([{ n: 1 }, { n: 2 }], { key: "n", uuidKey: false });
    await relateRows(integer.spec, [{ n: 2 }]);
    expect(integer.calls).toEqual([`destroy {"n":1}`, `update {"n":2}`]);
    const text = recorded([{ code: "ab" }], { key: "code", uuidKey: false });
    expect(await issuesOf(relateRows(text.spec, [{ code: "AB" }]))).toEqual([
      { code: "not_related", path: ["tracks", 0, "code"], label: "relate", at: source, details: { code: "AB" } },
    ]);
  });

  test("an item whose key is undefined is a new item", async () => {
    const { spec, calls } = recorded([]);
    await relateRows(spec, [{ id: undefined, name: "x" }]);
    expect(calls).toEqual([`create {"name":"x"}`]);
  });

  test("a failing call rejects with its own error, and stops the rest", async () => {
    const failure = new Error("child refused");
    const calls: string[] = [];
    const spec: RelateSpec<Row, string> = {
      where: "music.Album#tracks", field: "tracks", key: "id", uuidKey: true, source,
      current: async () => [{ id: T1 }],
      destroy: async () => { calls.push("destroy"); throw failure; },
      create: async () => { calls.push("create"); },
    };
    await expect(relateRows(spec, [{ name: "x" }])).rejects.toBe(failure);
    expect(calls).toEqual(["destroy"]);
  });
});
