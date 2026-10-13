// ENT-19: a `json` value keeps every key it is given, an own `__proto__` key included, at any depth, from the caller to
// the database and back; no prototype changes because of the data. The refusals of the old `z.json()` are pinned too.
// A domain with json attributes is built, generated, pushed to SQLite and called through the generated functions.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { InvalidInputError, type Seams } from "@meshfw/runtime";
import { callsOf } from "./calls.ts";
import { openPolicies } from "./open-policy.ts";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const doc = `entity :Doc table="docs"
  attributes
    uuid :id primary-key
    string :title
    json :payload
    json :stepped
  actions auto=[:read]
    create :make
      input
        &title
        &payload
        json :note
      do
        set
          &stepped=({ input }) => input.note
        run [after=:write] ({ input, self, context }) {
          context?.seen?.push({ input, self });
        }
    update :change
      input
        &payload
        json :note
      do
        set
          &stepped=({ input }) => input.note
        run [after=:write] ({ input, self, context }) {
          context?.seen?.push({ input, self });
        }
`;

let dir: string;
let app: any;
let domain: object;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".jsonproto-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([{ file: "src/domain/doc.mesh.mx", source: doc }]) });
  expect((built.diagnostics as { severity: string }[]).filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let counter = 0;
/** A file database, so the test can read the stored text raw, next to the layer. */
async function fresh(seams?: Seams) {
  const file = join(dir, `db-${counter++}.sqlite`);
  const db = sqlite({ file });
  await createSchema(db, app.tables);
  const mesh = callsOf(app.bind(db, seams ? { seams } : {}), domain);
  const raw = () => {
    const database = new Database(file, { readonly: true });
    try { return database.query("select title, payload, stepped from docs order by rowid").all() as { title: string; payload: string | null; stepped: string | null }[]; }
    finally { database.close(); }
  };
  return { db, mesh, raw };
}

/** `JSON.parse` makes an own `__proto__` data property; an object literal would set the prototype. */
const parse = (text: string): unknown => JSON.parse(text);

const values: Record<string, string> = {
  "at the top level, an object": '{"__proto__":{"a":1},"b":2}',
  "at the top level, a primitive": '{"__proto__":1}',
  "at the top level, null": '{"__proto__":null,"c":3}',
  "nested in an object": '{"x":{"y":{"__proto__":{"a":1}}},"z":1}',
  "inside an array": '[1,{"__proto__":{"a":1}},[{"__proto__":2}]]',
  "holding itself-shaped data": '{"__proto__":{"__proto__":{"__proto__":"deep"}}}',
};

/** Every object reachable from `value`: its prototype is `Object.prototype` (or none, for an array's `Array.prototype`); the number of own `__proto__` data properties found. */
function proto(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
    return value.reduce<number>((sum, item) => sum + proto(item), 0);
  }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  let found = 0;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    expect("value" in descriptor).toBe(true);
    if (key === "__proto__") found++;
    found += proto(descriptor.value);
  }
  return found;
}
/** The own `__proto__` keys in a JSON text. */
const protoKeys = (text: string) => text.match(/"__proto__":/g)?.length ?? 0;

/** The value is exactly the sent one (same keys, same order), keeps all its `__proto__` keys as data, and has ordinary prototypes. */
function expectKept(got: unknown, sent: string) {
  expect(JSON.stringify(got)).toBe(sent);
  expect(proto(got)).toBe(protoKeys(sent));
}
function expectPristine() {
  expect(({} as any).a).toBeUndefined();
  expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
  expect(Reflect.ownKeys(Object.prototype).sort()).toEqual(Reflect.ownKeys(Object.getPrototypeOf({})).sort());
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(Object.hasOwn(Object.prototype, "a")).toBe(false);
}
async function rejection(call: Promise<unknown>): Promise<InvalidInputError> {
  try { await call; } catch (error) { return error as InvalidInputError; }
  throw new Error("expected the call to reject");
}

describe("a json attribute and a json argument keep an own __proto__ key", () => {
  for (const [where, text] of Object.entries(values)) {
    test(`${where}: create and update, in the input, self, the stored row and a read`, async () => {
      const { db, mesh, raw } = await fresh();
      try {
        const seen: any[] = [];
        const created = await mesh.makeDoc({ title: "t", payload: parse(text), note: parse(text) }, { seen });
        expectKept(created.payload, text);
        expectKept(created.stepped, text);
        // The action's input and self, in a step after the write.
        expectKept(seen[0].input.payload, text);
        expectKept(seen[0].input.note, text);
        expectKept(seen[0].self.payload, text);
        expectKept(seen[0].self.stepped, text);
        // The stored row, raw: the text still has the key.
        expect(raw()).toEqual([{ title: "t", payload: text, stepped: text }]);
        // A read.
        const [read] = await mesh.readDoc({});
        expectKept(read.payload, text);
        expectKept(read.stepped, text);

        // An update: a different value in each, so the stored row proves a write.
        const other = '{"__proto__":{"u":[{"__proto__":0}]},"k":"v"}';
        const updated = await mesh.changeDoc({ id: created.id, payload: parse(other), note: parse(text) }, { seen });
        expectKept(updated.payload, other);
        expectKept(updated.stepped, text);
        expectKept(seen[1].input.payload, other);
        expectKept(seen[1].self.payload, other);
        expectKept(seen[1].self.stepped, text);
        expect(raw()).toEqual([{ title: "t", payload: other, stepped: text }]);
        const [again] = await mesh.readDoc({});
        expectKept(again.payload, other);
        expectKept(again.stepped, text);

        expectPristine();
      } finally { await db.close(); }
    });
  }

  test("what the caller sent is not changed, and two calls with the same value do not share it", async () => {
    const { db, mesh } = await fresh();
    try {
      const sent = parse(values["at the top level, an object"]!);
      const seen: any[] = [];
      const first = await mesh.makeDoc({ title: "a", payload: sent }, { seen });
      expectKept(sent, values["at the top level, an object"]!);
      expect(first.payload).not.toBe(sent);
      expect(Object.getOwnPropertyDescriptor(sent, "__proto__")!.value).toEqual({ a: 1 });
    } finally { await db.close(); }
  });

  test("the seams see the key in before, after and the input", async () => {
    const text = values["at the top level, an object"]!;
    const written: any[] = [];
    const committed: any[] = [];
    const { db, mesh } = await fresh({
      afterWrite: (_db, event) => { written.push(event); },
      afterCommit: (event) => { committed.push(event); },
    });
    try {
      const created = await mesh.makeDoc({ title: "s", payload: parse(text), note: parse(text) }, { seen: [] });
      const other = '{"o":{"__proto__":[1]}}';
      await mesh.changeDoc({ id: created.id, payload: parse(other) }, { seen: [] });
      expect(written).toHaveLength(2);
      expect(written[0].before).toBeNull();
      expectKept(written[0].after.payload, text);
      expectKept(written[0].after.stepped, text);
      expectKept(written[0].input.payload, text);
      expectKept(written[0].input.note, text);
      expectKept(written[1].before.payload, text);
      expectKept(written[1].after.payload, other);
      expectKept(written[1].input.payload, other);
      expect(committed).toHaveLength(2);
      expectKept(committed[0].changes[0].after.payload, text);
      expectKept(committed[1].changes[0].before.payload, text);
      expectKept(committed[1].changes[0].after.payload, other);
      expectPristine();
    } finally { await db.close(); }
  });

  test("a step sets a field from a value with the key, and a seam's frozen view still shows it", async () => {
    const text = values["inside an array"]!;
    const frozen: any[] = [];
    const { db, mesh } = await fresh({ afterWrite: (_db, event) => { frozen.push(event.after); } });
    try {
      await mesh.makeDoc({ title: "f", payload: null, note: parse(text) }, { seen: [] });
      expectKept(frozen[0].stepped, text);
      expect(Object.isFrozen(frozen[0].stepped)).toBe(true);
      expectPristine();
    } finally { await db.close(); }
  });

  test("a function of the entity file copies a record value that holds the key with structuredClone", async () => {
    const { cloneValue, readOnlyRecord } = await import("@meshfw/runtime");
    const text = values["nested in an object"]!;
    const view = readOnlyRecord({ payload: parse(text) } as any, "test") as any;
    const copy = cloneValue(view);
    expectKept(copy.payload, text);
    copy.payload.added = 1;
    expectPristine();
  });
});

describe("a json value keeps the key when it also holds what z.json() refused", () => {
  test("a null-prototype object, an inherited key, a non-enumerable key, a getter and an array property", async () => {
    const { db, mesh } = await fresh();
    try {
      const bare = Object.assign(Object.create(null), { a: 1 });
      expect((await mesh.makeDoc({ title: "x", payload: bare })).payload).toEqual({ a: 1 });
      const inherited = Object.create({ inherited: 1 });
      inherited.own = 2;
      expect((await mesh.makeDoc({ title: "x", payload: inherited })).payload).toEqual({ own: 2 });
      const hidden = Object.defineProperty({ shown: 1 }, "hidden", { value: 2, enumerable: false });
      expect((await mesh.makeDoc({ title: "x", payload: hidden })).payload).toEqual({ shown: 1 });
      const getter = { get g() { return 7; } };
      expect((await mesh.makeDoc({ title: "x", payload: getter })).payload).toEqual({ g: 7 });
      expect((await mesh.makeDoc({ title: "x", payload: Object.assign([1], { extra: 2 }) })).payload).toEqual([1]);
      expect((await mesh.makeDoc({ title: "x", payload: { constructor: 1, toString: "s", hasOwnProperty: null } })).payload).toEqual({ constructor: 1, toString: "s", hasOwnProperty: null });
      // The cast copies own string keys only (`Object.entries`), so a symbol key is dropped before the validator sees it.
      expect((await mesh.makeDoc({ title: "x", payload: { [Symbol("k")]: 1, a: 1 } })).payload).toEqual({ a: 1 });
      expectPristine();
    } finally { await db.close(); }
  });

  test("a cycle passes the validator, as before, and the copy keeps it; the write then fails; shared references stay shared", async () => {
    const { db, mesh } = await fresh();
    try {
      const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
      const failure = await rejection(mesh.makeDoc({ title: "c", payload: cyclic }));
      expect(failure).not.toBeInstanceOf(InvalidInputError);
      const shared = { x: 1 };
      const row = await mesh.makeDoc({ title: "c", payload: { a: shared, b: shared } });
      expect(row.payload).toEqual({ a: { x: 1 }, b: { x: 1 } });
    } finally { await db.close(); }
  });
});

describe("what z.json() refused is still refused, at the same path", () => {
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const refused: Record<string, unknown> = {
    "a function": () => 1,
    "a Date": new Date(),
    "undefined in an array": [1, undefined],
    "undefined in an object": { a: undefined },
    "NaN": Number.NaN,
    "Infinity": Number.POSITIVE_INFINITY,
    "-Infinity": Number.NEGATIVE_INFINITY,
    "NaN deep inside": { a: [{ b: Number.NaN }] },
    "a sparse array": sparse,
    "a Map": new Map(),
    "a Set": new Set(),
    "a symbol": Symbol("s"),
    "a bigint": 1n,
    "a class instance": new (class Widget {})(),
    "a boxed number": new Number(1),
    "a typed array": new Uint8Array(2),
    "a function deep inside": { list: [{ f: () => 1 }] },
  };
  for (const [what, value] of Object.entries(refused)) {
    test(what, async () => {
      const { db, mesh } = await fresh();
      try {
        for (const [call, path] of [[(v: unknown) => mesh.makeDoc({ title: "r", payload: v }), "payload"], [(v: unknown) => mesh.makeDoc({ title: "r", payload: null, note: v }), "note"]] as const) {
          const error = await rejection(call(value));
          expect(error).toBeInstanceOf(InvalidInputError);
          // One issue, at the json field itself, however deep the bad value is, with Zod's message for a union.
          expect(error.issues.map((issue) => [issue.path, issue.message])).toEqual([[[path], "Invalid input"]]);
        }
      } finally { await db.close(); }
    });
  }

  test("nothing is stored by a refused call, and undefined means not sent", async () => {
    const { db, mesh, raw } = await fresh();
    try {
      await rejection(mesh.makeDoc({ title: "r", payload: [1, undefined] }));
      expect(raw()).toEqual([]);
      expect((await mesh.makeDoc({ title: "r", payload: undefined })).payload).toBeNull();
    } finally { await db.close(); }
  });
});
